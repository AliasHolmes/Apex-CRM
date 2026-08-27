import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkEvidenceBlocksByTokenBudget } from '../server/leadSearch/llmBudget.js';

describe('High-Throughput Single-Pass Extraction Batching', () => {
  it('bundles 12 profile candidates into a single chunk under 4000 token budget', () => {
    const sampleBlock = `--- PROFILE CANDIDATE ---
SOURCE_PROVIDER: tavily
LINK: https://www.linkedin.com/in/sample-founder
TITLE: John Doe - Founder & CEO at Nexus AI Agency
[TAVILY SNIPPET]
Founder and CEO at Nexus AI Agency based in New York. Specializing in AI workflow automation and generative AI solutions for B2B enterprises. Over 10 years of experience in technical leadership.
`;

    // 12 candidates of ~500 chars (~125 tokens each = ~1500 tokens total)
    const blocks = Array(12).fill(sampleBlock);
    const budget = 4000;

    const chunks = chunkEvidenceBlocksByTokenBudget(blocks, budget);
    assert.equal(chunks.length, 1, `Expected all 12 candidate blocks to fit in 1 chunk, got ${chunks.length}`);
  });
});
