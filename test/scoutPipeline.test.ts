import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ScoutFreeTierBudget } from '../server/leadSearch/freeTier.ts';
import { fuseObservations } from '../server/leadSearch/observations.ts';
import { buildFallbackQueryPlan, buildFallbackSearchSpec, buildRetrievalTasks } from '../server/leadSearch/searchSpec.ts';
import { selectDiversifiedLeads } from '../server/leadSearch/scoutScoring.ts';
import { rankLeadForFinalSelection } from '../server/leadSearch/scoring.ts';

describe('free-tier prospect scout', () => {
  it('keeps every retrieval lane LinkedIn-first while varying the query intent', () => {
    const spec = buildFallbackSearchSpec('dental clinics in Austin hiring and expanding');
    const tasks = buildRetrievalTasks(buildFallbackQueryPlan('dental clinics in Austin hiring and expanding', spec), spec);

    assert.ok(tasks.some(task => task.lane === 'person' && task.tavily.includeDomains?.includes('linkedin.com')));
    assert.ok(tasks.some(task => task.lane === 'account' && task.tavily.includeDomains?.includes('linkedin.com')));
    assert.ok(tasks.some(task => task.lane === 'signal' && task.tavily.includeDomains?.includes('linkedin.com')));
    assert.ok(tasks.every(task => task.tavily.topic === 'general'));
    assert.ok(tasks.every(task => task.tavily.timeRange === undefined));
  });

  it('caps one scout run before it can consume unbounded free-tier credits', () => {
    const budget = new ScoutFreeTierBudget();

    assert.equal(budget.reserveTavilySearch('advanced'), true);
    assert.equal(budget.reserveTavilySearch('advanced'), false);
    assert.ok(budget.reserveTavilyExtract(10) <= 5);
    assert.equal(budget.snapshot().tavilyCreditsReserved <= 6, true);
  });

  it('fuses duplicated provider observations and retains corroboration', () => {
    const fused = fuseObservations([
      {
        title: 'Jane Doe - Founder at Acme Dental',
        url: 'https://www.linkedin.com/in/jane-doe/',
        content: 'Founder expanding a dental practice in Austin.',
        provider: 'tavily',
        query: 'dental founder Austin',
        round: 1,
        lane: 'person',
        raw: {}
      },
      {
        title: 'Jane Doe - Acme Dental',
        url: 'https://linkedin.com/in/jane-doe',
        content: 'Acme Dental is hiring and opening a new location.',
        provider: 'brightdata',
        query: 'Acme Dental hiring',
        round: 1,
        lane: 'signal',
        raw: {}
      }
    ]);

    assert.equal(fused.length, 1);
    assert.equal(fused[0].corroborated, true);
    assert.deepEqual(fused[0].sourceProviders.sort(), ['brightdata', 'tavily']);
    assert.deepEqual(fused[0].lanes.sort(), ['person', 'signal']);
  });

  it('keeps a final shortlist diversified by company', () => {
    const selected = selectDiversifiedLeads([
      { id: 'a', company: 'Acme', finalSelectionScore: 9.8 },
      { id: 'b', company: 'Acme', finalSelectionScore: 9.5 },
      { id: 'c', company: 'Acme', finalSelectionScore: 9.2 },
      { id: 'd', company: 'Beacon', finalSelectionScore: 9.0 }
    ], 3, 2);

    assert.deepEqual(selected.map(item => item.id), ['a', 'b', 'd']);
  });

  it('does not rank an email higher during scout selection', () => {
    const base = {
      scoreBreakdown: { finalScore: 7 },
      decisionMakerVerification: { confidence: 7 },
      evidence: { evidenceQuality: 'partial', sourceProvider: 'tavily' },
      scout: { criteriaCoverageScore: 7, corroborationScore: 6 }
    };
    const withoutEmail = rankLeadForFinalSelection({ ...base, contactDetails: {} });
    const withEmail = rankLeadForFinalSelection({ ...base, contactDetails: { email: 'founder@example.com' } });

    assert.equal(withEmail, withoutEmail);
  });
});
