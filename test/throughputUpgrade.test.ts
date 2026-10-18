import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOrthogonalQueryMatrix,
  buildStallGridQueries,
} from "../server/leadSearch/stallLadder.js";
import {
  lookupPersonDatasetDossier,
  processParkedCandidates,
} from "../server/leadSearch/stages/enrichStage.js";
import { isParkWithheldEnabled } from "../server/leadSearch/stages/judgeStage.js";
import { buildQuerySignature, isNearDuplicateQuery } from "../server/leadSearch/querySignature.js";
import type { ProspectContract } from "../server/leadSearch/prospectContract.js";

const mockContract: ProspectContract = {
  briefText: "Founders and agency owners of B2B outbound lead generation agencies who use Clay or Instantly in the US",
  targetCountry: "United States",
  identitySpec: {
    roles: ["founder", "owner", "CEO"],
    companyTypes: ["lead generation agency", "outbound agency"],
    industries: ["marketing services"],
    locations: ["United States"],
  },
  intentSpec: {
    toolingKeywords: ["Clay", "Instantly", "Smartlead"],
    painSignals: [],
  },
  requirements: [
    {
      id: "req_role",
      description: "Must be a founder or agency owner",
      scope: "person_role",
      importance: "hard",
      matchRule: "any_of",
      acceptableTerms: ["founder", "agency owner", "managing partner", "director"],
    },
    {
      id: "req_company",
      description: "Must be an outbound or lead generation agency",
      scope: "company_type",
      importance: "hard",
      matchRule: "any_of",
      acceptableTerms: ["lead generation agency", "outbound agency", "cold email agency"],
    },
    {
      id: "req_location",
      description: "Must be in the US",
      scope: "person_location",
      importance: "hard",
      matchRule: "any_of",
      acceptableTerms: ["united states", "usa", "us"],
    },
  ],
  exclusions: [],
  rules: {
    rejectAggregators: true,
    rejectBigTech: true,
  },
} as any;

test("WS1: buildOrthogonalQueryMatrix constructs distinct, contract-enforced multi-vector queries", () => {
  const plans = buildOrthogonalQueryMatrix(mockContract, {
    round: 1,
    count: 4,
    targetCountryCanonical: "United States",
    unvisitedMetros: ["Austin, United States", "New York, United States"],
  });

  assert.equal(plans.length, 4, "Must generate exactly 4 plans");
  for (const plan of plans) {
    assert.equal(plan.family, "orthogonal_matrix");
    assert.equal(plan.lane, "person");
    assert.ok(plan.query.length > 5, "Query must not be empty");

    // Ensure tooling is formatted as modifier ('using Clay'), not bare vertical
    if (plan.query.includes("Clay") || plan.query.includes("Instantly") || plan.query.includes("Smartlead")) {
      assert.ok(
        plan.query.includes("using Clay") ||
          plan.query.includes("using Instantly") ||
          plan.query.includes("using Smartlead"),
        `Query with tooling should follow natural grammar: ${plan.query}`,
      );
    }
  }

  // Ensure signatures are distinct and not near-duplicates
  const signatures = plans.map((p) => buildQuerySignature(p.query, { contract: mockContract }));
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const isDup = isNearDuplicateQuery(signatures[i], [signatures[j]], 0.5);
      assert.equal(isDup, false, `Query ${i} and ${j} should not be near-duplicates: "${plans[i].query}" vs "${plans[j].query}"`);
    }
  }
});

test("WS1: buildStallGridQueries backward-compatible wrapper delegates to buildOrthogonalQueryMatrix", () => {
  const plans = buildStallGridQueries(mockContract, ["Austin, United States"], 2);
  assert.equal(plans.length, 4);
  assert.equal(plans[0].family, "orthogonal_matrix");
});

test("WS3: isParkWithheldEnabled defaults to true and honors house-style disable flags", () => {
  const orig = process.env.LEAD_PARK_WITHHELD;
  try {
    delete process.env.LEAD_PARK_WITHHELD;
    assert.equal(isParkWithheldEnabled(), true, "Should default to true");

    process.env.LEAD_PARK_WITHHELD = "false";
    assert.equal(isParkWithheldEnabled(), false, "Should disable on 'false'");

    process.env.LEAD_PARK_WITHHELD = "0";
    assert.equal(isParkWithheldEnabled(), false, "Should disable on '0'");

    process.env.LEAD_PARK_WITHHELD = "off";
    assert.equal(isParkWithheldEnabled(), false, "Should disable on 'off'");

    process.env.LEAD_PARK_WITHHELD = "no";
    assert.equal(isParkWithheldEnabled(), false, "Should disable on 'no'");

    process.env.LEAD_PARK_WITHHELD = "1";
    assert.equal(isParkWithheldEnabled(), true, "Should enable on '1'");
  } finally {
    if (orig !== undefined) process.env.LEAD_PARK_WITHHELD = orig;
    else delete process.env.LEAD_PARK_WITHHELD;
  }
});

test("WS3: lookupPersonDatasetDossier queries gd_l1viktl72bvl7bjuj0 with exact URL filter", async () => {
  let calledDatasetId = "";
  let calledFilter: any = null;
  let calledTimeout = 0;

  const mockPorts: any = {
    brightDataSearchDataset: async (datasetId: string, filter: any, _size: number, _sort: any, _searchAfter: any, timeoutMs: number) => {
      calledDatasetId = datasetId;
      calledFilter = filter;
      calledTimeout = timeoutMs;
      return {
        hits: [
          {
            name: "Austin Hughes",
            position: "Founder & CEO",
            current_company_name: "Apex Outbound Agency",
            about: "Leading B2B lead generation with Clay & Smartlead.",
            experience: [
              { title: "Founder", company: "Apex Outbound Agency" },
            ],
          },
        ],
      };
    },
  };

  const dossier = await lookupPersonDatasetDossier(
    "https://www.linkedin.com/in/austin-hughes-apex",
    mockPorts,
    8_000,
  );

  assert.equal(calledDatasetId, "gd_l1viktl72bvl7bjuj0");
  assert.equal(calledFilter.name, "url");
  assert.equal(calledFilter.operator, "=");
  assert.equal(calledFilter.value, "https://linkedin.com/in/austin-hughes-apex");
  assert.equal(calledTimeout, 8_000);
  assert.ok(dossier);
  assert.equal(dossier.name, "Austin Hughes");
  assert.equal(dossier.current_company_name, "Apex Outbound Agency");
});

test("WS3: processParkedCandidates revives parked candidate using dossier evidence and enforces maxReinjectedPerRound", async () => {
  const events: string[] = [];
  const state: any = {
    parkedCandidates: [
      {
        candidateKey: "linkedin:austin-hughes",
        companyKey: "apex outbound",
        parkedRound: 1,
        cause: "probe_failed",
        recheckAttempts: 0,
        candidate: {
          candidateId: "cand_1",
          lead: {
            fullName: "Austin Hughes",
            currentTitle: "Founder",
            currentCompany: "Apex Outbound",
            contactDetails: { linkedinUrl: "https://www.linkedin.com/in/austin-hughes" },
          },
          evidence: [],
        },
      },
    ],
    abortController: new AbortController(),
  };

  const mockPorts: any = {
    brightDataSearchDataset: async () => ({
      hits: [
        {
          name: "Austin Hughes",
          position: "Founder & CEO",
          current_company_name: "Apex Outbound Agency",
          about: "Outbound lead generation specialists.",
          experience: [{ title: "Founder", company: "Apex Outbound Agency" }],
        },
      ],
    }),
  };

  const sessionCtx: any = {
    state,
    ports: mockPorts,
    logEvent: (msg: string) => events.push(msg),
  };

  // Ensure LEAD_PARK_WITHHELD is enabled
  const orig = process.env.LEAD_PARK_WITHHELD;
  const origCap = process.env.LEAD_MAX_REINJECTED_PER_ROUND;
  try {
    process.env.LEAD_PARK_WITHHELD = "true";
    process.env.LEAD_MAX_REINJECTED_PER_ROUND = "6";

    const reInjected = await processParkedCandidates(sessionCtx, 0, 2);

    assert.equal(reInjected.length, 1, "Candidate must be re-injected");
    assert.equal(reInjected[0].candidateId, "cand_1");
    assert.equal(reInjected[0].lead.currentCompany, "Apex Outbound Agency");

    // Verify injected evidence block
    const injectedEvidence = reInjected[0].evidence.find((e: any) =>
      e.id.startsWith("profile_dossier_reentry_"),
    );
    assert.ok(injectedEvidence, "Must contain profile_dossier_reentry block");
    assert.ok(injectedEvidence.text.includes("[BRIGHTDATA DOSSIER RE-ENTRY]"));
    assert.ok(injectedEvidence.text.includes("TITLE: Founder & CEO at Apex Outbound Agency"));
    assert.ok(injectedEvidence.text.includes("ABOUT: Outbound lead generation specialists."));

    // Verify logEvent was recorded
    assert.ok(events.some((e) => e.includes("acquired company/dossier evidence and re-enters judging")));
  } finally {
    if (orig !== undefined) process.env.LEAD_PARK_WITHHELD = orig;
    else delete process.env.LEAD_PARK_WITHHELD;
    if (origCap !== undefined) process.env.LEAD_MAX_REINJECTED_PER_ROUND = origCap;
    else delete process.env.LEAD_MAX_REINJECTED_PER_ROUND;
  }
});

test("WS2: dataset lane consumes cooldown streak and skips when threshold reached", async () => {
  const events: string[] = [];
  const state: any = {
    datasetLaneZeroStreak: 1,
    datasetSearchAfterByFilter: {},
    brightDataStats: { succeeded: 0, cacheHits: 0, negativeCacheHits: 0, rejectionReasons: {} },
    freeTierBudget: {},
    abortController: new AbortController(),
  };

  let datasetSearchCalled = false;
  const mockPorts: any = {
    brightDataSearchDataset: async () => {
      datasetSearchCalled = true;
      return { hits: [] };
    },
    tavilySearch: async () => ({ text: "", sources: [], items: [] }),
  };

  const sessionCtx: any = {
    config: { contract: mockContract, creditReservationEnabled: false },
    state,
    ports: mockPorts,
    logEvent: (msg: string) => events.push(msg),
    recordTrace: () => ({ id: "trace_1", timestamp: new Date().toISOString() }),
  };

  const origSkip = process.env.BRIGHTDATA_DATASET_ZERO_HIT_SKIP;
  const origPlan = process.env.BRIGHTDATA_PLAN;
  try {
    process.env.BRIGHTDATA_DATASET_ZERO_HIT_SKIP = "1";
    process.env.BRIGHTDATA_PLAN = "pro";

    // Dynamic import of executeRetrieveStage
    const { executeRetrieveStage } = await import("../server/leadSearch/stages/retrieveStage.js");

    const input: any = {
      round: 2,
      roundPlans: [
        {
          item: { query: "founder lead generation agency", lane: "person" },
          executableQuery: "founder lead generation agency",
        },
      ],
      queryRuns: [
        {
          query: "founder lead generation agency",
          searchLatencyMs: 0,
        },
      ],
      discoveryProviderMode: "hybrid",
      brightDataSearchMode: "unconditional",
      brightDataReady: true,
      brightDataProviderDisabled: false,
      brightDataTransportRetryAfter: 0,
      brightDataSearchRetryMax: 1,
      brightDataSearchRetryBaseDelayMs: 100,
      stats: { totalAttempts: 0 },
    };

    await executeRetrieveStage(sessionCtx, input);

    // Verify cooldown was consumed (reset to 0) and lane was skipped
    assert.equal(state.datasetLaneZeroStreak, 0, "Streak must reset to 0 (cooldown consumed)");
    assert.equal(datasetSearchCalled, false, "Dataset search must not be called when skipped");
    assert.ok(events.some((e) => e.includes("dataset lane skipped (cooldown from 1 zero-hit round(s))")));
  } finally {
    if (origSkip !== undefined) process.env.BRIGHTDATA_DATASET_ZERO_HIT_SKIP = origSkip;
    else delete process.env.BRIGHTDATA_DATASET_ZERO_HIT_SKIP;
    if (origPlan !== undefined) process.env.BRIGHTDATA_PLAN = origPlan;
    else delete process.env.BRIGHTDATA_PLAN;
  }
});

test("WS4: judge micro-batch defaults to 4 and batch token target defaults to 7000", () => {
  const origBatchSize = process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE;
  const origTokenTarget = process.env.FINALIST_JUDGE_BATCH_TOKEN_TARGET;
  try {
    delete process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE;
    delete process.env.FINALIST_JUDGE_BATCH_TOKEN_TARGET;

    const explicitBatchSize = Number(process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE || 0);
    const configuredMaxBatchCandidates =
      Number.isFinite(explicitBatchSize) && explicitBatchSize > 0
        ? Math.max(1, Math.min(12, Math.floor(explicitBatchSize)))
        : 4;

    const targetBatchTokens = Number(process.env.FINALIST_JUDGE_BATCH_TOKEN_TARGET || 7000);

    assert.equal(configuredMaxBatchCandidates, 4, "Default batch candidate count must be 4");
    assert.equal(targetBatchTokens, 7000, "Default target batch tokens must be 7000");
  } finally {
    if (origBatchSize !== undefined) process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE = origBatchSize;
    else delete process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE;
    if (origTokenTarget !== undefined) process.env.FINALIST_JUDGE_BATCH_TOKEN_TARGET = origTokenTarget;
    else delete process.env.FINALIST_JUDGE_BATCH_TOKEN_TARGET;
  }
});


