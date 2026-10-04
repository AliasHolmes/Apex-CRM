import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.APEX_DB_PATH = path.join(
  os.tmpdir(),
  `test-session-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);

import {
  qualifiedLeadKeys,
  shouldRunExtraIntentRound,
  requestContextFromOptions,
  resumeOptionsFromCheckpoint,
} from "../server/leadSearch/sessionHelpers.js";
import { MiningTelemetryRecorder } from "../server/leadSearch/telemetry.js";
import { classifySessionStatus, isTerminalSessionStatus } from "../src/lib/sessionStatus.js";
import { discoveryEngine } from "../server/leadSearch/discoveryEngine.js";
import { upsertMiningSession } from "../server/db.js";

test("a persistence-partial session is a warning outcome, never a failure", () => {
  assert.equal(classifySessionStatus("success"), "success");
  assert.equal(classifySessionStatus("partial_success"), "partial");
  assert.equal(classifySessionStatus("cancelled"), "cancelled");
  assert.equal(classifySessionStatus("error"), "failed");
  assert.equal(classifySessionStatus("interrupted"), "failed");
  assert.equal(classifySessionStatus("running"), "active");
  assert.equal(classifySessionStatus("cancellation_requested"), "active");
  assert.equal(classifySessionStatus(undefined), "active");
  assert.equal(isTerminalSessionStatus("partial_success"), true);
  assert.equal(isTerminalSessionStatus("running"), false);
});

test("qualified-lead dedupe keys collapse every spelling of one LinkedIn profile", () => {
  const a = qualifiedLeadKeys({ id: "x1", contactDetails: { linkedinUrl: "https://www.linkedin.com/in/Jane-Doe/" } });
  const b = qualifiedLeadKeys({ id: "x2", sourceUrl: "linkedin.com/in/jane-doe?trk=public" });
  const profileKeyA = a.filter((k) => !k.startsWith("id:"));
  const profileKeyB = b.filter((k) => !k.startsWith("id:"));
  assert.equal(profileKeyA.length, 1);
  assert.deepEqual(profileKeyA, profileKeyB);
  assert.ok(a.includes("id:x1"));
});

test("an extra intent round needs rising corroboration relative to the previous round", () => {
  const base = {
    intentThresholdMet: false,
    extraRoundsRun: 0,
    intentCorroboratedCount: 3,
    previousIntentCorroboratedCount: 2,
    round: 2,
    maxRounds: 5,
    acceptedCount: 10,
    candidateCeiling: 40,
  };
  assert.equal(shouldRunExtraIntentRound(base), true);
  assert.equal(shouldRunExtraIntentRound({ ...base, previousIntentCorroboratedCount: 3 }), false);
  assert.equal(shouldRunExtraIntentRound({ ...base, intentThresholdMet: true }), false);
  assert.equal(shouldRunExtraIntentRound({ ...base, extraRoundsRun: 1 }), false);
  assert.equal(shouldRunExtraIntentRound({ ...base, round: 5 }), false);
  assert.equal(shouldRunExtraIntentRound({ ...base, acceptedCount: 40 }), false);
});

test("a cancelled session is reported as cancelled in its trace summary", () => {
  const rec = new MiningTelemetryRecorder("session-cancel-1", "q", 5, new Date().toISOString());
  rec.finish("cancelled", { returned: 0, stopReason: "cancelled" });
  assert.equal(rec.getSummary().status, "cancelled");
});

test("the request context survives a checkpoint round-trip so a resume matches the original run", () => {
  const ctx = requestContextFromOptions({
    savedSearchId: "saved-1",
    excludeList: ["linkedin:a", "b@example.com", 42 as any],
    discoveryMode: "account_first",
    discoveryProviderMode: "hybrid",
    parentSessionId: "session-parent-1",
    deltaBrief: "also fintech",
  });
  assert.deepEqual(ctx.excludeList, ["linkedin:a", "b@example.com"]);
  const resumed = resumeOptionsFromCheckpoint({ requestContext: ctx } as any);
  assert.equal(resumed.savedSearchId, "saved-1");
  assert.deepEqual(resumed.excludeList, ["linkedin:a", "b@example.com"]);
  assert.equal(resumed.discoveryMode, "account_first");
  assert.equal(resumed.parentSessionId, "session-parent-1");
  assert.equal(resumed.deltaBrief, "also fintech");
  assert.deepEqual(resumeOptionsFromCheckpoint({} as any), {});
});

test("resume releases its session claim when the run fails before starting", async () => {
  const sessionId = `session-resume-claim-${Date.now()}`;
  // A checkpoint with no promptQuery makes executeDiscoverySession throw before its try block.
  upsertMiningSession({
    id: sessionId,
    status: "interrupted",
    prompt: "p",
    checkpoint: { sessionId, round: 1, stage: "plan", promptQuery: "", targetLimit: 5 } as any,
  });
  await assert.rejects(() => discoveryEngine.resume(sessionId), /non-empty string/);
  assert.equal(discoveryEngine.isActive(sessionId), false, "the failed resume left the session claimed forever");
  assert.equal(discoveryEngine.getLiveLogs(sessionId), null);
});

test("intermediate checkpoint trace events do not mislabel as database persistence", () => {
  const recorder = new MiningTelemetryRecorder("session-chk-1", "test", 5);
  recorder.record({
    phase: "candidate_processing",
    operation: "checkpoint_leads",
    status: "success",
    provider: "system",
  });
  const events = recorder.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "candidate_processing");
  assert.notEqual(events[0].phase, "persistence");
});

