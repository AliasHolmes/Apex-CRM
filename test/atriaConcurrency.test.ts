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
  'TOKEN_HARBOR_API_KEY',
  'TOKEN_HARBOR_ENABLED',
  'ATRIA_API_KEY',
  'ATRIA_BASE',
  'ATRIA_MODEL',
  'ATRIA_PROVIDER_NAME',
  'ATRIA_PRIORITY',
  'ATRIA_MAX_TIMEOUT_MS',
  'ATRIA_MIN_TIMEOUT_MS',
  'ATRIA_CONCURRENT_SLOTS',
  'BYESU_CONCURRENT_SLOTS',
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

describe('Atria Reasoning Dynamic Timeout & Safety Ceiling', () => {
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

  it('enforces 120s minimum floor and 600s ceiling for Atria dynamic timeout', async () => {
    const llm = await importLLM('atria-timeout-bounds');

    // 1. Minimum floor test: even tiny 50-token prompts have at least 120s (120,000ms)
    const smallTimeout = llm.computeAtriaDynamicTimeoutMs(100, [
      { role: 'user', content: 'hello' },
    ]);
    assert.ok(
      smallTimeout >= 120_000,
      `expected smallTimeout >= 120000ms, got ${smallTimeout}`,
    );

    // 2. Medium workload test: 2000 input tokens (~7000 chars) + 4000 max tokens
    // 60000 + 2000*12 (24000) + 4000*15 (60000) = 144,000ms (2.4 min)
    const mediumContent = 'word '.repeat(1400); // ~7000 chars -> ~2000 tokens
    const mediumTimeout = llm.computeAtriaDynamicTimeoutMs(4000, [
      { role: 'user', content: mediumContent },
    ]);
    assert.ok(
      mediumTimeout >= 140_000,
      `expected mediumTimeout >= 140000ms, got ${mediumTimeout}`,
    );

    // 3. Huge workload: scales up to ATRIA_MAX_TIMEOUT_MS ceiling (600,000ms / 10 min)
    const hugeContent = 'word '.repeat(30000);
    const hugeTimeout = llm.computeAtriaDynamicTimeoutMs(32000, [
      { role: 'user', content: hugeContent },
    ]);
    assert.equal(
      hugeTimeout,
      600_000,
      `expected hugeTimeout clamped to 600000ms ceiling, got ${hugeTimeout}`,
    );
  });

  it('honors ATRIA_MAX_TIMEOUT_MS and ATRIA_MIN_TIMEOUT_MS overrides from env', async () => {
    process.env.ATRIA_MIN_TIMEOUT_MS = '180000';
    process.env.ATRIA_MAX_TIMEOUT_MS = '900000';

    const llm = await importLLM('atria-timeout-overrides');

    const smallTimeout = llm.computeAtriaDynamicTimeoutMs(100, [
      { role: 'user', content: 'test' },
    ]);
    assert.ok(
      smallTimeout >= 180_000,
      `expected overridden min timeout >= 180000ms, got ${smallTimeout}`,
    );

    const hugeContent = 'word '.repeat(50000);
    const hugeTimeout = llm.computeAtriaDynamicTimeoutMs(50000, [
      { role: 'user', content: hugeContent },
    ]);
    assert.equal(
      hugeTimeout,
      900_000,
      `expected overridden max timeout = 900000ms, got ${hugeTimeout}`,
    );
  });
});

describe('Provider-Affinity Dual-Model Concurrency', () => {
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

  it('runs Atria and Byesu in parallel (1 request each) when concurrent requests arrive', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.BYESU_API_KEY = 'test-byesu-key';
    process.env.OPENAI_MODEL = 'gpt-5.6-terra';

    const llm = await importLLM('atria-byesu-parallel');
    llm.clearProviderCooldowns();

    const inFlightByProvider: Record<string, number> = { atria: 0, byesu: 0 };
    const maxInFlightByProvider: Record<string, number> = { atria: 0, byesu: 0 };
    const executedProviders: string[] = [];

    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      const providerKey = /atria/i.test(urlStr) ? 'atria' : 'byesu';

      inFlightByProvider[providerKey]++;
      maxInFlightByProvider[providerKey] = Math.max(
        maxInFlightByProvider[providerKey],
        inFlightByProvider[providerKey],
      );

      // Simulate network / model execution delay
      await new Promise((r) => setTimeout(r, 60));

      inFlightByProvider[providerKey]--;
      executedProviders.push(providerKey);

      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    };

    // Launch two requests simultaneously
    const [res1, res2] = await Promise.all([
      llm.openAIStructured<{ ok: boolean }>('Request 1', { type: 'object' }),
      llm.openAIStructured<{ ok: boolean }>('Request 2', { type: 'object' }),
    ]);

    assert.equal(res1.ok, true);
    assert.equal(res2.ok, true);

    // Both requests must have completed: one on Atria, one on Byesu!
    assert.equal(executedProviders.includes('atria'), true, 'Atria must have executed one request');
    assert.equal(executedProviders.includes('byesu'), true, 'Byesu must have executed one request');

    // Concurrency bound per provider must NEVER exceed 1
    assert.equal(
      maxInFlightByProvider.atria,
      1,
      `Atria in-flight must never exceed 1, got ${maxInFlightByProvider.atria}`,
    );
    assert.equal(
      maxInFlightByProvider.byesu,
      1,
      `Byesu in-flight must never exceed 1, got ${maxInFlightByProvider.byesu}`,
    );
  });

  it('queues subsequent requests when single provider is configured without exceeding slot limit', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    delete process.env.OPENAI_API_KEY;
    delete process.env.BYESU_API_KEY;

    const llm = await importLLM('atria-single-provider-queue');
    llm.clearProviderCooldowns();

    let atriaInFlight = 0;
    let maxAtriaInFlight = 0;
    const completionOrder: number[] = [];

    globalThis.fetch = async () => {
      atriaInFlight++;
      maxAtriaInFlight = Math.max(maxAtriaInFlight, atriaInFlight);
      await new Promise((r) => setTimeout(r, 50));
      atriaInFlight--;
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"status":"ok"}' } }],
      });
    };

    const p1 = llm.openAIStructured<{ status: string }>('Task 1', { type: 'object' }).then((r) => {
      completionOrder.push(1);
      return r;
    });
    const p2 = llm.openAIStructured<{ status: string }>('Task 2', { type: 'object' }).then((r) => {
      completionOrder.push(2);
      return r;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 'ok');
    assert.equal(r2.status, 'ok');

    // With only Atria configured, Task 2 waited for Task 1 to finish
    assert.equal(maxAtriaInFlight, 1, 'Atria in-flight must be strictly 1');
    assert.deepEqual(completionOrder, [1, 2]);
  });

  it('prioritizes Atria again once Atria finishes and frees its slot', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.BYESU_API_KEY = 'test-byesu-key';

    const llm = await importLLM('atria-reprioritization');
    llm.clearProviderCooldowns();

    const usedProviders: string[] = [];

    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      const provider = /atria/i.test(urlStr) ? 'atria' : 'byesu';
      usedProviders.push(provider);
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"done":true}' } }],
      });
    };

    // Sequential requests: Atria is always idle when each starts -> both go to Atria!
    await llm.openAIStructured<{ done: boolean }>('First call', { type: 'object' });
    await llm.openAIStructured<{ done: boolean }>('Second call', { type: 'object' });

    assert.deepEqual(
      usedProviders,
      ['atria', 'atria'],
      'Sequential calls must both prioritize Atria when idle',
    );
  });

  it('cleanly aborts queued request waiting for provider slot without leaking slots', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    delete process.env.OPENAI_API_KEY;
    delete process.env.BYESU_API_KEY;

    const llm = await importLLM('atria-abort-queue');
    llm.clearProviderCooldowns();

    const controller = new AbortController();

    globalThis.fetch = async () => {
      // First task takes 80ms
      await new Promise((r) => setTimeout(r, 80));
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    };

    // Task 1 occupies Atria slot
    const p1 = llm.openAIStructured<{ ok: boolean }>('Task 1', { type: 'object' });

    // Task 2 waits in provider slot queue and is aborted
    const p2 = llm.openAIStructured<{ ok: boolean }>('Task 2', { type: 'object' }, undefined, {
      signal: controller.signal,
    });
    const p2Rejection = assert.rejects(p2, (err: any) => err.name === 'AbortError');

    // Abort task 2 while waiting in queue
    setTimeout(() => controller.abort(), 15);

    // Task 3 waits behind task 2
    const p3 = llm.openAIStructured<{ ok: boolean }>('Task 3', { type: 'object' });

    const [res1] = await Promise.all([p1, p2Rejection]);
    assert.equal(res1.ok, true);

    // Task 3 completes cleanly after Task 1 finishes and Task 2 aborted
    const res3 = await p3;
    assert.equal(res3.ok, true);

    // Ensure all slots are zero
    assert.equal(llm.getProviderActiveSlots('atria'), 0);
  });
});

describe('Multi-Provider 4-Tier Concurrency & Policy (Atria -> Byesu -> Groq -> OpenRouter)', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_COMPLETION_CACHE = 'false';
    process.env.ATRIA_API_KEY = 'mock-atria-key';
    process.env.BYESU_API_KEY = 'mock-byesu-key';
    process.env.GROQ_API_KEY = 'mock-groq-key';
    process.env.OPENROUTER_API_KEY = 'mock-openrouter-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('waits in queue when both primaries are busy rather than spilling over to failsafe', async () => {
    const llm = await importLLM('multi-busy-wait');
    llm.clearProviderCooldowns();

    const usedProviders: string[] = [];
    const requestsBodies: any[] = [];

    globalThis.fetch = async (url: any, opts: any) => {
      const urlStr = String(url);
      const body = JSON.parse(opts.body);
      requestsBodies.push(body);

      let providerId = 'unknown';
      if (urlStr.includes('atria')) providerId = 'atria';
      else if (urlStr.includes('byesu')) providerId = 'primary';
      else if (urlStr.includes('groq')) providerId = 'groq';
      else if (urlStr.includes('openrouter')) providerId = 'openrouter';

      usedProviders.push(providerId);

      // Hold call for 50ms
      await new Promise((r) => setTimeout(r, 50));
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
      });
    };

    // Fire 3 simultaneous calls:
    // Call 1 -> Atria (slot 1)
    // Call 2 -> Byesu (slot 1)
    // Call 3 -> Must wait in queue for free primary slot, NEVER escalate to Groq!
    const [r1, r2, r3] = await Promise.all([
      llm.openAIStructured<{ ok: boolean }>('Req 1', { type: 'object' }),
      llm.openAIStructured<{ ok: boolean }>('Req 2', { type: 'object' }),
      llm.openAIStructured<{ ok: boolean }>('Req 3', { type: 'object' }),
    ]);

    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(r3.ok, true);

    // Verify all 3 went to primaries (Atria / Byesu), zero calls went to Groq or OpenRouter
    assert.ok(
      usedProviders.every((p) => p === 'atria' || p === 'primary'),
      `Expected all requests to be served by primary pair, got: ${usedProviders.join(', ')}`,
    );
    assert.ok(!(usedProviders as string[]).includes('groq'), 'Failsafe Groq was wrongly invoked when primaries were only busy!');
    assert.ok(!(usedProviders as string[]).includes('openrouter'), 'Failsafe OpenRouter was wrongly invoked!');
  });

  it('dispatches interactive requests to failsafe when primaries are genuinely out', async () => {
    const llm = await importLLM('multi-failsafe-interactive');
    llm.clearProviderCooldowns();

    // Mark primaries out
    const atriaHealth = llm.getProviderHealth('atria');
    atriaHealth.status = 'out';
    atriaHealth.outUntil = Date.now() + 60000;
    atriaHealth.outReason = 'fatal_error';

    const byesuHealth = llm.getProviderHealth('primary');
    byesuHealth.status = 'out';
    byesuHealth.outUntil = Date.now() + 60000;
    byesuHealth.outReason = 'fatal_error';

    const requestedUrls: string[] = [];
    const requestedBodies: any[] = [];

    globalThis.fetch = async (url: any, opts: any) => {
      const urlStr = String(url);
      requestedUrls.push(urlStr);
      const parsedBody = JSON.parse(opts.body);
      requestedBodies.push(parsedBody);

      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"status":"failsafe-ok"}' } }],
      });
    };

    // Interactive call: should escalate to Groq (failsafe 1)
    const result = await llm.openAIStructured<{ status: string }>(
      'Interactive query',
      { type: 'object' },
      undefined,
      { metadata: { isInteractive: true, priority: 'high' } },
    );

    assert.equal(result.status, 'failsafe-ok');
    assert.ok(requestedUrls[0].includes('api.groq.com'), `Expected Groq url, got ${requestedUrls[0]}`);

    // Verify reasoning_effort is NEVER sent to failsafe providers
    assert.equal(requestedBodies[0].reasoning_effort, undefined);
  });
});

