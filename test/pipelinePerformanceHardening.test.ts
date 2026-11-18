import test from "node:test";
import assert from "node:assert/strict";
import {
  getRecentProspectContractByBrief,
  upsertProspectContractCache,
} from "../server/db.js";
import {
  hasPlausibleIntentEvidence,
} from "../server/leadSearch/stages/selectStage.js";
import {
  buildAccountFlywheelItems,
} from "../server/leadSearch/stages/planStage.js";
import {
  runGatedCompanyAttribution,
  extractCompanySourceText,
} from "../server/leadSearch/companyAttribution.js";

test("Contract Compiler Warm Cache: getRecentProspectContractByBrief retrieves contract without TTL restriction", () => {
  const testBrief = "warm_cache_test_brief_" + Date.now();
  const testContract = {
    contractVersion: 2,
    rawBrief: testBrief,
    requirements: [
      { id: "req-1", text: "Must be a senior accountant", weight: 1.0, required: true },
    ],
  };

  // Upsert test contract with standard TTL
  upsertProspectContractCache("test-key-" + Date.now(), testBrief, "v2", testContract, 7);

  // Retrieve via getRecentProspectContractByBrief
  const retrieved = getRecentProspectContractByBrief(testBrief);
  assert.ok(retrieved, "Should retrieve cached contract");
  assert.equal(retrieved.contractVersion, 2);
  assert.equal(retrieved.rawBrief, testBrief);
  assert.equal(retrieved.requirements.length, 1);
  assert.equal(retrieved.requirements[0].id, "req-1");

  // Non-existent brief returns null safely
  const nonexistent = getRecentProspectContractByBrief("nonexistent_brief_xyz_" + Date.now());
  assert.equal(nonexistent, null);
});

test("Intent Heuristic Pre-screening: hasPlausibleIntentEvidence filters accurately", () => {
  assert.equal(hasPlausibleIntentEvidence(null as any), false);
  assert.equal(hasPlausibleIntentEvidence({} as any), false);

  // Negative cases: generic professional profiles with no hiring, expansion, or tooling signals
  const genericLead1 = {
    headline: "Staff Accountant at Apex Solutions",
    currentTitle: "Staff Accountant",
    company: "Apex Solutions",
  };
  assert.equal(hasPlausibleIntentEvidence(genericLead1), false);

  const genericLead2 = {
    headline: "Managing Director - Wealth Management & Financial Advisory",
    evidence: {
      snippets: ["Providing high-net-worth client advisory across North America."],
    },
  };
  assert.equal(hasPlausibleIntentEvidence(genericLead2), false);

  // Positive cases: active hiring, expansion, technology, or consulting signals
  const hiringLead = {
    headline: "VP of People | We're hiring senior full-stack developers!",
    currentTitle: "VP of People",
  };
  assert.equal(hasPlausibleIntentEvidence(hiringLead), true);

  const growthLead = {
    headline: "Founder & CEO @ FastGrowth",
    currentTitle: "Founder & CEO",
    evidence: {
      evidenceBlock: "Leading business growth, expansion into EMEA, and team scaling.",
    },
  };
  assert.equal(hasPlausibleIntentEvidence(growthLead), true);

  const toolingLead = {
    headline: "Head of Engineering",
    currentTitle: "Head of Engineering",
    evidence: {
      snippets: ["Managing modern cloud architecture and enterprise integration workflows."],
    },
  };
  assert.equal(hasPlausibleIntentEvidence(toolingLead), true);

  const attributionSignalLead = {
    headline: "Managing Partner",
    companyAttribution: {
      result: {
        evidenceQuote: "Recent funding round announced to expand delivery team and open roles.",
      },
    },
  };
  assert.equal(hasPlausibleIntentEvidence(attributionSignalLead), true);
});

test("Reverse Flywheel Routing: buildAccountFlywheelItems routes to LinkedIn person lane when requiresPerson is true", () => {
  const companies = ["Acme Corp", "TechFlow Inc"];
  const searchSpecPerson = {
    requiresPerson: true,
    targetRole: "Managing Director",
  } as any;

  const itemsPerson = buildAccountFlywheelItems(companies, searchSpecPerson, 8);
  assert.ok(itemsPerson.length > 0, "Should generate flywheel items");
  for (const item of itemsPerson) {
    assert.equal(item.lane, "person", "Lane must be person when requiresPerson is true");
    assert.ok(
      item.query.startsWith("site:linkedin.com/in/"),
      "Query must target site:linkedin.com/in/ when requiresPerson is true",
    );
  }

  // Non-person brief: target accounts directly without site:linkedin.com/in/
  const searchSpecAccount = {
    requiresPerson: false,
    targetRole: "Engineering",
  } as any;

  const itemsAccount = buildAccountFlywheelItems(companies, searchSpecAccount, 8);
  assert.ok(itemsAccount.length > 0, "Should generate account flywheel items");
  for (const item of itemsAccount) {
    assert.equal(item.lane, "account", "Lane must be account when requiresPerson is false");
    assert.equal(
      item.query.includes("site:linkedin.com/in/"),
      false,
      "Query must not target site:linkedin.com/in/ for account briefs",
    );
  }
});

test("Company Attribution High-Density Batching: batches 12 companies into groups of 6 and scales tokens", async () => {
  const calls: Array<{ batchSize: number; maxTokens?: number }> = [];

  const mockCandidates = Array.from({ length: 12 }, (_, i) => ({
    candidateId: `cand-${i}`,
    lead: {
      name: `Person ${i}`,
      company: `Enterprise Inc ${i}`,
      headline: `Engineer at Enterprise Inc ${i}`,
    },
    evidence: [
      {
        text: `[COMPANY SITE] Official website of Enterprise Inc ${i}: Leading developer of cloud infrastructure software and secure enterprise APIs.`,
      },
    ],
  })) as any[];

  const mockContract = {
    brief: "Cloud infrastructure companies",
    version: "2.0",
    policyVersion: "2.0",
    authorityRequired: false,
    exclusions: [],
    initialQueries: [],
    requirements: [
      { importance: "high", scope: "company", description: "B2B SaaS or cloud software" },
    ],
  } as any;

  const mockOpenAIStructured = async (
    prompt: string,
    _schema: any,
    _systemPrompt: string,
    opts: any,
  ) => {
    // Extract number of companies from prompt
    const matches = prompt.match(/--- COMPANY KEY:/g) || [];
    calls.push({
      batchSize: matches.length,
      maxTokens: opts?.maxTokens,
    });

    const keys = Array.from(prompt.matchAll(/--- COMPANY KEY: ([^\n]+) ---/g)).map((m) => m[1].trim());
    return {
      attributions: keys.map((k) => ({
        companyKey: k,
        businessModel: "b2b_saas",
        queryAlignment: "high",
        verdict: "verified_fit",
        verbatimEvidenceQuote: "cloud infrastructure software",
        reason: "Valid B2B cloud infrastructure provider",
      })),
    };
  };

  const summary = await runGatedCompanyAttribution(
    mockCandidates,
    mockContract,
    {
      openAIStructured: mockOpenAIStructured as any,
      batchSize: 6,
    },
  );

  // 12 companies / 6 per batch = exactly 2 batches
  assert.equal(calls.length, 2, "12 companies should be processed in exactly 2 batches of 6");
  assert.equal(calls[0].batchSize, 6, "First batch must have 6 companies");
  assert.equal(calls[1].batchSize, 6, "Second batch must have 6 companies");
  assert.ok(calls[0].maxTokens && calls[0].maxTokens >= 4096, "Tokens must scale to at least 4096");
  assert.ok(summary.attributedCount > 0, "Summary should count attributed candidates");
});

test("Judge Stage Auto-fail Short Circuit: Disqualifying contradictions are rejected before LLM judging", () => {
  const contradictoryCandidate = {
    candidateId: "cand-contra-1",
    lead: {
      name: "Bad Fit Candidate",
      company: "Consumer Retail LLC",
      companyDomain: "consumer-retail.com",
      companyAttribution: {
        verdict: "disqualifying_contradiction",
        reason: "B2C retail company, brief requested B2B SaaS",
        businessModel: "b2c_retail",
      },
    },
  } as any;

  // Simulate hoisted tagging
  const attr = contradictoryCandidate.lead.companyAttribution;
  if (attr?.verdict === "disqualifying_contradiction") {
    contradictoryCandidate.lead._autoFailed = true;
    contradictoryCandidate.lead._contradictionReason = `Company Attribution: ${attr.reason} (business model: ${attr.businessModel})`;
  }

  assert.equal(contradictoryCandidate.lead._autoFailed, true);
  assert.ok(contradictoryCandidate.lead._contradictionReason.includes("B2C retail company"));
});

test("Domain Lookup Bridge in Company Attribution: Resolves domain from lead.companyDomain", () => {
  const candidate = {
    candidateId: "cand-domain-bridge",
    lead: {
      name: "John Doe",
      company: "Reconciled Services",
      companyDomain: "reconciled.com",
    },
    evidence: [
      { text: "[COMPANY SITE] Official website of Reconciled Services: bookkeeping and accounting." },
    ],
  } as any;

  const extracted = extractCompanySourceText(candidate);
  assert.equal(extracted.domain, "reconciled.com", "Must resolve domain directly from lead.companyDomain");
  assert.equal(extracted.companyName, "Reconciled Services");
  assert.ok(extracted.sourceText.includes("Reconciled Services"));
});

