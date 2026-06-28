import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

// Save original fetch and env
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

describe('LiteLLM Fallback and Gateway Mode Tests', () => {
  beforeEach(() => {
    // Reset process.env before each test
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    // Restore some essential env variables if needed, but keep it clean
  });

  afterEach(() => {
    // Restore original fetch and env
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('Direct mode defaults to Byesu base and gpt-5.5', async () => {
    process.env.LLM_GATEWAY_MODE = 'direct';
    process.env.OPENAI_API_KEY = 'test-direct-key';

    // Use query param to bypass ES module cache
    const llm = await import(`../server/services/llm.ts?t=${Date.now()}-1`);

    assert.equal(llm.getAPIKey(), 'test-direct-key');
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
    assert.equal(capturedUrl, 'https://api.byesu.com/v1/chat/completions');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer test-direct-key');
    
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'gpt-5.5');
  });

  it('LiteLLM mode defaults to localhost and apex-primary', async () => {
    process.env.LLM_GATEWAY_MODE = 'litellm';
    process.env.LITELLM_MASTER_KEY = 'test-litellm-key';

    const llm = await import(`../server/services/llm.ts?t=${Date.now()}-2`);

    assert.equal(llm.getAPIKey(), 'test-litellm-key');
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
    assert.equal(capturedUrl, 'http://localhost:4000/v1/chat/completions');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer test-litellm-key');
    
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'apex-primary');
  });

  it('Environment variables override defaults in both modes', async () => {
    process.env.LLM_GATEWAY_MODE = 'litellm';
    process.env.LITELLM_MASTER_KEY = 'test-key';
    process.env.LITELLM_BASE_URL = 'https://custom-lite.com/v2';
    process.env.LITELLM_MODEL = 'custom-model';

    const llm = await import(`../server/services/llm.ts?t=${Date.now()}-3`);

    let capturedUrl = '';
    let capturedOptions: any = null;

    globalThis.fetch = async (url, options) => {
      capturedUrl = url.toString();
      capturedOptions = options;
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok' } }]
      }), { status: 200 });
    };

    await llm.openAIText('test');
    assert.equal(capturedUrl, 'https://custom-lite.com/v2/chat/completions');
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'custom-model');
  });

  it('LiteLLM mode only uses the proxy master key', async () => {
    process.env.LLM_GATEWAY_MODE = 'litellm';

    // Provider keys are for LiteLLM itself; Apex authenticates to the proxy.
    process.env.BYESU_API_KEY = 'byesu-key-only';
    process.env.OPENAI_API_KEY = 'openai-key';
    let llm = await import(`../server/services/llm.ts?t=${Date.now()}-4a`);
    assert.equal(llm.getAPIKey(), '');

    process.env.LITELLM_MASTER_KEY = 'master-key';
    llm = await import(`../server/services/llm.ts?t=${Date.now()}-4b`);
    assert.equal(llm.getAPIKey(), 'master-key');
  });

  it('Truncates long provider errors to 500 characters', async () => {
    process.env.LLM_GATEWAY_MODE = 'direct';
    process.env.OPENAI_API_KEY = 'test-key';

    const llm = await import(`../server/services/llm.ts?t=${Date.now()}-5`);

    // A very long HTML response (e.g., 502 Bad Gateway)
    const longHtml = '<html><body>' + 'x'.repeat(1000) + '</body></html>';

    globalThis.fetch = async () => {
      return new Response(longHtml, { status: 502 });
    };

    await assert.rejects(
      async () => {
        await llm.openAIText('test');
      },
      (err: Error) => {
        assert.ok(err.message.includes('[truncated]'));
        assert.ok(err.message.length <= 600); // 500 chars error + prefix
        return true;
      }
    );
  });

  it('LLM_JSON_MODE=auto retries without response_format on 400/422', async () => {
    process.env.LLM_GATEWAY_MODE = 'direct';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.LLM_JSON_MODE = 'auto';

    const llm = await import(`../server/services/llm.ts?t=${Date.now()}-6`);

    let callCount = 0;
    let lastBody: any = null;

    globalThis.fetch = async (url, options: any) => {
      callCount++;
      lastBody = JSON.parse(options.body);
      if (callCount === 1) {
        // Return 400 Bad Request (unsupported parameter)
        return new Response('Unsupported parameter response_format', { status: 400 });
      }
      // Success on retry
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"status": "ok"}' } }]
      }), { status: 200 });
    };

    const res = await llm.openAIStructured('test', { type: 'object' });
    assert.equal(callCount, 2);
    assert.deepEqual(res, { status: 'ok' });
    
    // First call should have had response_format
    // Second call should NOT have response_format
    assert.ok(!('response_format' in lastBody));
  });

  it('429 is treated as retryable when LLM_RETRY_429=true', async () => {
    process.env.LLM_GATEWAY_MODE = 'direct';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.LLM_RETRY_429 = 'true';
    process.env.LLM_MAX_RETRIES = '1';

    const llm = await import(`../server/services/llm.ts?t=${Date.now()}-7`);

    let callCount = 0;

    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Rate limit exceeded', { status: 429 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'success after retry' } }]
      }), { status: 200 });
    };

    const res = await llm.openAIText('test');
    assert.equal(callCount, 2);
    assert.equal(res.text, 'success after retry');
  });
});
