import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chunkEvidenceBlocksByTokenBudget,
  estimateTokenCount,
  fitOutputTokenBudget,
} from '../server/leadSearch/llmBudget.js';

describe('LLM extraction budgets', () => {
  it('chunks evidence without exceeding the estimated token budget', () => {
    const blocks = ['A'.repeat(120), 'B'.repeat(120), 'C'.repeat(120)];
    const chunks = chunkEvidenceBlocksByTokenBudget(blocks, 60);

    assert.deepEqual(chunks.map(chunk => chunk.length), [240, 120]);
    assert.ok(chunks.every(chunk => estimateTokenCount(chunk) <= 60));
  });

  it('truncates a pathological single evidence block instead of splitting one prospect', () => {
    const chunks = chunkEvidenceBlocksByTokenBudget(['LINK: https://example.test\n' + 'X'.repeat(2000)], 100);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 400);
    assert.match(chunks[0], /^LINK:/);
  });

  it('fits output beneath the total provider budget including the safety margin', () => {
    const output = fitOutputTokenBudget({
      configuredMaxTokens: 3000,
      estimatedInputTokens: 4100,
      totalTokenBudget: 7200,
      safetyTokens: 400,
      minimumOutputTokens: 800,
    });

    assert.equal(output, 2700);
    assert.ok(4100 + output + 400 <= 7200);
  });

  it('does not exceed the provider budget when schema overhead consumes the preferred reserve', () => {
    const output = fitOutputTokenBudget({
      configuredMaxTokens: 3000,
      estimatedInputTokens: 6900,
      totalTokenBudget: 7200,
      safetyTokens: 400,
      minimumOutputTokens: 800,
    });

    assert.equal(output, 1);
  });
});
