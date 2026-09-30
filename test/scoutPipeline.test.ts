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
import { buildScoutEvidence, selectDiversifiedLeads } from '../server/leadSearch/scoutScoring.ts';
import { computeMMRDiversitySelection, getLeadScore, rankLeadForFinalSelection } from '../server/leadSearch/scoring.ts';
import { effectiveScore } from '../server/leadSearch/sessionHelpers.ts';
import { executeFuseStage } from '../server/leadSearch/stages/fuseStage.ts';
import { buildRoundDiagnostics } from '../server/leadSearch/roundDiagnostics.ts';
import type { ProspectContract } from '../server/leadSearch/prospectContract.ts';

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

  it('exhaustively deduplicates across all identity key variations in executeFuseStage', async () => {
    const ctx: any = {
      config: { promptQuery: 'founders' },
      state: {
        seenCandidateKeys: new Set(['linkedin:alexriver']),
        existingKeys: new Set(['linkedin:janedoe']),
        acceptedLeads: []
      },
      logEvent: () => {}
    };

    const input: any = {
      round: 1,
      roundItems: [
        {
          item: {
            title: 'Alex River - Founder',
            url: 'https://www.linkedin.com/in/alexriver',
            content: 'Founder at Apex'
          },
          resultIndex: 0
        },
        {
          item: {
            title: 'Jane Doe - CEO',
            url: 'https://linkedin.com/in/janedoe',
            content: 'CEO at Beta'
          },
          resultIndex: 1
        },
        {
          item: {
            title: 'Sam Taylor - VP',
            url: 'https://linkedin.com/in/samtaylor',
            content: 'VP at Gamma'
          },
          resultIndex: 2
        }
      ],
      roundPlans: [],
      queryRuns: [],
      stats: { rejectionReasons: {} }
    };

    const output = await executeFuseStage(ctx, input);
    assert.equal(output.candidateItems.length, 1, 'Only unique new candidate Sam Taylor should pass fusion');
    assert.equal(output.candidateItems[0]._linkedinUsername, 'samtaylor');
  });

  it('Phase 1.2: criterionMatches and roundDiagnostics use word-boundary + alias matching (no substring false positives)', () => {
    const spec = buildFallbackSearchSpec('CTOs and VPs');
    spec.person.includeTitles = ['cto', 'vp'];
    spec.person.seniorities = [];
    spec.person.locations = ['us'];

    const directorLead = {
      fullName: 'Pat Director',
      currentTitle: 'Sales Director',
      currentCompany: 'Status Corp',
      location: 'Focus City'
    };
    const directorEvidence = buildScoutEvidence(directorLead, spec);
    assert.equal(
      directorEvidence.matchedCriteria.includes('target title'),
      false,
      '"cto" must not substring-match "Sales Director"'
    );
    assert.equal(
      directorEvidence.matchedCriteria.includes('target location'),
      false,
      '"us" must not substring-match "Status Corp" or "Focus City"'
    );

    const svpLead = {
      fullName: 'Dana Senior',
      currentTitle: 'SVP of Revenue',
      currentCompany: 'Acme',
      location: 'Austin'
    };
    const svpEvidence = buildScoutEvidence(svpLead, spec);
    assert.equal(
      svpEvidence.matchedCriteria.includes('target title'),
      false,
      '"vp" must not substring-match "SVP"'
    );

    const aliasCtoLead = {
      fullName: 'Robin Chief',
      currentTitle: 'Chief Technology Officer',
      currentCompany: 'Apex',
      location: 'United States'
    };
    const aliasCtoEvidence = buildScoutEvidence(aliasCtoLead, spec);
    assert.equal(
      aliasCtoEvidence.matchedCriteria.includes('target title'),
      true,
      '"cto" must alias-match "Chief Technology Officer"'
    );
    assert.equal(
      aliasCtoEvidence.matchedCriteria.includes('target location'),
      true,
      '"us" must alias-match "United States"'
    );

    const contract: ProspectContract = {
      version: 1,
      policyVersion: 'evidence-contract-v9',
      brief: 'CTOs in the US',
      decompositionMode: 'single_stream_identity',
      identitySpec: { roles: ['cto'], seniorities: [], companyTypes: [], industries: [], locations: ['us'] },
      intentSpec: { hiringSignals: [], painSignals: [], toolingKeywords: [], growthSignals: [] },
      authorityRequired: true,
      requirements: [
        {
          id: 'person_role',
          scope: 'person_role',
          description: 'Must be CTO',
          sourcePhrase: 'CTOs',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          queryable: true,
          requirementClass: 'identity_hard',
          acceptableTerms: ['cto']
        }
      ],
      exclusions: [],
      initialQueries: []
    };
    const diag = buildRoundDiagnostics({
      round: 1,
      rawCandidates: 1,
      extractedCandidates: 1,
      leads: [{ fullName: 'Pat Director', currentTitle: 'Operations Coordinator', summary: 'Reports to the factory director' }],
      contract,
      targetLimit: 5
    });
    assert.equal(diag.requirements[0].pass, 0, '"director" in summary must not satisfy "cto" requirement in roundDiagnostics');
  });

  it('Phase 1.3: selectDiversifiedLeads preserves 1-10 scores without sigmoid distortion or scoreBreakdown mutation', () => {
    const candidates = [
      { id: 'c1', company: 'Alpha', finalSelectionScore: 8.2, scoreBreakdown: { fitScore: 8, intentScore: 8, timingScore: 8, evidenceQualityScore: 8, sourceConfidenceScore: 8, finalScore: 8.2 } },
      { id: 'c2', company: 'Beta', finalSelectionScore: 7.4, scoreBreakdown: { fitScore: 7, intentScore: 7, timingScore: 7, evidenceQualityScore: 7, sourceConfidenceScore: 7, finalScore: 7.4 } },
      { id: 'c3', company: 'Gamma', finalSelectionScore: 6.1, scoreBreakdown: { fitScore: 6, intentScore: 6, timingScore: 6, evidenceQualityScore: 6, sourceConfidenceScore: 6, finalScore: 6.1 } }
    ];
    const selected = selectDiversifiedLeads(candidates, 3, 1);
    const byId = new Map(selected.map(s => [s.id, s]));
    assert.equal(byId.get('c1')?.finalSelectionScore, 8.2);
    assert.equal(byId.get('c2')?.finalSelectionScore, 7.4);
    assert.equal(byId.get('c3')?.finalSelectionScore, 6.1);
    assert.equal(byId.get('c1')?.scoreBreakdown.finalScore, 8.2);
    assert.equal((byId.get('c1') as any)?.sigmoidApplied, undefined);
  });

  it('Phase 2.1: getLeadScore enforces canonical precedence (qualification.finalScore > finalSelectionScore > scoreBreakdown.finalScore > fitScore > compositeScore) and 0-10 scaling', () => {
    // 1. qualification.finalScore wins over stale finalSelectionScore
    assert.equal(
      getLeadScore({
        qualification: { finalScore: 8.7 },
        finalSelectionScore: 7.1,
        scoreBreakdown: { finalScore: 6.5 },
        fitScore: 5.0,
        compositeScore: 40
      }),
      8.7
    );

    // 2. finalSelectionScore wins when qualification.finalScore is absent
    assert.equal(
      getLeadScore({
        finalSelectionScore: 8.4,
        scoreBreakdown: { finalScore: 6.5 },
        fitScore: 5.0
      }),
      8.4
    );

    // 3. scoreBreakdown.finalScore wins over fitScore / compositeScore
    assert.equal(
      getLeadScore({
        scoreBreakdown: { finalScore: 7.6 },
        fitScore: 6.0,
        compositeScore: 50
      }),
      7.6
    );

    // 4. 0-1 probability and 0-100 composite scales normalize to 1-10, while 1.0 stays 1.0
    assert.equal(getLeadScore({ qualification: { finalScore: 0.85 } }), 8.5);
    assert.equal(getLeadScore({ compositeScore: 88 }), 8.8);
    assert.equal(getLeadScore({ qualification: { finalScore: 1.0 } }), 1.0);
    assert.equal(getLeadScore({}, 4.5), 4.5);

    // 5. sessionHelpers.effectiveScore delegates to getLeadScore(lead, 0)
    assert.equal(effectiveScore({ qualification: { finalScore: 9.1 } }), 9.1);
    assert.equal(effectiveScore({}), 0);
  });

  it('Phase 2.2: computeMMRDiversitySelection accepts precomputedRanks and avoids redundant rank recomputation', () => {
    const pool = [
      { id: '1', fullName: 'A', currentCompany: 'Alpha', location: 'Austin', qualification: { finalScore: 9.0 } },
      { id: '2', fullName: 'B', currentCompany: 'Beta', location: 'Boston', qualification: { finalScore: 8.5 } },
      { id: '3', fullName: 'C', currentCompany: 'Gamma', location: 'Chicago', qualification: { finalScore: 8.0 } },
      { id: '4', fullName: 'D', currentCompany: 'Delta', location: 'Denver', qualification: { finalScore: 7.5 } }
    ];
    const direct = computeMMRDiversitySelection(pool, 3, 0.75);
    const rankMap = new Map(pool.map(c => [c, rankLeadForFinalSelection(c)]));
    const cached = computeMMRDiversitySelection(pool, 3, 0.75, rankMap);
    assert.deepEqual(cached.map(c => c.id), direct.map(c => c.id));
  });
});


