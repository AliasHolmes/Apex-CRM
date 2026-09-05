import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

async function importLLM(suffix: string) {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

describe('LLM gateway and provider fallback', () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    process.env.LLM_GATEWAY_MODE = 'direct';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
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

  it('routes through LiteLLM apex-primary when LLM_GATEWAY_MODE=litellm', async () => {
    process.env.LLM_GATEWAY_MODE = 'litellm';
    process.env.LITELLM_MASTER_KEY = 'test-litellm-key';
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('litellm-gateway');

    let capturedUrl = '';
    let capturedOptions: any = null;

    globalThis.fetch = async (url, options) => {
      capturedUrl = url.toString();
      capturedOptions = options;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'litellm ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'litellm ok');
    assert.equal(res.provider, 'LiteLLM');
    assert.equal(res.model, 'apex-primary');
    assert.equal(capturedUrl, 'http://127.0.0.1:4000/v1/chat/completions');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer test-litellm-key');

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'apex-primary');
  });

  it('falls back from LiteLLM to direct non-primary providers when the proxy route fails', async () => {
    process.env.LLM_GATEWAY_MODE = 'litellm';
    process.env.LITELLM_MASTER_KEY = 'test-litellm-key';
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.OPENROUTER_MODEL = 'openrouter-test-model';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('litellm-direct-fallback');
    const calls: Array<{ url: string; body: any; auth: string }> = [];

    globalThis.fetch = async (url, options: any) => {
      calls.push({
        url: url.toString(),
        body: JSON.parse(options.body),
        auth: options.headers['Authorization'],
      });

      if (calls.length === 1) {
        return new Response('proxy timeout', { status: 504 });
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'direct fallback ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const attempts: any[] = [];
    const res = await llm.openAIText('test prompt', undefined, {
      onProviderAttempt: (attempt: any) => attempts.push(attempt),
    });
    assert.equal(res.text, 'direct fallback ok');
    assert.equal(res.provider, 'Groq');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://127.0.0.1:4000/v1/chat/completions');
    assert.equal(calls[0].body.model, 'apex-primary');
    assert.equal(calls[1].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls[1].auth, 'Bearer test-groq-key');
    assert.equal(calls[1].body.model, 'llama-3.3-70b-versatile');
    assert.deepEqual(attempts.map(attempt => [attempt.providerId, attempt.status]), [
      ['litellm', 'error'],
      ['groq', 'success'],
    ]);
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

  it('keeps LiteLLM responsible for the primary deployment only', () => {
    const config = readFileSync(new URL('../litellm.config.yaml', import.meta.url), 'utf8');
    assert.doesNotMatch(config, /apex-openrouter-fallback|apex-groq-fallback|\bfallbacks:/);
    assert.match(config, /model_name:\s+apex-primary/);
    assert.match(config, /model:\s+openai\/gpt-5\.5/);
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

  it('falls back to OpenRouter after primary and Groq fail', async () => {
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
        choices: [{ message: { content: 'openrouter ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'openrouter ok');
    assert.equal(res.provider, 'OpenRouter');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls[1].auth, 'Bearer test-groq-key');
    assert.equal(calls[1].body.model, 'llama-3.3-70b-versatile');
    assert.equal(calls[2].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[2].auth, 'Bearer test-openrouter-key');
    assert.equal(calls[2].body.model, 'meta-llama/llama-3.3-70b-instruct:free');
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
        choices: [{ message: { content: 'openrouter ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'openrouter ok');
    assert.equal(res.provider, 'OpenRouter');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].body.model, 'llama-3.3-70b-versatile');
    assert.equal(calls[2].body.model, 'meta-llama/llama-3.3-70b-instruct:free');
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
        { id: 'groq', configured: true },
        { id: 'openrouter', configured: false },
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

    globalThis.fetch = async (url, options: any) => {
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

    globalThis.fetch = async (url, options: any) => {
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

  it('trips the circuit breaker when LiteLLM returns 500 connection errors', async () => {
    process.env.LLM_GATEWAY_MODE = 'litellm';
    process.env.LITELLM_MASTER_KEY = 'test-litellm-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.LLM_MAX_RETRIES = '0';

    const llm = await importLLM('litellm-circuit-breaker');
    const circuitBreaker = llm.createLLMSessionCircuitBreaker(2);
    const calls: string[] = [];

    globalThis.fetch = async (url: any) => {
      const urlStr = url.toString();
      calls.push(urlStr);
      if (urlStr.includes('127.0.0.1:4000')) {
        return new Response(JSON.stringify({
          error: {
            message: 'litellm.InternalServerError: InternalServerError: OpenAIException - Connection error.. Received Model Group=apex-primary',
            code: 500
          }
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'openrouter ok' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    // Call 1: LiteLLM fails (count = 1), falls back to OpenRouter
    const res1 = await llm.openAIText('prompt 1', undefined, { circuitBreaker });
    assert.equal(res1.text, 'openrouter ok');

    // Call 2: LiteLLM fails (count = 2 -> trips breaker!), falls back to OpenRouter
    const res2 = await llm.openAIText('prompt 2', undefined, { circuitBreaker });
    assert.equal(res2.text, 'openrouter ok');
    assert.equal(circuitBreaker.disabledProviderIds.has('litellm'), true);

    // Call 3: LiteLLM is disabled by circuit breaker, directly routes to OpenRouter without hitting 127.0.0.1:4000!
    const callsBefore3 = calls.length;
    const res3 = await llm.openAIText('prompt 3', undefined, { circuitBreaker });
    assert.equal(res3.text, 'openrouter ok');
    const newCalls = calls.slice(callsBefore3);
    assert.equal(newCalls.some(u => u.includes('127.0.0.1:4000')), false);
  });
});

