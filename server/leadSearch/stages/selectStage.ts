import { runLinkedInPostIntentEnrichment } from '../linkedinPostIntent.js';
import { selectDiversifiedLeads } from '../scoutScoring.js';
import { recordQueryPerformance } from '../../db.js';
import { hasTavilyKey } from '../../services/llm.js';
import type { SessionContext, LeadQueryRunTracker } from '../pipelineTypes.js';
import type { ProspectContract } from '../prospectContract.js';
import type { SearchSpec } from '../searchSpec.js';
import type { QueryRunStats } from '../strategist.js';

export type SelectStageInput = {
  contract: ProspectContract;
  searchSpec: SearchSpec;
  ttlDays: number;
  stats: any;
  leadQueryRuns: LeadQueryRunTracker | WeakMap<Record<string, any>, QueryRunStats>;
  trackableBrightDataSearch: (query: string, options?: any, lane?: string) => Promise<any[]>;
};

export type SelectStageOutput = {
  finalLeads: any[];
  leadsFound: number;
};

export async function executeSelectStage(
  ctx: SessionContext,
  input: SelectStageInput
): Promise<SelectStageOutput> {
  const { contract, searchSpec, ttlDays, stats, leadQueryRuns, trackableBrightDataSearch } = input;
  const { config, state, ports, logEvent, recordTrace } = ctx;
  const { qualifiedLeads } = state;
  const { targetLimit, maxRounds, linkedinPostIntentEnabled } = config;

  // 1. Initial Final Selection and Diversification
  const finalLeads = selectDiversifiedLeads(qualifiedLeads, targetLimit, searchSpec.maxPerCompany);

  // 2. Targeted Phase 5: LinkedIn Post Intent Enrichment ONLY on the final returned prospects
  if (linkedinPostIntentEnabled && finalLeads.length > 0) {
    logEvent(`Phase 5: Targeted LinkedIn post intent enrichment starting. Pool: ${finalLeads.length} selected finalists.`);
    const finalistsMap = new Map<string, any>(finalLeads.map((l: any, idx: number) => [l.id || `lead-${idx}`, l]));
    const postIntentStats = await runLinkedInPostIntentEnrichment({
      qualifiedLeads: finalistsMap,
      contract,
      brightDataSearch: (q, opts) => trackableBrightDataSearch(q, opts, 'phase_5_post_intent'),
      tavilySearchFallback: hasTavilyKey() ? (q, opts) => ports.tavilySearch(q, opts) : undefined,
      targetLimit,
      maxLeads: Math.min(Number(process.env.LINKEDIN_POST_INTENT_MAX_LEADS || 20), finalLeads.length),
      concurrency: Number(process.env.LINKEDIN_POST_INTENT_CONCURRENCY || 4),
      ttlDays,
      sessionAbortSignal: state.abortController.signal,
      logEvent,
      recordTrace
    });
    (stats as any).linkedinPostIntent = postIntentStats;
    logEvent(`Phase 5 complete: ${postIntentStats.succeeded} enriched, ${postIntentStats.cacheHits} cache hits, ${postIntentStats.noResults} no-results, ${postIntentStats.llmSkipped} skipped, ${postIntentStats.failed} failed.`);
  }

  for (const lead of qualifiedLeads) {
    const queryRun = leadQueryRuns.get(lead);
    if (!queryRun) continue;
    if (lead.qualification?.verdict === 'rescued') queryRun.rescuedFinalists++;
    else queryRun.qualifiedFinalists++;
  }
  for (const lead of finalLeads) {
    const queryRun = leadQueryRuns.get(lead);
    if (queryRun) queryRun.returnedFinalists++;
  }
  for (const run of stats.queryRuns) {
    const failDigest =
      run.requirementFailCounts &&
      Object.keys(run.requirementFailCounts).length > 0
        ? JSON.stringify(run.requirementFailCounts)
        : undefined;
    recordQueryPerformance({
      family: run.family || 'general',
      lane: run.lane || 'person',
      provider: run.providerPreference || 'tavily',
      runs: 0,
      outcomeRuns: 1,
      qualifiedCandidates: run.qualifiedFinalists,
      rescuedCandidates: run.rescuedFinalists,
      returnedCandidates: run.returnedFinalists,
      requirementFailDigest: failDigest,
    });
  }

  const leadsFound = finalLeads.length;
  stats.returned = leadsFound;
  stats.rerank = stats.rerank || {};
  stats.rerank.returned = leadsFound;

  if (leadsFound >= targetLimit) {
    stats.stopReason = 'target_reached';
  } else if (stats.stopReason === 'not_started') {
    stats.stopReason = stats.rounds >= maxRounds ? 'max_rounds' : 'exhausted';
  }

  logEvent(`Session complete: returned ${leadsFound}/${targetLimit}. Stop reason: ${stats.stopReason}. Stats: ${JSON.stringify(stats)}`);

  return {
    finalLeads,
    leadsFound
  };
}
