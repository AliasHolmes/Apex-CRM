import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-agent-brain-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import {
  buildAgentBrainSearchPlan,
  executeAgentBrainDiscovery,
} from "../server/leadSearch/agentBrainRunner.js";
import { discoveryEngine } from "../server/leadSearch/discoveryEngine.js";
import {
  closeLeadsDb,
  getLeadsDb,
  hasGroundedQualification,
  readLeadActivities,
  readMiningSessionById,
  readStoredLeadById,
} from "../server/db.js";

const originalFetch = globalThis.fetch;
const originalTavilyKey = process.env.TAVILY_API_KEY;
const originalTavilyKeys = process.env.TAVILY_API_KEYS;

describe("Agent Brain Generalization, Streaming & Grounded Writes", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TAVILY_API_KEY = "test-tavily-agent-brain";
    delete process.env.TAVILY_API_KEYS;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalTavilyKey;
    if (originalTavilyKeys === undefined) delete process.env.TAVILY_API_KEYS;
    else process.env.TAVILY_API_KEYS = originalTavilyKeys;
    closeLeadsDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${testDbPath}${suffix}`, { force: true });
      } catch {
        // ignore
      }
    }
  });

  it("buildAgentBrainSearchPlan honors contract fields and custom options for non-B2B prompts", () => {
    const plan = buildAgentBrainSearchPlan(
      "CTOs at fintech companies in Berlin using Rust",
      {
        decisionMakerRoles: ["CTO", "VP Engineering"],
        keywords: ["Rust", "Kubernetes"],
        geographicHubs: ["Berlin"],
      },
    );

    assert.equal(plan.isB2BOutbound, false);
    assert.deepEqual(plan.roles, ["CTO", "VP Engineering"]);
    assert.deepEqual(plan.keywords, ["Rust", "Kubernetes"]);
    assert.deepEqual(plan.locations, ["Berlin"]);
    assert.ok(plan.queries.length > 0);
    assert.equal(
      plan.queries.some((q) => /"AI agency"/i.test(q) && /"United States"/i.test(q)),
      false,
      "General prompts must not fall back to hardcoded US AI agency queries",
    );
    assert.ok(
      plan.queries.some((q) => /CTO/i.test(q) && /Berlin/i.test(q)),
      "Generated queries must incorporate active roles and location hubs",
    );

    const ukAiPlan = buildAgentBrainSearchPlan("AI agency and firm owner with hiring intent from the UK");
    assert.ok(
      ukAiPlan.queries.slice(0, 10).every((q) => /\bAI\b|artificial intelligence/i.test(q)),
      "AI agency queries must prioritize AI-aligned terms ahead of generic synonyms",
    );
  });

  it("buildAgentBrainSearchPlan preserves open_global when no geo is specified", () => {
    const plan = buildAgentBrainSearchPlan("Biotech founders building proteomics platforms");
    assert.equal(plan.isB2BOutbound, false);
    assert.equal(plan.geo.geo, "open_global");
    assert.equal(plan.locations.length, 0);
    assert.equal(
      plan.queries.some((q) => /"United States"/i.test(q)),
      false,
      "Zero default-invention rule must hold without invented US geo",
    );
  });

  it("discoveryEngine.finalizeExternalSession frees active count while retaining logs", () => {
    const sid = `agent-ext-${Date.now()}`;
    const baselineActive = discoveryEngine.getActiveCount();
    discoveryEngine.addLog(sid, "[AgentBrain:init] starting external run");
    assert.equal(discoveryEngine.isActive(sid), true);
    assert.equal(discoveryEngine.getActiveCount(), baselineActive + 1);
    assert.deepEqual(discoveryEngine.getLiveLogs(sid), [
      "[AgentBrain:init] starting external run",
    ]);

    discoveryEngine.finalizeExternalSession(sid);
    assert.equal(discoveryEngine.isActive(sid), false);
    assert.equal(discoveryEngine.getActiveCount(), baselineActive);
    assert.deepEqual(discoveryEngine.getLiveLogs(sid), [
      "[AgentBrain:init] starting external run",
    ]);
  });

  it("executeAgentBrainDiscovery qualifies non-B2B leads with grounded quotes and session-scoped verification", async () => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (!target.includes("tavily.com")) {
        throw new Error(`Unexpected external fetch to ${target}`);
      }
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Elena Weber - CTO at Nordbank Labs | LinkedIn",
              url: "https://www.linkedin.com/in/elena-weber-berlin-cto/",
              content:
                "CTO at Nordbank Labs in Berlin, Germany. Leading fintech infrastructure migration to Rust and distributed payment ledgers.",
            },
            {
              title: "Intern Applicant - Berlin | LinkedIn",
              url: "https://www.linkedin.com/in/berlin-intern-only/",
              content: "Software engineering intern based in Berlin learning Rust.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await executeAgentBrainDiscovery({
      sessionId: `agent-nonb2b-${Date.now()}`,
      promptQuery: "CTOs at fintech companies in Berlin using Rust",
      requestedLimit: 5,
      stage: "SCRAPED",
      enableBrightDataPro: false,
      decisionMakerRoles: ["CTO"],
      keywords: ["Rust", "fintech"],
      geographicHubs: ["Berlin"],
    });

    assert.equal(result.qualifiedCount, 1);
    assert.equal(result.leads[0]?.name, "Elena Weber");
    assert.equal(result.leads[0]?.title, "CTO");
    assert.equal(result.leads[0]?.company, "Nordbank Labs");
    assert.equal(result.verification.sqliteVerified, true);
    assert.equal(result.verification.ftsIndexed, true);
    assert.equal(result.verification.identityKeysRegistered, true);

    const stored = readStoredLeadById(result.leads[0].id);
    assert.ok(stored);
    assert.equal(hasGroundedQualification(stored), true);
    assert.equal(stored.tier, "TIER 1: PRIORITY");
    assert.equal(
      String(stored.notes || "").includes("[ungrounded-write]"),
      false,
      "Grounded quote must satisfy ADR-0015 without demotion boilerplate",
    );

    const activities = readLeadActivities(result.leads[0].id);
    assert.ok(activities.some((a) => a.actor === "agent_brain"));

    const sessionRow = readMiningSessionById(result.sessionId);
    assert.equal(sessionRow?.status, "success");

    const searchLogRow = getLeadsDb()
      .prepare(`SELECT raw_results_count, leads_found, detailed_logs FROM search_logs WHERE id = ?`)
      .get(result.sessionId) as { raw_results_count: number; leads_found: number; detailed_logs: string } | undefined;
    assert.ok(searchLogRow);
    assert.equal(searchLogRow.raw_results_count, 2);
    assert.equal(searchLogRow.leads_found, 1);
    assert.match(searchLogRow.detailed_logs, /AgentBrain/);
  });

  it("rejects Product Owner, Birmingham Alabama, and non-AI recruiters on UK AI agency briefs", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Helen Sample - Senior Product Owner at Opencast Software | LinkedIn",
              url: "https://www.linkedin.com/in/helen-sample-po-uk/",
              content: "Senior Product Owner at Opencast Software in Edinburgh, UK. AI agency experience and hiring.",
            },
            {
              title: "Scott Sample - Founder at Betterhire | LinkedIn",
              url: "https://www.linkedin.com/in/scott-sample-birmingham-al/",
              content: "Founder at Betterhire, an AI agency in Birmingham, Alabama, United States. We are hiring engineers.",
            },
            {
              title: "Sarah Sample - Owner at Sarah Recruitment | LinkedIn",
              url: "https://www.linkedin.com/in/sarah-sample-uk-recruit/",
              content: "Owner of Sarah Recruitment in Manchester, United Kingdom. Recruiting finance and sales teams.",
            },
            {
              title: "Oliver Grant - Founder at Albion AI Studio | LinkedIn",
              url: "https://www.linkedin.com/in/oliver-grant-albion-ai/",
              content: "Founder of Albion AI Studio, an AI automation agency in London, United Kingdom. We are hiring senior AI engineers.",
            },
            {
              title: "Maya Patel - Managing Director at Vertex AI & Automation | LinkedIn",
              url: "https://www.linkedin.com/in/maya-patel-vertex-uk/",
              content: "Managing Director at Vertex - Generative AI & automation consultancy in Manchester, UK. Growing our engineering team.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const result = await executeAgentBrainDiscovery({
      sessionId: `agent-uk-filter-${Date.now()}`,
      promptQuery: "AI agency and firm owner with hiring intent from the UK",
      requestedLimit: 5,
      stage: "SCRAPED",
      enableBrightDataPro: false,
    });

    assert.equal(result.qualifiedCount, 2);
    assert.equal(result.leads[0]?.name, "Oliver Grant");
    assert.equal(result.leads[1]?.name, "Maya Patel");
  });
});
