import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ScoutFreeTierBudget,
  isProviderCreditReservationEnabled
} from '../server/leadSearch/freeTier.ts';
import {
  resolveDiscoveryProviderMode,
  resolveBrightDataSearchMode,
  shouldRunTavilyForTask,
  shouldRunBrightDataForTask
} from '../server/leadSearch/discoveryRouting.ts';
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
    assert.ok(tasks.some(task => task.providerPreference === 'brightdata'));
  });

  it('does not hard-cap provider calls when credit reservation is disabled (key rotation mode)', () => {
    assert.equal(isProviderCreditReservationEnabled(), false);
    const budget = new ScoutFreeTierBudget();

    for (let i = 0; i < 20; i++) {
      assert.equal(budget.reserveTavilySearch('advanced'), true);
      assert.equal(budget.reserveBrightDataSearch(), true);
    }
    assert.ok(budget.reserveTavilyExtract(50) >= 50);
    assert.equal(budget.snapshot().reservationEnabled, false);
  });

  it('hard-caps only when PROVIDER_CREDIT_RESERVATION=true', () => {
    const previous = process.env.PROVIDER_CREDIT_RESERVATION;
    process.env.PROVIDER_CREDIT_RESERVATION = 'true';
    process.env.TAVILY_SCOUT_MAX_CREDITS_PER_SEARCH = '6';
    process.env.TAVILY_SCOUT_MAX_ADVANCED_SEARCHES = '1';
    process.env.TAVILY_SCOUT_EXTRACT_MAX_URLS = '5';
    try {
      const budget = new ScoutFreeTierBudget();
      assert.equal(budget.reserveTavilySearch('advanced'), true);
      assert.equal(budget.reserveTavilySearch('advanced'), false);
      assert.ok(budget.reserveTavilyExtract(10) <= 5);
      assert.equal(budget.snapshot().reservationEnabled, true);
    } finally {
      if (previous === undefined) delete process.env.PROVIDER_CREDIT_RESERVATION;
      else process.env.PROVIDER_CREDIT_RESERVATION = previous;
    }
  });

  it('routes dual-provider discovery without requiring Tavily low yield for BD primary', () => {
    assert.equal(resolveDiscoveryProviderMode({ brightDataConfigured: true }), 'hybrid');
    assert.equal(resolveDiscoveryProviderMode({ brightDataConfigured: false }), 'tavily_primary');
    assert.equal(resolveBrightDataSearchMode({ discoveryMode: 'hybrid' }), 'primary');
    assert.equal(resolveBrightDataSearchMode({ discoveryMode: 'tavily_primary' }), 'fallback');

    const person = { lane: 'person' as const, providerPreference: 'tavily' as const, priority: 1 };
    const account = { lane: 'account' as const, providerPreference: 'brightdata' as const, priority: 2 };

    assert.equal(shouldRunTavilyForTask(person, 'hybrid', true), true);
    assert.equal(shouldRunTavilyForTask(account, 'hybrid', true), false);
    assert.equal(shouldRunTavilyForTask(person, 'bd_primary', true), true);
    assert.equal(shouldRunBrightDataForTask(account, 'hybrid', 'primary', { brightDataReady: true, tavilyResultCount: 50 }), true);
    assert.equal(shouldRunBrightDataForTask(person, 'tavily_primary', 'fallback', { brightDataReady: true, tavilyResultCount: 50 }), false);
    assert.equal(shouldRunBrightDataForTask(person, 'tavily_primary', 'fallback', { brightDataReady: true, tavilyResultCount: 2 }), true);
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
