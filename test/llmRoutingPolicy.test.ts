import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;

const MANAGED_KEYS = [
  'OPENAI_API_KEY',
  'BYESU_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'BYESU_CONCURRENT_SLOTS',
  'LLM_MAX_RETRIES',
  'LLM_RETRY_429',
  'LLM_COMPLETION_CACHE',
  'LLM_PROVIDER_COOLDOWN_MS',
] as const;

const envSnapshot: Record<string, string | undefined> = {};

const okChat = (content: string) =>
  new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

async function importLLM(suffix: string): Promise<typeof import('../server/services/llm.ts')> {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

const isByesu = (url: unknown) => String(url).includes('byesu.com');

describe('LLM routing policy (Byesu primary, failsafe only when primary is out)', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_COMPLETION_CACHE = 'false';
    process.env.LLM_MAX_RETRIES = '0';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('a short per-call timeoutMs never blocks the failsafe fallback after a primary failure', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    const llm = await importLLM('budget-groq');
    const urls: string[] = [];
    globalThis.fetch = async (url: any) => {
      urls.push(String(url));
      if (isByesu(url)) {
        return new Response('invalid api key', { status: 401 });
      }
      return okChat('groq ok');
    };
    const res = await llm.openAIText('p', undefined, { timeoutMs: 10 });
    assert.equal(res.text, 'groq ok');
    assert.equal(res.provider, 'Groq');
    assert.ok(urls.some(isByesu), 'Byesu should be attempted first');
    assert.ok(urls.some((u) => u.includes('groq.com')), 'the failsafe should be used');
  });

  it('re-admits a provider the session breaker disabled once its OUT window ends', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    const llm = await importLLM('half-open-readmit');
    const breaker = llm.createLLMSessionCircuitBreaker(4);

    let byesuHealthy = false;
    globalThis.fetch = async (url: any) => {
      if (isByesu(url)) {
        return byesuHealthy ? okChat('byesu ok') : new Response('invalid api key', { status: 401 });
      }
      return okChat('groq ok');
    };

    // Byesu's auth failure marks it OUT: failsafe serves.
    const first = await llm.openAIText('p1', undefined, { circuitBreaker: breaker });
    assert.equal(first.text, 'groq ok');
    assert.equal(breaker.disabledProviderIds.has('primary'), true);
    assert.equal(llm.getProviderHealth('primary').status, 'out');

    // The OUT window ends: health moves to half-open and the breaker must let Byesu be re-tested.
    llm.getProviderHealth('primary').outUntil = Date.now() - 1;
    byesuHealthy = true;
    const second = await llm.openAIText('p2', undefined, { circuitBreaker: breaker });
    assert.equal(second.text, 'byesu ok');
    assert.equal(breaker.disabledProviderIds.has('primary'), false);
    assert.equal(llm.getProviderHealth('primary').status, 'healthy');
  });

  it('keeps a manually disabled provider disabled for the session', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    const llm = await importLLM('manual-disable');
    const breaker = llm.createLLMSessionCircuitBreaker(4);
    breaker.disabledProviderIds.add('primary');
    const urls: string[] = [];
    globalThis.fetch = async (url: any) => {
      urls.push(String(url));
      return okChat('groq ok');
    };
    const res = await llm.openAIText('p', undefined, { circuitBreaker: breaker });
    assert.equal(res.provider, 'Groq');
    assert.ok(!urls.some(isByesu));
    assert.equal(breaker.disabledProviderIds.has('primary'), true);
  });

  it('a cooling-down provider is not marked out and still serves once cooldown expires or slot is free', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    const llm = await importLLM('cooling-not-out');
    const health = llm.getProviderHealth('primary');
    health.status = 'cooling_down';
    health.cooldownUntil = Date.now() + 60_000;
    llm.providerCooldowns.set('primary', health.cooldownUntil);

    assert.equal(llm.isProviderOut('primary'), false, 'cooling down is not out');
    globalThis.fetch = async () => okChat('byesu ok');
    const res = await llm.openAIText('p');
    assert.equal(res.provider, 'Byesu');
  });

  it('does not start a cooldown after an unparseable answer', async () => {
    process.env.BYESU_API_KEY = 'b';
    const llm = await importLLM('parse-no-cooldown');
    llm.recordProviderFailure(
      'primary',
      new Error('[Byesu] Failed to parse OpenAI-compatible JSON response (parse_error=Unexpected token)'),
    );
    assert.equal(llm.isProviderCoolingDown('primary'), false);
    assert.equal(llm.getProviderHealth('primary').status, 'healthy');
  });

  it('health probes neither change provider health nor reach the failsafe', async () => {
    process.env.BYESU_API_KEY = 'b';
    process.env.GROQ_API_KEY = 'g';
    const llm = await importLLM('health-probe');
    const urls: string[] = [];
    globalThis.fetch = async (url: any) => {
      urls.push(String(url));
      if (isByesu(url)) return new Response('upstream error', { status: 503 });
      return okChat('groq ok');
    };
    await assert.rejects(() => llm.openAIText('ping', undefined, { metadata: { healthProbe: true } }));
    assert.equal(llm.getProviderHealth('primary').status, 'healthy');
    assert.equal(llm.isProviderCoolingDown('primary'), false);
    assert.ok(!urls.some((u) => u.includes('groq.com')));
  });

  it('health probes honor a strict timeoutMs (no workload floor) and do not retry', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.LLM_MAX_RETRIES = '3';
    const llm = await importLLM('health-probe-timeout');
    let byesuCalls = 0;
    globalThis.fetch = (async (url: any, init: any) => {
      if (isByesu(url)) byesuCalls++;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;
    const started = Date.now();
    await assert.rejects(() =>
      llm.openAIText('ping', undefined, { timeoutMs: 150, metadata: { healthProbe: true } }),
    );
    assert.ok(Date.now() - started < 3_000, `probe took ${Date.now() - started}ms`);
    assert.equal(byesuCalls, 1);
    assert.equal(llm.getProviderHealth('primary').status, 'healthy');
  });

  it('health probes report a busy provider instead of queueing behind real work', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.BYESU_CONCURRENT_SLOTS = '1';
    const llm = await importLLM('health-probe-busy');
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return okChat('ok');
    };
    llm.acquireProviderSlot('primary');
    try {
      const started = Date.now();
      await assert.rejects(
        () => llm.openAIText('ping', undefined, { metadata: { healthProbe: true } }),
        /busy/i,
      );
      assert.ok(Date.now() - started < 1_000);
      assert.equal(calls, 0);
    } finally {
      llm.releaseProviderSlot('primary');
    }
  });

  it('describeLLMRoute reports the failsafe provider when primary is out', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    const llm = await importLLM('route-health-aware');
    assert.equal(llm.describeLLMRoute('fast').providerId, 'primary');
    const h = llm.getProviderHealth('primary');
    h.status = 'out';
    h.outUntil = Date.now() + 60_000;
    const route = llm.describeLLMRoute('fast');
    assert.equal(route.providerId, 'groq');
    assert.equal(route.outputTokenCap, 950);
  });
});
