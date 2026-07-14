import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLeadEvidence, inferTavilyEvidenceQuality } from '../server/leadSearch/evidence.ts';
import { computeScoreBreakdown, rankLeadForFinalSelection } from '../server/leadSearch/scoring.ts';
import { buildFallbackQueryPlan, normalizeQueryPlanItems, toLinkedInSearchQuery } from '../server/leadSearch/strategist.ts';
import { incrementRejection, mapBrightDataRejection } from '../server/leadSearch/rejections.ts';

describe('lead search helpers', () => {
  it('computes deterministic final scores and clamps LLM component scores', () => {
    const score = computeScoreBreakdown({ fitScore: 12, intentScore: 8, timingScore: 0 }, 'good', 'brightdata');

    assert.equal(score.fitScore, 10);
    assert.equal(score.intentScore, 8);
    assert.equal(score.timingScore, 5);
    assert.equal(score.evidenceQualityScore, 9);
    assert.equal(score.sourceConfidenceScore, 8);
    assert.equal(score.finalScore, 8.4);
  });

  it('ranks stronger evidence and authority above earlier acceptable leads', () => {
    const earlyAcceptable = {
      scoreBreakdown: { finalScore: 7 },
      decisionMakerVerification: { confidence: 6 },
      evidence: { evidenceQuality: 'weak', sourceProvider: 'tavily' },
      contactDetails: {},
    };
    const laterStronger = {
      scoreBreakdown: { finalScore: 6.8 },
      decisionMakerVerification: { confidence: 9 },
      evidence: { evidenceQuality: 'good', sourceProvider: 'brightdata' },
      companyIntentEvidence: { evidenceQuality: 'good' },
      contactDetails: { email: 'founder@example.com' },
    };

    assert.ok(rankLeadForFinalSelection(laterStronger) > rankLeadForFinalSelection(earlyAcceptable));
  });

  it('normalizes legacy string and structured strategist outputs', () => {
    const normalized = normalizeQueryPlanItems({
      queries: [
        'site:linkedin.com/in/ LinkedIn dental clinic owner Austin',
        {
          query: 'dental practice growth manager Austin',
          family: 'growth_signal',
          intent: 'find_buying_signal',
          expectedSignal: 'Growth responsibility',
          priority: 2,
        },
      ],
    });

    assert.deepEqual(normalized.map(item => item.query), [
      'dental clinic owner Austin',
      'dental practice growth manager Austin',
    ]);
    assert.equal(normalized[1].family, 'growth_signal');
    assert.equal(toLinkedInSearchQuery(normalized[0]), 'site:linkedin.com/in/ dental clinic owner Austin');
  });

  it('builds deterministic fallback query plans', () => {
    const fallback = buildFallbackQueryPlan('dental clinics Austin patient booking');

    assert.equal(fallback.length, 4);
    assert.equal(fallback.some(item => item.family === 'tooling_signal'), true);
    assert.equal(fallback.some(item => item.intent === 'find_decision_makers'), true);
  });

  it('classifies Tavily evidence quality and caps preserved snippets', () => {
    const partial = inferTavilyEvidenceQuality({
      content: 'Founder at a fast-growing dental practice working on patient acquisition, front-office follow-up, scheduling operations, and growth systems for a multi-location clinic.',
      raw_content: '',
    });
    const evidence = createLeadEvidence({
      sourceUrl: 'https://linkedin.com/in/jane-doe',
      sourceProvider: 'tavily',
      sourceQuery: 'site:linkedin.com/in/ dental founder Austin',
      sourceRound: 1,
      evidenceQuality: partial,
      evidenceBlock: [
        'LINK: https://linkedin.com/in/jane-doe',
        'TITLE: Jane Doe - Founder',
        '[TAVILY SNIPPET]',
        'Founder at a dental practice focused on patient acquisition.',
        'Extra line that should be capped when max snippets is reached.',
      ].join('\n'),
      whyThisLead: 'Founder role matches the query.',
    });

    assert.equal(partial, 'partial');
    assert.equal(evidence.snippets.length, 3);
    assert.equal(evidence.whyThisLead, 'Founder role matches the query.');
    assert.equal(evidence.snippets.some(snippet => snippet.includes('LINK:')), false);
  });

  it('tracks structured rejection counts and maps Bright Data parser reasons', () => {
    const counts: Record<string, number> = {};
    incrementRejection(counts, 'duplicate_candidate');
    incrementRejection(counts, 'duplicate_candidate');
    incrementRejection(counts, mapBrightDataRejection('blocked_or_login_wall'));

    assert.equal(counts.duplicate_candidate, 2);
    assert.equal(counts.brightdata_login_wall, 1);
  });
});
