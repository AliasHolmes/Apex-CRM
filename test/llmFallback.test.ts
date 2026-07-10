import assert from 'node:assert/strict';
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
    assert.equal(capturedUrl, 'https://api.byesu.com/v1/chat/completions');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer test-primary-key');

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'gpt-5.5');
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

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'direct fallback ok');
    assert.equal(res.provider, 'OpenRouter');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'http://127.0.0.1:4000/v1/chat/completions');
    assert.equal(calls[0].body.model, 'apex-primary');
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[1].auth, 'Bearer test-openrouter-key');
    assert.equal(calls[1].body.model, 'openrouter-test-model');
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
    assert.equal(calls[0].url, 'https://api.byesu.com/v1/chat/completions');
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

    const llm = await importLLM('groq-fallback');
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
    assert.equal(calls[2].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(calls[2].auth, 'Bearer test-groq-key');
    assert.equal(calls[2].body.model, 'qwen/qwen3.6-27b');
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
});
