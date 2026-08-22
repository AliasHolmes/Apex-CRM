import crypto from 'crypto';
import { LEAD_STAGE_SET as leadStages, REVIEW_STATUS_SET as reviewStatuses, NEXT_ACTION_SET as nextActions } from '../../src/types.js';
import { buildProfileDedupeKeys, hasDuplicateProfile, normalizeDedupeValue, getProfileDomain, getLinkedInHandle } from '../../src/utils/leadDedupe.js';

import {
  readStoredLeads,
  readLeadsSummary,
  readExistingIdentityKeys,
  readLeadsStageSummary,
  readStoredLeadById,
  hasLeadStoreBeenInitialized,
  replaceStoredLeads,
  normalizeIncomingLeads,
  getLeadsDb,
  insertSearchLog,
  readSearchLogs,
  readSearchLogById,
  readMiningSessionById,
  readMiningSessions,
  upsertMiningSession,
  LeadNotFoundError,
  LeadRevisionConflictError,
  pruneExpiredEnrichmentCache,
  getEnrichmentCacheEntry,
  upsertEnrichmentCacheEntry,
  getNegativeEnrichmentCacheEntry,
  upsertNegativeEnrichmentCacheEntry,
  upsertLeadInExistingTransaction,
  upsertLeadWithIdentity,
  deleteLead,
  upsertLeadsWithIdentity,
  transferLeadIdentities,
  insertLeadActivity,
  readLeadActivities,
  upsertOutreachDraft,
  readOutreachDrafts,
  deleteOutreachDraft,
  readSavedSearches,
  readSavedSearchById,
  upsertSavedSearch,
  deleteSavedSearch,
  markSavedSearchRun,
  readQueryPerformance,
  recordQueryPerformance,
  readProviderUsage,
  recordProviderUsage,
  reserveProviderUsage
} from '../db.js';
import {
  hasOpenAIKey,
  hasTavilyKey,
  tavilySearch,
  tavilyExtract,
  openAIStructured,
  singleProfileSchema,
  APEX_SYSTEM_PROMPT,
  leadsArraySchema,
  searchQueriesSchema,
  searchSpecSchema,
  openAIText,
  STRATEGIST_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
  bulkLeadsArraySchema,
  getLLMProviderSummaries,
  getTavilyKeyStatus,
  createLLMSessionCircuitBreaker,
  type LLMProviderAttempt,
  type LLMUsage
} from '../services/llm.js';
import {
  BRIGHTDATA_SCRAPE_BATCH_MAX_URLS,
  chunkBrightDataBatchItems,
  closeBrightDataClient,
  getBrightDataStatus,
  getBrightDataCapabilities,
  isBrightDataConfigured,
  scrapeAsMarkdown,
  scrapeBatchAsMarkdown,
  brightDataSearch,
  type BrightDataSearchOptions,
  type BrightDataSearchResult,
  shouldAttemptBrightData,
  classifyBrightDataError,
  executeBrightDataSearchWithRetry,
  isBrightDataRetryableError
} from '../services/brightdata.js';
import {
  buildTavilyEvidence,
  extractLinkedInUsername,
  normalizeLinkedInUrl,
  parseLinkedInEvidence
} from '../services/linkedinEvidence.js';
import {
  computeScoreBreakdown,
  rankLeadForFinalSelection,
  type EvidenceQuality,
  type LeadSourceProvider
} from './scoring.js';
import { createLeadEvidence, inferTavilyEvidenceQuality } from './evidence.js';
import {
  normalizeQueryPlanItems,
  toLinkedInSearchQuery,
  type ProviderRunStats,
  type QueryRunStats,
  type SearchQueryPlanItem
} from './strategist.js';
import {
  incrementRejection,
  mapBrightDataRejection,
  type RejectionReason
} from './rejections.js';
import { verifyDecisionMakerFromEvidence } from './verification.js';
import { runIntentEnrichment } from './intentEnrichment.js';
import { enrichLeadProfile } from './profileEnrichment.js';
import {
  MiningTelemetryRecorder,
  estimateLLMCostUsd,
  getLLMRouteLabel,
  type MiningTraceEvent,
  type TargetEffortStats,
  type FinalistJudgeStats
} from './telemetry.js';
import {
  buildFallbackQueryPlan as buildScoutFallbackQueryPlan,
  buildFallbackSearchSpec,
  buildRetrievalTasks,
  buildSearchSpecPrompt,
  buildStrategistPrompt as buildScoutStrategistPrompt,
  normalizeSearchSpec,
  type DiscoveryMode,
  type SearchSpec
} from './searchSpec.js';
import {
  ScoutFreeTierBudget,
  brightDataFreeTierCapabilities,
  tavilyFreeTierCapabilities,
  isProviderCreditReservationEnabled
} from './freeTier.js';
import {
  resolveDiscoveryProviderMode,
  resolveBrightDataSearchMode,
  shouldRunTavilyForTask,
  shouldRunBrightDataForTask
} from './discoveryRouting.js';
import { executePlanStage } from './stages/planStage.js';
import { executeRetrieveStage } from './stages/retrieveStage.js';
import { executeFuseStage } from './stages/fuseStage.js';
import { executeExtractStage, type EvidenceMeta } from './stages/extractStage.js';
import { executeVerifyStage } from './stages/verifyStage.js';
import { executeEnrichStage } from './stages/enrichStage.js';
import type { SessionConfig, PipelineSessionState, PipelinePorts, SessionContext } from './pipelineTypes.js';
import { fuseObservations, type ScoutObservation } from './observations.js';
import { buildScoutEvidence, selectDiversifiedLeads } from './scoutScoring.js';
import {
  chunkEvidenceBlocksByTokenBudget,
  estimateTokenCount,
  fitOutputTokenBudget
} from './llmBudget.js';
import {
  buildDeterministicProspectContract,
  buildProspectContractPrompt,
  buildRecoveryQueryPrompt,
  enforceContractQueries,
  normalizeProspectContract,
  prospectContractSchema,
  PROSPECT_CONTRACT_POLICY_VERSION,
  searchSpecFromProspectContract,
  type ProspectContract
} from './prospectContract.js';
import {
  FINALIST_JUDGE_SYSTEM_PROMPT,
  buildFinalistJudgePrompt,
  finalistCandidateFromLead,
  finalistJudgeSchema,
  partitionCandidatesByStrictEvidence,
  validateFinalistJudgments,
  type FinalistCandidate
} from './finalistJudge.js';
import { buildRoundDiagnostics } from './roundDiagnostics.js';
import { buildCollectionCapacity } from './collectionCapacity.js';
import { scheduleAdaptiveRetrievalTasks } from './adaptiveScheduler.js';
import { runProviderQueue } from './providerQueue.js';
import { runLinkedInPostIntentEnrichment } from './linkedinPostIntent.js';

const getTraceBrightDataStatus = () => {
  const status = getBrightDataStatus();
  return { ...status, transport: status.transport || undefined };
};

export interface DiscoveryRequest {
  sessionId?: string;
  promptQuery: string;
  requestedLimit?: number;
  searchSpec?: SearchSpec;
  discoveryMode?: DiscoveryMode;
  discoveryProviderMode?: string;
  excludeList?: string[];
  savedSearchId?: string;
}

export interface DiscoveryEventListener {
  onLog?: (message: string) => void;
  onTraceEvent?: (event: MiningTraceEvent) => void;
  onDelta?: (delta: Partial<DiscoveryResult>) => void;
}

export interface DiscoveryResult {
  apiVersion?: number;
  sessionId: string;
  leads: Record<string, any>[];
  total: number;
  requestedLimit: number;
  shortfall?: number;
  shortfallReason?: string;
  stats: Record<string, any>;
  traceSummary: Record<string, any>;
  persistence?: { createdCount: number; updatedCount: number; duplicateCount: number };
  persistenceStatus?: 'complete' | 'partial' | 'failed';
  sandboxMode?: boolean;
  stopReason?: string;
  cancelled?: boolean;
}

export function candidateStableId(lead: Record<string, any>, rawUrl?: string): string {
  const url = rawUrl || lead.contactDetails?.linkedinUrl || lead.profile?.contactDetails?.linkedinUrl || lead.sourceUrl || lead.profile?.sourceUrl || lead.url || '';
  const username = extractLinkedInUsername(url);
  if (username) return `linkedin:${username.toLowerCase()}`;
  const normalizedUrl = normalizeLinkedInUrl(url);
  if (normalizedUrl && normalizedUrl.includes('linkedin.com/in/')) return `url:${normalizedUrl.toLowerCase()}`;
  const name = normalizeDedupeValue(lead.fullName || lead.profile?.fullName);
  const company = normalizeDedupeValue(lead.currentCompany || lead.company || lead.profile?.currentCompany);
  if (name && company) return `text:${name}@${company}`;
  if (name) return `text:${name}`;
  return `id:${crypto.randomUUID()}`;
}

export function mapCandidateToPersistedLead(p: any, fallbackId?: string, now = new Date().toISOString()): Record<string, any> {
  const leadId = p.id || fallbackId || `lead-${crypto.randomUUID()}`;
  p.id = leadId;
  const hasAccountContext = !!p.companyAccount;
  const rawBackendScore = Number(p.finalSelectionScore || p.scoreBreakdown?.finalScore || p.scoreOverride || 0);
  const backendFinalScore = rawBackendScore <= 1.0 && rawBackendScore > 0 ? rawBackendScore * 10 : rawBackendScore;
  const compositeScore = backendFinalScore > 0
    ? Math.round(backendFinalScore <= 10 ? backendFinalScore * 10 : backendFinalScore)
    : Math.round(Math.min(Math.max(Number(p.companyAccount?.operationalPainScore || 0), 0), 10) * 10);
  const predictiveScore = compositeScore > 0
    ? Math.min(96, Math.floor(compositeScore * (hasAccountContext ? 0.96 : 0.9)))
    : 0;
  return {
    id: leadId,
    profile: p,
    stage: 'SCRAPED',
    notes: hasAccountContext
      ? `LinkedIn-indexed lead with account context. ${p.companyAccount?.painSummary || 'Review profile and advance to outreach.'}`
      : 'Discovered via Tavily LinkedIn-indexed search.',
    createdAt: p.createdAt || now,
    tags: Array.from(new Set([
      'LinkedIn Indexed',
      ...(hasAccountContext ? ['Account Context'] : []),
      p.industry || 'Tech',
      ...(Array.isArray(p.tags) ? p.tags : []),
      ...(p.postIntentEvidence?.quality && p.postIntentEvidence.quality !== 'none' ? [`LinkedIn Post: ${String(p.postIntentEvidence.intentCategory || '').replace(/_/g, ' ')}`] : []),
      ...(p.corroborated || p.companyIntentEvidence?.evidenceQuality === 'good' || p.companyIntentEvidence?.evidenceQuality === 'partial' ? ['Intent Corroborated'] : []),
      ...(p.qualification?.verdict === 'qualified_partial' ? ['Signal Unverified'] : []),
      ...(p.evidence?.corroborated || (p.scout?.sourceCount && p.scout.sourceCount > 1) ? ['Corroborated'] : [])
    ].filter(Boolean))),
    fitScore: p.scoreBreakdown?.fitScore,
    intentScore: p.scoreBreakdown?.intentScore,
    timingScore: p.scoreBreakdown?.timingScore,
    compositeScore,
    predictiveScore,
    companyAccount: p.companyAccount,
    decisionMakerVerification: p.decisionMakerVerification,
    scout: p.scout,
    finalSelectionScore: p.finalSelectionScore,
    discoveryLane: p.discoveryLane,
    sourceProvider: p.sourceProvider || 'tavily',
    evidenceReasons: p.evidenceReasons,
    evidence: p.evidence,
    scoreBreakdown: p.scoreBreakdown,
    postIntentEvidence: p.postIntentEvidence,
    intentEnrichmentState: p.intentEnrichmentState,
    paretoSkyline: p.paretoSkyline,
    confidenceInterval: p.scoreBreakdown?.confidenceInterval || p.confidenceInterval,
    reviewStatus: 'UNREVIEWED',
    nextAction: 'NONE',
    buyingSignalsDetected: Array.from(new Set([
      ...(p.companyAccount?.buyingSignals?.map((signal: any) => signal.label) || []),
      ...(p.companyIntentEvidence?.buyingSignals || []),
      ...(p.postIntentEvidence?.intentKeywords || []),
      ...(p.postIntentEvidence?.quality && p.postIntentEvidence.quality !== 'none' && p.postIntentEvidence.llmReason ? [p.postIntentEvidence.llmReason] : [])
    ].filter(Boolean)))
  };
}

export type ExecuteDiscoveryOptions = {
  sessionId: string;
  promptQuery: string;
  requestedLimit: number;
  startedAt: number;
  sessionAbortController: AbortController;
  activeSessions: Map<string, string[]>;
  activeSessionControllers: Map<string, AbortController>;
  activeSessionEvents: Map<string, MiningTraceEvent[]>;
  cancelledSessions: Set<string>;
  searchSpec?: SearchSpec;
  discoveryMode?: DiscoveryMode;
  discoveryProviderMode?: string;
  excludeList?: string[];
  savedSearchId?: string;
  listener?: DiscoveryEventListener;
};

export async function executeDiscoverySession(options: ExecuteDiscoveryOptions): Promise<DiscoveryResult> {
  const {
    sessionId,
    promptQuery,
    requestedLimit,
    startedAt,
    sessionAbortController,
    activeSessions,
    activeSessionControllers,
    activeSessionEvents,
    cancelledSessions
  } = options;

  const sessionLogs: string[] = [];
  const debugLogs: any[] = [];
  const throwIfCancelled = () => {
    if (!cancelledSessions.has(sessionId) && !sessionAbortController.signal.aborted) return;
    const error = new Error('Lead discovery was cancelled.');
    error.name = 'AbortError';
    throw error;
  };
  const logEvent = (msg: string) => {
    throwIfCancelled();
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    sessionLogs.push(line);
    activeSessions.set(sessionId, sessionLogs);
    if (options.listener?.onLog) options.listener.onLog(line);
  };

  let generatedQueries: string[] = [];
  let rawResultsCount = 0;
  let leadsFound = 0;
  if (!promptQuery || promptQuery.length > 2_000) {
    throw new Error('query must be a non-empty string of 2,000 characters or fewer.');
  }
  const telemetry = new MiningTelemetryRecorder(sessionId, promptQuery, requestedLimit, new Date(startedAt).toISOString());
  upsertMiningSession({
    id: sessionId,
    status: 'running',
    prompt: promptQuery,
    requestedLimit,
    startedAt: new Date(startedAt).toISOString()
  });
  activeSessionControllers.set(sessionId, sessionAbortController);
  const recordTrace = (event: Omit<MiningTraceEvent, 'id' | 'timestamp'> & { timestamp?: string }) => {
    const recorded = telemetry.record(event);
    activeSessionEvents.set(sessionId, telemetry.getEvents());
    if (options.listener?.onTraceEvent) options.listener.onTraceEvent(recorded);
    return recorded;
  };
  const traceLogFields = () => {
    const trace = telemetry.getTrace();
    return {
      traceEvents: trace.events,
      providerSummary: trace.providerSummary,
      costSummary: trace.costSummary,
      phaseTimeline: trace.phaseTimeline,
      schemaVersion: trace.schemaVersion
    };
  };
  const safeInsertSearchLog = (entry: Parameters<typeof insertSearchLog>[0]) => {
    try {
      insertSearchLog({ ...entry, ...traceLogFields() });
    } catch (error) {
      console.warn('[find-leads] failed to write search log:', error instanceof Error ? error.message : String(error));
    }
  };
  const estimateTokens = estimateTokenCount;
  const summarizeLLM = (
    purpose: string,
    promptText: string,
    output: unknown,
    latencyMs: number,
    parseRetries = 0,
    providerAttempts: LLMProviderAttempt[] = [],
    usage?: LLMUsage
  ) => {
    const route = getLLMRouteLabel();
    const successfulAttempt = providerAttempts.find(attempt => attempt.status === 'success');
    const inputTokens = usage ? usage.inputTokens : estimateTokens(promptText);
    const outputTokens = usage ? usage.outputTokens : estimateTokens(typeof output === 'string' ? output : JSON.stringify(output || ''));
    return {
      purpose,
      model: usage?.model || successfulAttempt?.model || route.model,
      route: usage?.provider || successfulAttempt?.provider || route.route,
      fallbackUsed: providerAttempts.some(attempt => attempt.status === 'error' || attempt.status === 'skipped'),
      providerAttempts,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimateLLMCostUsd(inputTokens, outputTokens),
      parseRetries
    };
  };
  const brightDataStats = {
    configured: isBrightDataConfigured(),
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cacheHits: 0,
    searchAttempted: 0,
    searchSucceeded: 0,
    searchRetries: 0,
    searchRecovered: 0,
    searchGoogleAttempted: 0,
    searchGoogleSucceeded: 0,
    searchBingAttempted: 0,
    searchBingSucceeded: 0,
    searchBingRecovered: 0,
    profileScrapesAttempted: 0,
    profileScrapesSucceeded: 0,
    companyScrapesAttempted: 0,
    companyScrapesSucceeded: 0,
    negativeCacheHits: 0,
    batchScrapesAttempted: 0,
    batchScrapesSucceeded: 0,
    batchScrapesPartial: 0,
    batchScrapesFailed: 0,
    profileRetryQueued: 0,
    profileRetryAttempted: 0,
    profileRetrySucceeded: 0,
    transientFailures: 0,
    transportFailures: 0,
    providerDisabled: 0,
    emptyResponses: 0,
    negativeCacheWrites: 0,
    negativeCacheSkippedTransient: 0,
    processRestarts: 0,
    rejectionReasons: {} as Record<string, number>,
    failureReasons: {} as Record<string, number>
  };

  const incrementCounter = (counts: Record<string, number>, reason: string) => {
    counts[reason] = (counts[reason] || 0) + 1;
  };

  const sleepWithAbort = (ms: number, signal?: AbortSignal): Promise<void> => {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new Error('Session cancelled'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Session cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const trackableBrightDataSearch = async (
    query: string,
    options: BrightDataSearchOptions = {},
    phaseLabel: string = 'search'
  ): Promise<BrightDataSearchResult[]> => {
    brightDataStats.searchAttempted++;
    const results = await brightDataSearch(query, {
      ...options,
      onEngineAttempt: (engine) => {
        if (engine === 'google') brightDataStats.searchGoogleAttempted++;
        else if (engine === 'bing') brightDataStats.searchBingAttempted++;
        options.onEngineAttempt?.(engine);
      },
      onBingFallback: (evt) => {
        brightDataStats.searchBingRecovered++;
        if (options.onBingFallback) {
          options.onBingFallback(evt);
        } else {
          logEvent(`[Search Fallback] [${phaseLabel}] Google SERP challenged; Bing fallback rescued ${evt.resultsCount} result(s) for "${query}".`);
        }
      }
    });

    brightDataStats.searchSucceeded++;
    const isBing = results.some(r => r.sourceEngine === 'bing');
    if (isBing) {
      brightDataStats.searchBingSucceeded++;
    } else {
      brightDataStats.searchGoogleSucceeded++;
    }

    return results;
  };

  const stats = {
    requested: requestedLimit,
    returned: 0,
    rawCandidates: 0,
    cacheHits: 0,
    cacheWrites: 0,
    enriched: 0,
    brightDataFailures: 0,
    rounds: 0,
    stopReason: 'not_started',
    rejectionReasons: {} as Record<string, number>,
    queryRuns: [] as QueryRunStats[],
    brightData: brightDataStats,
    sourceProvider: 'tavily' as 'tavily' | 'brightdata_search' | 'mixed',
    brightDataSearchResults: 0,
    scout: {
      mode: 'person_first' as DiscoveryMode,
      maxPerCompany: 2,
      spec: null as SearchSpec | null,
      contract: null as any,
      discoveryProviderMode: 'hybrid' as string,
      brightDataSearchMode: 'primary' as string,
      creditReservation: 'disabled' as string,
      freeTier: {} as Record<string, unknown>,
      lightweightEvidenceUpgrades: 0,
      brightDataEvidenceUpgrades: 0,
      adaptiveScheduler: null as null | {
        active: boolean;
        totalOutcomeRuns: number;
        selected: string[];
        deferred: string[];
      }
    },
    rerank: {
      poolTarget: 0,
      poolSize: 0,
      returned: 0
    }
  };

  type EvidenceMeta = {
    evidenceBlock: string;
    evidenceQuality: EvidenceQuality;
    sourceProvider: LeadSourceProvider;
    sourceUrl: string;
    sourceQuery: string;
    sourceRound: number;
    queryRun?: QueryRunStats;
    sourceProviders?: string[];
    sourceCount?: number;
    lanes?: string[];
    corroborated?: boolean;
  };

  const noteRejection = (reason: RejectionReason, queryRun?: QueryRunStats) => {
    incrementRejection(stats.rejectionReasons, reason);
    if (queryRun) incrementRejection(queryRun.rejectionReasons, reason);
  };

  const profileKeys = (profile: any) => buildProfileDedupeKeys(profile || {});
  const hasDuplicateKeys = (profile: any, existingKeys: Set<string>) => hasDuplicateProfile(profile || {}, existingKeys);
  const addProfileKeys = (profile: any, existingKeys: Set<string>) => {
    profileKeys(profile).forEach(key => existingKeys.add(key));
  };

  const fallbackEvidenceForLead = (lead: any): EvidenceMeta => {
    const sourceUrl = lead.contactDetails?.linkedinUrl || '';
    const evidenceBlock = [
      sourceUrl ? `LINK: ${sourceUrl}` : '',
      lead.headline ? `HEADLINE: ${lead.headline}` : '',
      lead.summary ? `SUMMARY: ${lead.summary}` : '',
      Array.isArray(lead.evidenceReasons) ? lead.evidenceReasons.join('\n') : ''
    ].filter(Boolean).join('\n');
    return {
      evidenceBlock,
      evidenceQuality: 'weak',
      sourceProvider: lead.sourceProvider === 'brightdata_search' ? 'brightdata' : (lead.sourceProvider === 'brightdata' ? 'brightdata' : 'tavily'),
      sourceUrl,
      sourceQuery: promptQuery,
      sourceRound: stats.rounds || 1,
      sourceProviders: [lead.sourceProvider || 'tavily'],
      sourceCount: 1,
      lanes: [lead.discoveryLane || 'person'],
      corroborated: false
    };
  };

  const effectiveScore = (lead: any) => {
    const score = Number(lead.scoreBreakdown?.finalScore || 0);
    if (score > 0) return score;
    const fit = Number(lead.fitScore || 0);
    const composite = Number(lead.compositeScore || 0);
    const predictive = Number(lead.predictiveScore || 0);
    if (fit > 0) return fit;
    if (composite > 10) return composite / 10;
    if (composite > 0) return composite;
    if (predictive > 10) return predictive / 10;
    return predictive;
  };

  const acceptedLeads: any[] = [];
  let persistedCount = 0;
  const persistedLeadIds = new Set<string>();

  try {
    throwIfCancelled();
    logEvent(`--- NEW ADAPTIVE MINING SESSION: ${sessionId} ---`);
    recordTrace({
      phase: 'session',
      operation: 'start',
      status: 'started',
      provider: 'system',
      counts: { requested: stats.requested },
      metadata: { queryLength: String(promptQuery || '').length }
    });
    safeInsertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries: [],
      status: 'running',
      errorMessage: '',
      rawResultsCount: 0,
      leadsFound: 0,
      detailedLogs: sessionLogs.join('\n'),
      debugLogs: JSON.stringify(debugLogs)
    });

    const query = promptQuery;
    const excludeList = options.excludeList || [];
    if (!query) throw new Error('Search criteria/query is required');
    if (!hasOpenAIKey()) throw new Error('No LLM API key configured. Add BYESU_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY to your .env file.');

    const targetLimit = stats.requested;
    const rerankPoolMultiplier = Math.min(Math.max(Number(process.env.LEAD_SEARCH_RERANK_POOL_MULTIPLIER || 3), 1), 5);

    const requestedMode = ['person_first', 'account_first', 'signal_first', 'local_business'].includes((options.discoveryMode || options.discoveryProviderMode || "person_first"))
      ? (options.discoveryMode || options.discoveryProviderMode || "person_first") as DiscoveryMode
      : 'person_first';

    let searchSpec = normalizeSearchSpec(options.searchSpec, query);
    if (!options.searchSpec) {
      searchSpec = buildFallbackSearchSpec(query, requestedMode);
      const specStarted = Date.now();
      try {
        searchSpec = normalizeSearchSpec(await openAIStructured(
          buildSearchSpecPrompt(query),
          searchSpecSchema,
          STRATEGIST_SYSTEM_PROMPT,
          { maxTokens: 700, temperature: 0 }
        ), query);
        recordTrace({
          phase: 'strategy', operation: 'search_spec_compile', status: 'success', provider: 'llm',
          latencyMs: Date.now() - specStarted, metadata: { mode: searchSpec.mode }
        });
      } catch (error: any) {
        logEvent(`WARN: Search-spec compiler failed: ${error.message || String(error)}. Using deterministic spec.`);
        recordTrace({
          phase: 'strategy', operation: 'search_spec_compile', status: 'error', provider: 'llm',
          latencyMs: Date.now() - specStarted, error: { message: error.message || String(error) }
        });
      }
    }

    // Build deterministic contract first as fallback.
    const fallbackContract = buildDeterministicProspectContract(query, searchSpec);

    // Compile contract using LLM if OpenAI/Byesu key is configured.
    let contract = fallbackContract;
    if (hasOpenAIKey()) {
      const contractStarted = Date.now();
      const contractPrompt = buildProspectContractPrompt(query);
      try {
        const compiled = await openAIStructured<any>(
          contractPrompt,
          prospectContractSchema,
          `You are an expert B2B lead generation strategist. Compile the targeting contract.`,
          { maxTokens: 1000, temperature: 0 }
        );
        contract = normalizeProspectContract(compiled, query, fallbackContract);
        const hardCount = contract.requirements.filter(req => req.importance === 'hard').length;
        logEvent(`Compiled prospect quality contract v${contract.policyVersion} with ${hardCount} hard requirements.`);
      } catch (err: any) {
        logEvent(`WARN: Prospect contract compiler failed: ${err.message || String(err)}. Using deterministic contract.`);
      }
    }
    stats.scout.contract = contract;

    // Apply contract synonyms to searchSpec
    searchSpec = searchSpecFromProspectContract(searchSpec, contract);

    const contractHardCount = contract.requirements.filter(req => req.importance === 'hard').length;
    let collectionCapacity = buildCollectionCapacity({
      targetLimit,
      poolMultiplier: rerankPoolMultiplier,
      poolMax: Math.max(Number(process.env.LEAD_SEARCH_RERANK_POOL_MAX || 240), targetLimit),
      baseRounds: Number(process.env.LEAD_SEARCH_BASE_ROUNDS || 4),
      contractHardReqCount: contractHardCount,
      maxRoundsCap: Number(process.env.LEAD_SEARCH_MAX_ROUNDS || 0) || undefined
    });
    let rerankPoolTarget = collectionCapacity.rerankPoolTarget;
    stats.rerank.poolTarget = rerankPoolTarget;
    let maxRounds = collectionCapacity.maxRounds;
    if (collectionCapacity.poolCapped) {
      logEvent(`Requested ${targetLimit} prospects exceeds the ${collectionCapacity.rerankPoolTarget}-candidate evidence-pool safety cap; continuing on a best-effort basis.`);
    }

    const minScore = Math.min(Math.max(Number(process.env.LEAD_SEARCH_MIN_SCORE || 6), 1), 10);
    const ttlDays = Math.min(Math.max(Number(process.env.BRIGHTDATA_CACHE_TTL_DAYS || 7), 1), 30);
    const enrichmentCap = Math.min(
      Math.max(Number(process.env.BRIGHTDATA_ENRICHMENT_CAP || 0) || Math.max(targetLimit * 3, 20), 1),
      500
    );
    const safetyTimeoutMs = Number(process.env.LEAD_SEARCH_TIMEOUT_MS || 0) || 0;

    const discoveryProviderMode = resolveDiscoveryProviderMode({
      brightDataConfigured: isBrightDataConfigured(),
      tavilyConfigured: hasTavilyKey()
    });
    const brightDataSearchMode = resolveBrightDataSearchMode({ discoveryMode: discoveryProviderMode });
    const configuredBrightDataSearchRetryMax = Number(process.env.BRIGHTDATA_SEARCH_RETRY_MAX ?? 1);
    const brightDataSearchRetryMax = Number.isFinite(configuredBrightDataSearchRetryMax)
      ? Math.min(Math.max(Math.floor(configuredBrightDataSearchRetryMax), 0), 2)
      : 1;
    const configuredBrightDataSearchRetryDelay = Number(process.env.BRIGHTDATA_SEARCH_RETRY_BASE_DELAY_MS ?? 750);
    const brightDataSearchRetryBaseDelayMs = Number.isFinite(configuredBrightDataSearchRetryDelay)
      ? Math.min(Math.max(Math.floor(configuredBrightDataSearchRetryDelay), 0), 10_000)
      : 750;
    const profileConcurrency = Math.max(Number(process.env.BRIGHTDATA_PROFILE_CONCURRENCY || 1), 1);
    const profileMaxPerSearch = Math.max(Number(process.env.BRIGHTDATA_PROFILE_MAX_PER_SEARCH || 0) || Math.max(targetLimit * 2, 10), 0);
    const companyIntentEnabled = process.env.BRIGHTDATA_COMPANY_INTENT_ENABLED === 'true';
    const companyIntentMinScore = Math.min(Math.max(Number(process.env.BRIGHTDATA_COMPANY_INTENT_MIN_SCORE || 8), 1), 10);
    const companyIntentMaxPerSearch = Math.max(Number(process.env.BRIGHTDATA_COMPANY_INTENT_MAX_PER_SEARCH || 3), 0);
    const linkedinPostIntentEnabled = String(process.env.LINKEDIN_POST_INTENT_ENABLED || '').toLowerCase() !== 'false';
    // Default to post_filter deep unlock when Bright Data is available so scout
    // shortlists get markdown evidence; callers may still force on_demand.
    const profileEnrichmentStage = (process.env.BRIGHTDATA_PROFILE_ENRICHMENT_STAGE || (isBrightDataConfigured() ? "post_filter" : "on_demand"))
      || process.env.BRIGHTDATA_PROFILE_ENRICHMENT_STAGE
      || (isBrightDataConfigured() ? 'post_filter' : 'on_demand');


    const freeTierBudget = new ScoutFreeTierBudget();
    const tavilyCapabilities = tavilyFreeTierCapabilities();
    const brightDataCapabilities = brightDataFreeTierCapabilities();
    const creditReservationEnabled = isProviderCreditReservationEnabled();
    stats.scout = {
      mode: searchSpec.mode,
      maxPerCompany: searchSpec.maxPerCompany,
      spec: searchSpec,
      contract,
      discoveryProviderMode,
      brightDataSearchMode,
      creditReservation: creditReservationEnabled ? 'enabled' : 'disabled',
      freeTier: {
        tavily: tavilyCapabilities,
        brightData: brightDataCapabilities,
        session: freeTierBudget.snapshot()
      },
      lightweightEvidenceUpgrades: 0,
      brightDataEvidenceUpgrades: 0,
      adaptiveScheduler: null
    };
    logEvent(`Discovery mode=${discoveryProviderMode}, Bright Data search=${brightDataSearchMode}, creditReservation=${creditReservationEnabled ? 'enabled' : 'disabled (key rotation)'}.`);

    const expiredRows = pruneExpiredEnrichmentCache();
    if (expiredRows > 0) logEvent(`Pruned ${expiredRows} expired enrichment cache rows.`);

    const existingKeys = readExistingIdentityKeys();
    const excludedValues = new Set<string>();
    for (const exclusion of excludeList) {
      const normalized = normalizeDedupeValue(exclusion);
      if (!normalized) continue;
      excludedValues.add(normalized);
      existingKeys.add(`email:${normalized}`);
      if (normalized.includes('linkedin.com/in/')) existingKeys.add(`linkedin:${extractLinkedInUsername(normalized)}`);
      existingKeys.add(`name:${normalized}`);
    }

    const matchesExcludeList = (lead: any) => {
      if (excludedValues.size === 0) return false;
      const name = normalizeDedupeValue(lead?.fullName);
      const email = normalizeDedupeValue(lead?.contactDetails?.email);
      const linkedin = normalizeDedupeValue(lead?.contactDetails?.linkedinUrl);
      for (const exclusion of excludedValues) {
        if (email && email === exclusion) return true;
        if (linkedin && linkedin.includes(exclusion)) return true;
        if (name && name.includes(exclusion)) return true;
      }
      return false;
    };
    
    const checkpointAcceptedLeads = (candidates: any[], stageLabel: string) => {
      if (!candidates || candidates.length === 0) return;
      const persistStart = Date.now();
      try {
        const mapped = candidates.map(c => mapCandidateToPersistedLead(c));
        const writeResults = upsertLeadsWithIdentity(mapped);
        for (let i = 0; i < candidates.length; i++) {
          const res = writeResults[i];
          if (res && res.lead && res.lead.id) {
            candidates[i].id = res.lead.id;
            persistedLeadIds.add(res.lead.id);
          }
        }
        persistedCount = persistedLeadIds.size;
        recordTrace({
          phase: 'persistence',
          operation: 'checkpoint_leads',
          status: 'success',
          provider: 'sqlite',
          latencyMs: Date.now() - persistStart,
          counts: { candidates: candidates.length, persistedCount },
          metadata: { checkpointStage: stageLabel }
        });
        logEvent(`[Checkpoint] Auto-persisted ${candidates.length} leads (${stageLabel}).`);
      } catch (err: any) {
        console.warn(`[Checkpoint] Warning: incremental checkpoint failed at ${stageLabel}:`, err);
        recordTrace({
          phase: 'persistence',
          operation: 'checkpoint_leads',
          status: 'error',
          provider: 'sqlite',
          latencyMs: Date.now() - persistStart,
          error: { message: err.message || String(err) },
          metadata: { checkpointStage: stageLabel }
        });
      }
    };
    const leadQueryRuns = new WeakMap<Record<string, any>, QueryRunStats>();
    const seenCandidateKeys = new Set<string>();
    const seenQueryTexts = new Set<string>();
    const evidenceByUrl = new Map<string, EvidenceMeta>();
    const getEvidenceForLead = (lead: any): EvidenceMeta => {
      const linkedinUrl = lead?.contactDetails?.linkedinUrl || '';
      const fallbackUrl = lead?.sourceUrl || '';
      const candidateKeys = [
        normalizeLinkedInUrl(linkedinUrl),
        normalizeDedupeValue(linkedinUrl),
        linkedinUrl,
        normalizeLinkedInUrl(fallbackUrl),
        normalizeDedupeValue(fallbackUrl),
        fallbackUrl
      ].filter(Boolean);

      for (const key of candidateKeys) {
        const found = evidenceByUrl.get(key);
        if (found) return found;
      }
      return fallbackEvidenceForLead(lead);
    };
    const brightDataReady = shouldAttemptBrightData();
    let brightDataProviderDisabled = !brightDataReady;
    let brightDataToolDegraded = false;
    let brightDataTransportRetryAfter = 0;
    const urlRetryQueue = new Set<string>();
    let previousRoundSummary: Record<string, any> = {};
    const llmCircuitBreaker = createLLMSessionCircuitBreaker(
      Number(process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD || 2)
    );
    const failedExtractionRoundsBeforeStop = Math.min(
      Math.max(Number(process.env.LEAD_EXTRACTION_FAILURE_ROUNDS_BEFORE_STOP || 2), 1),
      4
    );
    let consecutiveFailedExtractionRounds = 0;

    if (!brightDataReady) {
      const status = getBrightDataStatus();
      brightDataProviderDisabled = status.health === 'provider_disabled' || status.health === 'unconfigured';
      logEvent(isBrightDataConfigured() ? 'Bright Data is temporarily unavailable. Continuing with cache/Tavily fallbacks.' : 'Bright Data token not configured. Continuing Tavily-only.');
    }

    let consecutiveStalledRounds = 0;
    let acceptedCountBeforeRound = 0;

    const qualifiedLeads: any[] = [];

    const sessionConfig: SessionConfig = {
      sessionId,
      promptQuery,
      targetLimit,
      minScore,
      ttlDays,
      startedAt,
      contract,
      capacity: collectionCapacity,
      maxRounds,
      creditReservationEnabled,
      companyIntentEnabled,
      companyIntentMaxPerSearch,
      companyIntentMinScore,
      linkedinPostIntentEnabled,
      profileEnrichmentStage,
      profileConcurrency,
      profileMaxPerSearch,
      extractionConcurrency: Math.min(Math.max(Number(process.env.LEAD_EXTRACTION_CONCURRENCY || 1), 1), 4),
      judgeConcurrency: Number(process.env.FINALIST_JUDGE_CONCURRENCY || 2)
    };

    const sessionState: PipelineSessionState = {
      round: 1,
      seenCandidateKeys,
      existingKeys,
      queryRuns: stats.queryRuns,
      acceptedLeads,
      qualifiedLeads,
      finalLeads: [],
      rejectionCounts: stats.rejectionReasons,
      failureCounts: brightDataStats.failureReasons,
      brightDataStats,
      freeTierBudget,
      llmCircuitBreaker,
      abortController: sessionAbortController,
      telemetry,
      debugLogs,
      previousRoundSummary
    };

    const pipelinePorts: PipelinePorts = {
      brightDataSearch: (q, opts, label) => trackableBrightDataSearch(q, opts, label),
      tavilySearch: (q, opts) => tavilySearch(q, opts),
      scrapeMarkdown: (url) => scrapeAsMarkdown(url),
      scrapeBatchMarkdown: (urls) => scrapeBatchAsMarkdown(urls)
    };

    const sessionCtx: SessionContext = {
      config: sessionConfig,
      state: sessionState,
      ports: pipelinePorts,
      logEvent,
      recordTrace
    };

    for (let round = 1; round <= maxRounds && acceptedLeads.length < rerankPoolTarget; round++) {
      if (safetyTimeoutMs > 0 && Date.now() - startedAt > safetyTimeoutMs) {
        stats.stopReason = 'timeout';
        break;
      }

      stats.rounds = round;
      sessionState.round = round;
      sessionState.previousRoundSummary = previousRoundSummary;
      acceptedCountBeforeRound = acceptedLeads.length;
      const remaining = Math.max(rerankPoolTarget - acceptedLeads.length, 0);

      const planResult = await executePlanStage(sessionCtx, {
        round,
        remaining,
        generatedQueries,
        seenQueryTexts,
        searchSpec,
        discoveryProviderMode,
        stats
      });

      if (planResult.stopReason) {
        stats.stopReason = planResult.stopReason;
        break;
      }

      const { roundPlans, queryRuns } = planResult;

      const retrieveResult = await executeRetrieveStage(sessionCtx, {
        round,
        roundPlans,
        queryRuns,
        discoveryProviderMode,
        brightDataSearchMode,
        brightDataReady,
        brightDataProviderDisabled,
        brightDataTransportRetryAfter,
        brightDataSearchRetryMax,
        brightDataSearchRetryBaseDelayMs,
        tavilyCapabilities,
        brightDataCapabilities,
        stats
      });

      const { roundItems } = retrieveResult;
      brightDataProviderDisabled = retrieveResult.brightDataProviderDisabled;
      brightDataTransportRetryAfter = retrieveResult.brightDataTransportRetryAfter;

      // Fuse provider observations before extraction. This retains independent
      // corroboration rather than discarding Bright Data results as duplicates.
      const fuseResult = await executeFuseStage(sessionCtx, {
        round,
        roundItems,
        roundPlans,
        queryRuns,
        stats
      });

      if (fuseResult.stopReason) {
        stats.stopReason = fuseResult.stopReason;
        break;
      }

      const { candidateItems, roundCandidateKeys } = fuseResult;
      rawResultsCount = seenCandidateKeys.size + roundCandidateKeys.size;
      stats.rawCandidates = rawResultsCount;

      const extractResult = await executeExtractStage(sessionCtx, {
        round,
        candidateItems,
        rerankPoolTarget,
        brightDataReady,
        brightDataProviderDisabled,
        tavilyCapabilities,
        brightDataCapabilities,
        consecutiveFailedExtractionRounds,
        failedExtractionRoundsBeforeStop,
        evidenceByUrl,
        stats
      });

      brightDataProviderDisabled = extractResult.brightDataProviderDisabled;
      consecutiveFailedExtractionRounds = extractResult.consecutiveFailedExtractionRounds;

      if (extractResult.stopReason) {
        stats.stopReason = extractResult.stopReason;
        break;
      }

      const provisionalLeads = extractResult.extractedProfiles;

      const { postFilterLeads } = await executeVerifyStage(sessionCtx, {
        round,
        provisionalLeads,
        evidenceByUrl,
        searchSpec,
        excludeList,
        stats
      });

      const enrichResult = await executeEnrichStage(sessionCtx, {
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
        brightDataProviderDisabled,
        brightDataTransportRetryAfter,
        stats,
        leadQueryRuns,
        trackableBrightDataSearch
      });

      brightDataProviderDisabled = enrichResult.brightDataProviderDisabled;
      brightDataTransportRetryAfter = enrichResult.brightDataTransportRetryAfter;

      const roundRuns = stats.queryRuns.filter(run => run.round === round);
      for (const run of roundRuns) {
        recordQueryPerformance({
          family: run.family || 'general',
          lane: run.lane || 'person',
          provider: run.providerPreference || 'tavily',
          rawCandidates: run.rawCandidates,
          uniqueCandidates: run.uniqueCandidates,
          extractedCandidates: run.extractedLeads,
          acceptedCandidates: run.acceptedLeads,
          duplicateCandidates: Number(run.rejectionReasons.duplicate_existing_lead || 0),
          searchLatencyMs: run.searchLatencyMs,
          providerUnits: run.providerUnits
        });
      }
      const roundDiagnosticsObj = buildRoundDiagnostics({
        round,
        rawCandidates: roundRuns.reduce((sum, run) => sum + run.rawCandidates, 0),
        extractedCandidates: roundRuns.reduce((sum, run) => sum + run.extractedLeads, 0),
        leads: acceptedLeads.filter(lead => lead.evidence?.sourceRound === round),
        contract,
        targetLimit,
        alreadyQualified: acceptedCountBeforeRound
      });

      previousRoundSummary = {
        rawCandidates: roundDiagnosticsObj.rawCandidates,
        uniqueCandidates: roundRuns.reduce((sum, run) => sum + run.uniqueCandidates, 0),
        extractedLeads: roundDiagnosticsObj.extractedCandidates,
        acceptedLeads: roundRuns.reduce((sum, run) => sum + run.acceptedLeads, 0),
        viableCandidates: roundDiagnosticsObj.viableCandidates,
        shouldRecover: roundDiagnosticsObj.shouldRecover,
        missingHardRequirementIds: roundDiagnosticsObj.missingHardRequirementIds,
        rejectionReasons: stats.rejectionReasons
      };

      logEvent(`Round ${round} diagnostics: ${previousRoundSummary.viableCandidates} candidates show all hard terms; recovery=${previousRoundSummary.shouldRecover ? 'needed' : 'not needed'}.`);
      checkpointAcceptedLeads(acceptedLeads.slice(acceptedCountBeforeRound), `round_${round}`);

      // Early shortlist termination:
      // If we already have >= target * 1.33 accepted leads AND at least target viable candidates showing all hard requirements,
      // stop immediately and proceed to Finalist Judging rather than burning unnecessary query rounds.
      const earlyStopTargetThreshold = Math.ceil(targetLimit * 1.33);
      if (
        acceptedLeads.length >= earlyStopTargetThreshold &&
        previousRoundSummary.viableCandidates >= targetLimit &&
        (!previousRoundSummary.missingHardRequirementIds || previousRoundSummary.missingHardRequirementIds.length === 0)
      ) {
        logEvent(`Round ${round}: Sufficient high-quality candidates (accepted=${acceptedLeads.length}, viable=${previousRoundSummary.viableCandidates}, target=${targetLimit}) collected with all hard criteria met. Stopping discovery loop early.`);
        stats.stopReason = 'target_fulfilled_early';
        break;
      }

      const newAcceptedInRound = acceptedLeads.length - acceptedCountBeforeRound;
      if (newAcceptedInRound === 0) {
        consecutiveStalledRounds++;
        if (consecutiveStalledRounds >= 2 && acceptedLeads.length > 0) {
          logEvent(`Round ${round}: 2 consecutive rounds produced 0 new accepted leads. Early exiting round loop with ${acceptedLeads.length} leads.`);
          stats.stopReason = 'early_exit_stalled';
          break;
        }
        if (consecutiveStalledRounds >= 3 && acceptedLeads.length === 0) {
          logEvent(`Round ${round}: 3 consecutive rounds produced 0 candidates. Early exiting round loop to prevent endless API token burning.`);
          stats.stopReason = 'exhausted';
          break;
        }
      } else {
        consecutiveStalledRounds = 0;
      }
    }

    if (acceptedLeads.length === 0) {
      throw new Error('Could not extract any new qualified profiles from search results. Try more specific criteria.');
    }

    stats.rerank.poolSize = acceptedLeads.length;

    const finalistCandidates: FinalistCandidate[] = acceptedLeads.map((lead, index) => {
      const evidence = getEvidenceForLead(lead);
      return finalistCandidateFromLead(`c${index}`, lead, evidence?.evidenceBlock, contract);
    });

    const { autoQualified, needsJudge } = partitionCandidatesByStrictEvidence(finalistCandidates, contract);
    const maxBatchSize = Math.max(1, Math.min(18, Number(process.env.FINALIST_JUDGE_BATCH_SIZE || 6)));
    const providerTokenBudget = Math.max(4_000, Number(process.env.LLM_PROVIDER_TOKEN_BUDGET || 7_200));
    // Preserve completion headroom for the structured verdict. Measure the real
    // prompt, because a serialized lead contains fields the judge never sees.
    const maxBatchInputTokens = Math.min(4_200, Math.max(1_600, providerTokenBudget - 3_000));
    const judgeBatches: FinalistCandidate[][] = [];
    let currentBatch: FinalistCandidate[] = [];

    for (const candidate of needsJudge) {
      const proposedBatch = [...currentBatch, candidate];
      const proposedInputTokens = estimateTokenCount(buildFinalistJudgePrompt(contract, proposedBatch));

      if (currentBatch.length >= maxBatchSize || (currentBatch.length > 0 && proposedInputTokens > maxBatchInputTokens)) {
        judgeBatches.push(currentBatch);
        currentBatch = [candidate];
      } else {
        currentBatch = proposedBatch;
      }
    }
    if (currentBatch.length > 0) {
      judgeBatches.push(currentBatch);
    }

    qualifiedLeads.length = 0;
    qualifiedLeads.push(...autoQualified.map(({ candidate, qualification }) => {
      candidate.lead.qualification = qualification;
      candidate.lead.whyThisLead = qualification.reason;
      candidate.lead.finalSelectionScore = qualification.finalScore;
      return candidate.lead;
    }));
    logEvent(`Finalist Judge: ${autoQualified.length} strict direct-profile qualifications; ${needsJudge.length} candidates need semantic review.`);
    if (judgeBatches.length) {
      logEvent(`Running evidence-validated Finalist Judge on ${needsJudge.length} candidates in ${judgeBatches.length} prompt-aware batch(es), up to ${maxBatchInputTokens} input tokens each.`);

      const evaluateFinalistBatch = async (batch: FinalistCandidate[], batchIndex: number, attemptDepth = 0): Promise<any[]> => {
        const judgeStarted = Date.now();
        const judgeAttempts: LLMProviderAttempt[] = [];
        let judgeUsage: LLMUsage | undefined;
        const judgePrompt = buildFinalistJudgePrompt(contract, batch);
        const dynamicMaxTokens = Math.min(5_000, Math.max(900, batch.length * 500));
        const estimatedInputTokens = estimateTokenCount(judgePrompt);
        try {
          const judgmentResult = await openAIStructured<any>(judgePrompt, finalistJudgeSchema, FINALIST_JUDGE_SYSTEM_PROMPT, {
            maxTokens: dynamicMaxTokens,
            temperature: 0,
            retryOnParseFailure: false,
            timeoutMs: Number(process.env.LLM_FINALIST_TIMEOUT_MS || 90_000),
            circuitBreaker: llmCircuitBreaker,
            onProviderAttempt: attempt => judgeAttempts.push(attempt),
            onUsage: usage => { judgeUsage = usage; }
          });
          const validation = validateFinalistJudgments(judgmentResult, contract, batch);
          const minimumValid = Math.ceil(batch.length * 0.60);
          if (validation.validJudgmentCount < minimumValid) {
            recordTrace({
              phase: 'candidate_processing', operation: 'finalist_judge', status: 'error', provider: 'llm', round: stats.rounds,
              latencyMs: Date.now() - judgeStarted,
              counts: { batchSize: batch.length, validJudgments: validation.validJudgmentCount, minimumValid },
              error: { message: 'Finalist judge response omitted too many candidates.' },
              llm: summarizeLLM('finalist_judge', judgePrompt, judgmentResult, Date.now() - judgeStarted, 0, judgeAttempts, judgeUsage),
              metadata: { batch: `${batchIndex + 1}_d${attemptDepth}`, policyVersion: contract.policyVersion, estimatedInputTokens, requestedOutputTokens: dynamicMaxTokens }
            });
            if (batch.length > 1 && attemptDepth < 3) {
              logEvent(`Finalist judge batch ${batchIndex + 1} omitted judgments; splitting ${batch.length} candidates.`);
              const mid = Math.ceil(batch.length / 2);
              const left = await evaluateFinalistBatch(batch.slice(0, mid), batchIndex, attemptDepth + 1);
              const right = await evaluateFinalistBatch(batch.slice(mid), batchIndex, attemptDepth + 1);
              return [...left, ...right];
            }
            return [] as any[];
          }
          const batchQualified = batch.flatMap(candidate => {
            const qualification = validation.qualifications.get(candidate.candidateId);
            if (!qualification) return [];
            candidate.lead.qualification = qualification;
            candidate.lead.whyThisLead = qualification.reason;
            candidate.lead.finalSelectionScore = qualification.finalScore;
            if (candidate.lead.scoreBreakdown) candidate.lead.scoreBreakdown.finalScore = qualification.finalScore;
            candidate.lead.scoreOverride = qualification.finalScore;
            return [candidate.lead];
          });
          debugLogs.push({
            timestamp: new Date().toISOString(), type: 'llm_response', label: `finalist_judge_batch_${batchIndex + 1}_d${attemptDepth}`,
            response: JSON.parse(JSON.stringify(judgmentResult))
          });
          recordTrace({
            phase: 'candidate_processing', operation: 'finalist_judge', status: 'success', provider: 'llm', round: stats.rounds,
            latencyMs: Date.now() - judgeStarted,
            counts: { batchSize: batch.length, validJudgments: validation.validJudgmentCount, qualified: batchQualified.length },
            llm: summarizeLLM('finalist_judge', judgePrompt, judgmentResult, Date.now() - judgeStarted, 0, judgeAttempts, judgeUsage),
            metadata: { batch: `${batchIndex + 1}_d${attemptDepth}`, policyVersion: contract.policyVersion, estimatedInputTokens, requestedOutputTokens: dynamicMaxTokens }
          });
          return batchQualified;
        } catch (error: any) {
          recordTrace({
            phase: 'candidate_processing', operation: 'finalist_judge', status: 'error', provider: 'llm', round: stats.rounds,
            latencyMs: Date.now() - judgeStarted, error: { message: error.message || String(error) },
            llm: summarizeLLM('finalist_judge', judgePrompt, '', Date.now() - judgeStarted, 0, judgeAttempts, judgeUsage),
            metadata: { batch: `${batchIndex + 1}_d${attemptDepth}`, policyVersion: contract.policyVersion, estimatedInputTokens, requestedOutputTokens: dynamicMaxTokens }
          });
          const isTokenOrSizeError = error.isTokenLimit || /413|payload too large|too many tokens|rate_limit_exceeded/i.test(error.message || '');
          if (batch.length > 1 && (isTokenOrSizeError || attemptDepth < 2)) {
            logEvent(`Finalist judge batch ${batchIndex + 1} failed (${error.message || String(error)}); splitting ${batch.length} candidates.`);
            const mid = Math.ceil(batch.length / 2);
            const left = await evaluateFinalistBatch(batch.slice(0, mid), batchIndex, attemptDepth + 1);
            const right = await evaluateFinalistBatch(batch.slice(mid), batchIndex, attemptDepth + 1);
            return [...left, ...right];
          }
          logEvent(`WARN: Finalist judge batch ${batchIndex + 1} failed completely: ${error.message || String(error)}.`);
          return [] as any[];
        }
      };

      const judgeResults = await runProviderQueue(
        judgeBatches.map((batch, batchIndex) => ({
          id: `${sessionId}:finalist:${batchIndex + 1}`,
          priority: judgeBatches.length - batchIndex,
          run: async () => evaluateFinalistBatch(batch, batchIndex)
        })),
        {
          concurrency: Number(process.env.FINALIST_JUDGE_CONCURRENCY || 2),
          signal: sessionAbortController.signal
        }
      );
      qualifiedLeads.push(...judgeResults.flat());
    }

    // Safety net: if qualifiedLeads falls short of targetLimit, we promote acceptedLeads up to the limit
    const qualifiedUrls = new Set<string>(qualifiedLeads.map(lead => lead.contactDetails?.linkedinUrl || lead.sourceUrl || ''));
    let rescuedCount = 0;
    const maxRescueRatio = Math.min(Math.max(Number(process.env.SAFETY_NET_MAX_RESCUE_RATIO ?? 0.5), 0), 1.0);
    const maxRescuesAllowed = Math.ceil(targetLimit * maxRescueRatio);
    if (qualifiedLeads.length < targetLimit) {
      const needed = targetLimit - qualifiedLeads.length;
      const rescueCap = Math.min(needed, maxRescuesAllowed);
      logEvent(`Safety Net: Finalist Judge qualified ${qualifiedLeads.length}/${targetLimit} leads. Rescuing top remaining accepted candidates (cap: ${rescueCap}).`);
      acceptedLeads.forEach(lead => {
        lead.finalSelectionScore = rankLeadForFinalSelection(lead);
      });
      acceptedLeads.sort((a, b) => {
        const rankDelta = Number(b.finalSelectionScore || 0) - Number(a.finalSelectionScore || 0);
        return rankDelta !== 0 ? rankDelta : effectiveScore(b) - effectiveScore(a);
      });
      for (const lead of acceptedLeads) {
        if (rescuedCount >= rescueCap || qualifiedLeads.length >= targetLimit) break;
        const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl || '';
        if (!qualifiedUrls.has(url)) {
          lead.qualification = { verdict: 'rescued', reason: 'Safety Net: identity-verified, signal evidence unavailable', finalScore: lead.finalSelectionScore };
          lead.whyThisLead = 'Safety Net: identity verified, buying signal not confirmed';
          lead.isRescued = true;
          qualifiedLeads.push(lead);
          qualifiedUrls.add(url);
          rescuedCount++;
        }
      }
      logEvent(`Safety Net: Promoted ${rescuedCount} candidates to reach target.`);
    }

    checkpointAcceptedLeads(qualifiedLeads.length > 0 ? qualifiedLeads : acceptedLeads, 'post_finalist_judge');

    // === PHASE 5: POST-COLLECTION LINKEDIN POST INTENT ENRICHMENT ===
    if (linkedinPostIntentEnabled && qualifiedLeads.length > 0) {
      logEvent(`Phase 5: LinkedIn post intent enrichment starting. Pool: ${qualifiedLeads.length} qualified leads.`);
      const qualifiedMap = new Map<string, any>(qualifiedLeads.map((l: any, idx: number) => [l.id || `lead-${idx}`, l]));
      const postIntentStats = await runLinkedInPostIntentEnrichment({
        qualifiedLeads: qualifiedMap,
        contract,
        brightDataSearch: (q, opts) => trackableBrightDataSearch(q, opts, 'phase_5_post_intent'),
        tavilySearchFallback: hasTavilyKey() ? (q, opts) => tavilySearch(q, opts) : undefined,
        targetLimit,
        maxLeads: Number(process.env.LINKEDIN_POST_INTENT_MAX_LEADS || 20),
        concurrency: Number(process.env.LINKEDIN_POST_INTENT_CONCURRENCY || 2),
        ttlDays,
        sessionAbortSignal: sessionAbortController.signal,
        logEvent,
        recordTrace
      });
      (stats as any).linkedinPostIntent = postIntentStats;
      logEvent(`Phase 5 complete: ${postIntentStats.succeeded} enriched, ${postIntentStats.cacheHits} cache hits, ${postIntentStats.noResults} no-results, ${postIntentStats.llmSkipped} skipped, ${postIntentStats.failed} failed.`);
    }
    // === END PHASE 5 ===

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
    leadsFound = finalLeads.length;
    stats.returned = leadsFound;
    stats.rerank.returned = leadsFound;

    if (leadsFound >= targetLimit) {
      stats.stopReason = 'target_reached';
    } else if (stats.stopReason === 'not_started') {
      stats.stopReason = stats.rounds >= maxRounds ? 'max_rounds' : 'exhausted';
    }

    logEvent(`Session complete: returned ${leadsFound}/${targetLimit}. Stop reason: ${stats.stopReason}. Stats: ${JSON.stringify(stats)}`);

    const now = new Date().toISOString();
    const mappedLeads: Record<string, any>[] = finalLeads.map((p: any) =>
      mapCandidateToPersistedLead(p, p.id || `lead-${crypto.randomUUID()}`, now)
    );

    let persistence = { createdCount: 0, updatedCount: 0, duplicateCount: 0 };
    const persistStarted = Date.now();
    try {
      const writeResults = upsertLeadsWithIdentity(mappedLeads);
      const persistedLeads = writeResults.map((result) => result.lead);
      for (let i = 0; i < finalLeads.length; i++) {
        const res = writeResults[i];
        if (res?.lead?.id) {
          finalLeads[i].id = res.lead.id;
          persistedLeadIds.add(res.lead.id);
        }
      }
      persistedCount = persistedLeadIds.size;
      persistence = {
        createdCount: writeResults.filter((result) => result.disposition === 'created').length,
        updatedCount: writeResults.filter((result) => result.disposition === 'updated').length,
        duplicateCount: writeResults.filter((result) => result.disposition === 'duplicate').length,
      };
      recordTrace({
        phase: 'persistence',
        operation: 'upsert_leads',
        status: 'success',
        provider: 'sqlite',
        latencyMs: Date.now() - persistStarted,
        counts: { leads: mappedLeads.length, ...persistence }
      });
      logEvent(`Successfully auto-persisted ${persistence.createdCount} new leads; ${persistence.duplicateCount} LinkedIn duplicates returned existing prospects.`);
      mappedLeads.splice(0, mappedLeads.length, ...persistedLeads);
    } catch (e: any) {
      console.error('Failed to auto-persist leads on backend:', e);
      recordTrace({
        phase: 'persistence',
        operation: 'upsert_leads',
        status: 'error',
        provider: 'sqlite',
        latencyMs: Date.now() - persistStarted,
        error: { message: e.message || String(e) }
      });
      logEvent(`Error auto-persisting leads on backend: ${e.message}`);
      if (persistedCount === 0) {
        throw new Error(`Failed to persist discovered leads: ${e.message || String(e)}`);
      }
    }

    const persistenceStatus: 'complete' | 'partial' | 'failed' =
      persistence.createdCount + persistence.updatedCount + persistence.duplicateCount >= mappedLeads.length
        ? 'complete'
        : (persistedCount > 0 ? 'partial' : 'failed');

    telemetry.finish('success', stats);
    const traceSummary = telemetry.getSummary();
    const detailedLogsText = `${sessionLogs.join('\n')}\n\nSTATS_SUMMARY:\n${JSON.stringify(stats, null, 2)}`;
    safeInsertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: 'success',
      errorMessage: '',
      rawResultsCount,
      leadsFound,
      detailedLogs: detailedLogsText,
      debugLogs: JSON.stringify(debugLogs)
    });

    upsertMiningSession({
      id: sessionId,
      status: 'success',
      completedAt: new Date().toISOString(),
      stats: { ...stats, persistedCount, persistenceStatus },
      traceSummary
    });

    if (typeof options.savedSearchId === 'string' && readSavedSearchById(options.savedSearchId)) {
      markSavedSearchRun(options.savedSearchId);
    }

    return { apiVersion: 1, leads: mappedLeads, persistence, persistenceStatus, stats, traceSummary, sandboxMode: false, sessionId, total: mappedLeads.length, requestedLimit: targetLimit, shortfall: Math.max(0, targetLimit - mappedLeads.length), shortfallReason: mappedLeads.length < targetLimit ? `Found ${mappedLeads.length}/${targetLimit} verified matches after exhausting search queries.` : undefined, stopReason: stats.stopReason, cancelled: false };

  } catch (error: any) {
    console.error('Error in /api/find-leads:', error);
    const cancelled = error?.name === 'AbortError' || String(error?.message || '').includes('cancelled');
    telemetry.finish('error', { ...stats, error: error.message || 'Failed to locate leads.' });
    const traceSummary = telemetry.getSummary();
    // Report only what actually reached SQLite -- never inflate with unpersisted candidates.
    const effectiveLeadsFound = persistedCount;
    const persistenceStatus: 'complete' | 'partial' | 'failed' = persistedCount > 0 ? 'partial' : 'failed';

    const detailedLogsText = `${sessionLogs.join('\n')}\n\nSTATS_SUMMARY:\n${JSON.stringify(stats, null, 2)}`;
    safeInsertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: cancelled ? 'cancelled' : 'error',
      errorMessage: error.message || 'Failed to locate leads.',
      rawResultsCount,
      leadsFound: effectiveLeadsFound,
      detailedLogs: detailedLogsText,
      debugLogs: JSON.stringify(debugLogs)
    });

    upsertMiningSession({
      id: sessionId,
      status: cancelled ? 'cancelled' : 'error',
      completedAt: new Date().toISOString(),
      errorMessage: error.message || 'Failed to locate leads.',
      stats: { ...stats, persistedCount, persistenceStatus },
      traceSummary
    });

    throw error;
  } finally {
    activeSessions.delete(sessionId);
    activeSessionEvents.delete(sessionId);
    cancelledSessions.delete(sessionId);
    activeSessionControllers.delete(sessionId);
    await closeBrightDataClient({ onlyIfIdle: true, onlyIfUnhealthy: true, reason: 'find-leads-complete' });
  }

}

export class DiscoverySessionEngine {
  private activeSessions = new Map<string, string[]>();
  private activeSessionControllers = new Map<string, AbortController>();
  private activeSessionEvents = new Map<string, MiningTraceEvent[]>();
  private cancelledSessions = new Set<string>();

  cancel(sessionId: string): boolean {
    if (!sessionId) return false;
    this.cancelledSessions.add(sessionId);
    const controller = this.activeSessionControllers.get(sessionId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }

  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  getLiveTrace(sessionId: string): MiningTraceEvent[] | null {
    return this.activeSessionEvents.get(sessionId) || null;
  }

  getLiveLogs(sessionId: string): string[] | null {
    return this.activeSessions.get(sessionId) || null;
  }

  addLog(sessionId: string, message: string): void {
    const logs = this.activeSessions.get(sessionId) || [];
    logs.push(message);
    this.activeSessions.set(sessionId, logs);
  }

  async execute(request: DiscoveryRequest, listener?: DiscoveryEventListener): Promise<DiscoveryResult> {
    const promptQuery = String(request.promptQuery || '').trim();
    if (!promptQuery || promptQuery.length > 2000) {
      throw new Error('query must be a non-empty string of 2,000 characters or fewer.');
    }

    const sessionId = request.sessionId?.trim() || (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`A lead mining session with this sessionId is already active: ${sessionId}`);
    }

    const sessionAbortController = new AbortController();
    this.activeSessionControllers.set(sessionId, sessionAbortController);

    return executeDiscoverySession({
      sessionId,
      promptQuery,
      requestedLimit: Math.min(Math.max(Number(request.requestedLimit || 5), 1), 200),
      startedAt: Date.now(),
      sessionAbortController,
      activeSessions: this.activeSessions,
      activeSessionControllers: this.activeSessionControllers,
      activeSessionEvents: this.activeSessionEvents,
      cancelledSessions: this.cancelledSessions,
      searchSpec: request.searchSpec,
      discoveryMode: request.discoveryMode,
      discoveryProviderMode: request.discoveryProviderMode,
      excludeList: request.excludeList,
      savedSearchId: request.savedSearchId,
      listener
    });
  }
}

export const discoveryEngine = new DiscoverySessionEngine();
