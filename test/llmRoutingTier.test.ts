import test from 'node:test';
import assert from 'node:assert/strict';
import { orderProvidersForTier, parseFastProviderIds, describeLLMRoute } from '../server/services/llm.js';
import { computeJudgeBatchCapacity } from '../server/leadSearch/stages/judgeStage.js';

const chain = [{ id: 'primary' }, { id: 'openrouter' }, { id: 'groq' }];
const ids = (list: { id: string }[]) => list.map(p => p.id).join(',');

test('keeps the configured priority unless fast providers are named', () => {
  assert.equal(ids(orderProvidersForTier(chain, 'fast', [])), 'primary,openrouter,groq');
  assert.equal(ids(orderProvidersForTier(chain, 'reasoning', ['groq'])), 'primary,openrouter,groq');
  assert.equal(ids(orderProvidersForTier(chain, undefined, ['groq'])), 'primary,openrouter,groq');
});

test('moves named fast providers first within their tier, never ahead of the primary provider', () => {
  assert.equal(ids(orderProvidersForTier(chain, 'fast', ['groq', 'openrouter'])), 'primary,groq,openrouter');
  assert.equal(ids(orderProvidersForTier(chain, 'fast', ['primary'])), 'primary,openrouter,groq');
  assert.equal(ids(orderProvidersForTier(chain, 'fast', ['unknown'])), 'primary,openrouter,groq');
  assert.deepEqual(parseFastProviderIds(' Groq, openrouter ,,'), ['groq', 'openrouter']);
});

test('sizes judge batches to the route output cap', () => {
  assert.equal(computeJudgeBatchCapacity(950, 4, false), 1);
  assert.equal(computeJudgeBatchCapacity(14000, 5, true), 9);
  assert.ok(computeJudgeBatchCapacity(Number.POSITIVE_INFINITY, 4, true) >= 1000);
});

test('describes the fast route from the environment', () => {
  const keys = ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'BYESU_API_KEY', 'LLM_FAST_PROVIDER_IDS', 'GROQ_MODEL', 'OPENAI_MODEL'];
  const snapshot = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.OPENAI_API_KEY = 'k1';
    process.env.OPENAI_MODEL = 'gpt-6.1-sol';
    process.env.GROQ_API_KEY = 'k2';
    assert.deepEqual(describeLLMRoute('fast'), { providerId: 'primary', reasoning: true, outputTokenCap: Number.POSITIVE_INFINITY });
    // Policy: naming a failsafe provider "fast" cannot route ahead of a healthy primary.
    process.env.LLM_FAST_PROVIDER_IDS = 'groq';
    assert.deepEqual(describeLLMRoute('fast'), { providerId: 'primary', reasoning: true, outputTokenCap: Number.POSITIVE_INFINITY });
  } finally {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
