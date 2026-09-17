import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  withSequentialLLMExecution,
  openAIText,
} from "../server/services/llm.js";
import {
  getLeadsETag,
  recordQueryPerformance,
  readQueryPerformance,
  readResumableMiningSessions,
  upsertMiningSession,
  readMiningSessionCheckpoint,
  deleteMiningSession,
  getLeadsDb,
  insertLeadActivity,
  readLeadActivities,
  upsertOutreachDraft,
  readOutreachDraftsByLeadId,
  upsertLeadWithIdentity,
  readStoredLeadById,
  transferLeadIdentities,
} from "../server/db.js";
import { LeadQueryRunTracker } from "../server/leadSearch/pipelineTypes.js";
import { normalizeProspectContract } from "../server/leadSearch/prospectContract.js";
import { isFlagEnabled } from "../server/leadSearch/featureFlags.js";

describe("Queue Invariants & Abort Mechanics", () => {
  it("immediately aborts a queued request when callerSignal aborts, without waiting for preceding tasks", async () => {
    let task1Running = true;
    const task1 = withSequentialLLMExecution(async () => {
      await new Promise((r) => setTimeout(r, 100));
      task1Running = false;
      return "task1-done";
    });

    const ac2 = new AbortController();
    let task2Executed = false;
    const task2Promise = withSequentialLLMExecution(async () => {
      task2Executed = true;
      return "task2-done";
    }, ac2.signal);

    let task3Executed = false;
    const task3Promise = withSequentialLLMExecution(async () => {
      task3Executed = true;
      return "task3-done";
    });

    // Abort task 2 immediately while task 1 is still running
    assert.equal(task1Running, true);
    ac2.abort();

    await assert.rejects(task2Promise, (err: any) => {
      assert.equal(err.name, "AbortError");
      return true;
    });

    // Task 1 should complete normally
    const res1 = await task1;
    assert.equal(res1, "task1-done");

    // Task 3 should execute and succeed
    const res3 = await task3Promise;
    assert.equal(res3, "task3-done");

    // Task 2 must NOT have executed its payload
    assert.equal(task2Executed, false);
    assert.equal(task3Executed, true);
  });

  it("does not starve queued request timeout budget while waiting for preceding requests in queue", async () => {
    const originalFetch = globalThis.fetch;
    const oldKey = process.env.OPENAI_API_KEY;
    const oldModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_MODEL = "test-model";

    try {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // Task 1 takes 60ms
          await new Promise((r) => setTimeout(r, 60));
        } else {
          // Task 2 executes quickly (10ms)
          await new Promise((r) => setTimeout(r, 10));
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      };

      // Launch task 1
      const p1 = openAIText("prompt 1");
      // Launch task 2 with 40ms timeout.
      // In the old code, waiting 60ms in queue would cause task 2 to timeout at 40ms!
      // In the fixed code, task 2 arms its 40ms timer only when it starts running, taking 10ms < 40ms.
      const p2 = openAIText("prompt 2", undefined, { timeoutMs: 40 });

      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1.text, "ok");
      assert.equal(r2.text, "ok");
    } finally {
      globalThis.fetch = originalFetch;
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
      if (oldModel === undefined) delete process.env.OPENAI_MODEL;
      else process.env.OPENAI_MODEL = oldModel;
    }
  });

  it("strictly honors LLM_MAX_RETRIES on HTTP 429 without forcing a 2-retry minimum", async () => {
    const originalFetch = globalThis.fetch;
    const oldKey = process.env.OPENAI_API_KEY;
    const oldOpenRouter = process.env.OPENROUTER_API_KEY;
    const oldAtriaKey = process.env.ATRIA_API_KEY;
    const oldRetries = process.env.LLM_MAX_RETRIES;
    const oldRetry429 = process.env.LLM_RETRY_429;
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter";
    delete process.env.ATRIA_API_KEY;
    process.env.LLM_MAX_RETRIES = "1";
    process.env.LLM_RETRY_429 = "true";

    try {
      let primaryAttempts = 0;
      globalThis.fetch = async (url: any) => {
        const urlStr = url.toString();
        if (urlStr.includes("byesu.com")) {
          primaryAttempts++;
          return new Response("rate limit", {
            status: 429,
            headers: { "Retry-After": "1" },
          });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "fallback-ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const res = await openAIText("prompt");
      assert.equal(res.text, "fallback-ok");
      // With LLM_MAX_RETRIES=1, attempt 0 and attempt 1 (total 2 attempts), NOT 3 attempts!
      assert.equal(primaryAttempts, 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
      if (oldOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = oldOpenRouter;
      if (oldAtriaKey === undefined) delete process.env.ATRIA_API_KEY;
      else process.env.ATRIA_API_KEY = oldAtriaKey;
      if (oldRetries === undefined) delete process.env.LLM_MAX_RETRIES;
      else process.env.LLM_MAX_RETRIES = oldRetries;
      if (oldRetry429 === undefined) delete process.env.LLM_RETRY_429;
      else process.env.LLM_RETRY_429 = oldRetry429;
    }
  });
});

describe("MAB Yield & Query Performance Decoupling", () => {
  it("does NOT decay query_performance.runs when runs: 0 is recorded from lead review", () => {
    const scopeKey = `test-cluster|test-family|person|tavily-${Date.now()}`;
    // Initialize with 10 runs
    recordQueryPerformance({
      scopeKey,
      domainCluster: "test-cluster",
      family: "test-family",
      lane: "person",
      provider: "tavily",
      runs: 10,
      rawCandidates: 50,
      uniqueCandidates: 40,
      extractedCandidates: 30,
      acceptedCandidates: 20,
      duplicateCandidates: 10,
      outcomeRuns: 10,
      qualifiedCandidates: 15,
      rescuedCandidates: 2,
      returnedCandidates: 10,
    });

    const initial = readQueryPerformance(10, "test-cluster").find(
      (r) => r.scope_key === scopeKey,
    );
    assert.ok(initial);
    assert.equal(initial.runs, 10);

    // Now simulate lead-review verification with runs: 0
    recordQueryPerformance({
      scopeKey,
      domainCluster: "test-cluster",
      family: "test-family",
      lane: "person",
      provider: "tavily",
      runs: 0,
      outcomeRuns: 1,
      qualifiedCandidates: 1,
      rescuedCandidates: 0,
    });

    const after = readQueryPerformance(10, "test-cluster").find(
      (r) => r.scope_key === scopeKey,
    );
    assert.ok(after);
    // Runs and all search funnel counts must be preserved, NOT decayed!
    assert.equal(after.runs, 10);
    assert.equal(after.raw_candidates, 50);
    assert.equal(after.unique_candidates, 40);
    assert.equal(after.extracted_candidates, 30);
    assert.equal(after.accepted_candidates, 20);
    assert.equal(after.duplicate_candidates, 10);
  });
});

describe("Resumed Session QueryRun Instance Re-linking", () => {
  it("re-links LeadQueryRunTracker map values to stats.queryRuns object instances", () => {
    const tracker = new LeadQueryRunTracker();
    const lead1 = {
      sourceUrl: "https://linkedin.com/in/jane-doe",
      fullName: "Jane Doe",
    };

    // Simulate serialized/restored stats.queryRuns
    const restoredQueryRuns: any[] = [
      {
        round: 1,
        query: "site:linkedin.com/in founders",
        qualifiedFinalists: 0,
        rescuedFinalists: 0,
        returnedFinalists: 0,
      },
    ];

    // Simulate restored LeadQueryRunTracker from JSON (contains disconnected cloned objects)
    tracker.fromJSON({
      "linkedin:jane-doe": {
        round: 1,
        query: "site:linkedin.com/in founders",
        qualifiedFinalists: 0,
        rescuedFinalists: 0,
        returnedFinalists: 0,
      } as any,
    });

    // Before relink: mutating tracker's entry does NOT mutate restoredQueryRuns[0]
    const beforeRun = tracker.get(lead1);
    assert.ok(beforeRun);
    assert.notEqual(beforeRun, restoredQueryRuns[0]);

    // Relink!
    tracker.relink(restoredQueryRuns);

    // After relink: tracker's entry IS the identical object reference
    const afterRun = tracker.get(lead1);
    assert.ok(afterRun);
    assert.equal(afterRun, restoredQueryRuns[0]);

    // Mutating via tracker updates restoredQueryRuns directly
    afterRun.qualifiedFinalists++;
    assert.equal(restoredQueryRuns[0].qualifiedFinalists, 1);
  });
});

describe("Native SQLite JSON Resumable Sessions & Checkpoint Memory Trimming", () => {
  it("projects scalar checkpoint summary using SQLite JSON functions", () => {
    const sId = `test-resumable-json-${Date.now()}`;
    const cp = {
      sessionId: sId,
      round: 3,
      stage: "judge" as const,
      promptQuery: "test query",
      targetLimit: 10,
      acceptedLeads: [{ id: "l1" }, { id: "l2" }, { id: "l3" }],
      updatedAt: "2026-09-17T03:00:00.000Z",
    };

    upsertMiningSession({
      id: sId,
      status: "interrupted",
      prompt: "test json extraction",
      requestedLimit: 10,
      checkpoint: cp as any,
    });

    const resumable = readResumableMiningSessions();
    const session = resumable.find((s) => s.id === sId);
    assert.ok(session);
    assert.ok(session.checkpoint);
    assert.equal(session.checkpoint.round, 3);
    assert.equal(session.checkpoint.stage, "judge");
    assert.equal((session.checkpoint as any).acceptedLeadsCount, 3);
    assert.equal(session.checkpoint.updatedAt, "2026-09-17T03:00:00.000Z");

    deleteMiningSession(sId);
  });

  it("preserves existing checkpoint_json in SQLite when updating session without checkpoint", () => {
    const sId = `test-upsert-preserve-${Date.now()}`;
    const cp = {
      sessionId: sId,
      round: 2,
      stage: "extract" as const,
      promptQuery: "test query",
      targetLimit: 5,
      acceptedLeads: [{ id: "l1" }],
      updatedAt: "2026-09-17T02:00:00.000Z",
    };

    // 1. Initial upsert with checkpoint
    upsertMiningSession({
      id: sId,
      status: "running",
      prompt: "preserve test",
      requestedLimit: 5,
      checkpoint: cp as any,
    });

    // 2. Status update without passing checkpoint
    upsertMiningSession({
      id: sId,
      status: "interrupted",
      errorMessage: "Process stopped",
    });

    // Verify checkpoint is still intact in SQLite!
    const restoredCp = readMiningSessionCheckpoint(sId);
    assert.ok(restoredCp);
    assert.equal(restoredCp.round, 2);
    assert.equal(restoredCp.stage, "extract");

    // 3. Status update with explicit checkpoint: null
    upsertMiningSession({
      id: sId,
      status: "success",
      checkpoint: null as any,
    });

    // Verify checkpoint was cleared
    const clearedCp = readMiningSessionCheckpoint(sId);
    assert.equal(clearedCp, null);

    deleteMiningSession(sId);
  });
});

describe("ETag Sanitization", () => {
  it("ignores non-filter cache busters in getLeadsETag", () => {
    const etag1 = getLeadsETag({ stage: "QUALIFIED", _t: "12345678" });
    const etag2 = getLeadsETag({ stage: "QUALIFIED", _t: "87654321" });
    const etag3 = getLeadsETag({ stage: "QUALIFIED" });
    const etagDiff = getLeadsETag({ stage: "NEW" });

    assert.equal(etag1, etag2);
    assert.equal(etag1, etag3);
    assert.notEqual(etag1, etagDiff);
  });
});

describe("Contract Diagnostics & Ungrounded Requirements", () => {
  it("collects dropped ungrounded hard requirements in droppedUngroundedRequirements", () => {
    const brief = "Find CTOs at fintech startups in London";
    const fallback = {
      version: 1 as const,
      policyVersion: "evidence-contract-v8" as const,
      brief,
      authorityRequired: false,
      requirements: [],
      exclusions: [],
      initialQueries: [],
    };

    const mockCompiled = {
      requirements: [
        {
          scope: "person_role",
          sourcePhrase: "CTO",
          importance: "hard",
        },
        {
          scope: "company_type",
          sourcePhrase: "hospitality chain", // NOT in brief!
          importance: "hard",
        },
        {
          scope: "person_location",
          sourcePhrase: "London",
          importance: "hard",
        },
      ],
    };

    const contract = normalizeProspectContract(mockCompiled, brief, fallback);
    assert.ok(contract.droppedUngroundedRequirements);
    assert.equal(contract.droppedUngroundedRequirements.length, 1);
    assert.equal(contract.droppedUngroundedRequirements[0].phrase, "hospitality chain");
    assert.equal(contract.droppedUngroundedRequirements[0].scope, "company_type");

    // The hard requirements in contract should not contain "hospitality chain"
    const hasHospitality = contract.requirements.some((r) =>
      r.sourcePhrase.toLowerCase().includes("hospitality"),
    );
    assert.equal(hasHospitality, false);
  });
});

describe("Graduated Feature Flags", () => {
  it("returns true unconditionally for all 6 graduated architecture flags", () => {
    assert.equal(isFlagEnabled.taxonomy(), true);
    assert.equal(isFlagEnabled.distributedQuery(), true);
    assert.equal(isFlagEnabled.semanticGrouping(), true);
    assert.equal(isFlagEnabled.enhancedDiagnostics(), true);
    assert.equal(isFlagEnabled.transientNegativeCache(), true);
    assert.equal(isFlagEnabled.proactiveTokenRegulator(), true);
  });
});

describe("Lead Merge Conflict & Relation Reassignment", () => {
  it("reassigns outreach drafts and activities to winner and purges conflicts", () => {
    const db = getLeadsDb();
    const winnerId = `winner-${Date.now()}`;
    const duplicateId = `dup-${Date.now()}`;

    // 1. Create winner and duplicate leads
    upsertLeadWithIdentity({
      id: winnerId,
      fullName: "Winner Lead",
      sourceUrl: `https://linkedin.com/in/${winnerId}`,
      stage: "SCRAPED",
    });
    upsertLeadWithIdentity({
      id: duplicateId,
      fullName: "Duplicate Lead",
      sourceUrl: `https://linkedin.com/in/${duplicateId}`,
      stage: "SCRAPED",
    });

    // 2. Attach draft and activity to duplicate
    upsertOutreachDraft({
      id: `draft-${duplicateId}`,
      leadId: duplicateId,
      leadName: "Duplicate Lead",
      tone: "professional",
      medium: "email",
      sequenceStep: "step_1",
      wordCount: 50,
      body: "Draft content for duplicate",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    insertLeadActivity({
      id: `activity-${duplicateId}`,
      leadId: duplicateId,
      type: "note",
      toValue: "Note on duplicate",
      actor: "user",
    });

    // 3. Insert into lead_identity_conflicts
    db.prepare(`
      INSERT OR IGNORE INTO lead_identity_conflicts (identity_key, canonical_lead_id, duplicate_lead_id, detected_at)
      VALUES (?, ?, ?, ?)
    `).run(`linkedin:${duplicateId}`, winnerId, duplicateId, new Date().toISOString());

    // Execute the merge transaction operations
    db.exec("BEGIN IMMEDIATE");
    try {
      transferLeadIdentities(db, duplicateId, winnerId);
      db.prepare("UPDATE outreach_drafts SET lead_id = ? WHERE lead_id = ?").run(winnerId, duplicateId);
      db.prepare("UPDATE lead_activities SET lead_id = ? WHERE lead_id = ?").run(winnerId, duplicateId);
      db.prepare("DELETE FROM lead_identity_conflicts WHERE canonical_lead_id = ? OR duplicate_lead_id = ?").run(duplicateId, duplicateId);
      db.prepare("DELETE FROM leads WHERE id = ?").run(duplicateId);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    // Verify duplicate is deleted
    assert.equal(readStoredLeadById(duplicateId), null);

    // Verify draft reassigned to winner
    const winnerDrafts = readOutreachDraftsByLeadId(winnerId);
    assert.equal(winnerDrafts.length, 1);
    assert.equal(winnerDrafts[0].id, `draft-${duplicateId}`);

    // Verify activity reassigned to winner
    const winnerActivities = readLeadActivities(winnerId);
    assert.ok(winnerActivities.some((a) => a.id === `activity-${duplicateId}`));

    // Verify conflicts pruned
    const remainingConflicts = db
      .prepare("SELECT COUNT(*) as cnt FROM lead_identity_conflicts WHERE duplicate_lead_id = ?")
      .get(duplicateId) as { cnt: number };
    assert.equal(remainingConflicts.cnt, 0);
  });
});
