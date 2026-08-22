import { runLinkedInPostIntentEnrichment } from '../linkedinPostIntent.js';
import { selectDiversifiedLeads } from '../scoutScoring.js';
import { recordQueryPerformance } from '../../db.js';
import { hasTavilyKey } from '../../services/llm.js';
import type { SessionContext } from '../pipelineTypes.js';
import type { ProspectContract } from '../prospectContract.js';
import type { SearchSpec } from '../searchSpec.js';
import type { QueryRunStats } from '../strategist.js';

export type SelectStageInput = {
  contract: ProspectContract;
  searchSpec: SearchSpec;
  ttlDays: number;
  stats: any;
  leadQueryRuns: WeakMap<Record<string, any>, QueryRunStats>;
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

  // 1. Optional Phase 5: LinkedIn Post Intent Enrichment
  if (linkedinPostIntentEnabled && qualifiedLeads.length > 0) {
    logEvent(`Phase 5: LinkedIn post intent enrichment starting. Pool: ${qualifiedLeads.length} qualified leads.`);
    const qualifiedMap = new Map<string, any>(qualifiedLeads.map((l: any, idx: number) => [l.id || `lead-${idx}`, l]));
    const postIntentStats = await runLinkedInPostIntentEnrichment({
      qualifiedLeads: qualifiedMap,
      contract,
      brightDataSearch: (q, opts) => trackableBrightDataSearch(q, opts, 'phase_5_post_intent'),
      tavilySearchFallback: hasTavilyKey() ? (q, opts) => ports.tavilySearch(q, opts) : undefined,
      targetLimit,
      maxLeads: Number(process.env.LINKEDIN_POST_INTENT_MAX_LEADS || 20),
      concurrency: Number(process.env.LINKEDIN_POST_INTENT_CONCURRENCY || 2),
      ttlDays,
      sessionAbortSignal: state.abortController.signal,
      logEvent,
      recordTrace
    });
    (stats as any).linkedinPostIntent = postIntentStats;
    logEvent(`Phase 5 complete: ${postIntentStats.succeeded} enriched, ${postIntentStats.cacheHits} cache hits, ${postIntentStats.noResults} no-results, ${postIntentStats.llmSkipped} skipped, ${postIntentStats.failed} failed.`);
  }

  // 2. Final Selection and Diversification
  const finalLeads = selectDiversifiedLeads(qualifiedLeads, targetLimit, searchSpec.maxPerCompany);

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
    recordQueryPerformance({
      family: run.family || 'general',
      lane: run.lane || 'person',
      provider: run.providerPreference || 'tavily',
      runs: 0,
      outcomeRuns: 1,
      qualifiedCandidates: run.qualifiedFinalists,
      rescuedCandidates: run.rescuedFinalists,
      returnedCandidates: run.returnedFinalists
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
