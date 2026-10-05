import test from "node:test";
import assert from "node:assert/strict";
import {
  computePersonaStrength,
  processParkedCandidates,
  toHostKey,
} from "../server/leadSearch/stages/enrichStage.js";
import {
  shouldParkWithheldCandidate,
  parkCandidate,
} from "../server/leadSearch/stages/judgeStage.js";
import {
  matchLookupResultToCompany,
  isHostExcluded,
} from "../server/leadSearch/companyDomainLookup.js";
import type { ProspectContract } from "../server/leadSearch/prospectContract.js";
import type { FinalistCandidate, Qualification } from "../server/leadSearch/finalistJudge.js";
import type { PipelineSessionState } from "../server/leadSearch/pipelineTypes.js";
import { enforceCheckpointByteBudget } from "../server/db.js";

const sampleContract: ProspectContract = {
  policyVersion: "2026-09-01",
  version: 1,
  brief: "AI consultancies in New Zealand",
  authorityRequired: true,
  exclusions: [],
  initialQueries: [],
  requirements: [
    {
      id: "req_role",
      scope: "person_role",
      importance: "hard",
      evidenceModality: "structured_profile",
      description: "Managing Director, Founder, or Owner",
      sourcePhrase: "founder or owner",
      acceptableTerms: ["founder", "co-founder", "owner", "managing director", "ceo"],
      queryable: true,
    },
    {
      id: "req_loc",
      scope: "person_location",
      importance: "hard",
      evidenceModality: "structured_profile",
      description: "Based in New Zealand",
      sourcePhrase: "in New Zealand",
      acceptableTerms: ["new zealand", "auckland", "wellington", "christchurch"],
      queryable: true,
    },
    {
      id: "req_company",
      scope: "company_type",
      importance: "hard",
      evidenceModality: "open_web_signal",
      description: "Consultancy or agency business model",
      sourcePhrase: "consultancy or agency",
      acceptableTerms: ["consultancy", "agency", "consulting firm"],
      queryable: true,
    },
  ],
};

test("computePersonaStrength: scores persona match accurately", () => {
  // Case 1: Both role and location match (+2 + 1 = 3)
  const lead1 = {
    currentTitle: "Co-Founder & CEO",
    location: "Auckland, New Zealand",
  };
  assert.equal(computePersonaStrength(lead1, sampleContract), 3);

  // Case 2: Role only matches (+2)
  const lead2 = {
    currentTitle: "Managing Director",
    location: "Sydney, Australia",
  };
  assert.equal(computePersonaStrength(lead2, sampleContract), 2);

  // Case 3: Location only matches (+1)
  const lead3 = {
    currentTitle: "Software Developer",
    location: "Wellington, New Zealand",
  };
  assert.equal(computePersonaStrength(lead3, sampleContract), 1);

  // Case 4: Neither matches (0)
  const lead4 = {
    currentTitle: "Student Intern",
    location: "Chicago, IL, USA",
  };
  assert.equal(computePersonaStrength(lead4, sampleContract), 0);
});

test("Probe ordering: sorts highValue desc then personaStrength desc", () => {
  const targets = [
    {
      lead: { currentTitle: "Junior Developer", location: "USA" }, // strength 0
      highValue: false,
    },
    {
      lead: { currentTitle: "Founder & CEO", location: "Auckland, New Zealand" }, // strength 3
      highValue: false,
    },
    {
      lead: { currentTitle: "Managing Director", location: "Sydney, Australia" }, // strength 2
      highValue: true,
    },
    {
      lead: { currentTitle: "Founder", location: "Christchurch, New Zealand" }, // strength 3
      highValue: true,
    },
  ];

  const sorted = [...targets].sort((a, b) => {
    const highValDiff = (b.highValue ? 1 : 0) - (a.highValue ? 1 : 0);
    if (highValDiff !== 0) return highValDiff;
    return (
      computePersonaStrength(b.lead, sampleContract) -
      computePersonaStrength(a.lead, sampleContract)
    );
  });

  // Top 1: highValue + strength 3
  assert.equal(sorted[0].lead.currentTitle, "Founder");
  // Top 2: highValue + strength 2
  assert.equal(sorted[1].lead.currentTitle, "Managing Director");
  // Top 3: non-highValue + strength 3
  assert.equal(sorted[2].lead.currentTitle, "Founder & CEO");
  // Top 4: non-highValue + strength 0
  assert.equal(sorted[3].lead.currentTitle, "Junior Developer");
});

test("toHostKey: extracts normalized host without www", () => {
  assert.equal(toHostKey("https://www.example.com/about"), "example.com");
  assert.equal(toHostKey("http://agency.co.nz/"), "agency.co.nz");
  assert.equal(toHostKey("subdomain.company.com"), "subdomain.company.com");
});

test("companyDomainLookup: host exclusions and matching", () => {
  // Excluded hosts
  assert.equal(isHostExcluded("linkedin.com"), true);
  assert.equal(isHostExcluded("www.clutch.co"), true);
  assert.equal(isHostExcluded("wikipedia.org"), true);
  assert.equal(isHostExcluded("agency.co.nz"), false);

  // Strong company match: exact slug in host
  const match1 = matchLookupResultToCompany(
    { uri: "https://www.abley.com/about", title: "About Us - Abley Transportation Consultants" },
    "Abley",
  );
  assert.ok(match1);
  assert.equal(match1.host, "abley.com");

  // Rejection: directory site
  const match2 = matchLookupResultToCompany(
    { uri: "https://www.clutch.co/profile/abley", title: "Abley on Clutch" },
    "Abley",
  );
  assert.equal(match2, null);

  // Rejection: unrelated host
  const match3 = matchLookupResultToCompany(
    { uri: "https://www.techcrunch.com/article-about-startups", title: "Startups to watch" },
    "Abley",
  );
  assert.equal(match3, null);
});

test("shouldParkWithheldCandidate: correctly identifies candidates to park", () => {
  // Scenario 1: Solely unproven company_type + passed person_role -> PARK (true)
  const lead1 = { fullName: "Alice Smith", currentCompany: "Apex AI" };
  const qual1: Pick<Qualification, "requirements"> = {
    requirements: [
      { requirementId: "req_role", status: "pass" },
      { requirementId: "req_loc", status: "pass" },
      { requirementId: "req_company", status: "unknown" }, // unproven
    ],
  };
  assert.equal(shouldParkWithheldCandidate(lead1, qual1, sampleContract), true);

  // Scenario 2: Contradicted company_type (failed) -> DO NOT PARK (false)
  const qual2: Pick<Qualification, "requirements"> = {
    requirements: [
      { requirementId: "req_role", status: "pass" },
      { requirementId: "req_loc", status: "pass" },
      { requirementId: "req_company", status: "fail" }, // explicitly contradicted
    ],
  };
  assert.equal(shouldParkWithheldCandidate(lead1, qual2, sampleContract), false);

  // Scenario 3: Failed person_role -> DO NOT PARK (false)
  const qual3: Pick<Qualification, "requirements"> = {
    requirements: [
      { requirementId: "req_role", status: "fail" }, // role failed
      { requirementId: "req_loc", status: "pass" },
      { requirementId: "req_company", status: "unknown" },
    ],
  };
  assert.equal(shouldParkWithheldCandidate(lead1, qual3, sampleContract), false);

  // Scenario 4: Proven company_type (pass) -> DO NOT PARK (false, candidate should be admitted)
  const qual4: Pick<Qualification, "requirements"> = {
    requirements: [
      { requirementId: "req_role", status: "pass" },
      { requirementId: "req_loc", status: "pass" },
      { requirementId: "req_company", status: "pass" },
    ],
  };
  assert.equal(shouldParkWithheldCandidate(lead1, qual4, sampleContract), false);

  // Scenario 5: Attribution contradicts brief -> DO NOT PARK (false)
  const leadContradicted = {
    fullName: "Bob Jones",
    companyAttribution: { queryAlignment: "contradicts_brief" },
  };
  assert.equal(shouldParkWithheldCandidate(leadContradicted, qual1, sampleContract), false);
});

test("parkCandidate: deduplication and capacity (cap 20 FIFO eviction)", () => {
  const state: Partial<PipelineSessionState> = {
    parkedCandidates: [],
  };

  // Add first candidate
  const cand1: FinalistCandidate = {
    candidateId: "c1",
    lead: { contactDetails: { linkedinUrl: "https://linkedin.com/in/alice" }, currentCompany: "Apex" },
    evidence: [{ id: "e1", text: "snippet 1" }],
  };
  const added1 = parkCandidate(state, cand1, 1);
  assert.equal(added1, true);
  assert.equal(state.parkedCandidates!.length, 1);

  // Deduplication: cannot add cand1 again
  const addedDuplicate = parkCandidate(state, cand1, 1);
  assert.equal(addedDuplicate, false);
  assert.equal(state.parkedCandidates!.length, 1);

  // Fill up to cap (20)
  for (let i = 2; i <= 20; i++) {
    const cand: FinalistCandidate = {
      candidateId: `c${i}`,
      lead: { contactDetails: { linkedinUrl: `https://linkedin.com/in/user${i}` }, currentCompany: `Co${i}` },
      evidence: [],
    };
    parkCandidate(state, cand, 1);
  }
  assert.equal(state.parkedCandidates!.length, 20);
  assert.equal(state.parkedCandidates![0].candidateKey, "https://linkedin.com/in/alice");

  // Add 21st candidate: evicts oldest (alice)
  const cand21: FinalistCandidate = {
    candidateId: "c21",
    lead: { contactDetails: { linkedinUrl: "https://linkedin.com/in/user21" }, currentCompany: "Co21" },
    evidence: [],
  };
  parkCandidate(state, cand21, 2);
  assert.equal(state.parkedCandidates!.length, 20);
  assert.equal(state.parkedCandidates![0].candidateKey, "https://linkedin.com/in/user2");
  assert.equal(state.parkedCandidates![19].candidateKey, "https://linkedin.com/in/user21");
});

test("processParkedCandidates: drops candidate after 3 failed re-checks", async () => {
  const prevEnv = process.env.LEAD_PARK_WITHHELD;
  process.env.LEAD_PARK_WITHHELD = "true";

  try {
    const state: any = {
      parkedCandidates: [
        {
          candidateKey: "https://linkedin.com/in/test",
          companyKey: "unknownco",
          parkedRound: 1,
          cause: "no_domain",
          recheckAttempts: 2, // 2 prior failed attempts
          candidate: {
            candidateId: "c_test",
            lead: { currentCompany: "Unknown Co" },
            evidence: [],
          },
        },
      ],
      abortController: new AbortController(),
      freeTierBudget: {
        reserveTavilySearch: () => false,
      },
    };

    const ctx: any = {
      state,
      logEvent: () => {},
      ports: {
        tavilySearch: async () => ({ items: [], sources: [] }),
      },
    };

    // 3rd attempt will fail because no domain and no Tavily search budget
    const reinjected = await processParkedCandidates(ctx, 0, 3);
    assert.equal(reinjected.length, 0);
    // Should be dropped after 3rd failure
    assert.equal(state.parkedCandidates.length, 0);
  } finally {
    process.env.LEAD_PARK_WITHHELD = prevEnv;
  }
});

test("Checkpoint persistence: round-trips parkedCandidates cleanly", () => {
  const state: Partial<PipelineSessionState> = {
    parkedCandidates: [
      {
        candidateKey: "https://linkedin.com/in/alice",
        companyKey: "apex",
        parkedRound: 1,
        cause: "no_domain",
        recheckAttempts: 0,
        candidate: {
          candidateId: "c1",
          lead: { fullName: "Alice", currentCompany: "Apex" },
          evidence: [{ id: "e1", text: "text" }],
        },
      },
    ],
  };

  const checkpoint: any = {
    sessionId: "sess_test",
    round: 1,
    stage: "enrich",
    promptQuery: "ai consultancy nz",
    targetLimit: 10,
    contract: sampleContract,
    queryRuns: [],
    acceptedLeads: [],
    qualifiedLeads: [],
    finalLeads: [],
    rejectionCounts: {},
    brightDataStats: {},
    parkedCandidates: state.parkedCandidates,
    updatedAt: new Date().toISOString(),
  };

  const budgeted = enforceCheckpointByteBudget(checkpoint);
  assert.ok(budgeted.parkedCandidates);
  assert.equal(budgeted.parkedCandidates.length, 1);
  assert.equal(budgeted.parkedCandidates[0].candidateKey, "https://linkedin.com/in/alice");

  // Legacy checkpoint without parkedCandidates loads cleanly
  delete checkpoint.parkedCandidates;
  const legacyBudgeted = enforceCheckpointByteBudget(checkpoint);
  assert.equal(legacyBudgeted.parkedCandidates, undefined);
});
