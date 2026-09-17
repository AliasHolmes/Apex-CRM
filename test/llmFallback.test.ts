import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;

const MANAGED_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE',
  'OPENAI_MODEL',
  'OPENAI_PROVIDER_NAME',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_MODEL',
  'OPENROUTER_PROVIDER_NAME',
  'OPENROUTER_APP_TITLE',
  'OPENROUTER_HTTP_REFERER',
  'GROQ_API_KEY',
  'GROQ_BASE_URL',
  'GROQ_MODEL',
  'TOKEN_HARBOR_API_KEY',
  'TOKEN_HARBOR_BASE',
  'TOKEN_HARBOR_MODEL',
  'TOKEN_HARBOR_ENABLED',
  'TOKEN_HARBOR_EXPIRATION_MS',
  'TOKEN_HARBOR_EXPIRATION',
  'ATRIA_API_KEY',
  'ATRIA_BASE',
  'ATRIA_MODEL',
  'ATRIA_PROVIDER_NAME',
  'ATRIA_PRIORITY',
  'LLM_GATEWAY_MODE',
  'LLM_MAX_RETRIES',
  'LLM_TIMEOUT_MS',
  'LLM_PROVIDER_COOLDOWN_MS',
  'LLM_SESSION_PROVIDER_FAILURE_THRESHOLD',
  'LLM_RETRY_429',
  'BYESU_API_KEY',
  'APP_URL',
] as const;

const envSnapshot: Record<string, string | undefined> = {};

async function importLLM(suffix: string) {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

describe('LLM gateway and provider fallback', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('uses Byesu-compatible primary defaults first', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('primary');

    assert.equal(llm.getAPIKey(), 'test-primary-key');
    assert.equal(llm.hasOpenAIKey(), true);

    let capturedUrl = '';
    let capturedOptions: any = null;

    globalThis.fetch = async (url, options) => {
      capturedUrl = url.toString();
      capturedOptions = options;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'ok');
    assert.equal(res.provider, 'Byesu');
    assert.equal(capturedUrl, 'https://byesu.com/v1/chat/completions');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer test-primary-key');

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.stream, false);
  });

  it('opens the session circuit breaker after two availability failures', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('session-circuit-breaker');
    const breaker = llm.createLLMSessionCircuitBreaker(2);
    const calls: string[] = [];

    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      if (url.toString().startsWith('https://byesu.com/')) {
        return new Response('primary timeout', { status: 504 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'fallback ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    for (let call = 0; call < 3; call++) {
      await llm.openAIText('test prompt', undefined, { circuitBreaker: breaker });
    }

    assert.equal(calls.filter(url => url.startsWith('https://byesu.com/')).length, 2);
    assert.equal(calls.filter(url => url.startsWith('https://openrouter.ai/')).length, 3);
    assert.equal(breaker.disabledProviderIds.has('primary'), true);
  });

  it('does not trip the session circuit breaker on transient 429 rate limits', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_MAX_RETRIES = '0';
    process.env.LLM_PROVIDER_COOLDOWN_MS = '0';

    const llm = await importLLM('circuit-breaker-429');
    const breaker = llm.createLLMSessionCircuitBreaker(2);
    const calls: string[] = [];

    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      if (url.toString().startsWith('https://byesu.com/')) {
        return new Response('rate limited', { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'fallback ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    for (let call = 0; call < 3; call++) {
      await llm.openAIText('test prompt', undefined, { circuitBreaker: breaker });
    }

    // All 3 calls attempted primary first because 429 does not trip the breaker
    assert.equal(calls.filter(url => url.startsWith('https://byesu.com/')).length, 3);
    assert.equal(calls.filter(url => url.startsWith('https://openrouter.ai/')).length, 3);
    assert.equal(breaker.disabledProviderIds.has('primary'), false);
  });

  it('never retries an unchanged 413 payload', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.LLM_MAX_RETRIES = '3';
    process.env.LLM_RETRY_429 = 'true';

    const llm = await importLLM('payload-too-large');
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response('payload too large', { status: 413 });
    };

    await assert.rejects(() => llm.openAIText('test prompt'), /413/);
    assert.equal(calls, 1);
  });

  it('honors Retry-After when 429 retries are explicitly enabled', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.LLM_MAX_RETRIES = '1';
    process.env.LLM_RETRY_429 = 'true';

    const llm = await importLLM('retry-after');
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const response = await llm.openAIText('test prompt');
    assert.equal(response.text, 'ok');
    assert.equal(calls, 2);
  });

  it('falls back directly to OpenRouter when the primary provider fails', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_MODEL = 'openrouter-test-model';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('openrouter-fallback');
    const calls: Array<{ url: string; body: any; auth: string; title?: string }> = [];

    globalThis.fetch = async (url, options: any) => {
      calls.push({
        url: url.toString(),
        body: JSON.parse(options.body),
        auth: options.headers['Authorization'],
        title: options.headers['X-Title'],
      });

      if (calls.length === 1) {
        return new Response('primary unavailable', { status: 503 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'fallback ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'fallback ok');
    assert.equal(res.provider, 'OpenRouter');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://byesu.com/v1/chat/completions');
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[1].auth, 'Bearer test-openrouter-key');
    assert.equal(calls[1].title, 'Apex CRM');
    assert.equal(calls[1].body.model, 'openrouter-test-model');
  });

  it('falls back to Groq after primary and OpenRouter fail', async () => {
    process.env.BYESU_API_KEY = 'test-byesu-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.LLM_MAX_RETRIES = '0';
    process.env.LLM_RETRY_429 = 'false';

    const llm = await importLLM('openrouter-groq-fallback');
    const calls: Array<{ url: string; body: any; auth: string }> = [];

    globalThis.fetch = async (url, options: any) => {
      calls.push({
        url: url.toString(),
        body: JSON.parse(options.body),
        auth: options.headers['Authorization'],
      });

      if (calls.length < 3) {
        return new Response('provider unavailable', { status: 429 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'groq ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'groq ok');
    assert.equal(res.provider, 'Groq');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[1].auth, 'Bearer test-openrouter-key');
    assert.equal(calls[1].body.model, 'meta-llama/llama-3.3-70b-instruct:free');
    assert.equal(calls[2].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls[2].auth, 'Bearer test-groq-key');
    assert.equal(calls[2].body.model, 'llama-3.3-70b-versatile');
  });

  it('uses default Llama models for OpenRouter and Groq fallbacks when env overrides are omitted', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('default-llama-models');
    const calls: Array<{ url: string; body: any }> = [];

    globalThis.fetch = async (url, options: any) => {
      calls.push({
        url: url.toString(),
        body: JSON.parse(options.body),
      });

      if (calls.length <= 2) {
        return new Response('primary unavailable', { status: 503 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'groq ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'groq ok');
    assert.equal(res.provider, 'Groq');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].body.model, 'meta-llama/llama-3.3-70b-instruct:free');
    assert.equal(calls[2].body.model, 'llama-3.3-70b-versatile');
  });

  it('reports configured and unconfigured providers without exposing keys', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.GROQ_API_KEY = 'test-groq-key';

    const llm = await importLLM('summaries');
    const summaries = llm.getLLMProviderSummaries();

    assert.deepEqual(
      summaries.map((provider: any) => ({ id: provider.id, configured: provider.configured })),
      [
        { id: 'primary', configured: true },
        { id: 'openrouter', configured: false },
        { id: 'groq', configured: true },
      ]
    );
    assert.equal('apiKey' in summaries[0], false);
  });

  it('LLM_JSON_MODE=auto retries the same provider without response_format on 400/422', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.LLM_JSON_MODE = 'auto';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('json-mode');

    let callCount = 0;
    let lastBody: any = null;

    globalThis.fetch = async (_url, options: any) => {
      callCount++;
      lastBody = JSON.parse(options.body);
      if (callCount === 1) {
        return new Response('Unsupported parameter response_format', { status: 400 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"status":"ok"}' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIStructured('test', { type: 'object' });
    assert.equal(callCount, 2);
    assert.deepEqual(res, { status: 'ok' });
    assert.ok(!('response_format' in lastBody));
  });

  it('throws a useful error when no provider keys are configured', async () => {
    const llm = await importLLM('no-keys');

    await assert.rejects(
      async () => {
        await llm.openAIText('test');
      },
      /No LLM provider available/
    );
  });

  it('aborts in-flight LLM requests immediately when signal is cancelled without fallback loop', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('abort-signal');
    const controller = new AbortController();
    const calls: string[] = [];

    globalThis.fetch = async (url, _options: any) => {
      calls.push(url.toString());
      // Abort signal while request is in flight
      controller.abort();
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    await assert.rejects(
      async () => {
        await llm.openAIText('test prompt', undefined, { signal: controller.signal });
      },
      (err: any) => {
        assert.equal(err.name, 'AbortError');
        return true;
      }
    );

    // Only attempted the first provider, did not failover to openrouter
    assert.equal(calls.length, 1);
  });

  it('trips the circuit breaker when primary provider returns 500 connection errors', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('primary-circuit-breaker');
    const circuitBreaker = llm.createLLMSessionCircuitBreaker(2);
    const calls: string[] = [];

    globalThis.fetch = async (url: any) => {
      const urlStr = url.toString();
      calls.push(urlStr);
      if (urlStr.includes('byesu.com')) {
        return new Response(JSON.stringify({
          error: {
            message: 'InternalServerError: Connection error',
            code: 500
          }
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    // Call 1: Primary fails (count = 1), falls back to OpenRouter
    const res1 = await llm.openAIText('prompt 1', undefined, { circuitBreaker });
    assert.equal(res1.text, 'openrouter ok');

    // Call 2: Primary fails (count = 2 -> trips breaker!), falls back to OpenRouter
    const res2 = await llm.openAIText('prompt 2', undefined, { circuitBreaker });
    assert.equal(res2.text, 'openrouter ok');
    assert.equal(circuitBreaker.disabledProviderIds.has('primary'), true);

    // Call 3: Primary is disabled by circuit breaker, directly routes to OpenRouter without hitting byesu.com!
    const callsBefore3 = calls.length;
    const res3 = await llm.openAIText('prompt 3', undefined, { circuitBreaker });
    assert.equal(res3.text, 'openrouter ok');
    const newCalls = calls.slice(callsBefore3);
    assert.equal(newCalls.some(u => u.includes('byesu.com')), false);
  });

  it('exports CLOUDFLARE_MAX_TIMEOUT_MS clamped to 115s', async () => {
    const llm = await importLLM('cf-timeout');
    assert.equal(llm.CLOUDFLARE_MAX_TIMEOUT_MS, 115_000);
  });

  it('guarantees strict sequential execution through withSequentialLLMExecution', async () => {
    const llm = await importLLM('sequential');
    const events: string[] = [];

    const task1 = () =>
      llm.withSequentialLLMExecution(async () => {
        events.push('start:1');
        await new Promise((r) => setTimeout(r, 40));
        events.push('end:1');
        return 1;
      });

    const task2 = () =>
      llm.withSequentialLLMExecution(async () => {
        events.push('start:2');
        await new Promise((r) => setTimeout(r, 20));
        events.push('end:2');
        return 2;
      });

    const task3 = () =>
      llm.withSequentialLLMExecution(async () => {
        events.push('start:3');
        await new Promise((r) => setTimeout(r, 10));
        events.push('end:3');
        return 3;
      });

    // Launch all three concurrently:
    const results = await Promise.all([task1(), task2(), task3()]);
    assert.deepEqual(results, [1, 2, 3]);
    // Must be completely sequential: 1 ends before 2 starts, 2 ends before 3 starts
    assert.deepEqual(events, [
      'start:1',
      'end:1',
      'start:2',
      'end:2',
      'start:3',
      'end:3',
    ]);
  });

  it('does NOT trip permanent circuit breaker on Cloudflare 524 gateway timeout', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('cf-524');
    const circuitBreaker = llm.createLLMSessionCircuitBreaker(2);

    globalThis.fetch = async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('byesu.com')) {
        return new Response('<html><title>524: A timeout occurred</title></html>', {
          status: 524,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter recovered' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt', undefined, { circuitBreaker });
    assert.equal(res.text, 'openrouter recovered');
    // Primary provider was placed on cooldown, NOT permanently disabled by circuit breaker on single failure
    assert.equal(circuitBreaker.disabledProviderIds.has('primary'), false);
  });

  it('trips permanent circuit breaker after consecutive Cloudflare 524 timeouts reach threshold', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('cf-524-trip');
    const circuitBreaker = llm.createLLMSessionCircuitBreaker(2);

    globalThis.fetch = async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('byesu.com')) {
        return new Response('<html><title>524: A timeout occurred</title></html>', {
          status: 524,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter recovered' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    // First call: failureCount becomes 1, not disabled
    await llm.openAIText('prompt 1', undefined, { circuitBreaker });
    assert.equal(circuitBreaker.disabledProviderIds.has('primary'), false);
    assert.equal(circuitBreaker.failureCounts['primary'], 1);

    // Clear provider cooldown so we can simulate the second call happening after cooldown expires
    llm.clearProviderCooldowns();

    // Second call: failureCount becomes 2 >= threshold (2), trips breaker!
    await llm.openAIText('prompt 2', undefined, { circuitBreaker });
    assert.equal(circuitBreaker.disabledProviderIds.has('primary'), true);
  });

  it('createLLMSessionCircuitBreaker defaults to 4 and respects LLM_SESSION_PROVIDER_FAILURE_THRESHOLD', async () => {
    delete process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD;
    const llm = await importLLM('cb-default');
    const defaultBreaker = llm.createLLMSessionCircuitBreaker();
    assert.equal(defaultBreaker.failureThreshold, 4);

    process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD = '5';
    const envBreaker = llm.createLLMSessionCircuitBreaker();
    assert.equal(envBreaker.failureThreshold, 5);

    const explicitBreaker = llm.createLLMSessionCircuitBreaker(2);
    assert.equal(explicitBreaker.failureThreshold, 2);
  });

  it('clamps Groq maximum output tokens to Math.min(maxTokens || 400, 950)', async () => {
    process.env.GROQ_API_KEY = 'test-groq-key';
    const llm = await importLLM('groq-clamp');

    let capturedBody: any;
    globalThis.fetch = async (_url: any, opts: any) => {
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'groq ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    // When maxTokens is 2000, groq should clamp to 950
    await llm.openAIText('test prompt', undefined, { maxTokens: 2000 });
    assert.equal(capturedBody.max_tokens, 950);

    // When maxTokens is 500, groq should use 500
    await llm.openAIText('test prompt', undefined, { maxTokens: 500 });
    assert.equal(capturedBody.max_tokens, 500);

    // When maxTokens is undefined, groq should default to 400
    await llm.openAIText('test prompt');
    assert.equal(capturedBody.max_tokens, 400);
  });

  it('breaks and throws immediately on fetch timeout without repeating retries', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_MAX_RETRIES = '2';

    const llm = await importLLM('timeout-abort');
    let primaryAttempts = 0;

    globalThis.fetch = async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('byesu.com')) {
        primaryAttempts++;
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'openrouter ok');
    // Primary had LLM_MAX_RETRIES=2, but timeout broke immediately on attempt 1 without repeating
    assert.equal(primaryAttempts, 1);
  });

  it('disables provider permanently for session on HTTP 429 code 1300 (quota exhausted) without 429 retries', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_RETRY_429 = 'true';
    process.env.LLM_MAX_RETRIES = '2';

    const llm = await importLLM('quota-1300');
    const circuitBreaker = llm.createLLMSessionCircuitBreaker(4);
    let primaryAttempts = 0;

    globalThis.fetch = async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('byesu.com')) {
        primaryAttempts++;
        return new Response(JSON.stringify({
          error: { message: 'Usage limit exceeded', code: '1300' }
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter recovered' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res1 = await llm.openAIText('test prompt 1', undefined, { circuitBreaker });
    assert.equal(res1.text, 'openrouter recovered');
    // Did not retry 429 multiple times because code 1300 was detected
    assert.equal(primaryAttempts, 1);
    // Added to disabledProviderIds immediately
    assert.equal(circuitBreaker.disabledProviderIds.has('primary'), true);

    // Subsequent call should skip primary immediately without attempting fetch
    const res2 = await llm.openAIText('test prompt 2', undefined, { circuitBreaker });
    assert.equal(res2.text, 'openrouter recovered');
    assert.equal(primaryAttempts, 1);
  });

  it('does NOT permanently disable provider on transient 429 mentioning 1300 ms or 13000 tokens', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_RETRY_429 = 'false';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('rate-limit-1300ms');
    const circuitBreaker = llm.createLLMSessionCircuitBreaker(4);

    globalThis.fetch = async (url: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('byesu.com')) {
        return new Response(JSON.stringify({
          error: { message: 'Rate limit reached. Retry in 1300 ms. Limit: 13000 tokens/min' }
        }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter recovered' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt', undefined, { circuitBreaker });
    assert.equal(res.text, 'openrouter recovered');
    // Should NOT be permanently disabled by circuit breaker because it was not error code 1300
    assert.equal(circuitBreaker.disabledProviderIds.has('primary'), false);
  });

  it('createLLMSessionCircuitBreaker handles invalid or non-numeric thresholds gracefully', async () => {
    const llm = await importLLM('cb-invalid-inputs');

    // NaN should fall back to 4
    const nanBreaker = llm.createLLMSessionCircuitBreaker(Number.NaN);
    assert.equal(nanBreaker.failureThreshold, 4);

    // Negative should fall back to 4
    const negBreaker = llm.createLLMSessionCircuitBreaker(-5);
    assert.equal(negBreaker.failureThreshold, 4);

    // Invalid env string should fall back to 4
    process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD = 'invalid_threshold';
    const envInvalidBreaker = llm.createLLMSessionCircuitBreaker();
    assert.equal(envInvalidBreaker.failureThreshold, 4);

    // Zero in env should fall back to 4
    process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD = '0';
    const envZeroBreaker = llm.createLLMSessionCircuitBreaker();
    assert.equal(envZeroBreaker.failureThreshold, 4);
    delete process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD;
  });

  it('uses Token Harbor DeepSeek V4.1 Flash as primary when active and configured', async () => {
    process.env.TOKEN_HARBOR_API_KEY = 'test-th-key';
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('th-primary');
    llm.resetTokenHarborRetirement();

    assert.equal(llm.isTokenHarborActive(), true);

    let capturedUrl = '';
    let capturedOptions: any = null;

    globalThis.fetch = async (url, options) => {
      capturedUrl = url.toString();
      capturedOptions = options;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'th ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'th ok');
    assert.equal(res.provider, 'Token Harbor (DeepSeek V4.1 Flash)');
    assert.equal(capturedUrl, 'https://tokenharbor.ai/v1/chat/completions');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer test-th-key');
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'deepseek-v4.1-flash:free');
  });

  it('falls back to Byesu when Token Harbor fails', async () => {
    process.env.TOKEN_HARBOR_API_KEY = 'test-th-key';
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('th-fallback-byesu');
    llm.resetTokenHarborRetirement();

    const calls: string[] = [];
    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      calls.push(urlStr);
      if (urlStr.includes('tokenharbor.ai')) {
        return new Response('th error', { status: 500 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'byesu fallback ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'byesu fallback ok');
    assert.equal(res.provider, 'Byesu');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], 'https://tokenharbor.ai/v1/chat/completions');
    assert.equal(calls[1], 'https://byesu.com/v1/chat/completions');
  });

  it('automatically reverts to Byesu when Token Harbor expiration date has passed', async () => {
    process.env.TOKEN_HARBOR_API_KEY = 'test-th-key';
    process.env.OPENAI_API_KEY = 'test-primary-key';
    // Set expiration in the past
    process.env.TOKEN_HARBOR_EXPIRATION_MS = String(Date.now() - 1000);

    const llm = await importLLM('th-expired');
    assert.equal(llm.isTokenHarborActive(), false);

    let capturedUrl = '';
    globalThis.fetch = async (url) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'byesu active' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'byesu active');
    assert.equal(res.provider, 'Byesu');
    assert.equal(capturedUrl, 'https://byesu.com/v1/chat/completions');
  });

  it('early retires Token Harbor permanently on 401 or 402', async () => {
    process.env.TOKEN_HARBOR_API_KEY = 'test-th-key';
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('th-early-retire');
    llm.resetTokenHarborRetirement();

    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('tokenharbor.ai')) {
        return new Response(JSON.stringify({
          error: { message: 'Your Token Harbor balance is at $0.', code: 'balance_zero' }
        }), { status: 402, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'byesu recovered' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res1 = await llm.openAIText('test 1');
    assert.equal(res1.text, 'byesu recovered');
    assert.equal(res1.provider, 'Byesu');
    // Token Harbor should now be retired
    assert.equal(llm.isTokenHarborActive(), false);

    // Second call should not even attempt Token Harbor
    const calls: string[] = [];
    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'byesu direct' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res2 = await llm.openAIText('test 2');
    assert.equal(res2.text, 'byesu direct');
    assert.equal(res2.provider, 'Byesu');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'https://byesu.com/v1/chat/completions');
  });

  it('isTokenHarborActive returns false when TOKEN_HARBOR_ENABLED is false or key is empty', async () => {
    delete process.env.TOKEN_HARBOR_API_KEY;
    delete process.env.TOKEN_HARBOR_ENABLED;

    const llm = await importLLM('th-empty-key');
    llm.resetTokenHarborRetirement();
    assert.equal(llm.isTokenHarborActive(), false);

    process.env.TOKEN_HARBOR_API_KEY = 'test-th-key';
    process.env.TOKEN_HARBOR_ENABLED = 'false';
    const llmDisabled = await importLLM('th-disabled-env');
    llmDisabled.resetTokenHarborRetirement();
    assert.equal(llmDisabled.isTokenHarborActive(), false);

    delete process.env.TOKEN_HARBOR_API_KEY;
    delete process.env.TOKEN_HARBOR_ENABLED;
  });

  it('guarantees Byesu is primary provider when Token Harbor is disabled', async () => {
    process.env.TOKEN_HARBOR_ENABLED = 'false';
    delete process.env.TOKEN_HARBOR_API_KEY;
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.OPENAI_PROVIDER_NAME = 'Byesu';
    process.env.OPENAI_MODEL = 'gpt-5.5';

    const llm = await importLLM('byesu-primary');
    assert.equal(llm.getPrimaryLLMProvider(), 'Byesu');
    assert.equal(llm.getPrimaryLLMModel(), 'gpt-5.5');

    let capturedUrl = '';
    globalThis.fetch = async (url) => {
      capturedUrl = url.toString();
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'byesu primary response' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test byesu primary');
    assert.equal(res.provider, 'Byesu');
    assert.equal(res.model, 'gpt-5.5');
    assert.equal(capturedUrl, 'https://byesu.com/v1/chat/completions');

    delete process.env.TOKEN_HARBOR_ENABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_PROVIDER_NAME;
    delete process.env.OPENAI_MODEL;
  });
});


