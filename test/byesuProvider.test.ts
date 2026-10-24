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

describe('Byesu Primary Provider Registration & Configuration', () => {
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

  it('registers Byesu as primary by default when OPENAI_API_KEY is configured', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';

    const llm = await importLLM('byesu-primary-reg');
    const configured = llm.getLLMProviderSummaries().filter((p: any) => p.configured);

    assert.equal(configured.length, 1);
    assert.equal(configured[0].id, 'primary');
    assert.equal(configured[0].name, 'Byesu');
    assert.equal(configured[0].baseUrl, 'https://byesu.com/v1');
    assert.equal(configured[0].model, 'gpt-6.1-sol');
    assert.equal(llm.getPrimaryLLMProvider(), 'Byesu');
    assert.equal(llm.getPrimaryLLMModel(), 'gpt-6.1-sol');
  });

  it('accepts BYESU_API_KEY as primary key when OPENAI_API_KEY is unset', async () => {
    process.env.BYESU_API_KEY = 'test-byesu-alias-key';

    const llm = await importLLM('byesu-alias-reg');
    const configured = llm.getLLMProviderSummaries().filter((p: any) => p.configured);

    assert.equal(configured.length, 1);
    assert.equal(configured[0].id, 'primary');
    assert.equal(configured[0].name, 'Byesu');
    assert.equal(llm.getAPIKey(), 'test-byesu-alias-key');
  });

  it('honors OPENAI_BASE and OPENAI_MODEL overrides while stripping trailing slashes', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.OPENAI_BASE = 'https://custom-gateway.byesu.com/v1///';
    process.env.OPENAI_MODEL = 'gpt-6.1-sol';
    process.env.OPENAI_PROVIDER_NAME = 'Byesu Enterprise';

    const llm = await importLLM('byesu-overrides');
    const primary = llm.getLLMProviderSummaries().find((p: any) => p.id === 'primary');

    assert.ok(primary);
    assert.equal(primary.baseUrl, 'https://custom-gateway.byesu.com/v1');
    assert.equal(primary.model, 'gpt-6.1-sol');
    assert.equal(primary.name, 'Byesu Enterprise');
    assert.equal(llm.getPrimaryLLMProvider(), 'Byesu Enterprise');
    assert.equal(llm.getPrimaryLLMModel(), 'gpt-6.1-sol');
  });

  it('sanitizes model names by stripping the failing antigravity/ prefix from OPENAI_MODEL and dispatches clean model name', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_MODEL = 'antigravity/gemini-3.8-flash-high';
    process.env.OPENAI_BASE = 'http://localhost:20128/v1';

    const llm = await importLLM('antigravity-sanitization');
    assert.equal(llm.sanitizeModelName('antigravity/gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
    assert.equal(llm.getPrimaryLLMModel(), 'gemini-3.8-flash-high');

    const primary = llm.getLLMProviderSummaries().find((p: any) => p.id === 'primary');
    assert.ok(primary);
    assert.equal(primary.model, 'gemini-3.8-flash-high');

    let dispatchedModel = '';
    globalThis.fetch = (async (_url: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      dispatchedModel = body.model;
      return jsonResponse({
        model: 'gemini-3.8-flash-high',
        choices: [{ finish_reason: 'stop', message: { content: 'hello' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    }) as any;

    await llm.openAIText('test prompt', '', { maxRetries: 0 });
    assert.equal(dispatchedModel, 'gemini-3.8-flash-high');
    assert.ok(!dispatchedModel.includes('antigravity'));
  });

  it('guarantees Tier 1 (Byesu) takes precedence over Tier 2 failsafes (Groq, OpenRouter)', async () => {
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

    const llm = await importLLM('byesu-tier-precedence');
    const candidates = llm.getLLMProviderSummaries().filter((p: any) => p.configured);
    const ids = candidates.map((p: any) => p.id);

    assert.equal(ids[0], 'primary');
    assert.equal(ids[1], 'groq');
    assert.equal(ids[2], 'openrouter');
  });

  it('deprecated Atria stubs return backwards-compatible inert values', async () => {
    const llm = await importLLM('atria-deprecated-stubs');

    assert.equal(llm.isAtriaConfigured(), false);
    assert.equal(llm.isAtriaPrimary(), false);
    assert.equal(typeof llm.resetAtriaReasoningEffortRefusal, 'function');
    assert.doesNotThrow(() => llm.resetAtriaReasoningEffortRefusal());

    assert.equal(llm.computeAtriaDynamicMaxTokens(2000), 2000);
    assert.equal(llm.computeAtriaDynamicTimeoutMs(2000, []), 60_000);
    assert.equal(llm.computeAtriaDynamicTimeoutMs(2000, [], 45_000), 45_000);
    assert.equal(llm.computeAtriaDynamicTimeoutMs(2000, [], 45_000, undefined, 90_000), 90_000);
    assert.equal(llm.getProviderConcurrencyLimit('atria'), 0);
  });
});

describe('Byesu Execution & Payload Handling', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_COMPLETION_CACHE = 'false';
    process.env.OPENAI_API_KEY = 'test-byesu-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('dispatches openAIText to Byesu chat completions endpoint with gpt-6.1-sol', async () => {
    const llm = await importLLM('byesu-text-exec');

    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = async (url, options) => {
      capturedUrl = url.toString();
      const init = options as RequestInit;
      capturedBody = JSON.parse(init.body as string);
      capturedHeaders = init.headers as Record<string, string>;
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'test response' } }],
      });
    };

    const res = await llm.openAIText('Hello Byesu', 'System instruction');

    assert.equal(res.text, 'test response');
    assert.equal(res.provider, 'Byesu');
    assert.equal(capturedUrl, 'https://byesu.com/v1/chat/completions');
    assert.equal(capturedBody.model, 'gpt-6.1-sol');
    assert.equal(capturedHeaders.Authorization, 'Bearer test-byesu-key');
    assert.equal(capturedBody.messages.length, 2);
    assert.equal(capturedBody.messages[0].role, 'system');
    assert.equal(capturedBody.messages[1].role, 'user');
  });

  it('dispatches openAIStructured and parses valid JSON successfully', async () => {
    const llm = await importLLM('byesu-structured-exec');

    let capturedBody: any = null;
    globalThis.fetch = async (_url, options) => {
      capturedBody = JSON.parse((options as RequestInit).body as string);
      return jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ success: true, count: 42 }) },
          },
        ],
      });
    };

    const schema = {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        count: { type: 'number' },
      },
      required: ['success', 'count'],
    };

    const res = await llm.openAIStructured<{ success: boolean; count: number }>(
      'Extract data',
      schema,
    );

    assert.deepEqual(res, { success: true, count: 42 });
    assert.equal(capturedBody.response_format?.type, 'json_object');
    assert.equal(capturedBody.model, 'gpt-6.1-sol');
  });

  it('strips markdown code fences from structured JSON completion', async () => {
    const llm = await importLLM('byesu-strip-fence');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '```json\n{"status":"valid"}\n```' },
          },
        ],
      });

    const res = await llm.openAIStructured<{ status: string }>('test', { type: 'object' });
    assert.equal(res.status, 'valid');
  });

  it('strips reasoning blocks from structured JSON completion', async () => {
    const llm = await importLLM('byesu-strip-reasoning');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: '<think>Analyzing schema requirements</think>{"parsed":true}',
            },
          },
        ],
      });

    const res = await llm.openAIStructured<{ parsed: boolean }>('test', { type: 'object' });
    assert.equal(res.parsed, true);
  });
});

describe('Byesu Error Handling, Circuit Breaker & Failsafe Gating', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_COMPLETION_CACHE = 'false';
    process.env.OPENAI_API_KEY = 'test-byesu-key';
    process.env.GROQ_API_KEY = 'test-groq-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('cascades to Tier 2 failsafe (Groq) when Byesu suffers 401 authentication failure', async () => {
    const llm = await importLLM('byesu-auth-cascade');
    llm.clearProviderCooldowns();

    const capturedCalls: string[] = [];
    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      capturedCalls.push(urlStr);
      if (urlStr.includes('byesu.com')) {
        return jsonResponse({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }, 401);
      }
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"status":"groq-saved"}' } }],
      });
    };

    const res = await llm.openAIStructured<{ status: string }>('Test prompt', { type: 'object' });

    assert.equal(res.status, 'groq-saved');
    assert.equal(capturedCalls.length, 2);
    assert.ok(capturedCalls[0].includes('byesu.com'));
    assert.ok(capturedCalls[1].includes('api.groq.com'));

    // Byesu is marked OUT due to auth failure
    assert.equal(llm.isProviderOut('primary'), true);
  });

  it('cascades to Tier 2 failsafe when Byesu suffers quota exhaustion (429 code 1300)', async () => {
    const llm = await importLLM('byesu-quota-cascade');
    llm.clearProviderCooldowns();

    const capturedCalls: string[] = [];
    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      capturedCalls.push(urlStr);
      if (urlStr.includes('byesu.com')) {
        return jsonResponse(
          { error: { message: 'Insufficient balance', code: '1300' } },
          429,
        );
      }
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: '{"status":"quota-recovered"}' } }],
      });
    };

    const res = await llm.openAIStructured<{ status: string }>('Test prompt', { type: 'object' });

    assert.equal(res.status, 'quota-recovered');
    assert.equal(capturedCalls.length, 2);
    assert.equal(llm.isProviderOut('primary'), true);
  });

  it('does NOT cascade to failsafe on invalid JSON parse error when Byesu is healthy', async () => {
    const llm = await importLLM('byesu-parse-error-no-leak');
    llm.clearProviderCooldowns();

    const capturedCalls: string[] = [];
    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      capturedCalls.push(urlStr);
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'not valid json text' } }],
      });
    };

    // ADR-0011 gating policy: A parse failure on a healthy primary throws to the stage
    // rather than leaking customer prospect data to external Tier 2 failsafes.
    await assert.rejects(
      () =>
        llm.openAIStructured<{ ok: boolean }>('Extract lead data', {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        }),
      (err: Error) => {
        assert.match(err.message, /Failed to parse.*JSON/i);
        return true;
      },
    );

    assert.ok(capturedCalls.length >= 1);
    assert.ok(capturedCalls.every((c) => c.includes('byesu.com')));
    assert.ok(!capturedCalls.some((c) => c.includes('api.groq.com')));
    assert.equal(llm.isProviderOut('primary'), false);
  });

  it('clearProviderCooldowns resets temporary cooldowns', async () => {
    const llm = await importLLM('byesu-cooldown-reset');
    llm.providerCooldowns.set('primary', Date.now() + 60_000);
    assert.equal(llm.providerCooldowns.size, 1);

    llm.clearProviderCooldowns();
    assert.equal(llm.providerCooldowns.size, 0);
  });
});
