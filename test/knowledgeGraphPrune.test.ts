import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// ADR-0013: knowledge-graph pruners + stale error-message hygiene.
process.env.APEX_DB_PATH = path.join(
  os.tmpdir(),
  `test-graph-prune-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
);

import {
  getLeadsDb,
  pruneExpiredKnowledgeGraph,
  clearStaleSessionErrorMessages,
  upsertCandidateVerdict,
} from '../server/db.ts';

const db = getLeadsDb();

const past = new Date(Date.now() - 86_400_000).toISOString();
const future = new Date(Date.now() + 86_400_000).toISOString();

test('pruneExpiredKnowledgeGraph removes only expired rows across all three tables', () => {
  // Fresh verdict rows (default 30d TTL) must survive; negative ttlDays expires a row.
  upsertCandidateVerdict({
    identityKey: 'linkedin:fresh-one',
    requirementHash: 'fp-1',
    verdict: 'pass',
    evidenceHash: 'h-fresh',
    qualification: { verdict: 'qualified', finalScore: 9 },
  });
  upsertCandidateVerdict({
    identityKey: 'linkedin:stale-one',
    requirementHash: 'fp-1',
    verdict: 'pass',
    evidenceHash: 'h-stale',
    qualification: { verdict: 'qualified', finalScore: 9 },
    ttlDays: -1,
  });

  const before = {
    verdicts: (db.prepare('SELECT count(*) c FROM candidate_verdicts').get() as any).c,
  };

  const removed = pruneExpiredKnowledgeGraph(new Date(Date.now() - 1000));

  assert.ok(removed >= 1, 'at least the expired verdict row must be removed');
  assert.ok(
    (db.prepare('SELECT count(*) c FROM candidate_verdicts').get() as any).c < before.verdicts,
    'the verdict table must shrink',
  );
  assert.ok(
    db.prepare("SELECT 1 FROM candidate_verdicts WHERE identity_key = 'linkedin:fresh-one'").get(),
    'unexpired verdicts must be kept',
  );
  assert.ok(
    !db.prepare("SELECT 1 FROM candidate_verdicts WHERE identity_key = 'linkedin:stale-one'").get(),
    'expired verdicts must be deleted',
  );
});

test('clearStaleSessionErrorMessages clears errors only on terminal-success rows', () => {
  db.prepare(
    `INSERT INTO mining_sessions (id, status, prompt, requested_limit, started_at, completed_at, error_message, stats_json, trace_summary_json, checkpoint_json, updated_at)
     VALUES (?, ?, 'p', 10, ?, ?, ?, '{}', '{}', '{}', ?)`,
  ).run('session-success-1', 'success', past, future, 'Session was active when server process stopped (interrupted).', past);
  db.prepare(
    `INSERT INTO mining_sessions (id, status, prompt, requested_limit, started_at, completed_at, error_message, stats_json, trace_summary_json, checkpoint_json, updated_at)
     VALUES (?, ?, 'p', 10, ?, ?, ?, '{}', '{}', '{}', ?)`,
  ).run('session-interrupted-1', 'interrupted', past, future, 'Server process exited (SIGINT).', past);

  const cleared = clearStaleSessionErrorMessages();

  assert.ok(cleared >= 1, 'the stale success row must be cleared');
  const successRow = db.prepare("SELECT error_message FROM mining_sessions WHERE id = 'session-success-1'").get() as any;
  assert.equal(successRow.error_message, null, 'a completed session must not keep an old error message');
  const interruptedRow = db.prepare("SELECT error_message FROM mining_sessions WHERE id = 'session-interrupted-1'").get() as any;
  assert.equal(
    interruptedRow.error_message,
    'Server process exited (SIGINT).',
    'a non-terminal session keeps its error message',
  );
});
