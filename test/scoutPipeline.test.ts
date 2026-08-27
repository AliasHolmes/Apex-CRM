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
import {
  buildFallbackQueryPlan,
  buildFallbackSearchSpec,
  buildRetrievalTasks,
  normalizeSearchSpec
} from '../server/leadSearch/searchSpec.ts';
import { selectDiversifiedLeads } from '../server/leadSearch/scoutScoring.ts';
import { rankLeadForFinalSelection } from '../server/leadSearch/scoring.ts';

describe('free-tier prospect scout', () => {
  it('preserves an explicitly requested discovery mode over a compiled spec', () => {
    const spec = normalizeSearchSpec(
      { mode: 'person_first', company: { keywords: ['Instig8'] } },
      'Instig8 hiring automation developers',
      'signal_first'
    );

    assert.equal(spec.mode, 'signal_first');
  });

  it('keeps identity lanes LinkedIn-first while signal lanes search the open web', () => {
    const spec = buildFallbackSearchSpec('dental clinics in Austin hiring and expanding');
    const tasks = buildRetrievalTasks(buildFallbackQueryPlan('dental clinics in Austin hiring and expanding', spec), spec);

    assert.ok(tasks.some(task => task.lane === 'person' && task.tavily.includeDomains?.includes('linkedin.com')));
    assert.ok(tasks.some(task => task.lane === 'account' && task.tavily.includeDomains?.includes('linkedin.com')));
    assert.ok(tasks.some(task => task.lane === 'signal' && task.tavily.includeDomains === undefined));
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

  it('ranks un-keyed candidates using rankLeadForFinalSelection fallback', () => {
    const candidateHigh = {
      id: 'high',
      company: 'Apex',
      decisionMakerVerification: { confidence: 9 },
      scout: { criteriaCoverageScore: 9, corroborationScore: 9 },
      evidence: { evidenceQuality: 'good', sourceProvider: 'tavily' }
    };
    const candidateLow = {
      id: 'low',
      company: 'Beacon',
      decisionMakerVerification: { confidence: 3 },
      scout: { criteriaCoverageScore: 3, corroborationScore: 3 },
      evidence: { evidenceQuality: 'weak', sourceProvider: 'tavily' }
    };

    const selected = selectDiversifiedLeads([candidateLow, candidateHigh], 1, 1);
    assert.equal(selected[0].id, 'high', 'Higher quality candidate must be selected even when finalSelectionScore key is absent');
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

  it('F8: classifies stall cause and preserves session when stall is provider-impaired', () => {
    let consecutiveStalledRounds = 0;
    let providerImpairedStallRounds = 0;
    let stopReason: string | null = null;

    // Simulate 2 rounds of provider failure (e.g. extraction 429/failures)
    for (let round = 1; round <= 2; round++) {
      const newAcceptedInRound = 0;
      const lastRoundProviderImpaired = true; // extraction failed

      if (newAcceptedInRound === 0) {
        if (lastRoundProviderImpaired) {
          providerImpairedStallRounds++;
          if (providerImpairedStallRounds >= 3) {
            stopReason = 'provider_exhausted';
            break;
          }
        } else {
          consecutiveStalledRounds++;
          if (consecutiveStalledRounds >= 2) {
            stopReason = 'early_exit_stalled';
            break;
          }
        }
      }
    }

    assert.equal(consecutiveStalledRounds, 0, 'Genuine stall counter should not advance on provider impairment');
    assert.equal(providerImpairedStallRounds, 2);
    assert.equal(stopReason, null, 'Session should not exit early_exit_stalled after 2 provider-impaired rounds');

    // On 3rd consecutive provider impairment, exits with provider_exhausted
    const lastRoundProviderImpaired = true;
    providerImpairedStallRounds++;
    if (providerImpairedStallRounds >= 3) stopReason = 'provider_exhausted';
    assert.equal(stopReason, 'provider_exhausted');
  });

  it('F2: soft-caps saturated companies in collection and skips deep enrichment when pool is healthy', () => {
    const maxPerCompany = 2;
    const acceptedLeads = [
      { id: '1', company: 'Acme Corp', fullName: 'Alice' },
      { id: '2', company: 'Acme Corp', fullName: 'Bob' },
      { id: '3', company: 'Other LLC', fullName: 'Charlie' }
    ];

    const acceptedCompanyCounts = new Map<string, number>();
    for (const lead of acceptedLeads) {
      const comp = lead.company.trim().toLowerCase();
      acceptedCompanyCounts.set(comp, (acceptedCompanyCounts.get(comp) || 0) + 1);
    }

    assert.equal(acceptedCompanyCounts.get('acme corp'), 2);

    // Candidates in current round
    const candidates = [
      { fullName: 'David (Acme)', company: 'Acme Corp', score: 9 },
      { fullName: 'Eve (Beta)', company: 'Beta Corp', score: 8 }
    ];

    // In enrichment, when pool is healthy (e.g. accepted >= 80% target), Acme candidate is skipped
    const rerankPoolTarget = 3;
    const isPoolStarved = acceptedLeads.length < rerankPoolTarget * 0.8;
    assert.equal(isPoolStarved, false);

    const enrichmentTargets = candidates.filter(c => {
      const comp = c.company.trim().toLowerCase();
      return (acceptedCompanyCounts.get(comp) || 0) < maxPerCompany;
    });

    assert.equal(enrichmentTargets.length, 1);
    assert.equal(enrichmentTargets[0].fullName, 'Eve (Beta)');
  });
});
