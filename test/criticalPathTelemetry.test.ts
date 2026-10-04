import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MiningTelemetryRecorder,
  classifyCriticalPathStage,
  formatCriticalPathLine,
} from '../server/leadSearch/telemetry.js';

const llmEvent = (
  phase: any,
  operation: string,
  round: number | undefined,
  attempts: Array<{ latencyMs: number; queueWaitMs?: number }>,
) => ({
  phase,
  operation,
  status: 'success' as const,
  provider: 'llm' as const,
  round,
  latencyMs: Math.max(...attempts.map((a) => a.latencyMs)),
  llm: {
    providerAttempts: attempts.map((a) => ({
      providerId: 'atria',
      provider: 'Atria',
      model: 'm',
      status: 'success' as const,
      ...a,
    })),
  } as any,
});

test('classifies trace events into critical-path stages', () => {
  assert.equal(classifyCriticalPathStage({ phase: 'candidate_processing', operation: 'incremental_finalist_judge' }), 'judge');
  assert.equal(classifyCriticalPathStage({ phase: 'extraction', operation: 'llm_extraction_chunk' }), 'extract');
  assert.equal(classifyCriticalPathStage({ phase: 'strategy', operation: 'plan' }), 'plan');
  assert.equal(classifyCriticalPathStage({ phase: 'enrichment', operation: 'x' }), 'enrich');
  assert.equal(classifyCriticalPathStage({ phase: 'search', operation: 'x' }), 'search');
  assert.equal(classifyCriticalPathStage({ phase: 'persistence', operation: 'x' }), 'other');
});

test('the recorder splits LLM time and queue wait by round and stage', () => {
  const recorder = new MiningTelemetryRecorder('s1', 'q', 10);
  recorder.record(llmEvent('extraction', 'chunk', 1, [{ latencyMs: 7000, queueWaitMs: 100 }]));
  recorder.record(llmEvent('extraction', 'chunk', 1, [{ latencyMs: 5000, queueWaitMs: 300 }]));
  recorder.record(llmEvent('candidate_processing', 'incremental_finalist_judge', 1, [{ latencyMs: 20000, queueWaitMs: 400 }]));
  recorder.record(llmEvent('candidate_processing', 'incremental_finalist_judge', 2, [{ latencyMs: 9000 }]));

  const round1 = recorder.getRoundLatency(1);
  assert.deepEqual(round1.extract, { calls: 2, llmMs: 12000, queueMs: 400 });
  assert.deepEqual(round1.judge, { calls: 1, llmMs: 20000, queueMs: 400 });
  assert.deepEqual(recorder.getRoundLatency(2).judge, { calls: 1, llmMs: 9000, queueMs: 0 });
  assert.deepEqual(recorder.getRoundLatency(3), {});
});

test('failed attempts inside a call still count toward LLM time', () => {
  const recorder = new MiningTelemetryRecorder('s2', 'q', 10);
  recorder.record(llmEvent('extraction', 'chunk', 1, [{ latencyMs: 30000 }, { latencyMs: 8000, queueWaitMs: 50 }]));
  assert.deepEqual(recorder.getRoundLatency(1).extract, { calls: 1, llmMs: 38000, queueMs: 50 });
});

test('events without a round or without provider attempts are ignored', () => {
  const recorder = new MiningTelemetryRecorder('s3', 'q', 10);
  recorder.record(llmEvent('extraction', 'chunk', undefined, [{ latencyMs: 1000 }]));
  recorder.record({ phase: 'extraction', operation: 'chunk', status: 'success', provider: 'llm', round: 1 } as any);
  assert.deepEqual(recorder.getRoundLatency(1), {});
});

test('latency totals survive the bounded event ring trimming old events', () => {
  const previous = process.env.LEAD_TELEMETRY_MAX_EVENTS;
  process.env.LEAD_TELEMETRY_MAX_EVENTS = '500';
  try {
    const recorder = new MiningTelemetryRecorder('s4', 'q', 10);
    for (let i = 0; i < 700; i++) {
      recorder.record(llmEvent('extraction', 'chunk', 1, [{ latencyMs: 10, queueWaitMs: 1 }]));
    }
    assert.ok(recorder.getEvents().length <= 500, 'the ring did trim');
    assert.deepEqual(recorder.getRoundLatency(1).extract, { calls: 700, llmMs: 7000, queueMs: 700 });
  } finally {
    if (previous === undefined) delete process.env.LEAD_TELEMETRY_MAX_EVENTS;
    else process.env.LEAD_TELEMETRY_MAX_EVENTS = previous;
  }
});

test('formats a readable critical-path line with stages in pipeline order', () => {
  const line = formatCriticalPathLine(
    1,
    { judge: 21000, search: 4200, extract: 8500 },
    {
      extract: { calls: 3, llmMs: 7200, queueMs: 100 },
      judge: { calls: 4, llmMs: 19800, queueMs: 400 },
    },
  );
  assert.equal(
    line,
    '[Round 1 Critical Path] Search: 4.2s | Extract: 8.5s (3 calls, LLM sum 7.2s, Queue sum 0.1s) | Judge: 21.0s (4 calls, LLM sum 19.8s, Queue sum 0.4s) | Total: 33.7s',
  );
});

test('stages with no time and no calls are omitted', () => {
  const line = formatCriticalPathLine(2, { plan: 0, judge: 1500 }, {});
  assert.equal(line, '[Round 2 Critical Path] Judge: 1.5s | Total: 1.5s');
});

test('the recorder formats using its own accumulated latency', () => {
  const recorder = new MiningTelemetryRecorder('s5', 'q', 10);
  recorder.record(llmEvent('candidate_processing', 'incremental_finalist_judge', 1, [{ latencyMs: 2000, queueWaitMs: 200 }]));
  assert.equal(
    recorder.formatRoundCriticalPath(1, { judge: 2500 }),
    '[Round 1 Critical Path] Judge: 2.5s (1 call, LLM sum 2.0s, Queue sum 0.2s) | Total: 2.5s',
  );
});
