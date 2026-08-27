import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolation guard for test SQLite database
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-perf-test-'));
process.env.APEX_DB_PATH = path.join(testDbDir, 'perf-test.sqlite');

const {
  upsertMiningSession,
  saveMiningSessionCheckpoint,
  readMiningSessionById,
  readMiningSessionSummaryById,
  readMiningSessions,
} = await import('../server/db.js');

test('readMiningSessionSummaryById returns session metadata without loading checkpoint', () => {
  const sessionId = `test-summary-${Date.now()}`;
  upsertMiningSession({
    id: sessionId,
    status: 'running',
    prompt: 'VPs of Engineering in Toronto',
    requestedLimit: 20,
    startedAt: new Date().toISOString(),
  });

  saveMiningSessionCheckpoint(sessionId, {
    sessionId,
    round: 2,
    stage: 'extract',
    promptQuery: 'VPs of Engineering in Toronto',
    targetLimit: 20,
    contract: { brief: 'VPs of Engineering in Toronto', requirements: [] } as any,
    queryRuns: [],
    acceptedLeads: [{ id: 'lead-1', fullName: 'Jane Doe' }],
    qualifiedLeads: [],
    finalLeads: [],
    rejectionCounts: {},
    failureCounts: {},
    brightDataStats: {},
    evidenceByUrl: {
      'https://example.com/jane': {
        evidenceBlock: 'Heavy evidence block data',
        evidenceQuality: 'good',
        sourceProvider: 'tavily',
        sourceUrl: 'https://example.com/jane',
        sourceQuery: 'VP Eng Toronto',
        sourceRound: 1,
      },
    },
    updatedAt: new Date().toISOString(),
  });

  // Full record includes checkpoint
  const fullRecord = readMiningSessionById(sessionId);
  assert.ok(fullRecord);
  assert.equal(fullRecord.id, sessionId);
  assert.equal(fullRecord.status, 'running');
  assert.ok(fullRecord.checkpoint, 'full record should have checkpoint');
  assert.equal(fullRecord.checkpoint?.acceptedLeads.length, 1);

  // Summary record omits checkpoint
  const summaryRecord = readMiningSessionSummaryById(sessionId);
  assert.ok(summaryRecord);
  assert.equal(summaryRecord.id, sessionId);
  assert.equal(summaryRecord.status, 'running');
  assert.equal(summaryRecord.prompt, 'VPs of Engineering in Toronto');
  assert.equal(summaryRecord.checkpoint, undefined, 'summary record should omit checkpoint');

  // List view also omits checkpoint for performance
  const sessions = readMiningSessions(10);
  const found = sessions.find((s) => s.id === sessionId);
  assert.ok(found);
  assert.equal(found.checkpoint, undefined, 'session list view should omit checkpoint');
});
