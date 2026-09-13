import { runLinkedInPostIntentEnrichment } from '../linkedinPostIntent.js';
import { runIntentEnrichment } from '../intentEnrichment.js';
import { selectDiversifiedLeads } from '../scoutScoring.js';
import { recordQueryPerformance } from '../../db.js';
import { hasTavilyKey } from '../../services/llm.js';
import { deriveDomainCluster } from '../adaptiveScheduler.js';
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

  const isShortfall = qualifiedLeads.length <= targetLimit;
  const forceShortfallEnrichment = process.env.ENRICH_SHORTFALL_LEADS === "true";
  const shouldRunIntent = !isShortfall || forceShortfallEnrichment;

  if (isShortfall && !forceShortfallEnrichment) {
    logEvent(
      `Shortfall detected (${qualifiedLeads.length} <= ${targetLimit}): all candidates guaranteed selection; bypassing external post-intent scraping.`,
    );
  }

  // 1. Initial Selection and Diversification (Pareto selection before Phase 4 & Phase 5 enrichment)
  // Selecting finalists first prevents wasting paid company website and LinkedIn post scraping
  // on candidates that would be discarded anyway by maxPerCompany or score cutoffs.
  const finalLeads = selectDiversifiedLeads(qualifiedLeads, targetLimit, searchSpec.maxPerCompany);

  // 2. Targeted Phase 4: Company Intent Probing on selected finalist leads
  const leadsNeedingIntent = finalLeads.filter((l) => {
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

  // 3. Targeted Phase 5: LinkedIn Post Intent Enrichment on selected finalist leads
  if (linkedinPostIntentEnabled && shouldRunIntent && finalLeads.length > 0) {
    logEvent(`Phase 5: Targeted LinkedIn post intent enrichment starting. Pool: ${finalLeads.length} finalist candidates.`);
    const qualifiedMap = new Map<string, any>(finalLeads.map((l: any, idx: number) => [l.id || `lead-${idx}`, l]));
    const postIntentStats = await runLinkedInPostIntentEnrichment({
      qualifiedLeads: qualifiedMap,
      contract,
      brightDataSearch: (q, opts) => trackableBrightDataSearch(q, opts, 'phase_5_post_intent'),
      tavilySearchFallback: hasTavilyKey() ? (q, opts) => ports.tavilySearch(q, opts) : undefined,
      targetLimit,
      maxLeads: Math.min(Number(process.env.LINKEDIN_POST_INTENT_MAX_LEADS || 20), finalLeads.length),
      concurrency: 1, // strictly sequential LLM execution
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
  const domainCluster = deriveDomainCluster(contract.brief || (ctx.config as any)?.promptQuery || '');
  for (const run of stats.queryRuns) {
    const failDigest =
      run.requirementFailCounts &&
      Object.keys(run.requirementFailCounts).length > 0
        ? JSON.stringify(run.requirementFailCounts)
        : undefined;
    recordQueryPerformance({
      domainCluster,
      family: run.family || 'general',
      lane: run.lane || 'person',
      provider: run.providerPreference || 'tavily',
      runs: 1,
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
