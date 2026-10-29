import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;

const MANAGED_KEYS = [
  'OPENAI_API_KEY',
  'BYESU_API_KEY',
  'OPENAI_BASE',
  'OPENAI_MODEL',
  'OPENAI_PROVIDER_NAME',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'BYESU_CONCURRENT_SLOTS',
  'OPENAI_CONCURRENT_SLOTS',
  'BYESU_MIN_TIMEOUT_MS',
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

describe('Byesu Dynamic Timeout & Cloudflare Safety Ceiling', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_COMPLETION_CACHE = 'false';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('enforces 75s minimum floor and 115s Cloudflare ceiling for Byesu dynamic timeout', async () => {
    const llm = await importLLM('byesu-timeout-bounds');

    // 1. Small workload: minimum floor of 75,000ms is respected even with a tiny prompt
    const smallTimeout = llm.computeByesuDynamicTimeoutMs(100, [
      { role: 'user', content: 'hello' },
    ]);
    assert.ok(
      smallTimeout >= 75_000,
      `expected smallTimeout >= 75000ms, got ${smallTimeout}`,
    );

    // 2. Medium workload: 2000 input tokens (~7000 chars) + 4000 max tokens
    // 45000 + 2000*6 (12000) + 4000*6 (24000) = 81,000ms
    const mediumContent = 'word '.repeat(1400); // ~7000 chars -> ~2000 tokens
    const mediumTimeout = llm.computeByesuDynamicTimeoutMs(4000, [
      { role: 'user', content: mediumContent },
    ]);
    assert.ok(
      mediumTimeout >= 80_000,
      `expected mediumTimeout >= 80000ms, got ${mediumTimeout}`,
    );

    // 3. Huge workload: clamped to CLOUDFLARE_MAX_TIMEOUT_MS ceiling (115,000ms)
    const hugeContent = 'word '.repeat(30000);
    const hugeTimeout = llm.computeByesuDynamicTimeoutMs(32000, [
      { role: 'user', content: hugeContent },
    ]);
    assert.equal(
      hugeTimeout,
      llm.CLOUDFLARE_MAX_TIMEOUT_MS,
      `expected hugeTimeout clamped to ${llm.CLOUDFLARE_MAX_TIMEOUT_MS}ms ceiling, got ${hugeTimeout}`,
    );
  });

  it('honors BYESU_MIN_TIMEOUT_MS override from env', async () => {
    process.env.BYESU_MIN_TIMEOUT_MS = '90000';

    const llm = await importLLM('byesu-min-timeout-override');

    const timeout = llm.computeByesuDynamicTimeoutMs(100, [
      { role: 'user', content: 'short' },
    ]);
    assert.ok(
      timeout >= 90_000,
      `expected overridden timeout >= 90000ms, got ${timeout}`,
    );
  });

  it('honors explicit hardTimeoutMs immediately without dynamic scaling', async () => {
    const llm = await importLLM('byesu-hard-timeout');

    const timeout = llm.computeByesuDynamicTimeoutMs(
      4000,
      [{ role: 'user', content: 'test' }],
      undefined,
      undefined,
      25_000,
    );
    assert.equal(timeout, 25_000);
  });

  it('honors small test timeouts (< 1000ms)', async () => {
    const llm = await importLLM('byesu-small-timeout');

    const timeout = llm.computeByesuDynamicTimeoutMs(
      4000,
      [{ role: 'user', content: 'test' }],
      250,
    );
    assert.equal(timeout, 250);
  });

  it('respects caller requestedTimeoutMs for single candidate when non-Cloudflare', async () => {
    const llm = await importLLM('byesu-single-candidate-respect');

    const timeout = llm.computeByesuDynamicTimeoutMs(
      4000,
      [{ role: 'user', content: 'test prompt' }],
      180_000,
      { candidateCount: 1 },
      undefined,
      false, // isCloudflareBounded = false (e.g. OmniRoute)
      true,  // isReasoning = true
    );
    assert.equal(timeout, 180_000);
  });

  it('defaults single-candidate ceiling to 180s for non-Cloudflare reasoning calls', async () => {
    const llm = await importLLM('byesu-single-candidate-180s');

    const hugeContent = 'word '.repeat(5000);
    const timeout = llm.computeByesuDynamicTimeoutMs(
      20000,
      [{ role: 'user', content: hugeContent }],
      undefined,
      { candidateCount: 1 },
      undefined,
      false, // non-Cloudflare
      true,  // reasoning
    );
    assert.equal(timeout, 180_000);
  });

  it('enforces Cloudflare ceiling for single candidate when isCloudflareBounded is true', async () => {
    const llm = await importLLM('byesu-single-candidate-cloudflare');

    const hugeContent = 'word '.repeat(5000);
    const timeout = llm.computeByesuDynamicTimeoutMs(
      20000,
      [{ role: 'user', content: hugeContent }],
      180_000,
      { candidateCount: 1 },
      undefined,
      true, // Cloudflare bounded (Byesu)
      true,
    );
    assert.equal(timeout, llm.CLOUDFLARE_MAX_TIMEOUT_MS);
  });
});

describe('Byesu Concurrency & Slot Management', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_COMPLETION_CACHE = 'false';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('resolves Byesu concurrency limit from BYESU_CONCURRENT_SLOTS or defaults to 8', async () => {
    const llm = await importLLM('byesu-slots-default');
    assert.equal(llm.getProviderConcurrencyLimit('primary'), 8);

    process.env.BYESU_CONCURRENT_SLOTS = '4';
    const llm4 = await importLLM('byesu-slots-4');
    assert.equal(llm4.getProviderConcurrencyLimit('primary'), 4);

    process.env.BYESU_CONCURRENT_SLOTS = '2';
    const llm2 = await importLLM('byesu-slots-2');
    assert.equal(llm2.getProviderConcurrencyLimit('primary'), 2);
  });

  it('executes concurrent requests up to slot limit without exceeding configured slots', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.BYESU_CONCURRENT_SLOTS = '2';

    const llm = await importLLM('byesu-parallel-slots');
    llm.clearProviderCooldowns();

    let inFlight = 0;
    let maxInFlight = 0;
    const completedCalls: number[] = [];

    globalThis.fetch = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 60));
      inFlight--;
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    };

    try {
      // Launch 4 simultaneous requests with 2 configured slots:
      // Req 1 and Req 2 occupy the 2 slots.
      // Req 3 and Req 4 queue and execute as slots are released.
      const p1 = llm.openAIStructured<{ ok: boolean }>('Req 1', { type: 'object' }).then((r) => {
        completedCalls.push(1);
        return r;
      });
      const p2 = llm.openAIStructured<{ ok: boolean }>('Req 2', { type: 'object' }).then((r) => {
        completedCalls.push(2);
        return r;
      });
      const p3 = llm.openAIStructured<{ ok: boolean }>('Req 3', { type: 'object' }).then((r) => {
        completedCalls.push(3);
        return r;
      });
      const p4 = llm.openAIStructured<{ ok: boolean }>('Req 4', { type: 'object' }).then((r) => {
        completedCalls.push(4);
        return r;
      });

      const results = await Promise.all([p1, p2, p3, p4]);

      assert.equal(results.length, 4);
      assert.ok(results.every((r) => r.ok === true));
      assert.equal(maxInFlight, 2, 'In-flight Byesu calls must never exceed 2 slots');
      assert.equal(llm.getProviderActiveSlots('primary'), 0, 'All Byesu slots must be released');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('waits in queue when Byesu is busy instead of spilling over to failsafe', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.BYESU_CONCURRENT_SLOTS = '1';
    process.env.GROQ_API_KEY = 'test-groq-key';

    const llm = await importLLM('byesu-busy-no-spill');
    llm.clearProviderCooldowns();

    const usedProviders: string[] = [];

    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      const provider = urlStr.includes('byesu.com') ? 'primary' : 'groq';
      usedProviders.push(provider);
      await new Promise((r) => setTimeout(r, 40));
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    };

    try {
      // 2 simultaneous calls with 1 slot:
      // Call 2 must wait in queue for Call 1 to finish, NEVER spill to Groq!
      const [r1, r2] = await Promise.all([
        llm.openAIStructured<{ ok: boolean }>('Req 1', { type: 'object' }),
        llm.openAIStructured<{ ok: boolean }>('Req 2', { type: 'object' }),
      ]);

      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      assert.deepEqual(usedProviders, ['primary', 'primary']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cleanly aborts queued request waiting for slot without leaking active slots', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.BYESU_CONCURRENT_SLOTS = '1';

    const llm = await importLLM('byesu-abort-queue');
    llm.clearProviderCooldowns();

    const controller = new AbortController();

    globalThis.fetch = async () => {
      await new Promise((r) => setTimeout(r, 80));
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    };

    try {
      // Task 1 occupies the single Byesu slot
      const p1 = llm.openAIStructured<{ ok: boolean }>('Task 1', { type: 'object' });

      // Task 2 waits in provider slot queue and is aborted
      const p2 = llm.openAIStructured<{ ok: boolean }>('Task 2', { type: 'object' }, undefined, {
        signal: controller.signal,
      });
      const p2Rejection = assert.rejects(p2, (err: any) => err.name === 'AbortError');

      // Abort task 2 while waiting in queue
      setTimeout(() => controller.abort(), 20);

      // Task 3 waits behind task 2
      const p3 = llm.openAIStructured<{ ok: boolean }>('Task 3', { type: 'object' });

      const [res1] = await Promise.all([p1, p2Rejection]);
      assert.equal(res1.ok, true);

      // Task 3 completes cleanly
      const res3 = await p3;
      assert.equal(res3.ok, true);

      // Ensure active slot count is strictly 0
      assert.equal(llm.getProviderActiveSlots('primary'), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes to Tier 2 failsafe when Byesu is genuinely marked OUT', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.GROQ_API_KEY = 'test-groq-key';

    const llm = await importLLM('byesu-out-failsafe');
    llm.clearProviderCooldowns();

    // Mark Byesu OUT
    const byesuHealth = llm.getProviderHealth('primary');
    byesuHealth.status = 'out';
    byesuHealth.outUntil = Date.now() + 60_000;
    byesuHealth.outReason = 'fatal_error';

    const usedProviders: string[] = [];
    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      usedProviders.push(urlStr.includes('api.groq.com') ? 'groq' : 'byesu');
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    };

    try {
      const res = await llm.openAIStructured<{ ok: boolean }>('Req', { type: 'object' });
      assert.equal(res.ok, true);
      assert.deepEqual(usedProviders, ['groq']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
