import { runLinkedInPostIntentEnrichment } from '../linkedinPostIntent.js';
import { runIntentEnrichment } from '../intentEnrichment.js';
import { selectDiversifiedLeads } from '../scoutScoring.js';
import { recordQueryPerformanceBatch } from '../../db.js';
import { hasTavilyKey } from '../../services/llm.js';
import {
  deriveContractDomainCluster,
  quantizeBriefToCentroid,
  centroidScopeKey,
  buildScopeKey,
} from '../adaptiveScheduler.js';
import { effectiveScore as sharedEffectiveScore, boundedNumber } from '../sessionHelpers.js';
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

export function shouldRunIntentEnrichment(isShortfall: boolean, forceShortfallEnrichment: boolean, qualifiedLeadsCount: number): boolean;
export function shouldRunIntentEnrichment(isShortfall: boolean, qualifiedLeadsCount: number, forceShortfallEnrichment?: boolean): boolean;
export function shouldRunIntentEnrichment(
  isShortfall: boolean,
  param2: boolean | number,
  param3: boolean | number = false,
): boolean {
  let forceShortfallEnrichment = false;
  let qualifiedLeadsCount = 0;
  if (typeof param2 === "boolean") {
    forceShortfallEnrichment = param2;
    qualifiedLeadsCount = typeof param3 === "number" ? param3 : 0;
  } else {
    qualifiedLeadsCount = typeof param2 === "number" ? param2 : 0;
    forceShortfallEnrichment = typeof param3 === "boolean" ? param3 : false;
  }
  return !isShortfall || forceShortfallEnrichment || qualifiedLeadsCount > 0;
}

export const INTENT_PRESCREEN_REGEX =
  /\b(?:hir(?:ing|ed|es)|recruit(?:ing|ment)|grow(?:ing|th)|expan(?:ding|sion)|open\s+roles?|vacanc(?:y|ies)|headcount|scaling|raised|funding|venture\s+backed|seed\s+round|series\s+[a-e]|subcontract(?:ing|or|ors)?|integrat(?:ion|ing)|migrat(?:ing|ion)|moderniz(?:ing|ation)|implement(?:ing|ation)|looking\s+for|seeking|rfp|procurement)\b/i;

export function hasPlausibleIntentEvidence(lead: Record<string, any>): boolean {
  if (!lead) return false;
  const text = [
    lead.headline,
    lead.currentTitle,
    lead.profile?.headline,
    lead.evidence?.evidenceBlock,
    lead.companyAttribution?.result?.evidenceQuote,
    ...(Array.isArray(lead.evidence?.snippets) ? lead.evidence.snippets : []),
  ]
    .filter(Boolean)
    .join(" ");
  return INTENT_PRESCREEN_REGEX.test(text);
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

  const stageStartedAt = Date.now();
  recordTrace({
    phase: "selection",
    operation: "stage_start",
    status: "info",
    counts: { qualifiedLeads: qualifiedLeads.length, targetLimit },
    metadata: { stage: "select" },
  });

  const isShortfall = determineSelectionShortfall(qualifiedLeads.length, targetLimit);
  const forceShortfallEnrichment = process.env.ENRICH_SHORTFALL_LEADS === "true";
  const shouldRunIntent = shouldRunIntentEnrichment(isShortfall, forceShortfallEnrichment, qualifiedLeads.length);

  if (isShortfall) {
    logEvent(
      `Shortfall detected (${qualifiedLeads.length} < ${targetLimit}): all candidates guaranteed selection; proceeding with intent enrichment on available qualified leads.`,
    );
  }

  // 1. Run Phase 4 & Phase 5 on top qualified candidates (before selection)
  //    Cap intent enrichment to top ceil(targetLimit * 1.5) candidates by effectiveScore to limit cost.
  const intentPool = [...qualifiedLeads]
    .sort((a, b) => sharedEffectiveScore(b) - sharedEffectiveScore(a))
    .slice(0, Math.min(qualifiedLeads.length, Math.ceil(targetLimit * 1.5)));

  for (const candidate of intentPool) {
    if (!hasPlausibleIntentEvidence(candidate)) {
      candidate.intentEnrichmentState = "enriched_none";
      candidate.intentQuality = "none";
    }
  }

  // Phase 4: Targeted Company Intent Probing on intent pool
  const leadsNeedingIntent = intentPool.filter((l) => {
    if (l.companyIntentEvidence || l._autoFailed || l.judgmentInsight?.status === "hard_fail") return false;
    if (!hasPlausibleIntentEvidence(l)) {
      l.intentEnrichmentState = "enriched_none";
      l.intentQuality = "none";
      return false;
    }
    const company = String(l.currentCompany || l.company || l.profile?.currentCompany || l.companyName || "").trim();
    if (!company || company.length < 2) return false;
    const title = String(l.currentTitle || l.headline || l.jobTitle || l.profile?.currentTitle || l.profile?.headline || "").trim();
    if (!title || title.length < 2) return false;
    return true;
  });
  const dynamicIntentDefault = Math.max(6, Math.ceil(targetLimit * 0.75));
  const effectiveIntentCap = Math.min(
    leadsNeedingIntent.length,
    companyIntentMaxPerSearch && companyIntentMaxPerSearch > 0
      ? Math.max(companyIntentMaxPerSearch, dynamicIntentDefault)
      : dynamicIntentDefault,
  );
  const effectiveIntentConcurrency = Math.max(1, companyIntentConcurrency || 1);
  if (
    companyIntentEnabled &&
    shouldRunIntent
  ) {
    if (leadsNeedingIntent.length > 0 && effectiveIntentCap > 0) {
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
    } else if (stats) {
      (stats as any).companyIntent = {
        attempted: 0,
        cacheHits: 0,
        noSite: 0,
        noSignal: 0,
        succeeded: 0,
        failed: 0,
        companiesDeduped: 0,
      };
    }
  }

  // Phase 5: Targeted LinkedIn Post Intent Enrichment on intent pool
  const leadsNeedingPostIntent = intentPool.filter((l) => {
    if (l._autoFailed || l.judgmentInsight?.status === "hard_fail") return false;
    if (!hasPlausibleIntentEvidence(l)) {
      l.intentEnrichmentState = "enriched_none";
      l.intentQuality = "none";
      return false;
    }
    return true;
  });

  if (linkedinPostIntentEnabled && shouldRunIntent && leadsNeedingPostIntent.length > 0) {
    logEvent(`Phase 5: Targeted LinkedIn post intent enrichment starting. Pool: ${leadsNeedingPostIntent.length} finalist candidates.`);
    const qualifiedMap = new Map<string, any>(leadsNeedingPostIntent.map((l: any, idx: number) => [l.id || `lead-${idx}`, l]));
    const postIntentConcurrency = boundedNumber(process.env.LINKEDIN_POST_INTENT_CONCURRENCY, 4, 1, 8);
    const postIntentStats = await runLinkedInPostIntentEnrichment({
      qualifiedLeads: qualifiedMap,
      contract,
      brightDataSearch: (q, opts) => trackableBrightDataSearch(q, opts, 'phase_5_post_intent'),
      tavilySearchFallback: hasTavilyKey() ? (q, opts) => ports.tavilySearch(q, opts) : undefined,
      targetLimit,
      maxLeads: Math.min(boundedNumber(process.env.LINKEDIN_POST_INTENT_MAX_LEADS, 20, 1, 200), leadsNeedingPostIntent.length),
      concurrency: postIntentConcurrency, // concurrent SERP retrieval; Phase B LLM batching remains sequential
      ttlDays,
      sessionAbortSignal: state.abortController.signal,
      sessionId: config.sessionId,
      logEvent,
      recordTrace
    });
    (stats as any).linkedinPostIntent = postIntentStats;
    logEvent(`Phase 5 complete: ${postIntentStats.succeeded} enriched, ${postIntentStats.cacheHits} cache hits, ${postIntentStats.noResults} no-results, ${postIntentStats.llmSkipped} skipped, ${postIntentStats.failed} failed.`);
  }

  // 2. NOW run selection with fully enriched scores (all 4 Pareto dimensions active)
  const finalLeads = selectDiversifiedLeads(qualifiedLeads, targetLimit, searchSpec.maxPerCompany);

  const finalLeadIds = new Set(
    finalLeads.map((l) => l.id || l.url || l.contactDetails?.linkedinUrl || l.fullName),
  );
  const droppedFromSelection = qualifiedLeads.filter(
    (l) => !finalLeadIds.has(l.id || l.url || l.contactDetails?.linkedinUrl || l.fullName),
  );

  for (const dropped of droppedFromSelection) {
    const comp = dropped.currentCompany || dropped.company;
    const sameCompanyCount = finalLeads.filter(
      (f) => (f.currentCompany || f.company) === comp,
    ).length;
    const isCompanyCap = sameCompanyCount >= (searchSpec.maxPerCompany || 2);
    const reasonCode = isCompanyCap ? "per_company_cap_exceeded" : "pareto_skyline_cut";
    const reasonDetails = isCompanyCap
      ? `Per-company cap (${searchSpec.maxPerCompany || 2}) exceeded for ${comp}`
      : `Candidate dropped in Pareto multi-objective ranking or MMR diversification`;

    recordTrace({
      phase: "selection",
      operation: "candidate_dropped",
      status: "info",
      metadata: {
        stage: "select",
        candidateId: dropped.id || dropped.url || dropped.contactDetails?.linkedinUrl,
        candidateName: dropped.fullName,
        company: comp,
        reasonCode,
        reasonDetails,
      },
    });
  }

  // Final rank-order by post-enrichment score
  finalLeads.sort((a, b) => {
    const scoreA = sharedEffectiveScore(a);
    const scoreB = sharedEffectiveScore(b);
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
    ? quantizeBriefToCentroid(contract || briefText)
    : deriveContractDomainCluster(contract, briefText);

  // Pre-merge requirementFailCounts per scopeKey so within-session runs accumulate additively
  const mergedFailCountsByScope = new Map<string, Record<string, number>>();
  for (const run of stats.queryRuns || []) {
    if (!run?.requirementFailCounts) continue;
    const family = run.family || 'general';
    const lane = run.lane || 'person';
    const provider = run.providerPreference || 'tavily';
    const sKey = useCentroid
      ? centroidScopeKey({ family, lane, providerPreference: provider }, domainCluster)
      : buildScopeKey({ domainCluster, family, lane, provider });
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
      : buildScopeKey({ domainCluster, family, lane, provider });
    const lookupKey = scopeKey;
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
      outcomeRuns: run.judgedCandidates > 0 ? 1 : 0,
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

  if (leadsFound >= targetLimit) {
    stats.stopReason = 'target_reached';
  } else if (stats.stopReason === 'not_started') {
    stats.stopReason = stats.rounds >= maxRounds ? 'max_rounds' : 'exhausted';
  }

  logEvent(`Session complete: returned ${leadsFound}/${targetLimit}. Stop reason: ${stats.stopReason}. Stats: ${JSON.stringify(stats)}`);

  recordTrace({
    phase: "selection",
    operation: "stage_complete",
    status: "success",
    latencyMs: Date.now() - stageStartedAt,
    counts: {
      qualifiedLeads: qualifiedLeads.length,
      finalLeads: finalLeads.length,
      droppedCandidates: droppedFromSelection.length,
    },
    metadata: {
      stage: "select",
      stopReason: stats.stopReason,
    },
  });

  return {
    finalLeads,
    leadsFound
  };
}
