import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const testDbPath = path.join(
  os.tmpdir(),
  `test-bandit-attribution-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import {
  buildScopeKey,
  adaptiveScopeKey,
  centroidScopeKey,
  scoreAdaptiveArm,
  scheduleAdaptiveRetrievalTasks,
  deriveDomainCluster,
  deriveContractDomainCluster,
  quantizeBriefToCentroid,
} from "../server/leadSearch/adaptiveScheduler.js";
import {
  getLeadsDb,
  recordLeadOutcome,
  readOutcomeRate,
  readOutcomeRateByScope,
} from "../server/db.js";

test("Phase 4: Bandit and Attribution Intelligence", async (t) => {
  t.after(() => {
    try {
      fs.unlinkSync(testDbPath);
    } catch {}
  });

  await t.test("4.1: buildScopeKey constructs canonical keys across all scope sources", () => {
    // 1. Cluster-scoped key
    const clusterKey = buildScopeKey({
      domainCluster: "b2b_saas",
      family: "persona_title",
      lane: "person",
      provider: "tavily",
    });
    assert.equal(clusterKey, "b2b_saas|persona_title|person|tavily");

    // 2. Global cluster omits prefix
    const globalKey = buildScopeKey({
      domainCluster: "global",
      family: "persona_title",
      lane: "person",
      provider: "tavily",
    });
    assert.equal(globalKey, "persona_title|person|tavily");

    // 3. Centroid slot key takes precedence
    const slotKey = buildScopeKey({
      centroid: "slot:b2b_agency:founder:marketing:us",
      family: "persona_title",
      lane: "person",
      provider: "brightdata",
    });
    assert.equal(slotKey, "slot:b2b_agency:founder:marketing:us|persona_title|person|brightdata");

    // 4. Case-insensitivity and trimming
    const messyKey = buildScopeKey({
      domainCluster: " B2B_AGENCY ",
      family: " Growth_Signal ",
      lane: " SIGNAL ",
      provider: " TAVILY ",
    });
    assert.equal(messyKey, "b2b_agency|growth_signal|signal|tavily");

    // 5. adaptiveScopeKey and centroidScopeKey match buildScopeKey
    const task = {
      family: "persona_title" as const,
      lane: "person" as const,
      providerPreference: "tavily" as const,
      domainCluster: "b2b_saas",
    };
    assert.equal(adaptiveScopeKey(task), clusterKey);
    assert.equal(
      centroidScopeKey(task, "slot:b2b_agency:founder:marketing:us"),
      "slot:b2b_agency:founder:marketing:us|persona_title|person|tavily",
    );
  });

  await t.test("4.2: scoreAdaptiveArm with LEAD_ADAPTIVE_REWARD_V2 avoids double-counting and normalizes cost", () => {
    process.env.LEAD_ADAPTIVE_REWARD_V2 = "true";
    try {
      // Row where all 5 qualified candidates were returned
      const rowNoOverlap = {
        outcome_runs: 5,
        qualified_candidates: 5,
        returned_candidates: 5,
        rescued_candidates: 0,
        judged_candidates: 10,
        provider_units: 5,
        search_latency_ms: 2500,
      };
      const v2Score = scoreAdaptiveArm(rowNoOverlap as any, 10, 0, false, 0);

      // In V2: returned = 1.0, qualifiedOnly = 0, successes = 1.0 per run.
      // successes = 1.0, trials = 2.0 (judged / 5), failures = 1.0.
      assert.ok(v2Score.score > 0);
      assert.ok(Number.isFinite(v2Score.score));
      // Alpha should reflect successes (1 + 1.0 = 2.0) rather than double-counting returned + qualified
      assert.equal(v2Score.alpha, 2.0);
    } finally {
      delete process.env.LEAD_ADAPTIVE_REWARD_V2;
    }
  });

  await t.test("4.3: readOutcomeRateByScope applies Empirical Bayes shrinkage toward global outcome rate", () => {
    const db = getLeadsDb();
    // Insert leads with discoveryScopeKey in payload
    db.prepare(`
      INSERT INTO leads (id, payload, created_at, updated_at)
      VALUES
        ('lead-arm-1', '{"discoveryScopeKey":"b2b_saas|persona_title|person|tavily"}', datetime('now'), datetime('now')),
        ('lead-arm-2', '{"discoveryScopeKey":"b2b_saas|persona_title|person|tavily"}', datetime('now'), datetime('now')),
        ('lead-arm-3', '{"discoveryScopeKey":"b2b_agency|persona_title|person|brightdata"}', datetime('now'), datetime('now'))
    `).run();

    // Record outcomes
    recordLeadOutcome("lead-arm-1", "positive", "CONVERTED", "b2b_saas|persona_title|person|tavily");
    recordLeadOutcome("lead-arm-2", "positive", "CONVERTED", "b2b_saas|persona_title|person|tavily");
    recordLeadOutcome("lead-arm-3", "negative", "LOST", "b2b_agency|persona_title|person|brightdata");

    const globalStats = readOutcomeRate();
    assert.equal(globalStats.total, 3);
    assert.equal(globalStats.positive, 2);
    const globalRate = 2 / 3;

    // With priorStrength kappa = 10:
    // arm1: n=2, pos=2. Shrunk rate: (2*1.0 + 10*(2/3)) / (2 + 10) = (2 + 6.6667) / 12 = 8.6667 / 12 = 0.7222
    // Arm 1 shrunk rate is pulled from 1.0 toward 0.667.
    const scopeRates = readOutcomeRateByScope(10);
    const arm1 = scopeRates.get("b2b_saas|persona_title|person|tavily");
    assert.ok(arm1 !== undefined);
    assert.equal(arm1.total, 2);
    assert.equal(arm1.positive, 2);
    assert.ok(arm1.shrunkRate < 1.0, "Small sample size must shrink toward global rate");
    assert.ok(arm1.shrunkRate > globalRate, "Arm with 100% positive should remain above global rate");
    assert.ok(Math.abs(arm1.shrunkRate - (2 + 10 * globalRate) / 12) < 0.001);
  });

  await t.test("4.4: deriveContractDomainCluster and 3-tier fallback chain in scheduler", () => {
    // 1. Domain clustering precision: bare "brand" or "consultant" alone does not misclassify
    assert.equal(deriveDomainCluster("Brand marketing director at enterprise software"), "b2b_saas");
    assert.equal(deriveDomainCluster("IT infrastructure consultant in Chicago"), "global");
    assert.equal(
      deriveContractDomainCluster({
        brief: "Fintech CTOs in London",
        identitySpec: { industries: ["fintech"] },
      }),
      "b2b_saas",
    );

    // 2. Deterministic slot centroid
    const slot = quantizeBriefToCentroid({
      brief: "Fintech CTOs in London",
      identitySpec: { roles: ["cto"], industries: ["fintech"], locations: ["uk"] },
    });
    assert.equal(slot.startsWith("slot:b2b_saas:cto:fintech:"), true);

    // 3. Fallback resolution: slot -> cluster -> global
    const taskAgency = {
      id: "q1",
      query: "agency query",
      family: "persona_title" as const,
      lane: "person" as const,
      providerPreference: "tavily" as const,
      priority: 1,
      domainCluster: "b2b_agency",
      centroid: "slot:b2b_agency:founder:marketing:us",
    };

    const rows = [
      // Only domainCluster row exists, no slot-specific row
      {
        scope_key: "b2b_agency|persona_title|person|tavily",
        domain_cluster: "b2b_agency",
        family: "persona_title",
        lane: "person",
        provider: "tavily",
        outcome_runs: 10,
        qualified_candidates: 8,
        returned_candidates: 7,
      },
    ];

    const result = scheduleAdaptiveRetrievalTasks([taskAgency as any], rows as any, {
      maxTasks: 1,
      minOutcomeRuns: 5,
    });
    assert.equal(result.active, true);
    assert.equal(result.decisions[0].outcomeRuns, 10);
  });
});
