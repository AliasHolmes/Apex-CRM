import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clampSearchLogRetentionLimit, MiningTelemetryRecorder } from '../server/leadSearch/telemetry.ts';

test('clampSearchLogRetentionLimit enforces default and bounds', () => {
  assert.equal(clampSearchLogRetentionLimit(undefined), 50);
  assert.equal(clampSearchLogRetentionLimit('3'), 10);
  assert.equal(clampSearchLogRetentionLimit('75'), 75);
  assert.equal(clampSearchLogRetentionLimit('800'), 500);
  assert.equal(clampSearchLogRetentionLimit('not-a-number'), 50);
});

test('MiningTelemetryRecorder aggregates provider and cost summaries', () => {
  process.env.LLM_OBSERVABILITY_INPUT_COST_PER_1M = '1';
  process.env.LLM_OBSERVABILITY_OUTPUT_COST_PER_1M = '2';

  const recorder = new MiningTelemetryRecorder('session-test', 'founders in Austin', 2, '2026-07-05T00:00:00.000Z');
  recorder.record({ phase: 'session', operation: 'start', status: 'started', provider: 'system' });
  recorder.record({
    phase: 'extraction',
    operation: 'llm_extract_chunk',
    status: 'success',
    provider: 'llm',
    latencyMs: 1200,
    llm: {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      estimatedCostUsd: 0.002,
      fallbackUsed: true,
      providerAttempts: [
        { providerId: 'litellm', provider: 'LiteLLM', model: 'apex-primary', status: 'error', statusCode: 504, latencyMs: 30_000 },
        { providerId: 'openrouter', provider: 'OpenRouter', model: 'fallback-model', status: 'success', latencyMs: 900 },
      ]
    }
  });
  recorder.record({ phase: 'search', operation: 'tavily_search', status: 'error', provider: 'tavily', error: { message: 'Bearer secret-token failed' } });
  recorder.finish('success', { returned: 2, stopReason: 'target_reached' });

  const trace = recorder.getTrace();
  assert.equal(trace.status, 'success');
  assert.equal(trace.providerSummary.llm.calls, 1);
  assert.equal(trace.providerSummary.llm.totalTokens, 1500);
  assert.equal(trace.providerSummary.llm.fallbackUses, 1);
  assert.equal(trace.providerSummary.tavily.failures, 1);
  assert.equal(trace.costSummary.tokensPerAcceptedLead, 750);
  assert.equal(trace.stopReason, 'target_reached');
  assert.match(trace.events.find(event => event.error)?.error?.message || '', /REDACTED/);
});

test('insertSearchLog stores telemetry fields and culls by SEARCH_LOG_RETENTION_LIMIT', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-telemetry-'));
  process.env.APEX_DB_PATH = path.join(tmpDir, 'apex.sqlite');
  process.env.SEARCH_LOG_RETENTION_LIMIT = '10';

  const dbModule = await import(`../server/db.ts?telemetry=${Date.now()}`);
  for (let i = 0; i < 12; i++) {
    dbModule.insertSearchLog({
      id: `session-${i}`,
      timestamp: new Date(Date.UTC(2026, 6, 5, 0, i, 0)).toISOString(),
      prompt: `prompt ${i}`,
      generatedQueries: [`query ${i}`],
      status: 'success',
      rawResultsCount: i,
      leadsFound: i,
      detailedLogs: 'details',
      debugLogs: '[]',
      traceEvents: [{ id: `event-${i}`, phase: 'session', operation: 'complete', status: 'success', timestamp: new Date().toISOString() }],
      providerSummary: { llm: { calls: 1 } },
      costSummary: { estimatedUsd: 0.001, totalTokens: 100 },
      phaseTimeline: [{ phase: 'session', status: 'success', events: 1 }],
      schemaVersion: 1
    });
  }

  const logs = dbModule.readSearchLogs();
  assert.equal(logs.length, 10);
  assert.equal(logs[0].id, 'session-11');
  const newest = dbModule.readSearchLogById('session-11');
  assert.equal(newest?.traceEvents.length, 1);
  assert.equal(newest?.providerSummary.llm.calls, 1);
  assert.equal(newest?.costSummary.totalTokens, 100);
  assert.equal(dbModule.readSearchLogById('session-0'), null);

});
