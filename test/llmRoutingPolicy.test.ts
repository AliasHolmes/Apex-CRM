import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;

const MANAGED_KEYS = [
  'OPENAI_API_KEY',
  'BYESU_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'ATRIA_API_KEY',
  'ATRIA_BASE',
  'ATRIA_PRIORITY',
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

const isAtria = (url: unknown) => String(url).includes('atria-asi.ai');
const isByesu = (url: unknown) => String(url).includes('byesu.com');

describe('LLM routing policy (Atria primary, Byesu secondary, failsafe only when both are out)', () => {
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

  it('a short per-call timeoutMs never blocks the Byesu fallback after an Atria failure', async () => {
    process.env.ATRIA_API_KEY = 'a';
    process.env.BYESU_API_KEY = 'b';
    process.env.GROQ_API_KEY = 'g';
    const llm = await importLLM('budget-byesu');
    const urls: string[] = [];
    globalThis.fetch = async (url: any) => {
      urls.push(String(url));
      if (isAtria(url)) {
        await new Promise((r) => setTimeout(r, 30));
        return new Response('upstream error', { status: 500 });
      }
      return okChat('byesu ok');
    };
    // The old budget was timeoutMs * 2 (= 20ms here), which rejected before Byesu was tried.
    const res = await llm.openAIText('p', undefined, { timeoutMs: 10 });
    assert.equal(res.text, 'byesu ok');
    assert.equal(res.provider, 'Byesu');
    assert.ok(urls.some(isAtria), 'Atria should be attempted first');
    assert.ok(!urls.some((u) => u.includes('groq.com')), 'the failsafe must not be used');
  });

  it('re-admits a provider the session breaker disabled once its OUT window ends', async () => {
    process.env.ATRIA_API_KEY = 'a';
    process.env.BYESU_API_KEY = 'b';
    const llm = await importLLM('half-open-readmit');
    const breaker = llm.createLLMSessionCircuitBreaker(4);

    let atriaHealthy = false;
    globalThis.fetch = async (url: any) => {
      if (isAtria(url)) {
        return atriaHealthy ? okChat('atria ok') : new Response('invalid api key', { status: 401 });
      }
      return okChat('byesu ok');
    };

    const first = await llm.openAIText('p1', undefined, { circuitBreaker: breaker });
    assert.equal(first.text, 'byesu ok');
    assert.equal(breaker.disabledProviderIds.has('atria'), true);
    assert.equal(llm.getProviderHealth('atria').status, 'out');

    // The OUT window ends: health moves to half-open and the breaker must let Atria be re-tested.
    llm.getProviderHealth('atria').outUntil = Date.now() - 1;
    atriaHealthy = true;
    const second = await llm.openAIText('p2', undefined, { circuitBreaker: breaker });
    assert.equal(second.text, 'atria ok');
    assert.equal(breaker.disabledProviderIds.has('atria'), false);
    assert.equal(llm.getProviderHealth('atria').status, 'healthy');
  });

  it('keeps a manually disabled provider disabled for the session', async () => {
    process.env.ATRIA_API_KEY = 'a';
    process.env.BYESU_API_KEY = 'b';
    const llm = await importLLM('manual-disable');
    const breaker = llm.createLLMSessionCircuitBreaker(4);
    breaker.disabledProviderIds.add('atria');
    const urls: string[] = [];
    globalThis.fetch = async (url: any) => {
      urls.push(String(url));
      return okChat('ok');
    };
    const res = await llm.openAIText('p', undefined, { circuitBreaker: breaker });
    assert.equal(res.provider, 'Byesu');
    assert.ok(!urls.some(isAtria));
    assert.equal(breaker.disabledProviderIds.has('atria'), true);
  });

  it('prefers the partner over a provider that is only cooling down', async () => {
    process.env.ATRIA_API_KEY = 'a';
    process.env.BYESU_API_KEY = 'b';
    process.env.GROQ_API_KEY = 'g';
    const llm = await importLLM('cooling-prefers-partner');
    const urls: string[] = [];
    globalThis.fetch = async (url: any) => {
      urls.push(String(url));
      return okChat('ok');
    };
    const health = llm.getProviderHealth('atria');
    health.status = 'cooling_down';
    health.cooldownUntil = Date.now() + 60_000;
    llm.providerCooldowns.set('atria', health.cooldownUntil);

    assert.equal(llm.isProviderOut('atria'), false, 'cooling down is not out');
    const res = await llm.openAIText('p');
    assert.equal(res.provider, 'Byesu');
    assert.ok(!urls.some((u) => u.includes('groq.com')));
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

  it('health probes honor a strict timeoutMs (no Atria 120s floor) and do not retry', async () => {
    process.env.ATRIA_API_KEY = 'a';
    process.env.LLM_MAX_RETRIES = '3';
    const llm = await importLLM('health-probe-timeout');
    let atriaCalls = 0;
    globalThis.fetch = (async (url: any, init: any) => {
      if (isAtria(url)) atriaCalls++;
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
    assert.equal(atriaCalls, 1);
    assert.equal(llm.getProviderHealth('atria').status, 'healthy');
  });

  it('health probes report a busy provider instead of queueing behind real work', async () => {
    process.env.BYESU_API_KEY = 'b';
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
        /busy/,
      );
      assert.ok(Date.now() - started < 1_000);
      assert.equal(calls, 0);
    } finally {
      llm.releaseProviderSlot('primary');
    }
  });

  it('describeLLMRoute reports the failsafe provider when both primaries are out', async () => {
    process.env.ATRIA_API_KEY = 'a';
    process.env.BYESU_API_KEY = 'b';
    process.env.GROQ_API_KEY = 'g';
    const llm = await importLLM('route-health-aware');
    assert.equal(llm.describeLLMRoute('fast').providerId, 'atria');
    for (const id of ['atria', 'primary']) {
      const h = llm.getProviderHealth(id);
      h.status = 'out';
      h.outUntil = Date.now() + 60_000;
    }
    const route = llm.describeLLMRoute('fast');
    assert.equal(route.providerId, 'groq');
    assert.equal(route.outputTokenCap, 950);
  });
});
