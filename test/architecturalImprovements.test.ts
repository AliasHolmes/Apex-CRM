import test from "node:test";
import assert from "node:assert/strict";
import { readExistingIdentityKeys, invalidateLeadsStatsCache, getLeadsDbMutationCounter } from "../server/db.js";
import { scoreAdaptiveArm } from "../server/leadSearch/adaptiveScheduler.js";
import { COUNTRY_TO_METROS, COUNTRY_CANONICAL_MAP, buildDeterministicProspectContract } from "../server/leadSearch/prospectContract.js";

test("Component 3: readExistingIdentityKeys returns defensive copy and caches until mutation counter increments", () => {
  const initialCounter = getLeadsDbMutationCounter();
  const keys1 = readExistingIdentityKeys();
  const keys2 = readExistingIdentityKeys();

  // Different object references (defensive clone)
  assert.notEqual(keys1, keys2);
  assert.deepEqual(Array.from(keys1).sort(), Array.from(keys2).sort());

  // Mutating keys1 does not affect keys2 or subsequent reads
  keys1.add("synthetic:test_mutation_leak");
  assert.equal(keys1.has("synthetic:test_mutation_leak"), true);
  assert.equal(keys2.has("synthetic:test_mutation_leak"), false);

  const keys3 = readExistingIdentityKeys();
  assert.equal(keys3.has("synthetic:test_mutation_leak"), false);

  // Invalidation clears cache and increments counter
  invalidateLeadsStatsCache();
  assert.equal(getLeadsDbMutationCounter(), initialCounter + 1);

  const keys4 = readExistingIdentityKeys();
  assert.equal(keys4.has("synthetic:test_mutation_leak"), false);
});

test("Component 4: scoreAdaptiveArm normalizes accumulated metrics by outcome_runs for alphaPost and betaPost", () => {
  const rowUnnormalizedExploded = {
    family: "persona_title",
    lane: "person",
    provider: "tavily",
    outcome_runs: 20,
    qualified_candidates: 40, // avg 2 per run
    returned_candidates: 20,  // avg 1 per run
    unique_candidates: 60,    // avg 3 per run
    rescued_candidates: 10,   // avg 0.5 per run
    duplicate_candidates: 20, // avg 1 per run
    provider_units: 40,       // avg 2 per run
    search_latency_ms: 20000, // avg 1s per run
  };

  const result = scoreAdaptiveArm(rowUnnormalizedExploded, 50, 1.25, false);

  // Per run:
  // qualified: 2 -> 2 * 2.5 = 5.0
  // returned: 1 -> 1 * 2.0 = 2.0
  // unique: 3 -> 3 * 0.04 = 0.12
  // alphaPrior = 1.0 -> expected alpha ~ 8.12
  // If unnormalized, alpha would be 1.0 + 40*2.5 + 20*2.0 + 60*0.04 = 143.4!
  assert.ok(result.alpha !== undefined && result.alpha < 15, `Expected alpha to be normalized (<15), but was ${result.alpha}`);
  assert.ok(result.alpha !== undefined && result.alpha > 7, `Expected alpha to reflect per-run quality (>7), but was ${result.alpha}`);

  // rescued: 0.5 -> 0.5 * 1.25 = 0.625
  // duplicates: 1.0 -> 1.0 * 0.08 = 0.08
  // providerUnits: 2.0 -> 2.0 * 0.12 = 0.24
  // latencySeconds: 1.0 -> 1.0 * 0.002 = 0.002
  // betaPrior = 1.0 -> expected beta ~ 1.947
  // If unnormalized, beta would be 1.0 + 10*1.25 + 20*0.08 + 40*0.12 + 20*0.002 = 19.94!
  assert.ok(result.beta !== undefined && result.beta < 5, `Expected beta to be normalized (<5), but was ${result.beta}`);
  assert.ok(result.beta !== undefined && result.beta > 1.5, `Expected beta to reflect per-run cost (>1.5), but was ${result.beta}`);
});

test("Component 2: COUNTRY_TO_METROS expanded for all specified international markets", () => {
  const expectedCountries = [
    "germany", "france", "netherlands", "ireland", "spain",
    "italy", "switzerland", "sweden", "singapore", "japan"
  ];

  for (const country of expectedCountries) {
    assert.ok(Array.isArray(COUNTRY_TO_METROS[country]), `Missing COUNTRY_TO_METROS for ${country}`);
    assert.ok(COUNTRY_TO_METROS[country].length > 0, `Empty metros for ${country}`);
  }

  assert.deepEqual(COUNTRY_TO_METROS["germany"], ["Berlin", "Munich", "Frankfurt", "Hamburg", "Cologne", "Stuttgart"]);
  assert.deepEqual(COUNTRY_TO_METROS["france"], ["Paris", "Lyon", "Marseille", "Toulouse", "Bordeaux"]);
  assert.deepEqual(COUNTRY_TO_METROS["netherlands"], ["Amsterdam", "Rotterdam", "Utrecht", "Eindhoven"]);
  assert.deepEqual(COUNTRY_TO_METROS["ireland"], ["Dublin", "Cork", "Galway"]);
  assert.deepEqual(COUNTRY_TO_METROS["spain"], ["Madrid", "Barcelona", "Valencia", "Seville"]);
  assert.deepEqual(COUNTRY_TO_METROS["italy"], ["Milan", "Rome", "Turin", "Bologna"]);
  assert.deepEqual(COUNTRY_TO_METROS["switzerland"], ["Zurich", "Geneva", "Basel", "Lausanne"]);
  assert.deepEqual(COUNTRY_TO_METROS["sweden"], ["Stockholm", "Gothenburg", "Malmo"]);
  assert.deepEqual(COUNTRY_TO_METROS["singapore"], ["Singapore"]);
  assert.deepEqual(COUNTRY_TO_METROS["japan"], ["Tokyo", "Osaka", "Yokohama"]);

  assert.equal(COUNTRY_CANONICAL_MAP["japan"], "Japan");

  // Demonyms check
  assert.deepEqual(COUNTRY_TO_METROS["german"], COUNTRY_TO_METROS["germany"]);
  assert.deepEqual(COUNTRY_TO_METROS["french"], COUNTRY_TO_METROS["france"]);
  assert.deepEqual(COUNTRY_TO_METROS["japanese"], COUNTRY_TO_METROS["japan"]);

  // Test international location acceptable terms expansion in deterministic contract
  const contractDE = buildDeterministicProspectContract("AI founders in Germany");
  const locReq = contractDE.requirements.find((r: any) => r.scope === "person_location");
  assert.ok(locReq, "Expected location requirement in contract");
  assert.ok(locReq.acceptableTerms.includes("Berlin"), "Expected Berlin in acceptableTerms");
  assert.ok(locReq.acceptableTerms.includes("Munich"), "Expected Munich in acceptableTerms");
  assert.ok(locReq.acceptableTerms.includes("Germany"), "Expected Germany in acceptableTerms");
});

test("Component 1: executeSelectStage processes qualifiedLeads and runs selectDiversifiedLeads", async () => {
  const { executeSelectStage } = await import("../server/leadSearch/stages/selectStage.js");
  const { buildFallbackSearchSpec } = await import("../server/leadSearch/searchSpec.js");
  const { buildDeterministicProspectContract } = await import("../server/leadSearch/prospectContract.js");

  const qualifiedLeads = [
    { id: "lead-1", fullName: "Alice Smith", currentCompany: "Alpha Tech", currentTitle: "CEO", score: 85, qualification: { verdict: "qualified", finalScore: 85 } },
    { id: "lead-2", fullName: "Bob Jones", profile: { currentCompany: "Beta AI", currentTitle: "Founder" }, score: 80, qualification: { verdict: "qualified", finalScore: 80 } },
    { id: "lead-3", fullName: "Charlie Brown", currentCompany: "Gamma Corp", currentTitle: "CTO", score: 75, qualification: { verdict: "qualified", finalScore: 75 } },
  ];

  const searchSpec = buildFallbackSearchSpec("CEO AI");
  searchSpec.maxPerCompany = 1;
  const contract = buildDeterministicProspectContract("CEO AI in USA");

  const mockCtx: any = {
    config: {
      targetLimit: 2,
      maxRounds: 3,
      linkedinPostIntentEnabled: false,
    },
    state: {
      qualifiedLeads: [...qualifiedLeads],
      abortController: new AbortController(),
    },
    ports: {
      brightDataSearch: async () => [],
      tavilySearch: async () => ({ items: [] }),
    },
    logEvent: () => {},
    recordTrace: () => {},
  };

  const statsObj: any = { queryRuns: [] };
  const output = await executeSelectStage(mockCtx, {
    contract,
    searchSpec,
    ttlDays: 7,
    stats: statsObj,
    leadQueryRuns: new Map(),
    trackableBrightDataSearch: async () => [],
    companyIntentEnabled: true,
    companyIntentMaxPerSearch: 3,
    companyIntentConcurrency: 1,
  });

  assert.equal(output.leadsFound, 2);
  assert.equal(output.finalLeads.length, 2);
  assert.equal(output.finalLeads[0].id, "lead-1");
  assert.equal(output.finalLeads[1].id, "lead-2");
  assert.ok(statsObj.companyIntent, "Expected stats.companyIntent to be populated");
});

test("Component 6: Early shortlist termination logic calculates unique company diversity correctly", () => {
  const targetLimit = 10;
  const minCompanyDiversity = Math.ceil(targetLimit * 0.8); // 8

  const qualifiedLeads = [
    { currentCompany: "Acme 1", qualification: { verdict: "qualified" } },
    { profile: { currentCompany: "Acme 2" }, qualification: { verdict: "qualified" } },
    { companyName: "Acme 3", qualification: { verdict: "qualified" } },
    { currentCompany: "Acme 4", qualification: { verdict: "qualified" } },
    { currentCompany: "Acme 5", qualification: { verdict: "qualified" } },
    { currentCompany: "Acme 6", qualification: { verdict: "qualified" } },
    { currentCompany: "Acme 7", qualification: { verdict: "qualified" } },
    { currentCompany: "Acme 8", qualification: { verdict: "qualified" } },
    { currentCompany: "Acme 8", qualification: { verdict: "qualified" } }, // Duplicate company
    { currentCompany: "Acme 9", qualification: { verdict: "qualified" } },
  ];

  const roundEndEffectiveQualified = qualifiedLeads.reduce((acc, lead: any) => {
    if (lead.qualification?.verdict === "qualified") return acc + 1;
    if (lead.qualification?.verdict === "qualified_partial") return acc + 0.75;
    return acc;
  }, 0);

  const uniqueCompanies = new Set(
    qualifiedLeads
      .filter(
        (l: any) =>
          l.qualification?.verdict === "qualified" ||
          l.qualification?.verdict === "qualified_partial",
      )
      .map((l: any) =>
        String(l.currentCompany || l.company || l.profile?.currentCompany || l.companyName || "").trim().toLowerCase(),
      )
      .filter(Boolean),
  ).size;

  assert.equal(roundEndEffectiveQualified, 10);
  assert.equal(uniqueCompanies, 9);
  assert.ok(uniqueCompanies >= minCompanyDiversity); // 9 >= 8 -> triggers early stop!
});

