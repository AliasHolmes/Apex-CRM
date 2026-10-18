import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  estimateLLMCostUsd,
  DEFAULT_PROVIDER_COST_PER_1M,
} from '../server/leadSearch/telemetry.ts';
import {
  clearUnsupportedJsonModeProvidersForTest,
  openAIStructured,
} from '../server/services/llm.ts';
import { promoteSafetyNetCandidates } from '../server/leadSearch/stages/judgeStage.ts';
import type { ProspectContract } from '../server/leadSearch/prospectContract.ts';

const baseContract: ProspectContract = {
  version: 1,
  policyVersion: 'test-v1',
  brief: 'Tech Founders',
  authorityRequired: false,
  exclusions: [],
  initialQueries: [],
  requirements: [
    {
      id: 'req_role',
      description: 'Must be Founder',
      sourcePhrase: 'Founder',
      acceptableTerms: ['Founder'],
      queryable: true,
      evidenceModality: 'structured_profile',
      importance: 'hard',
      scope: 'person_role',
    },
  ],
};

describe('Work Package B + C4: LLM Hygiene, Cost Visibility & Fallback Invariants', () => {
  beforeEach(() => {
    clearUnsupportedJsonModeProvidersForTest();
    delete process.env.LLM_OBSERVABILITY_INPUT_COST_PER_1M;
    delete process.env.LLM_OBSERVABILITY_OUTPUT_COST_PER_1M;
  });

  it('B4: estimateLLMCostUsd provides accurate provider rates and supports env overrides', () => {
    assert.equal(DEFAULT_PROVIDER_COST_PER_1M.byesu.input, 1.5);
    assert.equal(DEFAULT_PROVIDER_COST_PER_1M.byesu.output, 6.0);

    // 1M input, 1M output for Byesu: 1.50 + 6.00 = 7.50
    const byesuCost = estimateLLMCostUsd(1_000_000, 1_000_000, 'byesu');
    assert.equal(byesuCost, 7.5);

    // Gemini rate: 0.15 + 0.60 = 0.75
    const geminiCost = estimateLLMCostUsd(1_000_000, 1_000_000, 'gemini');
    assert.equal(geminiCost, 0.75);

    // OpenAI rate: 2.50 + 10.00 = 12.50
    const openaiCost = estimateLLMCostUsd(1_000_000, 1_000_000, 'openai');
    assert.equal(openaiCost, 12.5);

    // Env override takes precedence
    process.env.LLM_OBSERVABILITY_INPUT_COST_PER_1M = '5.00';
    process.env.LLM_OBSERVABILITY_OUTPUT_COST_PER_1M = '20.00';
    const overrideCost = estimateLLMCostUsd(1_000_000, 1_000_000, 'byesu');
    assert.equal(overrideCost, 25.0);
  });

  it('C4: promoteSafetyNetCandidates strictly excludes unverified and fallback_unverified leads', () => {
    const unverifiedLead = {
      id: 'lead_unverified',
      fullName: 'Unverified Lead',
      qualification: {
        policyVersion: 'test-v1',
        verdict: 'unverified',
        qualificationSource: 'deterministic',
        finalScore: 0,
        requirements: [{ requirementId: 'req_role', status: 'unknown' }],
      },
      _qualificationFallback: 'fallback_unverified',
    };

    const regularLead = {
      id: 'lead_eligible',
      fullName: 'Eligible Lead',
      score: 8,
    };

    const acceptedLeads = [unverifiedLead, regularLead];
    const qualifiedLeads: any[] = [];

    const result = promoteSafetyNetCandidates({
      acceptedLeads,
      qualifiedLeads,
      contract: baseContract,
      shortfall: 2,
    });

    assert.equal(result.promoted, 1, 'Only the eligible lead should be promoted, unverified must be excluded');
    assert.equal(qualifiedLeads.length, 1);
    assert.equal(qualifiedLeads[0].id, 'lead_eligible');
  });

  it('B1: openAIStructured accumulates usage across parse retries and fires outer callback with sum', async () => {
    let attempt = 0;
    const originalFetch = globalThis.fetch;
    const oldKey = process.env.OPENAI_API_KEY;
    const oldCache = process.env.LLM_COMPLETION_CACHE;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.LLM_COMPLETION_CACHE = 'false';

    globalThis.fetch = (async () => {
      attempt++;
      // Attempt 1: unparseable raw text
      // Attempt 2: valid JSON
      const content = attempt === 1 ? 'NOT_JSON_BODY' : JSON.stringify({ name: 'Alice' });
      return new Response(
        JSON.stringify({
          model: 'test-model',
          choices: [{ finish_reason: 'stop', message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const usagesReceived: any[] = [];
      const result = await openAIStructured<{ name: string }>(
        'Return name Alice',
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        'You are an assistant',
        {
          onUsage: (u) => usagesReceived.push(u),
        },
      );

      assert.equal(result.name, 'Alice');
      assert.equal(attempt, 2, 'Should have executed attempt 1 and attempt 2 retry');
      assert.ok(usagesReceived.length >= 2, 'Should have received usage for attempt 1 and attempt 2');

      const finalUsage = usagesReceived[usagesReceived.length - 1];
      assert.equal(finalUsage.inputTokens, 200, 'Input tokens should be 100 + 100 = 200');
      assert.equal(finalUsage.outputTokens, 100, 'Output tokens should be 50 + 50 = 100');
      assert.equal(finalUsage.totalTokens, 300, 'Total tokens should be 150 + 150 = 300');
    } finally {
      globalThis.fetch = originalFetch;
      if (oldKey) process.env.OPENAI_API_KEY = oldKey;
      else delete process.env.OPENAI_API_KEY;
      if (oldCache) process.env.LLM_COMPLETION_CACHE = oldCache;
      else delete process.env.LLM_COMPLETION_CACHE;
    }
  });
});
