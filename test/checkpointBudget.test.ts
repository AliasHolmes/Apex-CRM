import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-checkpoint-budget-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import {
  closeLeadsDb,
  enforceCheckpointByteBudget,
  CheckpointBudgetExceededError,
  saveMiningSessionCheckpoint,
  upsertMiningSession,
  readMiningSessionById,
  type MiningSessionCheckpoint,
} from "../server/db.js";

test("Stream 4 - Checkpoint Byte Budget Enforcement", async (t) => {
  t.after(() => {
    closeLeadsDb();
  });

  await t.test("leaves small checkpoint untouched", () => {
    const cp: MiningSessionCheckpoint = {
      sessionId: "session-1",
      round: 1,
      stage: "enrich",
      promptQuery: "tech founders",
      targetLimit: 10,
      contract: {},
      queryRuns: [],
      acceptedLeads: [{ fullName: "Alice", currentCompany: "Tech Corp" }],
      qualifiedLeads: [{ fullName: "Alice", currentCompany: "Tech Corp" }],
      finalLeads: [],
      rejectionCounts: {},
      failureCounts: {},
      brightDataStats: {},
      updatedAt: new Date().toISOString(),
    };

    const trimmed = enforceCheckpointByteBudget(cp);
    assert.equal(trimmed.acceptedLeads.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(trimmed), "utf8") <= 512_000);
  });

  await t.test("strips evidenceByUrl when checkpoint exceeds budget", () => {
    const bulkyEvidence: Record<string, any> = {};
    for (let i = 0; i < 200; i++) {
      bulkyEvidence[`https://example.com/page/${i}`] = {
        title: `Page ${i}`,
        content: "x".repeat(3000),
      };
    }

    const cp: MiningSessionCheckpoint = {
      sessionId: "session-bulky-evidence",
      round: 1,
      stage: "enrich",
      promptQuery: "tech founders",
      targetLimit: 10,
      contract: {},
      queryRuns: [],
      acceptedLeads: [{ fullName: "Alice" }],
      qualifiedLeads: [{ fullName: "Alice" }],
      finalLeads: [],
      rejectionCounts: {},
      failureCounts: {},
      brightDataStats: {},
      evidenceByUrl: bulkyEvidence,
      updatedAt: new Date().toISOString(),
    };

    const originalSize = Buffer.byteLength(JSON.stringify(cp), "utf8");
    assert.ok(originalSize > 512_000);

    const trimmed = enforceCheckpointByteBudget(cp);
    const trimmedSize = Buffer.byteLength(JSON.stringify(trimmed), "utf8");
    assert.ok(trimmedSize <= 512_000);
    assert.deepEqual(trimmed.evidenceByUrl, {});
  });

  await t.test("progressively clamps 1600 accepted leads to stay under 512KB", () => {
    const acceptedLeads: any[] = [];
    for (let i = 0; i < 1600; i++) {
      acceptedLeads.push({
        id: `lead-${i}`,
        fullName: `Candidate Number ${i}`,
        currentTitle: `Vice President of Engineering and Systems Architecture ${i}`,
        currentCompany: `Enterprise Technology Solutions International Corporation ${i}`,
        headline: `Experienced Engineering Leader driving cloud transformations across multi-cloud infrastructure ${i}`,
        summary: `Over 15 years leading distributed engineering teams, scaling platform infrastructure, optimizing microservices, and aligning technical roadmap with executive vision.`,
        score: 8.5,
        decisionMakerVerification: {
          confidence: 8,
          reason: "Direct executive leadership role verified",
        },
      });
    }

    const cp: MiningSessionCheckpoint = {
      sessionId: "session-1600-leads",
      round: 2,
      stage: "enrich",
      promptQuery: "enterprise engineering leaders",
      targetLimit: 100,
      contract: {},
      queryRuns: [],
      acceptedLeads,
      qualifiedLeads: acceptedLeads.slice(0, 100),
      finalLeads: [],
      rejectionCounts: {},
      failureCounts: {},
      brightDataStats: {},
      updatedAt: new Date().toISOString(),
    };

    const originalSize = Buffer.byteLength(JSON.stringify(cp), "utf8");
    assert.ok(originalSize > 512_000, `Original size ${originalSize} should exceed 512KB`);

    const trimmed = enforceCheckpointByteBudget(cp);
    const trimmedSize = Buffer.byteLength(JSON.stringify(trimmed), "utf8");
    assert.ok(trimmedSize <= 512_000, `Trimmed size ${trimmedSize} must be <= 512KB`);
    assert.ok(trimmed.acceptedLeads.length < 1600, "Should have trimmed candidate count");
    assert.ok(trimmed.acceptedLeads.length >= 100, "Should retain at least 100 candidates if fits");
  });

  await t.test("saveMiningSessionCheckpoint and upsertMiningSession persist <= 512KB into database", () => {
    const sessionId = "session-db-test";
    upsertMiningSession({
      id: sessionId,
      prompt: "test",
      status: "running",
    });

    const acceptedLeads: any[] = [];
    for (let i = 0; i < 1600; i++) {
      acceptedLeads.push({
        id: `lead-${i}`,
        fullName: `Candidate ${i}`,
        currentTitle: `VP Engineering ${i}`,
        currentCompany: `Acme Corp ${i}`,
        summary: "y".repeat(500),
      });
    }

    const cp: MiningSessionCheckpoint = {
      sessionId,
      round: 1,
      stage: "enrich",
      promptQuery: "test",
      targetLimit: 50,
      contract: {},
      queryRuns: [],
      acceptedLeads,
      qualifiedLeads: [],
      finalLeads: [],
      rejectionCounts: {},
      failureCounts: {},
      brightDataStats: {},
      updatedAt: new Date().toISOString(),
    };

    // Test saveMiningSessionCheckpoint
    saveMiningSessionCheckpoint(sessionId, cp);
    const readSession = readMiningSessionById(sessionId);
    assert.ok(readSession?.checkpoint);
    const dbSize = Buffer.byteLength(JSON.stringify(readSession.checkpoint), "utf8");
    assert.ok(dbSize <= 512_000, `Database checkpoint size ${dbSize} must be <= 512KB`);

    // Test upsertMiningSession
    upsertMiningSession({
      id: sessionId,
      checkpoint: cp,
    });
    const readSession2 = readMiningSessionById(sessionId);
    assert.ok(readSession2?.checkpoint);
    const dbSize2 = Buffer.byteLength(JSON.stringify(readSession2.checkpoint), "utf8");
    assert.ok(dbSize2 <= 512_000, `Database checkpoint size from upsert ${dbSize2} must be <= 512KB`);
  });

  await t.test("throws CheckpointBudgetExceededError if budget is impossible to satisfy", () => {
    const cp: any = {
      sessionId: "impossible",
      round: 1,
      promptQuery: "test",
      acceptedLeads: [{ a: "1" }],
    };
    assert.throws(
      () => enforceCheckpointByteBudget(cp, 5),
      (err: any) => {
        assert.ok(err instanceof CheckpointBudgetExceededError);
        return true;
      },
    );
  });
});
