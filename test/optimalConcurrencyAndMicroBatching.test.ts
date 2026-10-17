import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { validateEngineConfig } from '../server/configValidation.ts';

const MANAGED_KEYS = [
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

  it('validates engine configuration bounds for Byesu slots and micro-batch sizes', () => {
    // 1. Clean recommended configuration: no warnings for the shipped config
    process.env.BYESU_CONCURRENT_SLOTS = '8';
    process.env.LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK = '3';
    process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE = '2';
    process.env.LEAD_EXTRACTION_CONCURRENCY = '8';
    process.env.FINALIST_JUDGE_CONCURRENCY = '6';

    const cleanWarnings = validateEngineConfig();
    assert.deepEqual(
      cleanWarnings.filter(w =>
        w.includes('BYESU_CONCURRENT_SLOTS') ||
        w.includes('LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK') ||
        w.includes('FINALIST_JUDGE_MICRO_BATCH_SIZE')
      ),
      [],
      'The shipped 8-slot Byesu config must not emit warnings',
    );

    // 2. Over-budget configuration: warning emitted past the recommended envelopes
    process.env.BYESU_CONCURRENT_SLOTS = '24';
    process.env.LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK = '8';
    process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE = '10';

    const badWarnings = validateEngineConfig();
    assert.ok(
      badWarnings.some(w => w.includes('BYESU_CONCURRENT_SLOTS')),
      'Should warn when BYESU_CONCURRENT_SLOTS > 16',
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

  it('allows Byesu to handle up to 8 concurrent requests simultaneously when BYESU_CONCURRENT_SLOTS=8', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.BYESU_CONCURRENT_SLOTS = '8';

    const originalFetch = globalThis.fetch;
    const llm = await importLLM('byesu-eight-slots');
    llm.clearProviderCooldowns();

    let activeInFlight = 0;
    let maxInFlight = 0;

    globalThis.fetch = async () => {
      activeInFlight++;
      maxInFlight = Math.max(maxInFlight, activeInFlight);
      // Hold each call briefly so all 8 overlap concurrently
      await new Promise((r) => setTimeout(r, 60));
      activeInFlight--;
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"status":"ok"}' } }],
      });
    };

    try {
      // Fire 8 requests simultaneously
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          llm.openAIStructured<{ status: string }>(`Task ${i + 1}`, { type: 'object' }),
        ),
      );

      assert.equal(results.length, 8);
      assert.ok(results.every(r => r.status === 'ok'));
      // All 8 requests must have been running in parallel on Byesu simultaneously!
      assert.equal(
        maxInFlight,
        8,
        `Expected max in-flight on Byesu to reach 8, got ${maxInFlight}`,
      );
      assert.equal(llm.getProviderActiveSlots('primary'), 0, 'All slots must be released cleanly');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queues a 9th request when Byesu 8-slot capacity is fully saturated', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.BYESU_CONCURRENT_SLOTS = '8';

    const originalFetch = globalThis.fetch;
    const llm = await importLLM('byesu-eight-saturation');
    llm.clearProviderCooldowns();

    let activeInFlight = 0;
    let maxInFlight = 0;

    globalThis.fetch = async () => {
      activeInFlight++;
      maxInFlight = Math.max(maxInFlight, activeInFlight);
      await new Promise((r) => setTimeout(r, 60));
      activeInFlight--;
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"status":"ok"}' } }],
      });
    };

    try {
      // Launch 9 requests simultaneously
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          llm.openAIStructured<{ status: string }>(`Task ${i + 1}`, { type: 'object' }),
        ),
      );

      assert.equal(results.length, 9);
      // Max in-flight must never exceed 8 (the slot limit)
      assert.equal(
        maxInFlight,
        8,
        `In-flight must strictly cap at 8, got ${maxInFlight}`,
      );
      assert.equal(llm.getProviderActiveSlots('primary'), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
