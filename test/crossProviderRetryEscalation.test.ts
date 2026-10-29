import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeByesuDynamicTimeoutMs,
  openAIStructured,
} from '../server/services/llm.js';
import { resolveJudgeRetryProviderOrder } from '../server/leadSearch/plannerRouting.js';

const originalFetch = globalThis.fetch;

test('Recommendation 1: computeByesuDynamicTimeoutMs provides 210s ceiling for dense non-Cloudflare single-candidate judge calls', () => {
  const sampleMessages = [{ role: 'user', content: 'Single candidate dense evidence prompt'.repeat(100) }];
  const timeoutMs = computeByesuDynamicTimeoutMs(
    14000,
    sampleMessages as any,
    210_000,
    { candidateCount: 1, promptSize: 4000 },
    undefined,
    false,
    true,
  );
  assert.equal(timeoutMs, 210_000);
});

test('Recommendation 2: resolveJudgeRetryProviderOrder defaults to cross-provider escalation order', () => {
  const originalEnv = process.env.LEAD_JUDGE_RETRY_PROVIDER_ORDER;
  try {
    delete process.env.LEAD_JUDGE_RETRY_PROVIDER_ORDER;
    assert.deepEqual(resolveJudgeRetryProviderOrder(), ['byesu', 'primary', 'openrouter', 'groq']);

    process.env.LEAD_JUDGE_RETRY_PROVIDER_ORDER = 'byesu, openrouter';
    assert.deepEqual(resolveJudgeRetryProviderOrder(), ['byesu', 'openrouter']);
  } finally {
    if (originalEnv !== undefined) {
      process.env.LEAD_JUDGE_RETRY_PROVIDER_ORDER = originalEnv;
    } else {
      delete process.env.LEAD_JUDGE_RETRY_PROVIDER_ORDER;
    }
  }
});

test('Recommendation 2: withProviderFallback honors explicit tierProviderOrder trying byesu before primary on retry', async () => {
  const savedOpenAiKey = process.env.OPENAI_API_KEY;
  const savedOpenAiBase = process.env.OPENAI_BASE;
  const savedByesuKey = process.env.BYESU_API_KEY;
  const savedByesuBase = process.env.BYESU_BASE;

  try {
    process.env.OPENAI_API_KEY = 'test-primary-omniroute-key';
    process.env.OPENAI_BASE = 'http://localhost:20128/v1';
    process.env.OPENAI_PROVIDER_NAME = 'OmniRoute';
    process.env.BYESU_API_KEY = 'test-byesu-key';
    process.env.BYESU_BASE = 'https://byesu.com/v1';

    const attemptedUrls: string[] = [];
    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      attemptedUrls.push(urlStr);

      if (urlStr.includes('byesu.com')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ qualified: true, score: 85 }) } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // If called OmniRoute first, return failure
      return new Response('OmniRoute error', { status: 500 });
    };

    const schema = {
      type: 'object',
      properties: {
        qualified: { type: 'boolean' },
        score: { type: 'number' },
      },
      required: ['qualified', 'score'],
    };

    const res = await openAIStructured<any>(
      'Evaluate candidate',
      schema,
      'System prompt',
      {
        tierProviderOrder: ['byesu', 'primary'],
        maxRetries: 0,
      },
    );

    assert.deepEqual(res, { qualified: true, score: 85 });
    assert.ok(attemptedUrls.length > 0);
    assert.ok(attemptedUrls[0].includes('byesu.com'), `Expected byesu to be tried first, got: ${attemptedUrls[0]}`);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedOpenAiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiKey; else delete process.env.OPENAI_API_KEY;
    if (savedOpenAiBase !== undefined) process.env.OPENAI_BASE = savedOpenAiBase; else delete process.env.OPENAI_BASE;
    if (savedByesuKey !== undefined) process.env.BYESU_API_KEY = savedByesuKey; else delete process.env.BYESU_API_KEY;
    if (savedByesuBase !== undefined) process.env.BYESU_BASE = savedByesuBase; else delete process.env.BYESU_BASE;
  }
});
