import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFinalistJudgePrompt,
  type FinalistCandidate,
} from "../server/leadSearch/finalistJudge.js";
import { selectEvidenceForFinalist } from "../server/leadSearch/evidenceSelection.js";
import type { ProspectContract } from "../server/leadSearch/prospectContract.js";
import { createLiveRollingPool } from "../server/leadSearch/liveRollingPool.js";

const TEST_CONTRACT: ProspectContract = {
  version: 1,
  policyVersion: "2026-10-test",
  brief: "Founders and CEOs of AI technology companies",
  authorityRequired: true,
  exclusions: [],
  initialQueries: [],
  requirements: [
    {
      id: "req-role",
      description: "Founder or CEO",
      sourcePhrase: "CEO",
      acceptableTerms: ["ceo", "chief executive officer", "founder"],
      scope: "person_role",
      importance: "hard",
      evidenceModality: "structured_profile",
      queryable: true,
    },
    {
      id: "req-domain",
      description: "AI software or technology company",
      sourcePhrase: "AI",
      acceptableTerms: ["ai", "artificial intelligence", "workflow"],
      scope: "company_type",
      importance: "hard",
      evidenceModality: "structured_profile",
      queryable: true,
    },
  ],
};

function createProbeEnrichedCandidate(id: string): FinalistCandidate {
  const probeLead: Record<string, any> = {
    id: `lead-${id}`,
    fullName: `Candidate ${id}`,
    currentTitle: "Chief Executive Officer",
    currentCompany: `Acme AI Corp ${id}`,
    location: "Austin, TX",
    _locationProvenance: "company_site",
    profile: {
      fullName: `Candidate ${id}`,
      currentTitle: "Chief Executive Officer",
      currentCompany: `Acme AI Corp ${id}`,
      location: "Austin, TX",
      _locationProvenance: "company_site",
    },
    companyAccount: {
      employeeCount: "25-50",
      description: "PROBE_COMPANY_DESCRIPTION_SECRET",
      operationalPainScore: 9,
      painSummary: "PROBE_HIGH_OPERATIONAL_PAIN_SUMMARY_SECRET",
      buyingSignals: [
        {
          type: "LEAD_FLOW",
          label: "Active pricing model",
          evidence: "PROBE_PRICING_MODEL_ENTERPRISE_TIER_SECRET",
          confidence: 0.8,
        },
        {
          type: "GROWTH_SIGNAL",
          label: "Customer case studies",
          evidence: "PROBE_CASE_STUDIES_FORTUNE_100_SECRET",
          confidence: 0.7,
        },
        {
          type: "GROWTH_SIGNAL",
          label: "Actively hiring",
          evidence: "PROBE_OPEN_ROLES_HEAD_OF_GROWTH_SECRET",
          confidence: 0.8,
        },
        {
          type: "OPERATIONAL_COMPLEXITY",
          label: "Tech stack in use",
          evidence: "PROBE_TECH_STACK_KUBERNETES_POSTGRES_SECRET",
          confidence: 0.6,
        },
      ],
    },
  };

  const rawEvidence = `Candidate ${id} is the Chief Executive Officer at Acme AI Corp ${id}, building autonomous AI workflow systems for enterprise clients. VERIFIED_GENUINE_EVIDENCE_${id}`;

  const selectedEvidence = selectEvidenceForFinalist(probeLead, TEST_CONTRACT, rawEvidence);

  return {
    candidateId: `cand-${id}`,
    lead: probeLead,
    evidence: selectedEvidence.evidence,
  };
}

const PROBE_SIGNATURES = [
  "PROBE_COMPANY_DESCRIPTION_SECRET",
  "PROBE_HIGH_OPERATIONAL_PAIN_SUMMARY_SECRET",
  "PROBE_PRICING_MODEL_ENTERPRISE_TIER_SECRET",
  "PROBE_CASE_STUDIES_FORTUNE_100_SECRET",
  "PROBE_OPEN_ROLES_HEAD_OF_GROWTH_SECRET",
  "PROBE_TECH_STACK_KUBERNETES_POSTGRES_SECRET",
  "operationalPainScore",
  "_locationProvenance",
  "company_site",
];

describe("Judge-Purity Invariant (ADR-0012 / Finding F8)", () => {
  it("never includes site-probe crawler signals in the serialized judge prompt", () => {
    const candidate = createProbeEnrichedCandidate("1");
    const prompt = buildFinalistJudgePrompt(TEST_CONTRACT, [candidate]);

    // Legitimate evidence must be present
    assert.match(prompt, /VERIFIED_GENUINE_EVIDENCE_1/);
    assert.match(prompt, /Candidate 1/);
    assert.match(prompt, /Chief Executive Officer/);

    // Site-probe-only fields and secrets must NEVER be present
    for (const signature of PROBE_SIGNATURES) {
      assert.doesNotMatch(
        prompt,
        new RegExp(signature, "i"),
        `Judge prompt must not leak site-probe marker: ${signature}`
      );
    }
  });

  it("maintains judge prompt purity across micro-batched candidates", () => {
    const candidates = [
      createProbeEnrichedCandidate("A"),
      createProbeEnrichedCandidate("B"),
      createProbeEnrichedCandidate("C"),
    ];

    const prompt = buildFinalistJudgePrompt(TEST_CONTRACT, candidates);

    for (const cand of ["A", "B", "C"]) {
      assert.match(prompt, new RegExp(`VERIFIED_GENUINE_EVIDENCE_${cand}`));
    }

    for (const signature of PROBE_SIGNATURES) {
      assert.doesNotMatch(
        prompt,
        new RegExp(signature, "i"),
        `Batched judge prompt leaked site-probe marker: ${signature}`
      );
    }
  });

  it("maintains purity through coalescing buffer and live rolling pool", async () => {
    const interceptedPrompts: string[] = [];

    const mockPool = createLiveRollingPool<FinalistCandidate[], void>({
      concurrency: 2,
      run: async (batch) => {
        const prompt = buildFinalistJudgePrompt(TEST_CONTRACT, batch);
        interceptedPrompts.push(prompt);
      },
    });

    const pendingGroup: FinalistCandidate[] = [];
    const targetBatchSize = 3;

    const queueAndFlush = (candidates: FinalistCandidate[]) => {
      pendingGroup.push(...candidates);
      if (pendingGroup.length >= targetBatchSize) {
        mockPool.submit([...pendingGroup]);
        pendingGroup.length = 0;
      }
    };

    queueAndFlush([createProbeEnrichedCandidate("X1")]);
    queueAndFlush([createProbeEnrichedCandidate("X2")]);
    assert.equal(interceptedPrompts.length, 0, "Coalescing buffer should hold when below targetBatchSize");

    queueAndFlush([createProbeEnrichedCandidate("X3")]);
    assert.equal(mockPool.submittedCount(), 1, "Should submit 1 batch when targetBatchSize is reached");

    // Flush remaining
    queueAndFlush([createProbeEnrichedCandidate("X4")]);
    if (pendingGroup.length > 0) {
      mockPool.submit([...pendingGroup]);
      pendingGroup.length = 0;
    }

    await mockPool.drain();

    assert.equal(interceptedPrompts.length, 2, "Expected 2 flushed batches");

    for (const prompt of interceptedPrompts) {
      for (const signature of PROBE_SIGNATURES) {
        assert.doesNotMatch(
          prompt,
          new RegExp(signature, "i"),
          `Buffer-flushed prompt leaked site-probe marker: ${signature}`
        );
      }
    }
  });
});
