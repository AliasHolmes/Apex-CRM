import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDbPath = path.join(
  os.tmpdir(),
  `test-mab-decay-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

const { getLeadsDb, closeLeadsDb, recordQueryPerformance } = await import(
  "../server/db.js"
);

test.after(() => {
  closeLeadsDb();
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch {}
});

test("Stream 1: MAB bandit decay symmetry", async () => {
  const db = getLeadsDb();

  // 1. Record initial query performance with 10 runs and 100 qualified candidates
  recordQueryPerformance({
    scopeKey: "ai-agency|person|linkedin|brightdata",
    domainCluster: "ai-agency",
    family: "person",
    lane: "linkedin",
    provider: "brightdata",
    runs: 10,
    rawCandidates: 50,
    uniqueCandidates: 40,
    extractedCandidates: 30,
    acceptedCandidates: 20,
    duplicateCandidates: 5,
    outcomeRuns: 10,
    qualifiedCandidates: 100,
    rescuedCandidates: 10,
    returnedCandidates: 100,
    searchLatencyMs: 500,
    providerUnits: 20,
    judgedCandidates: 80,
    hardFailedCandidates: 5,
    unknownCandidates: 2,
    requirementFailDigest: "",
  });

  const rowInitial = db
    .prepare("SELECT * FROM query_performance WHERE scope_key = ?")
    .get("ai-agency|person|linkedin|brightdata") as any;
  assert.equal(rowInitial.runs, 10);
  assert.equal(rowInitial.qualified_candidates, 100);

  // 2. Simulate a review or metadata update where runs = 0 and outcomeRuns = 0
  recordQueryPerformance({
    scopeKey: "ai-agency|person|linkedin|brightdata",
    domainCluster: "ai-agency",
    family: "person",
    lane: "linkedin",
    provider: "brightdata",
    runs: 0,
    rawCandidates: 0,
    uniqueCandidates: 0,
    extractedCandidates: 0,
    acceptedCandidates: 0,
    duplicateCandidates: 0,
    outcomeRuns: 0,
    qualifiedCandidates: 0,
    rescuedCandidates: 0,
    returnedCandidates: 0,
    searchLatencyMs: 0,
    providerUnits: 0,
    judgedCandidates: 0,
    hardFailedCandidates: 0,
    unknownCandidates: 0,
    requirementFailDigest: "",
  });

  const rowAfterReview = db
    .prepare("SELECT * FROM query_performance WHERE scope_key = ?")
    .get("ai-agency|person|linkedin|brightdata") as any;

  // With the fix: runs AND qualified_candidates remain exactly 10 and 100 (not eroded by 5% to 95)
  assert.equal(
    rowAfterReview.runs,
    10,
    "runs must not erode on non-run / review update",
  );
  assert.equal(
    rowAfterReview.qualified_candidates,
    100,
    "qualified_candidates must not erode on non-run / review update",
  );
});
