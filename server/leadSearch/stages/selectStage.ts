import { runLinkedInPostIntentEnrichment } from '../linkedinPostIntent.js';
import { runIntentEnrichment } from '../intentEnrichment.js';
import { selectDiversifiedLeads } from '../scoutScoring.js';
import { recordQueryPerformanceBatch } from '../../db.js';
import { hasTavilyKey } from '../../services/llm.js';
import {
  deriveDomainCluster,
  quantizeBriefToCentroid,
  centroidScopeKey,
} from '../adaptiveScheduler.js';
import { effectiveScore as sharedEffectiveScore } from '../sessionHelpers.js';
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
  companyIntentEnabled?: boolean;
  companyIntentMaxPerSearch?: number;
  companyIntentConcurrency?: number;
};

export type SelectStageOutput = {
  finalLeads: any[];
  leadsFound: number;
};

export function determineSelectionShortfall(
  qualifiedCount: number,
  targetLimit: number,
): boolean {
  return qualifiedCount < targetLimit;
}

export async function executeSelectStage(
  ctx: SessionContext,
  input: SelectStageInput
): Promise<SelectStageOutput> {
  const {
    contract,
    searchSpec,
    ttlDays,
    stats,
    leadQueryRuns,
    trackableBrightDataSearch,
    companyIntentEnabled,
    companyIntentMaxPerSearch,
    companyIntentConcurrency,
  } = input;
  const { config, state, ports, logEvent, recordTrace } = ctx;
  const { qualifiedLeads } = state;
  const { targetLimit, maxRounds, linkedinPostIntentEnabled } = config;

  const isShortfall = determineSelectionShortfall(qualifiedLeads.length, targetLimit);
  const forceShortfallEnrichment = process.env.ENRICH_SHORTFALL_LEADS === "true";
  const shouldRunIntent = !isShortfall || forceShortfallEnrichment;

  if (isShortfall && !forceShortfallEnrichment) {
    logEvent(
      `Shortfall detected (${qualifiedLeads.length} < ${targetLimit}): all candidates guaranteed selection; bypassing external post-intent scraping.`,
    );
  }

  // 1. Run Phase 4 & Phase 5 on top qualified candidates (before selection)
  //    Cap intent enrichment to top ceil(targetLimit * 1.5) candidates by effectiveScore to limit cost.
  const intentPool = [...qualifiedLeads]
    .sort((a, b) => sharedEffectiveScore(b) - sharedEffectiveScore(a))
    .slice(0, Math.min(qualifiedLeads.length, Math.ceil(targetLimit * 1.5)));

  // Phase 4: Targeted Company Intent Probing on intent pool
  const leadsNeedingIntent = intentPool.filter((l) => {
    if (l.companyIntentEvidence || l._autoFailed || l.judgmentInsight?.status === "hard_fail") return false;
    const company = String(l.currentCompany || l.company || l.profile?.currentCompany || l.companyName || "").trim();
    if (!company || company.length < 2) return false;
    const title = String(l.currentTitle || l.headline || l.jobTitle || l.profile?.currentTitle || l.profile?.headline || "").trim();
    if (!title || title.length < 2) return false;
    return true;
  });
  const effectiveIntentCap = Math.min(companyIntentMaxPerSearch || 6, 6);
  const effectiveIntentConcurrency = Math.max(1, companyIntentConcurrency || 1);
  if (
    companyIntentEnabled &&
    shouldRunIntent &&
    leadsNeedingIntent.length > 0 &&
    effectiveIntentCap > 0
  ) {
    logEvent(`Phase 4: Targeted company intent probing starting. Pool: ${leadsNeedingIntent.length} finalist leads.`);
    const qualifiedMap = new Map<string, any>(
      leadsNeedingIntent.map((l, idx) => [l.id || `lead-${idx}`, l]),
    );
    const companyIntentStats = await runIntentEnrichment({
      qualifiedLeads: qualifiedMap,
      contract,
      companyIntentMaxPerSearch: effectiveIntentCap,
      companyIntentConcurrency: effectiveIntentConcurrency,
      ttlDays,
      brightDataSearch: (q) =>
        trackableBrightDataSearch(q, {}, "phase_4_company_website"),
      tavilySearchFallback: hasTavilyKey()
        ? async (q) =>
            (
              await ports.tavilySearch(q, {
                signal: state.abortController.signal,
              })
            ).items
        : undefined,
      sessionAbortSignal: state.abortController.signal,
      logEvent,
      recordTrace,
    });
    if (stats) {
      (stats as any).companyIntent = companyIntentStats;
    }
  }

  // Phase 5: Targeted LinkedIn Post Intent Enrichment on intent pool
  if (linkedinPostIntentEnabled && shouldRunIntent && intentPool.length > 0) {
    logEvent(`Phase 5: Targeted LinkedIn post intent enrichment starting. Pool: ${intentPool.length} finalist candidates.`);
    const qualifiedMap = new Map<string, any>(intentPool.map((l: any, idx: number) => [l.id || `lead-${idx}`, l]));
    const postIntentConcurrency = Math.max(
      1,
      Math.min(4, Number(process.env.LINKEDIN_POST_INTENT_CONCURRENCY || 3)),
    );
    const postIntentStats = await runLinkedInPostIntentEnrichment({
      qualifiedLeads: qualifiedMap,
      contract,
      brightDataSearch: (q, opts) => trackableBrightDataSearch(q, opts, 'phase_5_post_intent'),
      tavilySearchFallback: hasTavilyKey() ? (q, opts) => ports.tavilySearch(q, opts) : undefined,
      targetLimit,
      maxLeads: Math.min(Number(process.env.LINKEDIN_POST_INTENT_MAX_LEADS || 20), intentPool.length),
      concurrency: postIntentConcurrency, // concurrent SERP retrieval; Phase B LLM batching remains sequential
      ttlDays,
      sessionAbortSignal: state.abortController.signal,
      logEvent,
      recordTrace
    });
    (stats as any).linkedinPostIntent = postIntentStats;
    logEvent(`Phase 5 complete: ${postIntentStats.succeeded} enriched, ${postIntentStats.cacheHits} cache hits, ${postIntentStats.noResults} no-results, ${postIntentStats.llmSkipped} skipped, ${postIntentStats.failed} failed.`);
  }

  // 2. NOW run selection with fully enriched scores (all 4 Pareto dimensions active)
  const finalLeads = selectDiversifiedLeads(qualifiedLeads, targetLimit, searchSpec.maxPerCompany);

  // Final rank-order by post-enrichment score
  finalLeads.sort((a, b) => {
    const scoreA = a.finalSelectionScore ?? sharedEffectiveScore(a);
    const scoreB = b.finalSelectionScore ?? sharedEffectiveScore(b);
    return scoreB - scoreA;
  });

  for (const lead of qualifiedLeads) {
    const queryRun = leadQueryRuns.get(lead);
    if (!queryRun) continue;
    if (lead.qualification?.verdict === 'rescued') queryRun.rescuedFinalists++;
    else queryRun.qualifiedFinalists++;
  }
  for (const lead of finalLeads) {
    const queryRun = leadQueryRuns.get(lead);
    if (queryRun) queryRun.returnedFinalists++;
    // Credit corroborating query runs proportionally
    const corrobRuns = (lead as any)._corroboratingQueryRuns as QueryRunStats[] | undefined;
    if (corrobRuns) {
      for (const cRun of corrobRuns) {
        if (cRun) cRun.returnedFinalists = (cRun.returnedFinalists || 0) + 0.5;
      }
    }
  }

  const briefText = contract.brief || (ctx.config as any)?.promptQuery || '';
  const useCentroid = process.env.LEAD_ADAPTIVE_CENTROID_ENABLED === 'true';
  const domainCluster = useCentroid
    ? quantizeBriefToCentroid(briefText)
    : deriveDomainCluster(briefText);

  // Pre-merge requirementFailCounts per scopeKey so within-session runs accumulate additively
  const mergedFailCountsByScope = new Map<string, Record<string, number>>();
  for (const run of stats.queryRuns || []) {
    if (!run?.requirementFailCounts) continue;
    const family = run.family || 'general';
    const lane = run.lane || 'person';
    const provider = run.providerPreference || 'tavily';
    const sKey = useCentroid
      ? centroidScopeKey({ family, lane, providerPreference: provider }, domainCluster)
      : [domainCluster !== 'global' ? domainCluster : '', family, lane, provider].filter(Boolean).join('|').toLowerCase();
    const acc = mergedFailCountsByScope.get(sKey) || {};
    for (const [reqId, cnt] of Object.entries(run.requirementFailCounts)) {
      acc[reqId] = (acc[reqId] || 0) + Number(cnt);
    }
    mergedFailCountsByScope.set(sKey, acc);
  }

  const perfUpdates = stats.queryRuns.map((run: any) => {
    const family = run.family || 'general';
    const lane = run.lane || 'person';
    const provider = run.providerPreference || 'tavily';
    const scopeKey = useCentroid
      ? centroidScopeKey({ family, lane, providerPreference: provider }, domainCluster)
      : undefined;
    const lookupKey = scopeKey || [domainCluster !== 'global' ? domainCluster : '', family, lane, provider].filter(Boolean).join('|').toLowerCase();
    const mergedCounts = mergedFailCountsByScope.get(lookupKey) || run.requirementFailCounts;
    const failDigest =
      mergedCounts && Object.keys(mergedCounts).length > 0
        ? JSON.stringify(mergedCounts)
        : undefined;
    return {
      ...(scopeKey ? { scopeKey } : {}),
      domainCluster,
      family,
      lane,
      provider,
      runs: 1,
      outcomeRuns: 1,
      rawCandidates: run.rawCandidates || 0,
      uniqueCandidates: run.uniqueCandidates || 0,
      extractedCandidates: run.extractedLeads || 0,
      acceptedCandidates: run.acceptedLeads || 0,
      duplicateCandidates:
        (run.rejectionReasons?.duplicate_existing_lead || 0) +
        Math.max(0, (run.rawCandidates || 0) - (run.uniqueCandidates || 0)),
      searchLatencyMs: run.searchLatencyMs || 0,
      providerUnits: run.providerUnits || 0,
      qualifiedCandidates: run.qualifiedFinalists,
      rescuedCandidates: run.rescuedFinalists,
      returnedCandidates: Math.round(run.returnedFinalists || 0),
      judgedCandidates: run.judgedCandidates || 0,
      hardFailedCandidates: run.hardFailedCandidates || 0,
      unknownCandidates: run.unknownCandidates || 0,
      requirementFailDigest: failDigest,
    };
  });
  recordQueryPerformanceBatch(perfUpdates);

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
