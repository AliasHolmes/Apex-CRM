import test from 'node:test';
import assert from 'node:assert/strict';
import { executeRetrieveStage } from '../server/leadSearch/stages/retrieveStage.js';
import { executePlanStage } from '../server/leadSearch/stages/planStage.js';
import { buildCollectionCapacity } from '../server/leadSearch/collectionCapacity.js';
import type { SessionContext } from '../server/leadSearch/pipelineTypes.js';

function createMockContext(overrides: Partial<SessionContext> = {}): SessionContext {
  const logs: string[] = [];
  const traceEvents: any[] = [];
  return {
    config: {
      sessionId: `test-session-${Date.now()}`,
      promptQuery: 'Head of Growth in New York',
      targetLimit: 10,
      minScore: 7,
      ttlDays: 30,
      startedAt: Date.now(),
      contract: {
        brief: 'Head of Growth in New York',
        requirements: [
          {
            id: 'req-1',
            description: 'Head of Growth',
            importance: 'hard',
            scope: 'role',
            evidenceModality: 'structured_profile',
            acceptableTerms: ['Head of Growth']
          }
        ],
        exclusions: [],
        scoringRubric: { coreFitWeight: 40, buyerAuthorityWeight: 30, firmographicWeight: 20, buyingSignalWeight: 10, penaltyPerMissingRequirement: 15 },
        searchQueries: [],
        decompositionMode: 'single_stream',
        policyVersion: 'test-v1'
      } as any,
      capacity: buildCollectionCapacity({ targetLimit: 10 }),
      maxRounds: 4,
      creditReservationEnabled: false,
      companyIntentEnabled: false,
      companyIntentMaxPerSearch: 2,
      companyIntentMinScore: 6,
      linkedinPostIntentEnabled: false,
      profileEnrichmentStage: 'none',
      profileConcurrency: 1,
      profileMaxPerSearch: 2,
      extractionConcurrency: 1,
      judgeConcurrency: 1
    },
    state: {
      round: 1,
      seenCandidateKeys: new Set<string>(),
      existingKeys: new Set<string>(),
      queryRuns: [],
      acceptedLeads: [],
      qualifiedLeads: [],
      finalLeads: [],
      rejectionCounts: {},
      failureCounts: {},
      brightDataStats: { attempted: 0, succeeded: 0, failed: 0, failureReasons: {} },
      freeTierBudget: {
        reserveTavilySearch: () => true,
        reserveBrightDataSearch: () => true
      } as any,
      llmCircuitBreaker: { isTripped: () => false, recordFailure: () => {}, recordSuccess: () => {} } as any,
      abortController: new AbortController(),
      telemetry: {
        record: (e: any) => { traceEvents.push(e); return e; },
        getEvents: () => traceEvents
      } as any,
      debugLogs: [],
      previousRoundSummary: {}
    },
    ports: {
      brightDataSearch: async () => [],
      tavilySearch: async () => ({ text: '', sources: [], items: [] }),
      scrapeMarkdown: async () => '',
      scrapeBatchMarkdown: async () => []
    },
    logEvent: (msg: string) => logs.push(msg),
    recordTrace: (event: any) => { traceEvents.push(event); return event; },
    ...overrides
  };
}

test('retrieveStage executes Wave 1 Tavily and Unconditional Bright Data in parallel', async () => {
  let tavilyCalled = false;
  let bdCalled = false;

  const mockCtx = createMockContext({
    ports: {
      tavilySearch: async () => {
        tavilyCalled = true;
        return {
          text: 'Tavily Result Text',
          sources: [],
          items: [{ title: 'Alice Smith - Head of Growth', url: 'https://www.linkedin.com/in/alice-growth', content: 'Alice profile' }]
        };
      },
      brightDataSearch: async () => {
        bdCalled = true;
        return [
          {
            title: 'Bob Jones - Head of Growth',
            url: 'https://www.linkedin.com/in/bob-growth',
            snippet: 'Bob profile',
            content: 'Bob profile',
            sourceProvider: 'brightdata_search' as const,
            sourceEngine: 'google' as const
          }
        ];
      },
      scrapeMarkdown: async () => '',
      scrapeBatchMarkdown: async () => []
    }
  });

  const roundPlans = [
    {
      item: {
        family: 'person',
        lane: 'person',
        providerPreference: 'tavily',
        intent: 'person',
        priority: 1,
        query: 'Head of Growth New York startup',
        tavily: { searchDepth: 'basic', maxResults: 5 }
      } as any,
      executableQuery: 'Head of Growth New York startup'
    },
    {
      item: {
        family: 'account',
        lane: 'account',
        providerPreference: 'brightdata',
        intent: 'account',
        priority: 2,
        query: 'site:linkedin.com/in/ "Head of Growth" New York',
        tavily: { searchDepth: 'basic', maxResults: 5 }
      } as any,
      executableQuery: 'site:linkedin.com/in/ "Head of Growth" New York'
    }
  ];

  const queryRuns = roundPlans.map(p => ({
    round: 1,
    query: p.executableQuery,
    family: p.item.family,
    intent: p.item.intent,
    rawCandidates: 0,
    uniqueCandidates: 0,
    evidenceBlocks: 0,
    extractedLeads: 0,
    acceptedLeads: 0,
    rejectionReasons: {},
    lane: p.item.lane,
    providerPreference: p.item.providerPreference,
    tavilySearchDepth: 'basic',
    corroboratedCandidates: 0,
    searchLatencyMs: 0,
    providerUnits: 0,
    qualifiedFinalists: 0,
    rescuedFinalists: 0,
    returnedFinalists: 0
  }));

  const result = await executeRetrieveStage(mockCtx, {
    round: 1,
    roundPlans,
    queryRuns,
    discoveryProviderMode: 'hybrid',
    brightDataSearchMode: 'primary',
    brightDataReady: true,
    brightDataProviderDisabled: false,
    brightDataTransportRetryAfter: 0,
    brightDataSearchRetryMax: 1,
    brightDataSearchRetryBaseDelayMs: 10,
    tavilyCapabilities: { monthlyLimit: 1000, configured: true } as any,
    brightDataCapabilities: { monthlyLimit: 500, configured: true } as any,
    stats: { sourceProvider: 'tavily', brightDataFailures: 0, rounds: 1 } as any
  });

  assert.ok(tavilyCalled, 'Tavily should have been executed in Wave 1');
  assert.ok(bdCalled, 'Bright Data should have been executed in Wave 1');
  assert.equal(result.roundItems.length, 3, 'Both Wave 1 lanes execute and aggregate items');
  assert.ok(result.roundItems.some(i => i.item.sourceProvider === 'tavily'));
  assert.ok(result.roundItems.some(i => i.item.sourceProvider === 'brightdata'));
});

test('retrieveStage Wave 2 triggers conditional supplemental Bright Data tasks when Tavily yield is low', async () => {
  let wave2Executed = false;

  const mockCtx = createMockContext({
    ports: {
      tavilySearch: async () => {
        // Return low results (< 5)
        return {
          text: '',
          sources: [],
          items: [{ title: 'Single Candidate', url: 'https://www.linkedin.com/in/single', content: 'Snippet' }]
        };
      },
      brightDataSearch: async () => {
        wave2Executed = true;
        return [
          {
            title: 'Supplemental BD Result',
            url: 'https://www.linkedin.com/in/supplemental',
            snippet: 'BD Snippet',
            content: 'BD Snippet',
            sourceProvider: 'brightdata_search' as const,
            sourceEngine: 'google' as const
          }
        ];
      },
      scrapeMarkdown: async () => '',
      scrapeBatchMarkdown: async () => []
    }
  });

  const roundPlans = [
    {
      item: {
        family: 'person',
        lane: 'person',
        providerPreference: 'tavily',
        intent: 'person',
        priority: 1,
        query: 'Tavily Search Query',
        tavily: { searchDepth: 'basic', maxResults: 5 }
      } as any,
      executableQuery: 'Tavily Search Query'
    },
    {
      item: {
        family: 'person',
        lane: 'person',
        providerPreference: 'tavily',
        intent: 'person',
        priority: 2,
        query: 'Fallback Supplemental Query',
        tavily: { searchDepth: 'basic', maxResults: 5 }
      } as any,
      executableQuery: 'Fallback Supplemental Query'
    }
  ];

  const queryRuns = roundPlans.map(p => ({
    round: 1,
    query: p.executableQuery,
    family: p.item.family,
    intent: p.item.intent,
    rawCandidates: 0,
    uniqueCandidates: 0,
    evidenceBlocks: 0,
    extractedLeads: 0,
    acceptedLeads: 0,
    rejectionReasons: {},
    lane: p.item.lane,
    providerPreference: p.item.providerPreference,
    tavilySearchDepth: 'basic',
    corroboratedCandidates: 0,
    searchLatencyMs: 0,
    providerUnits: 0,
    qualifiedFinalists: 0,
    rescuedFinalists: 0,
    returnedFinalists: 0
  }));

  const result = await executeRetrieveStage(mockCtx, {
    round: 1,
    roundPlans,
    queryRuns,
    discoveryProviderMode: 'tavily_primary',
    brightDataSearchMode: 'fallback',
    brightDataReady: true,
    brightDataProviderDisabled: false,
    brightDataTransportRetryAfter: 0,
    brightDataSearchRetryMax: 1,
    brightDataSearchRetryBaseDelayMs: 10,
    tavilyCapabilities: { monthlyLimit: 1000, configured: true } as any,
    brightDataCapabilities: { monthlyLimit: 500, configured: true } as any,
    stats: { sourceProvider: 'tavily', brightDataFailures: 0, rounds: 1 } as any
  });

  assert.ok(wave2Executed, 'Wave 2 supplemental Bright Data should trigger on low Tavily yield in fallback mode');
  assert.equal(result.roundItems.length, 4, 'Includes 2 Tavily items + 2 supplemental BD items');
});

import { buildFallbackSearchSpec } from '../server/leadSearch/searchSpec.js';

test('planStage derives adaptive tasks per round from CollectionCapacity candidateBatchSize', async () => {
  delete process.env.LEAD_ADAPTIVE_TASKS_PER_ROUND;

  const mockCtx = createMockContext({
    config: {
      ...createMockContext().config,
      capacity: buildCollectionCapacity({ targetLimit: 50 }) // candidateBatchSize = 30
    }
  });

  const seenQueryTexts = new Set<string>();
  const generatedQueries: string[] = [];

  const planResult = await executePlanStage(mockCtx, {
    round: 1,
    remaining: 50,
    generatedQueries,
    seenQueryTexts,
    searchSpec: buildFallbackSearchSpec('VP of Sales B2B SaaS'),
    discoveryProviderMode: 'hybrid',
    stats: { scout: {}, queryRuns: [] } as any
  });

  assert.ok(planResult.roundPlans.length >= 3, 'Derived tasks should be >= 3 for large candidate batch capacity');
  assert.ok(planResult.roundPlans.length <= 8, 'Derived tasks should not exceed scheduler safety clamp of 8');
});

import { executeFuseStage } from '../server/leadSearch/stages/fuseStage.js';

test('parallel two-wave retrieval produces identical fused candidate output to serial retrieval', async () => {
  const mockPlans = [
    {
      item: {
        family: 'person',
        lane: 'person',
        providerPreference: 'tavily',
        intent: 'person',
        priority: 1,
        query: 'VP Sales New York',
        tavily: { searchDepth: 'basic', maxResults: 5 }
      } as any,
      executableQuery: 'VP Sales New York'
    },
    {
      item: {
        family: 'account',
        lane: 'account',
        providerPreference: 'brightdata',
        intent: 'account',
        priority: 2,
        query: 'site:linkedin.com/in/ "VP Sales" New York',
        tavily: { searchDepth: 'basic', maxResults: 5 }
      } as any,
      executableQuery: 'site:linkedin.com/in/ "VP Sales" New York'
    }
  ];

  const roundItems = [
    {
      item: {
        title: 'Sarah Connor - VP Sales',
        url: 'https://www.linkedin.com/in/sarah-connor',
        content: 'Experienced VP Sales leader in NYC.',
        sourceProvider: 'tavily'
      },
      resultIndex: 0
    },
    {
      item: {
        title: 'John Doe - VP Sales',
        url: 'https://www.linkedin.com/in/john-doe-sales',
        content: 'Enterprise VP Sales in New York SaaS.',
        sourceProvider: 'brightdata_search'
      },
      resultIndex: 1
    }
  ];

  const ctx1 = createMockContext();
  const queryRuns1 = mockPlans.map(p => ({
    round: 1, query: p.executableQuery, family: p.item.family, intent: p.item.intent,
    rawCandidates: 0, uniqueCandidates: 0, evidenceBlocks: 0, extractedLeads: 0, acceptedLeads: 0,
    rejectionReasons: {}, lane: p.item.lane, providerPreference: p.item.providerPreference,
    tavilySearchDepth: 'basic', corroboratedCandidates: 0, searchLatencyMs: 0, providerUnits: 0,
    qualifiedFinalists: 0, rescuedFinalists: 0, returnedFinalists: 0
  }));

  const fusedOutput = await executeFuseStage(ctx1, {
    round: 1,
    roundItems,
    roundPlans: mockPlans,
    queryRuns: queryRuns1,
    stats: { rejectionReasons: {} }
  });

  assert.equal(fusedOutput.candidateItems.length, 2);
  assert.ok(fusedOutput.candidateItems.some((c: any) => c.title.includes('Sarah Connor')));
  assert.ok(fusedOutput.candidateItems.some((c: any) => c.title.includes('John Doe')));
  assert.equal(fusedOutput.roundCandidateKeys.size, 2);
});

test('executeFuseStage does not emit session-killing stopReason on zero unique candidates', async () => {
  const mockPlans = [
    {
      item: {
        query: 'test query',
        family: 'person',
        lane: 'person',
        intent: 'person',
        priority: 1,
        providerPreference: 'tavily',
        tavily: { searchDepth: 'basic', maxResults: 5 }
      } as any,
      executableQuery: 'test query'
    }
  ];

  const ctx = createMockContext();
  // Simulate duplicate / non-profile items that yield 0 unique candidates
  const roundItems = [
    {
      item: {
        title: 'Random Article',
        url: 'https://example.com/some-article-not-linkedin',
        content: 'Just an article with no linkedin profile.',
        sourceProvider: 'tavily'
      },
      resultIndex: 0
    }
  ];

  const queryRuns = mockPlans.map(p => ({
    round: 2, query: p.executableQuery, family: p.item.family, intent: p.item.intent,
    rawCandidates: 0, uniqueCandidates: 0, evidenceBlocks: 0, extractedLeads: 0, acceptedLeads: 0,
    rejectionReasons: {}, lane: p.item.lane, providerPreference: p.item.providerPreference,
    tavilySearchDepth: 'basic', corroboratedCandidates: 0, searchLatencyMs: 0, providerUnits: 0,
    qualifiedFinalists: 0, rescuedFinalists: 0, returnedFinalists: 0
  }));

  const fusedOutput = await executeFuseStage(ctx, {
    round: 2,
    roundItems,
    roundPlans: mockPlans,
    queryRuns,
    stats: { rejectionReasons: {} }
  });

  assert.equal(fusedOutput.candidateItems.length, 0);
  assert.equal(fusedOutput.uniqueRoundItemsCount, 0);
  assert.equal(fusedOutput.stopReason, undefined, 'Zero-yield round must not return stopReason: exhausted');
});
