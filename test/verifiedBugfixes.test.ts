import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { applyIntentEnrichmentDelta, applyPostIntentDelta } from '../server/leadSearch/scoring.js';
import { normalizeServerScore } from '../src/utils/leadScore';
import { executePlanStage } from '../server/leadSearch/stages/planStage.js';
import { executeVerifyStage } from '../server/leadSearch/stages/verifyStage.js';
import { executeFuseStage } from '../server/leadSearch/stages/fuseStage.js';
import { buildFallbackSearchSpec } from '../server/leadSearch/searchSpec.js';
import { buildCollectionCapacity } from '../server/leadSearch/collectionCapacity.js';

describe('Verified Bugfixes Regression Suite', () => {
  it('planStage handles missing plan.item.tavily gracefully without throwing TypeError', async () => {
    const mockContext: any = {
      config: {
        sessionId: 'test-session',
        promptQuery: 'CEO tech California',
        targetLimit: 10,
        strategyBrief: 'CEO tech California',
        contract: {
          brief: 'CEO tech California',
          requirements: [
            {
              id: 'req-1',
              description: 'CEO',
              importance: 'hard',
              scope: 'role',
              evidenceModality: 'structured_profile',
              acceptableTerms: ['CEO'],
            },
          ],
          exclusions: [],
          policyVersion: 'test',
        },
        capacity: buildCollectionCapacity({ targetLimit: 10 }),
        maxRounds: 3,
      },
      state: {
        abortController: new AbortController(),
        seenQueryTexts: new Set<string>(),
        generatedQueries: [],
        debugLogs: [],
      },
      ports: {
        openAIStructured: async () => ({
          queries: [
            {
              query: 'CEO tech California',
              family: 'persona_title',
              intent: 'find_decision_makers',
              priority: 1,
              lane: 'person',
              // tavily is deliberately undefined here
            },
          ],
        }),
      },
      logEvent: () => {},
      recordTrace: () => {},
    };

    const output = await executePlanStage(mockContext, {
      round: 1,
      maxRounds: 3,
      domainCluster: 'tech',
      stats: { scout: {} } as any,
      generation: 1,
      remaining: 10,
      generatedQueries: [],
      seenQueryTexts: new Set<string>(),
      searchSpec: buildFallbackSearchSpec('CEO tech California'),
      discoveryProviderMode: 'hybrid',
      brightDataSearchMode: 'fallback',
      brightDataReady: true,
      brightDataProviderDisabled: false,
      brightDataTransportRetryAfter: 0,
      tavilyCapabilities: {} as any,
      brightDataCapabilities: {} as any,
    });

    assert.ok(output.roundPlans.length > 0, 'Should generate round plans');
    assert.ok(output.queryRuns.length > 0, 'Should generate query runs');
    assert.equal(output.queryRuns[0].tavilySearchDepth, 'basic', 'Should default tavilySearchDepth to basic when missing');
  });

  it('scoring.ts normalizes 0-100 scores down to 0-10 without hard-cap clipping', () => {
    const leadWith100Scale = {
      fullName: 'Jane Doe',
      finalSelectionScore: 75, // 0-100 integer
      companyIntentEvidence: null,
    };

    const intentScore = applyIntentEnrichmentDelta(leadWith100Scale);
    assert.ok(intentScore <= 10.0, 'Enriched score must be on 0-10 scale');
    assert.ok(intentScore >= 6.0, 'Normalized 75 must yield score >= 6.0, not clipped down to 1.0 or 0');

    const postIntentScore = applyPostIntentDelta(leadWith100Scale);
    assert.ok(postIntentScore <= 10.0, 'Post-intent score must be on 0-10 scale');
    assert.ok(postIntentScore >= 6.0, 'Normalized 75 must yield score >= 6.0');
  });

  it('verifyStage treats leadScore === minScore - 1 as borderline and applies borderline cap', async () => {
    const minScore = 7.0;
    const mockLead: any = {
      fullName: 'Borderline Test',
      fitScore: 6.0,
      score: 6.0,
      currentTitle: 'CEO',
      currentCompany: 'Borderline Inc',
      evidence: { evidenceQuality: 'good', authorityConfidence: 8.0 },
      contactDetails: { linkedinUrl: 'https://linkedin.com/in/borderline-test' },
    };

    const mockContext: any = {
      config: { sessionId: 'test', promptQuery: 'CEO', minScore },
      state: {
        abortController: new AbortController(),
        existingKeys: new Set<string>(),
      },
      ports: {},
      logEvent: () => {},
      recordTrace: () => {},
    };

    const evidenceByUrl = new Map();
    evidenceByUrl.set('https://linkedin.com/in/borderline-test', {
      url: 'https://linkedin.com/in/borderline-test',
      evidenceQuality: 'good',
      authorityConfidence: 8.0,
      confidenceScore: 8.0,
      evidenceBlock: 'Evidence summary text',
      sourceProviders: ['tavily'],
    });

    const result1 = await executeVerifyStage(mockContext, {
      round: 1,
      provisionalLeads: [mockLead],
      evidenceByUrl,
      searchSpec: buildFallbackSearchSpec('CEO'),
      stats: { rejectionReasons: {} },
    });

    assert.equal(result1.postFilterLeads.length, 1, 'First borderline lead must be admitted');
    assert.equal(result1.postFilterLeads[0].lead._borderlineEvidence, true, 'Must be tagged as borderline evidence');
  });

  it('fuseStage safely handles observations with missing or undefined sourceProviders', async () => {
    const mockContext: any = {
      config: { sessionId: 'test', promptQuery: 'CEO Safe Inc' },
      state: {
        seenCandidateKeys: new Set<string>(),
        existingKeys: new Set<string>(),
        abortController: new AbortController(),
        signalStore: {
          add: () => {},
        },
      },
      ports: {},
      logEvent: () => {},
      recordTrace: () => {},
    };

    const roundItem: any = {
      item: {
        url: 'https://linkedin.com/in/test-safe-providers',
        title: 'Safe Provider Test - CEO',
        content: 'CEO at Safe Inc',
      },
      resultIndex: 0,
    };

    const output = await executeFuseStage(mockContext, {
      round: 1,
      roundItems: [roundItem],
      roundPlans: [],
      queryRuns: [],
      stats: { rejectionReasons: {} },
    });

    assert.ok(Array.isArray(output.candidateItems), 'fuseStage must succeed without throwing TypeError');
    assert.ok(output.candidateItems.length > 0, 'Candidate item must be fused');
    assert.equal(output.candidateItems[0].sourceProvider, 'tavily', 'Must safely default sourceProvider to tavily');
  });
});

describe('Client-side score normalization (LeadContext.tsx:589 inversion)', () => {
  // The sixth and last site of a bug class fixed five times elsewhere. A scraped profile
  // scored exactly 1 - the worst possible 1-10 score, and what the engine clamps every
  // judge-marked reject to - was treated as a 0-1 probability, multiplied by ten, then
  // scaled by ten again by compositeScore, landing on 100 instead of 10.
  it('does not scale a score of exactly 1 (the worst candidate must not become the best)', () => {
    assert.equal(normalizeServerScore(1), 1, 'exactly 1 is a 1-10 score, not a probability');
  });

  it('reproduces the full single-lead composite math without the inversion', () => {
    // Mirrors LeadContext.handleLeadAdded: normalize, then scale to the 0-100 composite.
    const compositeFrom = (raw: unknown) => {
      const serverScore = normalizeServerScore(raw);
      return typeof serverScore === 'number'
        ? Math.round(serverScore <= 10 ? serverScore * 10 : serverScore)
        : null;
    };

    assert.equal(compositeFrom(1), 10, 'worst candidate must land at 10/100, not 100/100');
    assert.equal(compositeFrom(10), 100, 'best candidate still reaches 100');
    assert.equal(compositeFrom(0.85), 85, '0-1 probability scale still expands');
    assert.equal(compositeFrom(85), 85, 'already 0-100 passes through unchanged');
    assert.equal(compositeFrom(0), 0);
    assert.equal(compositeFrom(undefined), null, 'absent score defers to the caller fallback');
  });

  it('preserves the 0-1 probability branch on its exclusive lower bound', () => {
    assert.equal(normalizeServerScore(0.05), 0.5);
    assert.equal(normalizeServerScore(0.999), 9.99);
    assert.equal(normalizeServerScore(0), 0, 'zero is not rescaled');
    assert.equal(normalizeServerScore(undefined), undefined);
    assert.equal(normalizeServerScore(NaN), undefined);
    assert.equal(normalizeServerScore('7' as unknown), undefined, 'non-numbers defer to the caller');
  });

  it('keeps no executable `<= 1.0` score comparison in the client', () => {
    // Source guard so a seventh copy cannot be reintroduced. Comments are stripped first,
    // because the fix deliberately documents the rule in prose.
    const src = readFileSync(
      path.join(process.cwd(), 'src', 'context', 'LeadContext.tsx'),
      'utf8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.equal(
      /<=\s*1\.0/.test(code),
      false,
      'LeadContext.tsx must not compare scores with <= 1.0; use normalizeServerScore',
    );
    assert.match(code, /normalizeServerScore/, 'LeadContext.tsx must use the shared helper');
  });
});
