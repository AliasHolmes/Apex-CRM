import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRetrievalCacheKey, readCachedSearch, writeCachedSearch } from '../server/leadSearch/retrievalCache.js';
import { executeRetrieveStage } from '../server/leadSearch/stages/retrieveStage.js';
import { buildCollectionCapacity } from '../server/leadSearch/collectionCapacity.js';

const result = { text: 'r', sources: [], items: [{ title: 'Jane Doe - Founder - Nimbus', url: 'https://www.linkedin.com/in/jane-doe', content: 'Founder' }] };

test('keys are stable across whitespace/case and differ by options', () => {
  const a = buildRetrievalCacheKey('tavily', 'Founder  AI Agency', { maxResults: 10, includeDomains: ['linkedin.com'] });
  assert.equal(a, buildRetrievalCacheKey('tavily', 'founder ai agency', { maxResults: 10, includeDomains: ['LinkedIn.com'] }));
  assert.notEqual(a, buildRetrievalCacheKey('tavily', 'founder ai agency', { maxResults: 20, includeDomains: ['linkedin.com'] }));
});

test('round-trips and ignores expired entries', () => {
  const key = buildRetrievalCacheKey('tavily', 'expiry probe', {});
  writeCachedSearch(key, result);
  assert.equal(readCachedSearch(key)?.items.length, 1);
  const farFuture = new Date(Date.now() + 365 * 24 * 3600 * 1000);
  assert.equal(readCachedSearch(key, farFuture), null);
});

test('disabled when the TTL is zero', () => {
  process.env.LEAD_RETRIEVAL_CACHE_TTL_DAYS = '0';
  try {
    const key = buildRetrievalCacheKey('tavily', 'disabled probe', {});
    writeCachedSearch(key, result);
    assert.equal(readCachedSearch(key), null);
  } finally {
    delete process.env.LEAD_RETRIEVAL_CACHE_TTL_DAYS;
  }
});

test('a repeated Tavily query is served from cache without a provider call or credits', async () => {
  // 3 results so the zero-yield ablation/rewrite paths (<= 1 result) never fire.
  let tavilyCalls = 0;
  const items = [1, 2, 3].map((n) => ({ title: `Person ${n} - Founder - Co ${n}`, url: `https://www.linkedin.com/in/person-${n}`, content: 'Founder' }));
  const ctx: any = {
    config: {
      sessionId: 'retrieval-cache', promptQuery: 'Founders', targetLimit: 10, minScore: 5, ttlDays: 7, startedAt: Date.now(),
      contract: { brief: 'Founders', requirements: [], exclusions: [], policyVersion: 'p' },
      capacity: buildCollectionCapacity({ targetLimit: 10 }), maxRounds: 1, creditReservationEnabled: false,
    },
    state: {
      round: 1, seenCandidateKeys: new Set(), existingKeys: new Set(), queryRuns: [], acceptedLeads: [], qualifiedLeads: [],
      rejectionCounts: {}, brightDataStats: { attempted: 0, succeeded: 0, failed: 0, failureReasons: {} },
      freeTierBudget: { reserveTavilySearch: () => true, reserveBrightDataSearch: () => true },
      abortController: new AbortController(), debugLogs: [], previousRoundSummary: {},
    },
    ports: {
      tavilySearch: async () => { tavilyCalls++; return { text: 'live', sources: [], items }; },
      brightDataSearch: async () => [], brightDataSearchDataset: async () => ({ hits: [] }),
      scrapeMarkdown: async () => '', scrapeBatchMarkdown: async () => [],
    },
    logEvent: () => {}, recordTrace: (e: any) => e,
  };
  const plan = { item: { family: 'person', lane: 'person', providerPreference: 'tavily', intent: 'person', priority: 1, query: 'cache probe founders', tavily: { searchDepth: 'basic', maxResults: 5, includeDomains: ['linkedin.com'] } }, executableQuery: 'cache probe founders' };
  const runOnce = (stats: any) => executeRetrieveStage(ctx, {
    round: 1,
    roundPlans: [plan] as any,
    queryRuns: [{
      round: 1, query: plan.executableQuery, rawCandidates: 0, uniqueCandidates: 0, evidenceBlocks: 0,
      extractedLeads: 0, acceptedLeads: 0, rejectionReasons: {}, searchLatencyMs: 0, providerUnits: 0,
      qualifiedFinalists: 0, rescuedFinalists: 0, returnedFinalists: 0,
    }] as any,
    discoveryProviderMode: 'tavily_primary',
    brightDataSearchMode: 'fallback',
    brightDataReady: false,
    brightDataProviderDisabled: true,
    brightDataTransportRetryAfter: 0,
    brightDataSearchRetryMax: 0,
    brightDataSearchRetryBaseDelayMs: 0,
    tavilyCapabilities: { monthlyLimit: 1000, configured: true },
    brightDataCapabilities: { monthlyLimit: 0, configured: false },
    stats,
  } as any);

  const first = await runOnce({ sourceProvider: 'tavily', brightDataFailures: 0, rounds: 1 });
  const secondStats: any = { sourceProvider: 'tavily', brightDataFailures: 0, rounds: 1 };
  const second = await runOnce(secondStats);

  assert.equal(tavilyCalls, 1, 'second identical query must not call Tavily');
  assert.ok(first.roundItems.length > 0);
  assert.equal(second.roundItems.length, first.roundItems.length);
  assert.equal(secondStats.retrievalCacheHits, 1);
});
