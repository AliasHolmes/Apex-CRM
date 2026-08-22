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
  reserveProviderUsage,
  saveMiningSessionCheckpoint,
  readMiningSessionCheckpoint,
  readResumableMiningSessions
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
import { executeJudgeStage } from './stages/judgeStage.js';
import { executeSelectStage } from './stages/selectStage.js';
import { executePersistStage } from './stages/persistStage.js';
import type { SessionConfig, PipelineSessionState, PipelinePorts, SessionContext, MiningSessionCheckpoint } from './pipelineTypes.js';
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
  initialCheckpoint?: MiningSessionCheckpoint;
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

    // Build deterministic contract first as fallback (or restore from checkpoint).
    const fallbackContract = options.initialCheckpoint?.contract || buildDeterministicProspectContract(query, searchSpec);

    // Compile contract using LLM if OpenAI/Byesu key is configured and not resuming from existing contract.
    let contract = options.initialCheckpoint?.contract || fallbackContract;
    if (!options.initialCheckpoint?.contract && hasOpenAIKey()) {
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

    if (options.initialCheckpoint) {
      const cp = options.initialCheckpoint;
      logEvent(`[Resume] Resuming session ${sessionId} from round ${cp.round} (${(cp.acceptedLeads || []).length} accepted leads).`);
      stats.rounds = cp.round;
      if (Array.isArray(cp.queryRuns)) {
        stats.queryRuns.push(...cp.queryRuns);
        for (const run of cp.queryRuns) {
          if (run.query) seenQueryTexts.add(run.query);
        }
      }
      if (cp.rejectionCounts) Object.assign(stats.rejectionReasons, cp.rejectionCounts);
      if (cp.failureCounts && brightDataStats.failureReasons) Object.assign(brightDataStats.failureReasons, cp.failureCounts);
      if (cp.brightDataStats) Object.assign(brightDataStats, cp.brightDataStats);
      if (cp.previousRoundSummary) previousRoundSummary = cp.previousRoundSummary;
      if (Array.isArray(cp.acceptedLeads)) {
        for (const lead of cp.acceptedLeads) {
          acceptedLeads.push(lead);
          buildProfileDedupeKeys(lead).forEach(k => existingKeys.add(k));
        }
      }
      if (Array.isArray(cp.qualifiedLeads)) {
        qualifiedLeads.push(...cp.qualifiedLeads);
      }
    }

    const initialRound = (options.initialCheckpoint?.round && options.initialCheckpoint.stage === 'enrich')
      ? options.initialCheckpoint.round + 1
      : (options.initialCheckpoint?.round || 1);

    let nextPlanPromise: Promise<any> | null = null;

    for (let round = initialRound; round <= maxRounds && acceptedLeads.length < rerankPoolTarget; round++) {
      if (safetyTimeoutMs > 0 && Date.now() - startedAt > safetyTimeoutMs) {
        stats.stopReason = 'timeout';
        break;
      }

      stats.rounds = round;
      sessionState.round = round;
      sessionState.previousRoundSummary = previousRoundSummary;
      acceptedCountBeforeRound = acceptedLeads.length;
      const remaining = Math.max(rerankPoolTarget - acceptedLeads.length, 0);

      const planResult = nextPlanPromise
        ? await nextPlanPromise
        : await executePlanStage(sessionCtx, {
            round,
            remaining,
            generatedQueries,
            seenQueryTexts,
            searchSpec,
            discoveryProviderMode,
            stats
          });
      nextPlanPromise = null;

      if (planResult.stopReason) {
        stats.stopReason = planResult.stopReason;
        break;
      }

      const { roundPlans, queryRuns } = planResult;
      stats.queryRuns.push(...queryRuns);

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

      // Stage Pipelining: Pre-compute plan for round N+1 speculatively in background while extract/verify/enrich execute
      if (round + 1 <= maxRounds && acceptedLeads.length < rerankPoolTarget) {
        nextPlanPromise = executePlanStage(sessionCtx, {
          round: round + 1,
          remaining: Math.max(rerankPoolTarget - acceptedLeads.length, 0),
          generatedQueries,
          seenQueryTexts,
          searchSpec,
          discoveryProviderMode,
          stats
        }).catch(err => {
          logEvent(`WARN: Pipelined plan for round ${round + 1} failed: ${err.message || String(err)}`);
          return { roundPlans: [], queryRuns: [] };
        });
      }

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
      saveMiningSessionCheckpoint(sessionId, {
        sessionId,
        round,
        stage: 'enrich',
        promptQuery,
        targetLimit,
        contract,
        searchSpec,
        queryRuns: stats.queryRuns,
        acceptedLeads: acceptedLeads.slice(0, 240),
        qualifiedLeads: qualifiedLeads.slice(0, 240),
        finalLeads: [],
        rejectionCounts: stats.rejectionReasons,
        failureCounts: brightDataStats.failureReasons,
        brightDataStats,
        previousRoundSummary,
        updatedAt: new Date().toISOString()
      });

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

    saveMiningSessionCheckpoint(sessionId, {
      sessionId,
      round: stats.rounds || 1,
      stage: 'judge',
      promptQuery,
      targetLimit,
      contract,
      searchSpec,
      queryRuns: stats.queryRuns,
      acceptedLeads: acceptedLeads.slice(0, 240),
      qualifiedLeads: qualifiedLeads.slice(0, 240),
      finalLeads: [],
      rejectionCounts: stats.rejectionReasons,
      failureCounts: brightDataStats.failureReasons,
      brightDataStats,
      previousRoundSummary,
      updatedAt: new Date().toISOString()
    });

    await executeJudgeStage(sessionCtx, {
      contract,
      evidenceByUrl,
      stats,
      checkpointAcceptedLeads
    });

    const selectResult = await executeSelectStage(sessionCtx, {
      contract,
      searchSpec,
      ttlDays,
      stats,
      leadQueryRuns,
      trackableBrightDataSearch
    });

    const { finalLeads } = selectResult;
    leadsFound = selectResult.leadsFound;

    const persistResult = await executePersistStage(sessionCtx, {
      finalLeads,
      leadsFound,
      rawResultsCount,
      generatedQueries,
      stats,
      savedSearchId: options.savedSearchId,
      persistedLeadIds,
      sessionLogs,
      safeInsertSearchLog
    });

    persistedCount = persistResult.persistedCount;
    return persistResult.result;

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

  getResumableSessions() {
    return readResumableMiningSessions();
  }

  async resume(sessionId: string, listener?: DiscoveryEventListener): Promise<DiscoveryResult> {
    const trimmedId = (sessionId || '').trim();
    if (!trimmedId) {
      throw new Error('sessionId is required to resume a mining session.');
    }
    if (this.activeSessions.has(trimmedId)) {
      throw new Error(`A lead mining session with this sessionId is already active: ${trimmedId}`);
    }
    const checkpoint = readMiningSessionCheckpoint(trimmedId);
    if (!checkpoint) {
      throw new Error(`No resumable checkpoint found for session: ${trimmedId}`);
    }

    const sessionAbortController = new AbortController();
    this.activeSessionControllers.set(trimmedId, sessionAbortController);

    return executeDiscoverySession({
      sessionId: trimmedId,
      promptQuery: checkpoint.promptQuery,
      requestedLimit: checkpoint.targetLimit,
      startedAt: Date.now(),
      sessionAbortController,
      activeSessions: this.activeSessions,
      activeSessionControllers: this.activeSessionControllers,
      activeSessionEvents: this.activeSessionEvents,
      cancelledSessions: this.cancelledSessions,
      searchSpec: checkpoint.searchSpec,
      initialCheckpoint: checkpoint,
      listener
    });
  }
}

export const discoveryEngine = new DiscoverySessionEngine();
