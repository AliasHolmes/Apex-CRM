import test from "node:test";
import assert from "node:assert/strict";
import {
  findEvidenceForLead,
  buildCheckpointEvidence,
} from "../server/leadSearch/sessionHelpers.js";
import { selectDiversifiedLeads } from "../server/leadSearch/scoutScoring.js";
import { LeadQueryRunTracker } from "../server/leadSearch/pipelineTypes.js";

test("findEvidenceForLead retrieves checkpointed evidence stored under linkedin:handle key", () => {
  const evidenceByUrl = new Map<string, any>();
  const mockEvidence = {
    evidenceBlock: "Experienced VP of Growth at TechCo",
    evidenceQuality: "good" as const,
    sourceProvider: "tavily" as const,
    sourceUrl: "https://www.linkedin.com/in/alex-smith-123",
    sourceQuery: "VP of Growth",
    sourceRound: 1,
  };

  // Checkpoint saves canonical key 'linkedin:alex-smith-123'
  evidenceByUrl.set("linkedin:alex-smith-123", mockEvidence);

  const lead = {
    fullName: "Alex Smith",
    contactDetails: {
      linkedinUrl: "https://www.linkedin.com/in/alex-smith-123/",
    },
  };

  const found = findEvidenceForLead(lead, evidenceByUrl);
  assert.ok(found, "Evidence should be found via linkedin:handle key");
  assert.equal(found?.evidenceBlock, "Experienced VP of Growth at TechCo");
  assert.equal(found?.evidenceQuality, "good");
});

test("buildCheckpointEvidence avoids generating malformed linkedin: empty keys", () => {
  const evidenceByUrl = new Map<string, any>();
  const mockEvidence = {
    evidenceBlock: "Company website info",
    evidenceQuality: "partial" as const,
    sourceProvider: "tavily" as const,
    sourceUrl: "https://example.com/team",
    sourceQuery: "Tech Founder",
    sourceRound: 1,
  };
  evidenceByUrl.set("https://example.com/team", mockEvidence);

  const acceptedLeads = [
    {
      fullName: "Non LinkedIn Lead",
      sourceUrl: "https://example.com/team",
    },
  ];

  const checkpointEvidence = buildCheckpointEvidence(evidenceByUrl, acceptedLeads);
  assert.equal(checkpointEvidence["linkedin:"], undefined, "Should not create empty linkedin: key");
  assert.ok(checkpointEvidence["https://example.com/team"], "Should save raw URL key");
});

test("selectDiversifiedLeads strictly respects maxPerCompany for Pareto skyline candidates", () => {
  const candidates = [
    {
      candidateId: "c1",
      fullName: "Alice A",
      currentCompany: "Acme AI",
      decisionMakerVerification: { confidence: 9 },
      finalSelectionScore: 9.5,
    },
    {
      candidateId: "c2",
      fullName: "Alice B",
      currentCompany: "Acme AI",
      decisionMakerVerification: { confidence: 9 },
      finalSelectionScore: 9.4,
    },
    {
      candidateId: "c3",
      fullName: "Alice C",
      currentCompany: "Acme AI",
      decisionMakerVerification: { confidence: 9 },
      finalSelectionScore: 9.3,
    },
    {
      candidateId: "c4",
      fullName: "Alice D",
      currentCompany: "Acme AI",
      decisionMakerVerification: { confidence: 9 },
      finalSelectionScore: 9.2,
    },
    {
      candidateId: "c5",
      fullName: "Bob A",
      currentCompany: "Beta Corp",
      decisionMakerVerification: { confidence: 8 },
      finalSelectionScore: 8.8,
    },
    {
      candidateId: "c6",
      fullName: "Bob B",
      currentCompany: "Beta Corp",
      decisionMakerVerification: { confidence: 8 },
      finalSelectionScore: 8.7,
    },
  ];

  const maxPerCompany = 2;
  const limit = 5;
  const selected = selectDiversifiedLeads(candidates, limit, maxPerCompany);

  assert.ok(selected.length <= limit, "Selected count should not exceed limit");
  const acmeCount = selected.filter(
    (c) => (c.currentCompany || "").toLowerCase() === "acme ai"
  ).length;
  assert.ok(
    acmeCount <= maxPerCompany,
    `Acme AI count (${acmeCount}) should not exceed maxPerCompany (${maxPerCompany})`
  );
});

test("LeadQueryRunTracker retrieves query run across lead transformations and ID mutations", () => {
  const tracker = new LeadQueryRunTracker();
  const mockQueryRun = {
    round: 1,
    query: "site:linkedin.com/in founders",
    acceptedLeads: 1,
    lane: "person",
  } as any;

  const rawLead = {
    id: "lead-123",
    fullName: "Jane Founder",
    currentCompany: "NextGen",
    contactDetails: { linkedinUrl: "https://www.linkedin.com/in/janefounder" },
  };

  tracker.set(rawLead, mockQueryRun);

  // Simulated candidate transformation in judge stage
  const transformedLead = {
    ...rawLead,
    qualification: { verdict: "qualified" },
  };

  const retrieved = tracker.get(transformedLead);
  assert.ok(retrieved, "Query run should be retrieved for transformed lead object");
  assert.equal(retrieved?.query, "site:linkedin.com/in founders");
});

test("findEvidenceForLead resolves evidence from nested lead.profile structure", () => {
  const evidenceByUrl = new Map<string, any>();
  const mockEvidence = {
    evidenceBlock: "Profile evidence from nested structure",
    evidenceQuality: "good" as const,
    sourceProvider: "brightdata" as const,
    sourceUrl: "https://www.linkedin.com/in/sarah-connor",
    sourceQuery: "Security Director",
    sourceRound: 2,
  };
  evidenceByUrl.set("linkedin:sarah-connor", mockEvidence);

  const nestedLead = {
    id: "lead-999",
    profile: {
      fullName: "Sarah Connor",
      contactDetails: {
        linkedinUrl: "https://www.linkedin.com/in/sarah-connor",
      },
    },
  };

  const found = findEvidenceForLead(nestedLead, evidenceByUrl);
  assert.ok(found, "Should find evidence when linkedinUrl is nested under profile");
  assert.equal(found?.evidenceBlock, "Profile evidence from nested structure");
});

test("selectDiversifiedLeads outputs consistent scores for both Pareto and MMR leads", () => {
  const candidates = [
    {
      candidateId: "c1",
      fullName: "Leader A",
      currentCompany: "Alpha AI",
      decisionMakerVerification: { confidence: 10 },
      finalSelectionScore: 8.5,
    },
    {
      candidateId: "c2",
      fullName: "Leader B",
      currentCompany: "Beta Tech",
      decisionMakerVerification: { confidence: 8 },
      finalSelectionScore: 7.2,
    },
  ];

  const selected = selectDiversifiedLeads(candidates, 2, 2);
  assert.equal(selected.length, 2);
  for (const s of selected) {
    assert.ok(typeof s.finalSelectionScore === "number", "Score should be numeric");
    assert.ok(
      s.finalSelectionScore >= 1 && s.finalSelectionScore <= 10,
      `Score ${s.finalSelectionScore} should be in [1, 10] range`
    );
  }
});
