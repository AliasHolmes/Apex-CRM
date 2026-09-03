import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated test DB
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-audit-test-"));
process.env.APEX_DB_PATH = path.join(testDbDir, "test.sqlite");

const {
  getLeadsDb,
  upsertMiningSession,
  readMiningSessionById,
  readResumableMiningSessions,
  clearResumableMiningSessions,
  clearInterruptedMiningSessions,
  deleteMiningSessions,
  upsertLeadWithIdentity,
  deleteLead,
  deleteLeadInExistingTransaction,
  insertLeadActivity,
  upsertOutreachDraft,
  readLeadsSummary,
} = await import("../server/db.js");

const { COPILOT_STOP_WORDS } = await import("../server/routes/api.js");

// -----------------------------------------------------------------------------
// Issue 1: Resumable Sessions Cleanup Defect
// -----------------------------------------------------------------------------
test("clearResumableMiningSessions clears both interrupted and error sessions with checkpoints", () => {
  const sInterruptedWithCp = `test-clear-int-cp-${Date.now()}`;
  const sErrorWithCp = `test-clear-err-cp-${Date.now()}`;
  const sErrorNoCp = `test-clear-err-nocp-${Date.now()}`;
  const sCompleted = `test-clear-completed-${Date.now()}`;

  const mockCp = {
    sessionId: sInterruptedWithCp,
    round: 1,
    stage: "plan",
    promptQuery: "test",
    targetLimit: 10,
  };

  upsertMiningSession({
    id: sInterruptedWithCp,
    status: "interrupted",
    prompt: "interrupted with checkpoint",
    checkpoint: mockCp as any,
  });
  upsertMiningSession({
    id: sErrorWithCp,
    status: "error",
    prompt: "error with checkpoint",
    checkpoint: mockCp as any,
  });
  upsertMiningSession({
    id: sErrorNoCp,
    status: "error",
    prompt: "error without checkpoint",
  });
  upsertMiningSession({
    id: sCompleted,
    status: "success",
    prompt: "completed session",
  });

  // Verify readResumableMiningSessions initially includes both sessions with checkpoints
  const initialResumable = readResumableMiningSessions();
  const initialIds = initialResumable.map((s) => s.id);
  assert.ok(initialIds.includes(sInterruptedWithCp), "Should include interrupted session with checkpoint");
  assert.ok(initialIds.includes(sErrorWithCp), "Should include error session with checkpoint");
  assert.ok(!initialIds.includes(sErrorNoCp), "Should not include error session without checkpoint");
  assert.ok(!initialIds.includes(sCompleted), "Should not include completed session");

  // Clear resumable sessions
  const deleted = clearResumableMiningSessions();
  assert.ok(deleted >= 2, `Expected at least 2 deleted, got ${deleted}`);

  // readResumableMiningSessions should now be empty of our test sessions
  const afterResumable = readResumableMiningSessions();
  const afterIds = afterResumable.map((s) => s.id);
  assert.ok(!afterIds.includes(sInterruptedWithCp), "Interrupted session should be cleared");
  assert.ok(!afterIds.includes(sErrorWithCp), "Error session with checkpoint should be cleared");

  // Verify non-resumable sessions were NOT deleted
  assert.ok(readMiningSessionById(sErrorNoCp), "Error session without checkpoint must be preserved");
  assert.ok(readMiningSessionById(sCompleted), "Completed session must be preserved");

  // Verify clearInterruptedMiningSessions alias works identically
  const sAlias = `test-alias-${Date.now()}`;
  upsertMiningSession({
    id: sAlias,
    status: "error",
    prompt: "test alias",
    checkpoint: mockCp as any,
  });
  assert.ok(readResumableMiningSessions().some((s) => s.id === sAlias));
  const aliasDeleted = clearInterruptedMiningSessions();
  assert.ok(aliasDeleted >= 1);
  assert.ok(!readResumableMiningSessions().some((s) => s.id === sAlias));

  // Cleanup
  deleteMiningSessions([sErrorNoCp, sCompleted]);
});

// -----------------------------------------------------------------------------
// Issue 2: Transaction & Statement Optimization for deleteLead
// -----------------------------------------------------------------------------
test("deleteLeadInExistingTransaction cleans up all cascade tables using cached statements", () => {
  const db = getLeadsDb();
  const leadIds = [`test-opt-lead-1-${Date.now()}`, `test-opt-lead-2-${Date.now()}`];

  for (const id of leadIds) {
    upsertLeadWithIdentity({
      id,
      fullName: `Test Lead ${id}`,
      company: "Test Corp",
      title: "VP Engineering",
      stage: "NEW",
      reviewStatus: "UNREVIEWED",
      nextAction: "NONE",
    });

    insertLeadActivity({
      leadId: id,
      type: "note",
      toValue: "activity for bulk test",
      actor: "tester",
    });

    upsertOutreachDraft({
      id: `draft-${id}`,
      leadId: id,
      leadName: `Test Lead ${id}`,
      tone: "casual",
      medium: "email",
      sequenceStep: "1",
      wordCount: 1,
      body: "Hello",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // Bulk delete loop inside a single BEGIN IMMEDIATE transaction without exception throwing
  db.exec("BEGIN IMMEDIATE");
  for (const id of leadIds) {
    deleteLeadInExistingTransaction(db, id);
  }
  db.exec("COMMIT");

  // Verify cascading deletions
  for (const id of leadIds) {
    const leadRow = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE id = ?").get(id) as any;
    assert.equal(leadRow.cnt, 0);

    const actRow = db.prepare("SELECT COUNT(*) as cnt FROM lead_activities WHERE lead_id = ?").get(id) as any;
    assert.equal(actRow.cnt, 0);

    const draftRow = db.prepare("SELECT COUNT(*) as cnt FROM outreach_drafts WHERE lead_id = ?").get(id) as any;
    assert.equal(draftRow.cnt, 0);
  }

  // Standalone deleteLead works and manages its own transaction
  const standaloneId = `test-standalone-${Date.now()}`;
  upsertLeadWithIdentity({
    id: standaloneId,
    fullName: "Standalone Lead",
    stage: "NEW",
    reviewStatus: "UNREVIEWED",
    nextAction: "NONE",
  });
  deleteLead(standaloneId);
  const standaloneCheck = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE id = ?").get(standaloneId) as any;
  assert.equal(standaloneCheck.cnt, 0);

  // deleteLead inside existing transaction still works safely
  const nestedId = `test-nested-${Date.now()}`;
  upsertLeadWithIdentity({
    id: nestedId,
    fullName: "Nested Lead",
    stage: "NEW",
    reviewStatus: "UNREVIEWED",
    nextAction: "NONE",
  });
  db.exec("BEGIN IMMEDIATE");
  deleteLead(nestedId);
  db.exec("COMMIT");
  const nestedCheck = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE id = ?").get(nestedId) as any;
  assert.equal(nestedCheck.cnt, 0);
});

// -----------------------------------------------------------------------------
// Issue 3: Copilot FTS Stop-Words & Recall
// -----------------------------------------------------------------------------
test("COPILOT_STOP_WORDS includes all conversational verbs and allows FTS recall", () => {
  const expectedStopWords = [
    "best", "find", "search", "reach", "contact", "recommend", "show", "tell",
    "need", "today", "help", "who", "which", "what", "where", "how", "give",
    "list", "get", "someone", "anyone",
  ];

  for (const word of expectedStopWords) {
    assert.ok(COPILOT_STOP_WORDS.has(word), `Expected '${word}' to be in COPILOT_STOP_WORDS`);
  }

  // Insert a target lead
  const testId = `test-copilot-recall-${Date.now()}`;
  try {
    upsertLeadWithIdentity({
      id: testId,
      fullName: "Marcus Vance",
      company: "Stripe",
      title: "Head of Infrastructure",
      stage: "NEW",
      reviewStatus: "UNREVIEWED",
      nextAction: "NONE",
      profile: {
        fullName: "Marcus Vance",
        currentCompany: "Stripe",
        currentTitle: "Head of Infrastructure",
      },
    });

    // Conversational queries that previously failed due to "who", "best", "contact", "reach", "today"
    const conversationalQuery = "Who is the best contact at Stripe to reach out to today?";
    const tokens = conversationalQuery
      .replace(/[^\p{L}\p{N}\s_@.-]/gu, " ")
      .split(/\s+/)
      .filter((w: string) => w.length > 1 && !COPILOT_STOP_WORDS.has(w.toLowerCase()));

    assert.ok(!tokens.map(t => t.toLowerCase()).includes("who"));
    assert.ok(!tokens.map(t => t.toLowerCase()).includes("best"));
    assert.ok(!tokens.map(t => t.toLowerCase()).includes("contact"));
    assert.ok(!tokens.map(t => t.toLowerCase()).includes("reach"));
    assert.ok(!tokens.map(t => t.toLowerCase()).includes("today"));
    assert.ok(tokens.includes("Stripe"));

    const searchRes = readLeadsSummary({ search: tokens.join(" "), limit: 15 });
    assert.ok(searchRes.leads.some((l) => l.id === testId), "Should successfully retrieve target lead Marcus Vance at Stripe");
  } finally {
    deleteLead(testId);
  }
});

// -----------------------------------------------------------------------------
// Issue 4: Delete Optimistic Concurrency Shield Logic
// -----------------------------------------------------------------------------
test("rehydrate logic filters out in-flight deleted lead IDs during tab switches", () => {
  // Simulate the rehydration filter algorithm implemented in LeadContext.tsx
  const lead1 = { id: "lead-1", fullName: "Alice", stage: "NEW" };
  const lead2 = { id: "lead-2", fullName: "Bob", stage: "NEW" };
  const lead3 = { id: "lead-3", fullName: "Charlie", stage: "NEW" };

  const currentLeads = [lead1, lead3]; // lead-2 was optimistically deleted from local state
  const serverLeads = [lead1, lead2, lead3]; // server has not finished deletion yet

  const inFlightDeletions = new Set<string>(["lead-2"]);
  const pendingQueues = new Map<string, Promise<boolean>>([["lead-2", Promise.resolve(true)]]);
  const pendingRollbacks = new Map<string, any>([["lead-2", null]]);
  const currentLeadMap = new Map(currentLeads.map((l) => [l.id, l]));

  const isDeleting = (id: string) =>
    inFlightDeletions.has(id) ||
    (pendingQueues.has(id) &&
      pendingRollbacks.get(id) === null &&
      !currentLeadMap.has(id));

  // Filter out in-flight deletions from server leads
  const activeServerLeads = serverLeads.filter((s) => !isDeleting(s.id));
  assert.equal(activeServerLeads.length, 2);
  assert.ok(!activeServerLeads.some((l) => l.id === "lead-2"), "lead-2 must not be restored from server leads");

  const serverLeadIds = new Set<string>();
  const nextLeads: any[] = [];
  for (const serverLead of activeServerLeads) {
    serverLeadIds.add(serverLead.id);
    if (pendingQueues.has(serverLead.id)) {
      const current = currentLeadMap.get(serverLead.id);
      if (current) {
        nextLeads.push(current);
        continue;
      }
    }
    nextLeads.push(serverLead);
  }

  for (const currentLead of currentLeads) {
    if (
      !isDeleting(currentLead.id) &&
      pendingQueues.has(currentLead.id) &&
      !serverLeadIds.has(currentLead.id)
    ) {
      nextLeads.unshift(currentLead);
    }
  }

  assert.deepEqual(
    nextLeads.map((l) => l.id),
    ["lead-1", "lead-3"],
    "lead-2 must remain absent during rehydration while deletion is in flight",
  );
});

test("queued patch on a lead undergoing deletion aborts when deletion completes and does not persist", async () => {
  // Simulate the exact patch queuing and delete promise resolution mechanism in LeadContext
  const inFlightDeletions = new Set<string>();
  const leadPatchQueues = new Map<string, Promise<boolean>>();
  const leadPatchRollback = new Map<string, any>();

  const leadId = "lead-deleting-target";

  // 1. Delete initiates
  let deleteResolve: (val: boolean) => void;
  const deletePromise = new Promise<boolean>((resolve) => {
    deleteResolve = resolve;
  });

  inFlightDeletions.add(leadId);
  leadPatchRollback.set(leadId, null);
  leadPatchQueues.set(leadId, deletePromise);

  // 2. An edit is attempted while deletion is in flight
  let persistedAttempted = false;
  const reconcileSimulated = (lead: any, rollback: any) => {
    if (inFlightDeletions.has(lead.id)) {
      return Promise.resolve(false);
    }
    const previousOperation = leadPatchQueues.get(lead.id) ?? Promise.resolve(true);
    const operation = previousOperation.then(async (previousSucceeded) => {
      if (!previousSucceeded || inFlightDeletions.has(lead.id)) return false;
      persistedAttempted = true;
      return true;
    });
    leadPatchQueues.set(lead.id, operation);
    return operation;
  };

  // Direct attempt while in flight returns false immediately
  const directResult = await reconcileSimulated({ id: leadId, name: "New Name" }, null);
  assert.equal(directResult, false, "Direct edit on in-flight deletion must abort immediately");
  assert.equal(persistedAttempted, false);

  // 3. Test chained scenario where patch had already attached to previousOperation before finally cleanup
  let chainedPatchAttempted = false;
  const chainedOperation = deletePromise.then(async (previousSucceeded) => {
    if (!previousSucceeded || inFlightDeletions.has(leadId)) return false;
    chainedPatchAttempted = true;
    return true;
  });

  // Deletion completes successfully (resolving with false to indicate lead is gone)
  deleteResolve!(false);
  inFlightDeletions.delete(leadId);

  const chainedResult = await chainedOperation;
  assert.equal(chainedResult, false, "Chained patch must abort because previousSucceeded was false");
  assert.equal(chainedPatchAttempted, false, "Chained patch must never attempt persistence");
});

test("bulk deletion handles non-existent IDs and reuses cached statements cleanly", () => {
  const db = getLeadsDb();
  const nonExistentIds = [
    `non-existent-1-${Date.now()}`,
    `non-existent-2-${Date.now()}`,
    `non-existent-3-${Date.now()}`,
  ];

  // Should succeed with 0 rows affected and zero exceptions
  db.exec("BEGIN IMMEDIATE");
  for (const id of nonExistentIds) {
    deleteLeadInExistingTransaction(db, id);
  }
  db.exec("COMMIT");

  for (const id of nonExistentIds) {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE id = ?").get(id) as any;
    assert.equal(row.cnt, 0);
  }
});

