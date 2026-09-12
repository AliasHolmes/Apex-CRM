import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAdaptiveArm } from "../server/leadSearch/adaptiveScheduler.js";

test("Deterministic Role Triage: regex accurately separates non-decision-makers from owners", () => {
  const NON_DECISION_MAKER_REGEX =
    /\b(intern|internship|student|junior|staff engineer|software engineer|swe|ml engineer|machine learning engineer|data scientist|ai researcher|postdoc|phd candidate|recruiter|talent acquisition|account executive|sdr|bdr)\b/i;
  const OWNER_TERMS_REGEX =
    /\b(owner|founder|co-founder|chief|ceo|cto|cmo|coo|president|principal|partner|managing director|director|head|vp|vice president)\b/i;

  const isNonDecisionMaker = (title: string) =>
    NON_DECISION_MAKER_REGEX.test(title) && !OWNER_TERMS_REGEX.test(title);

  // Non-decision-makers (should be discarded in 0ms)
  assert.equal(isNonDecisionMaker("Senior Software Engineer"), true);
  assert.equal(isNonDecisionMaker("Machine Learning Engineer"), true);
  assert.equal(isNonDecisionMaker("Lead ML Engineer"), true);
  assert.equal(isNonDecisionMaker("Data Scientist"), true);
  assert.equal(isNonDecisionMaker("AI Researcher"), true);
  assert.equal(isNonDecisionMaker("Technical Recruiter"), true);
  assert.equal(isNonDecisionMaker("Senior Account Executive"), true);
  assert.equal(isNonDecisionMaker("Software Engineering Intern"), true);

  // Decision-makers (must NOT be discarded by triage)
  assert.equal(isNonDecisionMaker("Founder & CEO"), false);
  assert.equal(isNonDecisionMaker("Co-Founder & CTO"), false);
  assert.equal(isNonDecisionMaker("Managing Director"), false);
  assert.equal(isNonDecisionMaker("Agency Owner"), false);
  assert.equal(isNonDecisionMaker("Principal Consultant"), false);
  assert.equal(isNonDecisionMaker("Head of AI Solutions"), false);
  assert.equal(isNonDecisionMaker("Partner & VP Engineering"), false);
});

test("Adaptive Scheduler: penalizes duplicate-heavy arms and rewards net qualified candidates", () => {
  // Arm A: High qualified yield, zero duplicates
  const cleanArm = scoreAdaptiveArm({
    outcome_runs: 5,
    qualified_candidates: 15,
    returned_candidates: 10,
    unique_candidates: 15,
    duplicate_candidates: 0,
    search_latency_ms: 1500,
    provider_units: 5,
  }, 10, 1.25, false);

  // Arm B: Many returned candidates, but mostly duplicates and low qualified yield
  const duplicateArm = scoreAdaptiveArm({
    outcome_runs: 5,
    qualified_candidates: 2,
    returned_candidates: 10,
    unique_candidates: 3,
    duplicate_candidates: 25,
    search_latency_ms: 1500,
    provider_units: 5,
  }, 10, 1.25, false);

  // Clean arm must score significantly higher than duplicate-polluted arm
  assert.ok(cleanArm.score > duplicateArm.score);
  assert.ok(cleanArm.score > 10);
  assert.ok(duplicateArm.score < 5);
});

test("Pre-Judge Site Grounding: deriveCompanyDomainWithProvenance extracts valid target domain", async () => {
  const { deriveCompanyDomainWithProvenance } = await import("../server/leadSearch/siteProbe.js");

  const leadWithWebsite = {
    fullName: "Jane Doe",
    company: "Acme AI Consulting",
    website: "https://acme-ai.co.uk",
  };
  const derived = deriveCompanyDomainWithProvenance(leadWithWebsite);
  assert.ok(derived);
  assert.equal(derived.provenance, "explicit");
  assert.equal(derived.domain, "https://acme-ai.co.uk");

  const rawTarget = derived.domain.replace(/\/$/, '').toLowerCase();
  const targetUrl = /^https?:\/\//i.test(rawTarget) ? rawTarget : `https://${rawTarget}`;
  const host = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
  assert.equal(host, "acme-ai.co.uk");
  assert.equal(targetUrl, "https://acme-ai.co.uk");
});

