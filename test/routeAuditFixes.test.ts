import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";

const testDbPath = path.join(
  os.tmpdir(),
  `test-route-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);
process.env.APEX_DB_PATH = testDbPath;

import {
  getLeadsDb,
  upsertLeadWithIdentity,
  readStoredLeadById,
  readLeadActivities,
  recordLeadOutcome,
  upsertMiningSession,
  readMiningSessionById,
  reconcileOrphanedMiningSessions,
  deleteLead,
} from "../server/db.js";
import apiRouter, { resolveMaxConcurrentSessions } from "../server/routes/api.js";

const app = express();
app.use(express.json());
app.use("/api", apiRouter);

let server: Server;
let baseUrl: string;

test.before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

const seed = (id: string, name: string, stage: string) =>
  upsertLeadWithIdentity(
    {
      id,
      profile: { fullName: name, currentCompany: `${name} Co`, currentTitle: "CEO" },
      stage,
      reviewStatus: "UNREVIEWED",
      nextAction: "NONE",
      createdAt: new Date().toISOString(),
    },
    { requireExisting: false },
  ).lead;

const bulk = async (leads: any[], extra: Record<string, unknown> = {}) => {
  const res = await fetch(`${baseUrl}/api/leads/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leads, requireExisting: true, perItemConflict: true, ...extra }),
  });
  return { status: res.status, body: await res.json() };
};

const outcomesFor = (leadId: string) =>
  (
    getLeadsDb()
      .prepare("SELECT outcome_type, outcome_detail FROM lead_outcomes WHERE lead_id = ?")
      .all(leadId) as Array<{ outcome_type: string; outcome_detail: string }>
  ).map((row) => ({ ...row })); // node:sqlite rows are null-prototype objects

test("POST /leads/bulk forwards forceOverwrite to the lead writer", async (t) => {
  await t.test("without forceOverwrite a regression to SCRAPED is ignored (CRM-owned field protection)", async () => {
    const lead = seed("bulk-protect-1", "Protect One", "ENRICHED");
    const r = await bulk([{ ...lead, stage: "SCRAPED" }]);
    assert.equal(r.status, 200);
    assert.equal(readStoredLeadById("bulk-protect-1")?.stage, "ENRICHED");
  });

  await t.test("with forceOverwrite the explicit stage change is honored", async () => {
    const lead = seed("bulk-force-1", "Force One", "ENRICHED");
    const r = await bulk([{ ...lead, stage: "SCRAPED" }], { forceOverwrite: true });
    assert.equal(r.status, 200);
    assert.equal(readStoredLeadById("bulk-force-1")?.stage, "SCRAPED");
  });
});

test("POST /leads/bulk activity log records real transitions only", async (t) => {
  await t.test("fromValue is the previous stage", async () => {
    const lead = seed("bulk-act-1", "Activity One", "ENRICHED");
    await bulk([{ ...lead, stage: "SEQUENCE ACTIVE" }], { forceOverwrite: true });
    const acts = readLeadActivities("bulk-act-1").filter((a) => a.type === "stage_change");
    assert.equal(acts.length, 1);
    assert.equal(acts[0].fromValue, "ENRICHED");
    assert.equal(acts[0].toValue, "SEQUENCE ACTIVE");
  });

  await t.test("re-saving the same stage writes no activity", async () => {
    const lead = seed("bulk-act-2", "Activity Two", "REPLIED");
    await bulk([{ ...lead }], { forceOverwrite: true });
    assert.equal(readLeadActivities("bulk-act-2").filter((a) => a.type === "stage_change").length, 0);
  });
});

test("POST /leads/bulk records binary outcomes the learning loop can read", async (t) => {
  await t.test("CONVERTED is a positive outcome", async () => {
    const lead = seed("bulk-out-1", "Outcome One", "ENRICHED");
    await bulk([{ ...lead, stage: "CONVERTED" }], { forceOverwrite: true });
    assert.deepEqual(outcomesFor("bulk-out-1"), [{ outcome_type: "positive", outcome_detail: "CONVERTED" }]);
  });

  await t.test("LOST is a negative outcome", async () => {
    const lead = seed("bulk-out-2", "Outcome Two", "ENRICHED");
    await bulk([{ ...lead, stage: "LOST" }], { forceOverwrite: true });
    assert.deepEqual(outcomesFor("bulk-out-2"), [{ outcome_type: "negative", outcome_detail: "LOST" }]);
  });

  await t.test("a mid-funnel stage such as SEQUENCE ACTIVE records no outcome", async () => {
    const lead = seed("bulk-out-3", "Outcome Three", "ENRICHED");
    await bulk([{ ...lead, stage: "SEQUENCE ACTIVE" }], { forceOverwrite: true });
    assert.deepEqual(outcomesFor("bulk-out-3"), []);
  });
});

test("PATCH /leads/:id requires a revision for an existing lead even with allowCreate", async () => {
  seed("patch-create-1", "Patch Create", "ENRICHED");
  const res = await fetch(`${baseUrl}/api/leads/patch-create-1`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      allowCreate: true,
      lead: {
        profile: { fullName: "Patch Create", currentCompany: "Patch Create Co", currentTitle: "CEO" },
        stage: "LOST",
      },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, "REVISION_REQUIRED");
  assert.equal(readStoredLeadById("patch-create-1")?.stage, "ENRICHED");
});

test("merge moves the duplicate's outcomes to the winner", async () => {
  seed("merge-win-1", "Merge Winner", "ENRICHED");
  seed("merge-dup-1", "Merge Duplicate", "ENRICHED");
  recordLeadOutcome("merge-dup-1", "positive", "KEEP");
  const res = await fetch(`${baseUrl}/api/leads/merge-win-1/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ duplicateId: "merge-dup-1" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(outcomesFor("merge-dup-1"), []);
  assert.deepEqual(outcomesFor("merge-win-1"), [{ outcome_type: "positive", outcome_detail: "KEEP" }]);
});

test("mining session housekeeping", async (t) => {
  await t.test("reconciliation writes ISO-8601 timestamps like every other writer", () => {
    upsertMiningSession({ id: "session-recon-1", status: "running", prompt: "p" });
    reconcileOrphanedMiningSessions();
    const s = readMiningSessionById("session-recon-1")!;
    assert.equal(s.status, "interrupted");
    assert.match(String(s.completedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    assert.match(String(s.updatedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  await t.test("a resumed session can clear its stale completedAt and errorMessage", () => {
    upsertMiningSession({
      id: "session-clear-1",
      status: "error",
      prompt: "p",
      completedAt: new Date().toISOString(),
      errorMessage: "old failure",
    });
    upsertMiningSession({
      id: "session-clear-1",
      status: "running",
      completedAt: null,
      errorMessage: null,
    });
    const s = readMiningSessionById("session-clear-1")!;
    assert.equal(s.status, "running");
    assert.equal(s.completedAt, undefined);
    assert.equal(s.errorMessage, undefined);
  });
});

test("deleteLead removes the lead inside its own transaction and nests safely", () => {
  seed("del-1", "Delete One", "ENRICHED");
  deleteLead("del-1");
  assert.equal(readStoredLeadById("del-1"), null);
  seed("del-2", "Delete Two", "ENRICHED");
  const db = getLeadsDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    deleteLead("del-2");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  assert.equal(readStoredLeadById("del-2"), null);
});

test("APEX_MAX_CONCURRENT_SESSIONS has a single default shared by start and resume", () => {
  const saved = process.env.APEX_MAX_CONCURRENT_SESSIONS;
  try {
    delete process.env.APEX_MAX_CONCURRENT_SESSIONS;
    assert.equal(resolveMaxConcurrentSessions(), 1);
    process.env.APEX_MAX_CONCURRENT_SESSIONS = "3";
    assert.equal(resolveMaxConcurrentSessions(), 3);
    process.env.APEX_MAX_CONCURRENT_SESSIONS = "99";
    assert.equal(resolveMaxConcurrentSessions(), 8);
    process.env.APEX_MAX_CONCURRENT_SESSIONS = "0";
    assert.equal(resolveMaxConcurrentSessions(), 1);
  } finally {
    if (saved === undefined) delete process.env.APEX_MAX_CONCURRENT_SESSIONS;
    else process.env.APEX_MAX_CONCURRENT_SESSIONS = saved;
  }
});
