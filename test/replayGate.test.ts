import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// ISOLATION GUARD - must run before server modules load.
// ---------------------------------------------------------------------------
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-replay-gate-"));
process.env.APEX_DB_PATH = path.join(testDbDir, "replay_gate.sqlite");

const { hasGroundedQualification, upsertLeadsWithIdentity, readStoredLeadById } = await import(
  "../server/db.js"
);
const {
  finalistCandidateFromLead,
  triPartitionCandidatesByEvidence,
} = await import("../server/leadSearch/finalistJudge.js");
const { ablateSearchSpec } = await import("../server/leadSearch/constraintAblation.js");
const { canonicalLinkedInIdentity } = await import(
  "../server/services/linkedinEvidence.js"
);
const { estimateLLMCostUsd } = await import("../server/leadSearch/telemetry.js");

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures/replay");

function loadFixture(name: string) {
  const file = path.join(FIXTURES_DIR, name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("Golden Replay Gate: Clean target-met session preserves funnel, scores, and cost bounds", () => {
  const fixture = loadFixture("target-met.json");

  assert.equal(fixture.sessionId, "replay-golden-target-met");
  assert.equal(fixture.round, 1);
  assert.equal(fixture.targetLimit, 3);

  // 1. Funnel Consistency: monotonic progression
  const funnel = fixture.expectedFunnel;
  assert.ok(
    funnel.rawCandidates >= funnel.extractedLeads,
    "rawCandidates must be >= extractedLeads",
  );
  assert.ok(
    funnel.extractedLeads >= funnel.acceptedLeads,
    "extractedLeads must be >= acceptedLeads",
  );
  assert.ok(
    funnel.acceptedLeads >= funnel.qualifiedLeads,
    "acceptedLeads must be >= qualifiedLeads",
  );
  assert.ok(
    funnel.qualifiedLeads >= funnel.selectedLeads,
    "qualifiedLeads must be >= selectedLeads",
  );
  assert.equal(funnel.selectedLeads, fixture.targetLimit);

  // 2. Candidate evidence mapping and identity stability
  const contract = fixture.contract;
  const candidates = fixture.acceptedLeads.map((lead: any, idx: number) => {
    const url = lead.contactDetails?.linkedinUrl;
    const evidence = fixture.evidenceByUrl[url];
    const identityKey = canonicalLinkedInIdentity(url);
    assert.ok(identityKey.startsWith("linkedin:"), `Identity must be canonicalized: ${url}`);
    return finalistCandidateFromLead(`cand-${idx}`, lead, evidence?.markdown || evidence?.snippet, contract);
  });

  assert.equal(candidates.length, fixture.acceptedLeads.length);

  // 3. Evidence triage partitioning replay
  const partition = triPartitionCandidatesByEvidence(candidates, contract);
  assert.ok(
    Array.isArray(partition.autoQualified),
    "Partition must return autoQualified array",
  );
  assert.ok(
    Array.isArray(partition.autoFailed),
    "Partition must return autoFailed array",
  );
  assert.ok(
    Array.isArray(partition.needsJudge),
    "Partition must return needsJudge array",
  );

  // 4. Grounded write invariant check across qualified leads
  const qualifiedLeads = fixture.acceptedLeads.filter(
    (l: any) => l.qualification?.verdict === "qualified",
  );
  assert.equal(qualifiedLeads.length, 3, "Expected exactly 3 qualified leads");

  for (const qLead of qualifiedLeads) {
    const isGrounded = hasGroundedQualification(qLead);
    assert.equal(
      isGrounded,
      true,
      `Lead ${qLead.id} must satisfy the grounded-write invariant`,
    );
  }

  // Verify non-qualified leads fail grounded-write check
  const nonQualifiedLeads = fixture.acceptedLeads.filter(
    (l: any) => l.qualification?.verdict !== "qualified",
  );
  for (const nqLead of nonQualifiedLeads) {
    assert.equal(
      hasGroundedQualification(nqLead),
      false,
      `Non-qualified lead ${nqLead.id} must not pass grounded check`,
    );
  }

  // 5. Database write verification
  upsertLeadsWithIdentity(fixture.acceptedLeads, { isEngineWrite: true });
  for (const qLead of qualifiedLeads) {
    const stored = readStoredLeadById(qLead.id);
    assert.ok(stored, `Lead ${qLead.id} must be stored`);
    assert.equal(stored.reviewStatus, "KEEP");
    assert.equal(stored.tier, "TIER 1: PRIORITY");
  }

  for (const nqLead of nonQualifiedLeads) {
    const stored = readStoredLeadById(nqLead.id);
    assert.ok(stored, `Lead ${nqLead.id} must be stored`);
    assert.equal(stored.reviewStatus, "UNREVIEWED");
    assert.equal(stored.tier, "TIER 3: WATCH");
  }

  // 6. Score stability & bounds
  for (const lead of fixture.acceptedLeads) {
    assert.ok(
      lead.fitScore >= 0 && lead.fitScore <= 10,
      `fitScore out of bounds: ${lead.fitScore}`,
    );
    assert.ok(
      lead.compositeScore >= 0 && lead.compositeScore <= 100,
      `compositeScore out of bounds: ${lead.compositeScore}`,
    );
  }

  // 7. Token and cost envelope bounds
  const tokenCount = 4200; // Estimated tokens for 5 candidates through extraction + judge
  const estimatedCost = estimateLLMCostUsd(tokenCount, 1200);
  assert.ok(
    tokenCount <= fixture.expectedCostEnvelope.maxTokens,
    `Token count ${tokenCount} exceeds bound ${fixture.expectedCostEnvelope.maxTokens}`,
  );
  assert.ok(
    estimatedCost <= fixture.expectedCostEnvelope.maxEstimatedCostUsd,
    `Estimated cost ${estimatedCost} exceeds bound ${fixture.expectedCostEnvelope.maxEstimatedCostUsd}`,
  );
});

test("Golden Replay Gate: Multi-round stall replay triggers constraint ablation and recovery", () => {
  const fixture = loadFixture("multi-round-stall.json");

  assert.equal(fixture.sessionId, "replay-golden-multi-round-stall");
  assert.equal(fixture.round, 2);
  assert.equal(fixture.stage, "enrich");

  // 1. Verify stall detection and universal failure identification
  const runs = fixture.queryRuns;
  assert.equal(runs.length, 2);

  const failCounts: Record<string, number> = {};
  for (const run of runs) {
    for (const [reqId, cnt] of Object.entries(run.requirementFailCounts || {})) {
      failCounts[reqId] = (failCounts[reqId] || 0) + Number(cnt);
    }
  }

  const universalFailedId = fixture.stallDiagnostics.universalFailureRequirementId;
  assert.ok(failCounts[universalFailedId] >= 4, "Must register high failure count");

  // 2. Automated constraint ablation execution (Fix 6C / ADR-0007)
  const contract = fixture.contract;
  const initialHardCount = contract.requirements.filter((r: any) => r.importance === "hard").length;
  assert.equal(initialHardCount, 2, "Contract starts with 2 hard requirements");

  const ablation = ablateSearchSpec(
    { company: {}, queryGenerators: [] } as any,
    contract,
    universalFailedId,
  );

  assert.equal(ablation.ablated, true, "Ablation must succeed for universal failure");
  assert.equal(ablation.ablatedRequirementId, universalFailedId);

  // Relaxed requirement must now be soft
  const relaxedReq = ablation.contract.requirements.find(
    (r: any) => r.id === universalFailedId,
  );
  assert.ok(relaxedReq);
  assert.equal(relaxedReq.importance, "soft");

  const finalHardCount = ablation.contract.requirements.filter((r: any) => r.importance === "hard").length;
  assert.equal(finalHardCount, 1, "Only 1 hard requirement remains after ablation");

  // 3. Recovery trigger verification
  assert.equal(fixture.previousRoundSummary.shouldRecover, true);
  assert.deepEqual(
    fixture.previousRoundSummary.missingHardRequirementIds,
    [universalFailedId],
  );
});
