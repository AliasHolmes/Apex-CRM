import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { validateEngineConfig } from '../server/configValidation.ts';

const MANAGED_KEYS = [
  'ATRIA_API_KEY',
  'ATRIA_BASE',
  'ATRIA_MODEL',
  'ATRIA_PRIORITY',
  'ATRIA_CONCURRENT_SLOTS',
  'BYESU_API_KEY',
  'BYESU_CONCURRENT_SLOTS',
  'OPENAI_API_KEY',
  'LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK',
  'LEAD_EXTRACTION_CONCURRENCY',
  'FINALIST_JUDGE_MICRO_BATCH_SIZE',
  'FINALIST_JUDGE_CONCURRENCY',
  'LLM_COMPLETION_CACHE',
] as const;

const envSnapshot: Record<string, string | undefined> = {};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function importLLM(suffix: string): Promise<typeof import('../server/services/llm.ts')> {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

describe('Optimal Concurrency & Micro-Batching Architecture', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_COMPLETION_CACHE = 'false';
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('validates engine configuration bounds for Atria slots and micro-batch sizes', () => {
    // 1. Clean recommended configuration: no warnings for 4 slots, chunk 3, batch 2
    process.env.ATRIA_CONCURRENT_SLOTS = '4';
    process.env.LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK = '3';
    process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE = '2';
    process.env.LEAD_EXTRACTION_CONCURRENCY = '4';
    process.env.FINALIST_JUDGE_CONCURRENCY = '4';

    const cleanWarnings = validateEngineConfig();
    assert.deepEqual(
      cleanWarnings.filter(w =>
        w.includes('ATRIA_CONCURRENT_SLOTS') ||
        w.includes('LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK') ||
        w.includes('FINALIST_JUDGE_MICRO_BATCH_SIZE')
      ),
      [],
      'Recommended quad micro-batch config must not emit warnings',
    );

    // 2. Over-budget configuration: warning emitted when slots > 4 or batch > 5
    process.env.ATRIA_CONCURRENT_SLOTS = '6';
    process.env.LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK = '8';
    process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE = '10';

    const badWarnings = validateEngineConfig();
    assert.ok(
      badWarnings.some(w => w.includes('ATRIA_CONCURRENT_SLOTS')),
      'Should warn when ATRIA_CONCURRENT_SLOTS > 4',
    );
    assert.ok(
      badWarnings.some(w => w.includes('LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK')),
      'Should warn when extraction chunk size > 5',
    );
    assert.ok(
      badWarnings.some(w => w.includes('FINALIST_JUDGE_MICRO_BATCH_SIZE')),
      'Should warn when judge micro-batch size > 5',
    );
  });

  it('allows Atria to handle up to 4 concurrent requests simultaneously when ATRIA_CONCURRENT_SLOTS=4', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.ATRIA_CONCURRENT_SLOTS = '4';
    delete process.env.OPENAI_API_KEY;
    delete process.env.BYESU_API_KEY;

    const originalFetch = globalThis.fetch;
    const llm = await importLLM('atria-quad-slots');
    llm.clearProviderCooldowns();

    let activeAtriaInFlight = 0;
    let maxAtriaInFlight = 0;

    globalThis.fetch = async () => {
      activeAtriaInFlight++;
      maxAtriaInFlight = Math.max(maxAtriaInFlight, activeAtriaInFlight);
      // Hold each call briefly so all 4 overlap concurrently
      await new Promise((r) => setTimeout(r, 60));
      activeAtriaInFlight--;
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"status":"ok"}' } }],
      });
    };

    try {
      // Fire 4 requests simultaneously
      const results = await Promise.all([
        llm.openAIStructured<{ status: string }>('Task 1', { type: 'object' }),
        llm.openAIStructured<{ status: string }>('Task 2', { type: 'object' }),
        llm.openAIStructured<{ status: string }>('Task 3', { type: 'object' }),
        llm.openAIStructured<{ status: string }>('Task 4', { type: 'object' }),
      ]);

      assert.equal(results.length, 4);
      assert.ok(results.every(r => r.status === 'ok'));
      // All 4 requests must have been running in parallel on Atria simultaneously!
      assert.equal(
        maxAtriaInFlight,
        4,
        `Expected max in-flight on Atria to reach 4, got ${maxAtriaInFlight}`,
      );
      assert.equal(llm.getProviderActiveSlots('atria'), 0, 'All slots must be released cleanly');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queues a 5th request when Atria 4-slot capacity is fully saturated', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.ATRIA_CONCURRENT_SLOTS = '4';
    delete process.env.OPENAI_API_KEY;
    delete process.env.BYESU_API_KEY;

    const originalFetch = globalThis.fetch;
    const llm = await importLLM('atria-quad-saturation');
    llm.clearProviderCooldowns();

    let activeAtriaInFlight = 0;
    let maxAtriaInFlight = 0;

    globalThis.fetch = async () => {
      activeAtriaInFlight++;
      maxAtriaInFlight = Math.max(maxAtriaInFlight, activeAtriaInFlight);
      await new Promise((r) => setTimeout(r, 60));
      activeAtriaInFlight--;
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"status":"ok"}' } }],
      });
    };

    try {
      // Launch 5 requests simultaneously
      const results = await Promise.all([
        llm.openAIStructured<{ status: string }>('Task 1', { type: 'object' }),
        llm.openAIStructured<{ status: string }>('Task 2', { type: 'object' }),
        llm.openAIStructured<{ status: string }>('Task 3', { type: 'object' }),
        llm.openAIStructured<{ status: string }>('Task 4', { type: 'object' }),
        llm.openAIStructured<{ status: string }>('Task 5', { type: 'object' }),
      ]);

      assert.equal(results.length, 5);
      // Max in-flight must never exceed 4 (the slot limit)
      assert.equal(
        maxAtriaInFlight,
        4,
        `In-flight must strictly cap at 4, got ${maxAtriaInFlight}`,
      );
      assert.equal(llm.getProviderActiveSlots('atria'), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
