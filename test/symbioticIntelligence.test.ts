import test from "node:test";
import assert from "node:assert/strict";
import { rankLeadForFinalSelection } from "../server/leadSearch/scoring.js";
import { verifyDecisionMakerFromEvidence } from "../server/leadSearch/verification.js";
import { verifyEvidencePassage } from "../server/leadSearch/finalistJudge.js";
import {
  upsertDiscoveredCompanies,
  readDiscoveredCompanyNames,
  upsertProspectContractCache,
  getProspectContractCache,
  upsertOutreachDraft,
  readOutreachDraftsByLeadId,
  deleteOutreachDraft,
} from "../server/db.js";
import { PROSPECT_CONTRACT_POLICY_VERSION } from "../server/leadSearch/prospectContract.js";

test("companyIntent: word boundary matching prevents false positive substring hits", async () => {
  const countOccurrences = (markdown: string, signal: string): number => {
    const trimmed = signal.trim().toLowerCase();
    if (!trimmed) return 0;
    const escaped = trimmed.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const pattern = new RegExp(`\\b(?<!-)${escaped}(?!-)\\b`, "gi");
    const matches = markdown.match(pattern);
    return matches ? matches.length : 0;
  };

  const textWithFalsePositives =
    "We are a filmmaker collective. His statement was misleading. You can email our team.";
  assert.equal(countOccurrences(textWithFalsePositives, "make"), 0);
  assert.equal(countOccurrences(textWithFalsePositives, "lead"), 0);
  assert.equal(countOccurrences(textWithFalsePositives, "ai"), 0);

  const textWithRealSignals =
    "We use Make.com and AI workflows for B2B lead generation.";
  assert.equal(countOccurrences(textWithRealSignals, "make"), 1);
  assert.equal(countOccurrences(textWithRealSignals, "lead"), 1);
  assert.equal(countOccurrences(textWithRealSignals, "ai"), 1);
});

test("scoring: BM25+ scores reflect genuine search query tokens", () => {
  const leadWithTokens = {
    headline: "Founder & CEO at Apex Digital Agency",
    currentTitle: "Chief Executive Officer",
    currentCompany: "Apex Digital Agency",
    summary: "Leading digital transformation and automation workflows.",
    decisionMakerVerification: { confidence: 9 },
    scout: {
      queryTokens: ["founder", "digital", "agency", "automation"],
      criteriaCoverageScore: 8,
      corroborationScore: 8,
    },
  };

  const scoreWithTokens = rankLeadForFinalSelection(leadWithTokens);
  assert.ok(scoreWithTokens > 5.0, `Score should be high, got ${scoreWithTokens}`);

  const leadWithoutTokens = {
    headline: "Unrelated Person",
    currentTitle: "Intern",
    currentCompany: "Generic Corp",
    summary: "No relevant experience.",
    decisionMakerVerification: { confidence: 2 },
    scout: {
      queryTokens: ["founder", "digital", "agency", "automation"],
      criteriaCoverageScore: 2,
      corroborationScore: 2,
    },
  };

  const scoreWithoutTokens = rankLeadForFinalSelection(leadWithoutTokens);
  assert.ok(
    scoreWithTokens > scoreWithoutTokens,
    `Qualified lead score (${scoreWithTokens}) must exceed unqualified lead score (${scoreWithoutTokens})`,
  );
});

test("verification: third-party snippets do not disqualify legitimate CEOs", () => {
  const ceoWithSnippet = {
    query: "marketing agency founder",
    currentTitle: "Founder & CEO",
    headline: "Founder & CEO at Nexus Media",
    currentCompany: "Nexus Media",
    seniorityLevel: "Owner / Executive",
    evidenceText: "Nexus Media is looking for an executive assistant and 2 interns to join the team.",
  };

  const verification = verifyDecisionMakerFromEvidence(ceoWithSnippet);
  assert.equal(verification.ignoredTitle, false);
  assert.equal(verification.titleMatched, true);
  assert.ok(verification.confidence >= 7, `CEO confidence should be >= 7, got ${verification.confidence}`);
});

test("finalistJudge: verifyEvidencePassage handles flexible token overlap and paraphrasing", () => {
  const evidenceText =
    "Acme Creative is an award-winning digital marketing and automation agency based in Austin, Texas.";
  
  // Exact match
  const exact = verifyEvidencePassage(evidenceText, "digital marketing and automation agency", 0.70);
  assert.equal(exact.valid, true);

  // Paraphrased with minor word deletion/shift
  const paraphrased = verifyEvidencePassage(evidenceText, "award-winning digital marketing agency based in Austin", 0.70);
  assert.equal(paraphrased.valid, true);
  assert.ok(paraphrased.similarity >= 0.70);

  // Completely unrelated quote
  const unrelated = verifyEvidencePassage(evidenceText, "enterprise database warehouse migration for financial banks in London", 0.70);
  assert.equal(unrelated.valid, false);
});

test("db: discovered_companies persistence and retrieval across sessions", () => {
  const testCompanies = [
    {
      companyName: "Test Agency Alpha",
      signalCount: 3,
      strongestSignal: "Looking for n8n developer",
      sourceUrls: ["https://alpha.example.com"],
      confidence: 0.9,
    },
    {
      companyName: "Test Agency Beta",
      signalCount: 5,
      strongestSignal: "Scaling Zapier workflows",
      sourceUrls: ["https://beta.example.com"],
      confidence: 0.95,
    },
  ];

  upsertDiscoveredCompanies(testCompanies);
  const names = readDiscoveredCompanyNames(10);
  assert.ok(names.includes("Test Agency Alpha"));
  assert.ok(names.includes("Test Agency Beta"));
});

test("db: prospect_contract_cache stores and retrieves quality contracts", () => {
  const cacheKey = "test query agency prospecting";
  const dummyContract = {
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    requirements: [
      {
        id: "req-1",
        label: "Founder",
        scope: "person_role",
        importance: "hard",
        acceptableTerms: ["founder", "ceo"],
      },
    ],
  };

  upsertProspectContractCache(cacheKey, cacheKey, PROSPECT_CONTRACT_POLICY_VERSION, dummyContract as any, 1);
  const cached = getProspectContractCache(cacheKey, PROSPECT_CONTRACT_POLICY_VERSION);
  assert.ok(cached !== null);
  assert.equal(cached.policyVersion, PROSPECT_CONTRACT_POLICY_VERSION);
  assert.equal(cached.requirements[0].id, "req-1");
});

test("db: outreach_drafts sequence history retrieval by leadId", () => {
  const testLeadId = `test-lead-${Date.now()}`;
  const draft1 = {
    id: `draft-1-${Date.now()}`,
    leadId: testLeadId,
    leadName: "Jane Doe",
    companyName: "Acme Corp",
    tone: "Professional",
    medium: "Cold Email",
    sequenceStep: "Step 1 - First Touch",
    wordCount: 80,
    body: "Hi Jane, noticed your recent n8n workflow post on LinkedIn...",
  };

  const draft2 = {
    id: `draft-2-${Date.now()}`,
    leadId: testLeadId,
    leadName: "Jane Doe",
    companyName: "Acme Corp",
    tone: "Professional",
    medium: "Cold Email",
    sequenceStep: "Step 2 - Value Demonstration",
    wordCount: 95,
    body: "Hi Jane, following up on our previous note regarding your automation pipeline...",
  };

  upsertOutreachDraft(draft1);
  upsertOutreachDraft(draft2);

  const history = readOutreachDraftsByLeadId(testLeadId);
  assert.equal(history.length, 2);
  assert.equal(history[0].sequenceStep, "Step 1 - First Touch");
  assert.equal(history[1].sequenceStep, "Step 2 - Value Demonstration");

  deleteOutreachDraft(draft1.id);
  deleteOutreachDraft(draft2.id);
});
