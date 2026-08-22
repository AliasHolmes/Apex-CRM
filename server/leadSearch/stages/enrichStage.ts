import {
  extractLinkedInUsername,
  normalizeLinkedInUrl,
  parseLinkedInEvidence
} from '../../services/linkedinEvidence.js';
import {
  classifyBrightDataError,
  isBrightDataRetryableError,
  getBrightDataStatus
} from '../../services/brightdata.js';
import {
  getEnrichmentCacheEntry,
  upsertEnrichmentCacheEntry,
  getNegativeEnrichmentCacheEntry,
  upsertNegativeEnrichmentCacheEntry
} from '../../db.js';
import { verifyDecisionMakerFromEvidence } from '../verification.js';
import { createLeadEvidence } from '../evidence.js';
import { computeScoreBreakdown } from '../scoring.js';
import { incrementRejection, mapBrightDataRejection, type RejectionReason } from '../rejections.js';
import { runIntentEnrichment } from '../intentEnrichment.js';
import { hasTavilyKey } from '../../services/llm.js';
import { buildProfileDedupeKeys } from '../../../src/utils/leadDedupe.js';
import type { SessionContext } from '../pipelineTypes.js';
import type { PostFilterLead } from './verifyStage.js';
import type { EvidenceMeta } from './extractStage.js';
import type { QueryRunStats } from '../strategist.js';
import type { ProspectContract } from '../prospectContract.js';

const incrementCounter = (map: Record<string, number>, key: string) => {
  map[key] = (map[key] || 0) + 1;
};

const BRIGHTDATA_SCRAPE_BATCH_MAX_URLS = 10;

const sleepWithAbort = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error('Session aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Session aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export type EnrichmentTarget = {
  lead: any;
  evidenceMeta: EvidenceMeta;
  queryRun?: QueryRunStats;
  url: string;
  normalizedUrl: string;
  username: string;
  reserved: boolean;
  enriched: boolean;
  retryAttempts: number;
  highValue: boolean;
};

export type EnrichStageInput = {
  round: number;
  postFilterLeads: PostFilterLead[];
  rerankPoolTarget: number;
  profileEnrichmentStage: string;
  profileMaxPerSearch: number;
  enrichmentCap: number;
  companyIntentEnabled: boolean;
  companyIntentMaxPerSearch: number;
  profileConcurrency: number;
  ttlDays: number;
  contract: ProspectContract;
  brightDataProviderDisabled: boolean;
  brightDataTransportRetryAfter: number;
  stats: any;
  leadQueryRuns: WeakMap<Record<string, any>, QueryRunStats>;
  trackableBrightDataSearch: (query: string, options?: any, lane?: string) => Promise<any[]>;
};

export type EnrichStageOutput = {
  brightDataProviderDisabled: boolean;
  brightDataTransportRetryAfter: number;
};

export async function executeEnrichStage(
  ctx: SessionContext,
  input: EnrichStageInput
): Promise<EnrichStageOutput> {
  const {
    round,
    postFilterLeads,
    rerankPoolTarget,
    profileEnrichmentStage,
    profileMaxPerSearch,
    enrichmentCap,
    companyIntentEnabled,
    companyIntentMaxPerSearch,
    profileConcurrency,
    ttlDays,
    contract,
    stats,
    leadQueryRuns,
    trackableBrightDataSearch
  } = input;

  let brightDataProviderDisabled = input.brightDataProviderDisabled;
  let brightDataTransportRetryAfter = input.brightDataTransportRetryAfter;
  const { config, state, ports, logEvent, recordTrace } = ctx;
  const { existingKeys, acceptedLeads, brightDataStats, debugLogs } = state;
  const urlRetryQueue = state.urlRetryQueue || new Set<string>();
  const { promptQuery, minScore } = config;

  const getTraceBrightDataStatus = () => {
    const status = getBrightDataStatus();
    return { ...status, transport: status.transport || undefined };
  };

  const noteRejection = (reason: RejectionReason, queryRun?: QueryRunStats) => {
    incrementRejection(stats.rejectionReasons, reason);
    if (queryRun) incrementRejection(queryRun.rejectionReasons, reason);
  };

  const effectiveScore = (lead: any) => {
    const score = Number(lead.scoreBreakdown?.finalScore || 0);
    if (score > 0) return score;
    const fit = Number(lead.fitScore || 0);
    const composite = Number(lead.compositeScore || 0);
    return Math.max(fit, composite);
  };

  const addProfileKeys = (profile: any, existingKeysSet: Set<string>) => {
    buildProfileDedupeKeys(profile || {}).forEach(key => existingKeysSet.add(key));
  };

  // 1. Post-Filter Bright Data Profile Enrichment (Deep Scrape)
  if (profileEnrichmentStage === 'post_filter') {
    let brightDataToolDegraded = false;
    const selectedRows = postFilterLeads.filter(({ lead, evidenceMeta }) => {
      const score = effectiveScore(lead);
      return (score >= minScore - 1 && score <= minScore + 1) || evidenceMeta.evidenceQuality !== 'good';
    }).slice(0, profileMaxPerSearch);

    logEvent(`Round ${round}: ${selectedRows.length} leads selected for deep profile enrichment.`);
    recordTrace({
      phase: 'enrichment',
      operation: 'brightdata_profile_selection',
      status: selectedRows.length > 0 ? 'started' : 'skipped',
      provider: 'brightdata',
      round,
      counts: { selectedForEnrichment: selectedRows.length },
      brightData: getTraceBrightDataStatus()
    });

    const refreshLeadEvidence = (target: EnrichmentTarget) => {
      const { lead, evidenceMeta } = target;
      lead.decisionMakerVerification = verifyDecisionMakerFromEvidence({
        query: promptQuery,
        fullName: lead.fullName,
        currentTitle: lead.currentTitle,
        currentCompany: lead.currentCompany,
        headline: lead.headline,
        seniorityLevel: lead.seniorityLevel,
        evidenceText: evidenceMeta.evidenceBlock
      });
      lead.evidence = createLeadEvidence({
        sourceUrl: evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl || '',
        sourceProvider: evidenceMeta.sourceProvider,
        sourceQuery: evidenceMeta.sourceQuery,
        sourceRound: evidenceMeta.sourceRound,
        evidenceQuality: evidenceMeta.evidenceQuality,
        evidenceBlock: evidenceMeta.evidenceBlock,
        whyThisLead: lead.evidenceReasons[0]
      });
      lead.scoreBreakdown = computeScoreBreakdown(lead, evidenceMeta.evidenceQuality, evidenceMeta.sourceProvider, lead.decisionMakerVerification);
      lead.scoreOverride = lead.scoreBreakdown.finalScore;
    };

    const classifyAndRecordBrightDataFailure = (error: unknown, operation: string, url?: string) => {
      const classified = classifyBrightDataError(error);
      stats.brightDataFailures++;
      brightDataStats.failed++;
      incrementCounter(brightDataStats.failureReasons, classified.reasonCode);
      if (classified.reasonCode === 'target_transient') brightDataStats.transientFailures++;
      if (classified.reasonCode === 'transport_transient') {
        brightDataStats.transportFailures++;
        brightDataStats.processRestarts++;
        brightDataTransportRetryAfter = Date.now() + 5_000;
      }
      if (classified.providerDisabled) {
        brightDataStats.providerDisabled++;
        brightDataProviderDisabled = true;
      }
      if (classified.reasonCode === 'target_transient' || classified.reasonCode === 'target_blocked') {
        brightDataToolDegraded = true;
      }
      debugLogs.push({
        timestamp: new Date().toISOString(),
        type: operation,
        url,
        reasonCode: classified.reasonCode,
        retryable: classified.retryable,
        providerDisabled: classified.providerDisabled,
        error: classified.message
      });
      return classified;
    };

    const queueRetry = (target: EnrichmentTarget, reason: string) => {
      if (!target.highValue || brightDataProviderDisabled) return;
      if (urlRetryQueue.has(target.normalizedUrl)) return;
      urlRetryQueue.add(target.normalizedUrl);
      brightDataStats.profileRetryQueued++;
      debugLogs.push({
        timestamp: new Date().toISOString(),
        type: 'brightdata_profile_retry',
        url: target.url,
        status: 'queued',
        reason
      });
    };

    const applyMarkdownToTarget = (target: EnrichmentTarget, markdown: string, source: 'batch' | 'retry') => {
      if (!markdown || markdown.trim().length === 0) {
        brightDataStats.emptyResponses++;
        brightDataStats.negativeCacheSkippedTransient++;
        queueRetry(target, 'empty_body');
        debugLogs.push({ timestamp: new Date().toISOString(), type: 'brightdata_transient_skip_cache', url: target.url, reason: 'empty_body' });
        return false;
      }

      const title = target.lead.currentTitle || target.lead.headline || 'Untitled';
      const snippet = target.evidenceMeta.evidenceBlock;
      const parsed = parseLinkedInEvidence(markdown, { title, url: target.url, snippet });
      debugLogs.push({
        timestamp: new Date().toISOString(),
        type: source === 'batch' ? 'brightdata_batch_parse' : 'brightdata_parse',
        url: target.url,
        quality: parsed.quality,
        rejectionReason: parsed.rejectionReason,
        evidenceBlock: parsed.evidenceBlock
      });

      if (parsed.quality === 'good' || parsed.quality === 'partial') {
        target.evidenceMeta.sourceProvider = 'brightdata';
        target.evidenceMeta.evidenceQuality = parsed.quality;
        target.evidenceMeta.evidenceBlock = parsed.evidenceBlock;
        target.enriched = true;
        brightDataStats.profileScrapesSucceeded++;
        if (source === 'retry') brightDataStats.profileRetrySucceeded++;
        upsertEnrichmentCacheEntry({
          normalizedUrl: target.normalizedUrl,
          linkedinUsername: target.username,
          personName: parsed.personName,
          companyName: parsed.companyName,
          evidenceBlock: parsed.evidenceBlock,
          scrapeQuality: parsed.quality,
          sourceProvider: 'brightdata'
        }, ttlDays);
        stats.cacheWrites++;
        refreshLeadEvidence(target);
        return true;
      }

      const mappedReason = mapBrightDataRejection(parsed.rejectionReason);
      incrementRejection(brightDataStats.rejectionReasons, mappedReason);
      noteRejection(mappedReason, target.queryRun);
      logEvent(`Bright Data scrape rejected for ${target.username}: ${parsed.rejectionReason || 'low quality'}`);

      upsertNegativeEnrichmentCacheEntry({
        normalizedUrl: target.normalizedUrl,
        linkedinUsername: target.username,
        evidenceBlock: mappedReason,
        scrapeQuality: 'bad',
        sourceProvider: 'brightdata'
      }, parsed.rejectionReason === 'blocked_or_login_wall' ? 0.25 : undefined);
      brightDataStats.negativeCacheWrites++;
      return false;
    };

    const targetsByUrl = new Map<string, EnrichmentTarget>();
    let reservedSlots = 0;
    for (const { lead, evidenceMeta, queryRun } of selectedRows) {
      const rawUrl = evidenceMeta.sourceUrl || lead.contactDetails?.linkedinUrl;
      if (!rawUrl) continue;
      const normalizedUrl = normalizeLinkedInUrl(rawUrl);
      const username = extractLinkedInUsername(rawUrl);
      if (!normalizedUrl || !username || targetsByUrl.has(normalizedUrl)) continue;

      const positiveCache = getEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
      if (positiveCache) {
        stats.cacheHits++;
        brightDataStats.cacheHits++;
        evidenceMeta.sourceProvider = 'cache';
        evidenceMeta.evidenceQuality = positiveCache.scrapeQuality === 'good' ? 'good' : 'partial';
        evidenceMeta.evidenceBlock = positiveCache.evidenceBlock;
        const cachedTarget: EnrichmentTarget = { lead, evidenceMeta, queryRun, url: rawUrl, normalizedUrl, username, reserved: false, enriched: true, retryAttempts: 0, highValue: true };
        refreshLeadEvidence(cachedTarget);
        continue;
      }

      const negativeCache = getNegativeEnrichmentCacheEntry({ normalizedUrl, linkedinUsername: username });
      if (negativeCache) {
        brightDataStats.negativeCacheHits++;
        const reason = negativeCache.evidenceBlock as RejectionReason;
        incrementRejection(brightDataStats.rejectionReasons, reason);
        noteRejection(reason, queryRun);
        continue;
      }

      if (reservedSlots >= enrichmentCap) break;
      const score = effectiveScore(lead);
      const target: EnrichmentTarget = {
        lead,
        evidenceMeta,
        queryRun,
        url: rawUrl,
        normalizedUrl,
        username,
        reserved: true,
        enriched: false,
        retryAttempts: 0,
        highValue: score >= minScore - 1
      };
      reservedSlots++;
      stats.enriched++;
      targetsByUrl.set(normalizedUrl, target);
    }

    const uncachedTargets = Array.from(targetsByUrl.values());
    if (brightDataProviderDisabled) {
      brightDataStats.skipped += uncachedTargets.length;
    }

    const batchSize = BRIGHTDATA_SCRAPE_BATCH_MAX_URLS;
    for (let i = 0; i < uncachedTargets.length && !brightDataProviderDisabled; i += batchSize) {
      if (brightDataTransportRetryAfter && Date.now() < brightDataTransportRetryAfter) break;
      const batchTargets = uncachedTargets.slice(i, i + batchSize);
      const batchUrls = batchTargets.map(target => target.url);
      const started = Date.now();
      brightDataStats.attempted++;
      brightDataStats.profileScrapesAttempted += batchTargets.length;
      brightDataStats.batchScrapesAttempted++;
      try {
        const batchResults = await ports.scrapeBatchMarkdown(batchUrls);
        const resultByKey = new Map<string, string>();
        for (const item of batchResults) {
          const normalized = normalizeLinkedInUrl(item.url);
          const username = extractLinkedInUsername(item.url);
          if (normalized) resultByKey.set(normalized, item.content);
          if (username) resultByKey.set(`user:${username}`, item.content);
        }

        let successCount = 0;
        for (const target of batchTargets) {
          const markdown = resultByKey.get(target.normalizedUrl) || resultByKey.get(`user:${target.username}`) || '';
          if (markdown && applyMarkdownToTarget(target, markdown, 'batch')) successCount++;
          if (!markdown) {
            brightDataStats.emptyResponses++;
            queueRetry(target, 'batch_miss');
          }
        }

        if (successCount === batchTargets.length) {
          brightDataStats.batchScrapesSucceeded++;
          brightDataStats.succeeded++;
        } else if (successCount > 0) {
          brightDataStats.batchScrapesPartial++;
          brightDataStats.succeeded++;
          debugLogs.push({ timestamp: new Date().toISOString(), type: 'brightdata_batch_partial', urls: batchUrls, successCount, expectedCount: batchTargets.length });
        } else {
          brightDataStats.batchScrapesFailed++;
          for (const target of batchTargets) queueRetry(target, 'batch_no_successes');
        }

        debugLogs.push({
          timestamp: new Date().toISOString(),
          type: 'brightdata_batch_scrape',
          urls: batchUrls,
          resultCount: batchResults.length,
          successCount
        });
        recordTrace({
          phase: 'enrichment',
          operation: 'brightdata_batch_scrape',
          status: successCount > 0 ? 'success' : 'skipped',
          provider: 'brightdata',
          round,
          latencyMs: Date.now() - started,
          counts: { requestedUrls: batchTargets.length, returnedUrls: batchResults.length, enrichedProfiles: successCount },
          brightData: getTraceBrightDataStatus()
        });
      } catch (error) {
        brightDataStats.batchScrapesFailed++;
        const classified = classifyAndRecordBrightDataFailure(error, 'brightdata_batch_error');
        recordTrace({
          phase: 'enrichment',
          operation: 'brightdata_batch_scrape',
          status: 'error',
          provider: 'brightdata',
          round,
          latencyMs: Date.now() - started,
          error: { message: `${classified.reasonCode}: ${classified.message}` },
          brightData: getTraceBrightDataStatus()
        });
        if (classified.providerDisabled) break;
        for (const target of batchTargets) {
          if (isBrightDataRetryableError(classified)) {
            brightDataStats.negativeCacheSkippedTransient++;
            queueRetry(target, classified.reasonCode);
          } else if (classified.reasonCode === 'target_blocked') {
            upsertNegativeEnrichmentCacheEntry({
              normalizedUrl: target.normalizedUrl,
              linkedinUsername: target.username,
              evidenceBlock: 'brightdata_login_wall',
              scrapeQuality: 'bad',
              sourceProvider: 'brightdata'
            }, 0.25);
            brightDataStats.negativeCacheWrites++;
          }
        }
      }
    }

    const retryMax = Math.min(Math.max(Number(process.env.BRIGHTDATA_PROFILE_RETRY_MAX || 2), 0), 3);
    const retryDelays = [3_000, 10_000, 20_000];
    const retryTargets = uncachedTargets.filter(target => urlRetryQueue.has(target.normalizedUrl) && !target.enriched);
    for (const target of retryTargets) {
      if (brightDataProviderDisabled) break;
      for (let attempt = 0; attempt < retryMax && !target.enriched && !brightDataProviderDisabled; attempt++) {
        if (brightDataTransportRetryAfter && Date.now() < brightDataTransportRetryAfter) {
          await sleepWithAbort(Math.max(0, brightDataTransportRetryAfter - Date.now()), state.abortController.signal);
        }
        if (attempt > 0) await sleepWithAbort(retryDelays[Math.min(attempt - 1, retryDelays.length - 1)], state.abortController.signal);
        const started = Date.now();
        target.retryAttempts++;
        brightDataStats.profileRetryAttempted++;
        brightDataStats.profileScrapesAttempted++;
        try {
          const markdown = await ports.scrapeMarkdown(target.url);
          debugLogs.push({ timestamp: new Date().toISOString(), type: 'brightdata_profile_retry', url: target.url, status: 'success', attempt: attempt + 1, response: markdown ? { length: markdown.length, preview: markdown.slice(0, 300) } : null });
          applyMarkdownToTarget(target, markdown || '', 'retry');
          recordTrace({
            phase: 'enrichment',
            operation: 'brightdata_profile_retry',
            status: target.enriched ? 'success' : 'skipped',
            provider: 'brightdata',
            round,
            latencyMs: Date.now() - started,
            counts: { attempt: attempt + 1, markdownChars: markdown?.length || 0 },
            brightData: { ...getTraceBrightDataStatus(), target: target.url }
          });
          if (!target.enriched) break;
        } catch (error) {
          const classified = classifyAndRecordBrightDataFailure(error, 'brightdata_profile_retry', target.url);
          if (classified.retryable) brightDataStats.negativeCacheSkippedTransient++;
          recordTrace({
            phase: 'enrichment',
            operation: 'brightdata_profile_retry',
            status: 'error',
            provider: 'brightdata',
            round,
            latencyMs: Date.now() - started,
            error: { message: `${classified.reasonCode}: ${classified.message}` },
            brightData: { ...getTraceBrightDataStatus(), target: target.url }
          });
          if (classified.providerDisabled || !classified.retryable) break;
        }
      }
      urlRetryQueue.delete(target.normalizedUrl);
    }

    const reservedButUnenriched = uncachedTargets.filter(target => target.reserved && !target.enriched).length;
    if (reservedButUnenriched > 0) stats.enriched = Math.max(0, stats.enriched - reservedButUnenriched);
    if (brightDataToolDegraded) logEvent('Bright Data profile enrichment had target-level failures, but provider remains available for other Bright Data work.');
  }

  // 2. Final Acceptance for candidates in this round
  for (const { lead, queryRun } of postFilterLeads) {
    if (acceptedLeads.length >= rerankPoolTarget) break;
    const finalDecisionMaker = lead.decisionMakerVerification || verifyDecisionMakerFromEvidence({
      query: promptQuery,
      fullName: lead.fullName,
      currentTitle: lead.currentTitle,
      currentCompany: lead.currentCompany,
      headline: lead.headline,
      seniorityLevel: lead.seniorityLevel,
      evidenceText: lead.evidence?.snippets?.join(' ') || ''
    });
    lead.decisionMakerVerification = finalDecisionMaker;
    if (finalDecisionMaker.ignoredTitle || finalDecisionMaker.confidence < 5) {
      noteRejection('not_decision_maker', queryRun);
      continue;
    }
    lead.scoreBreakdown = computeScoreBreakdown(lead, lead.evidence?.evidenceQuality || 'weak', lead.evidence?.sourceProvider === 'cache' ? 'cache' : lead.evidence?.sourceProvider === 'brightdata' ? 'brightdata' : 'tavily', finalDecisionMaker);
    lead.scoreOverride = lead.scoreBreakdown.finalScore;
    if (effectiveScore(lead) < minScore) {
      noteRejection('score_below_minimum', queryRun);
      continue;
    }

    if (queryRun) {
      queryRun.acceptedLeads++;
      leadQueryRuns.set(lead, queryRun);
    }
    lead.id = lead.id || `lead-${crypto.randomUUID()}`;
    addProfileKeys(lead, existingKeys);
    acceptedLeads.push(lead);
  }

  // 3. Optional company intent enrichment via canonical runIntentEnrichment module
  if (companyIntentEnabled && acceptedLeads.length > 0 && companyIntentMaxPerSearch > 0) {
    const qualifiedMap = new Map<string, any>(acceptedLeads.map((l, idx) => [l.id || `lead-${idx}`, l]));
    await runIntentEnrichment({
      qualifiedLeads: qualifiedMap,
      contract,
      companyIntentMaxPerSearch,
      companyIntentConcurrency: profileConcurrency,
      ttlDays,
      brightDataSearch: (q) => trackableBrightDataSearch(q, {}, 'phase_4_company_website'),
      tavilySearchFallback: hasTavilyKey() ? async (q) => (await ports.tavilySearch(q, { signal: state.abortController.signal })).items : undefined,
      sessionAbortSignal: state.abortController.signal,
      logEvent,
      recordTrace
    });
  }

  return {
    brightDataProviderDisabled,
    brightDataTransportRetryAfter
  };
}
