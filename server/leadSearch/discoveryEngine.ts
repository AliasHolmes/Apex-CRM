import crypto from "crypto";
import {
  LEAD_STAGE_SET as leadStages,
  REVIEW_STATUS_SET as reviewStatuses,
  NEXT_ACTION_SET as nextActions,
} from "../../src/types.js";
import {
  buildProfileDedupeKeys,
  hasDuplicateProfile,
  normalizeDedupeValue,
  getProfileDomain,
  getLinkedInHandle,
} from "../../src/utils/leadDedupe.js";

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
  readResumableMiningSessions,
  getProspectContractCache,
  upsertProspectContractCache,
} from "../db.js";
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
  type LLMUsage,
} from "../services/llm.js";
import {
  BRIGHTDATA_SCRAPE_BATCH_MAX_URLS,
  chunkBrightDataBatchItems,
  closeBrightDataClient,
  getBrightDataStatus,
  getBrightDataCapabilities,
  isBrightDataConfigured,
  probeBrightDataRecovery,
  scrapeAsMarkdown,
  scrapeBatchAsMarkdown,
  brightDataSearch,
  type BrightDataSearchOptions,
  type BrightDataSearchResult,
  shouldAttemptBrightData,
  classifyBrightDataError,
  executeBrightDataSearchWithRetry,
  isBrightDataRetryableError,
} from "../services/brightdata.js";
import {
  buildTavilyEvidence,
  extractLinkedInUsername,
  normalizeLinkedInUrl,
  parseLinkedInEvidence,
} from "../services/linkedinEvidence.js";
import {
  computeScoreBreakdown,
  rankLeadForFinalSelection,
  type EvidenceQuality,
  type LeadSourceProvider,
} from "./scoring.js";
import { SignalStore } from "./signalStore.js";
import { createLeadEvidence, inferTavilyEvidenceQuality } from "./evidence.js";
import {
  normalizeQueryPlanItems,
  toLinkedInSearchQuery,
  type ProviderRunStats,
  type QueryRunStats,
  type SearchQueryPlanItem,
} from "./strategist.js";
import {
  incrementRejection,
  mapBrightDataRejection,
  type RejectionReason,
} from "./rejections.js";
import { verifyDecisionMakerFromEvidence } from "./verification.js";
import { runIntentEnrichment } from "./intentEnrichment.js";
import { enrichLeadProfile } from "./profileEnrichment.js";
import {
  MiningTelemetryRecorder,
  estimateLLMCostUsd,
  getLLMRouteLabel,
  summarizeContractClassification,
  type MiningTraceEvent,
  type TargetEffortStats,
  type FinalistJudgeStats,
} from "./telemetry.js";
import {
  buildFallbackQueryPlan as buildScoutFallbackQueryPlan,
  buildFallbackSearchSpec,
  buildRetrievalTasks,
  buildSearchSpecPrompt,
  buildStrategistPrompt as buildScoutStrategistPrompt,
  normalizeSearchSpec,
  type DiscoveryMode,
  type SearchSpec,
} from "./searchSpec.js";
import {
  ScoutFreeTierBudget,
  brightDataFreeTierCapabilities,
  tavilyFreeTierCapabilities,
  isProviderCreditReservationEnabled,
} from "./freeTier.js";
import {
  resolveDiscoveryProviderMode,
  resolveBrightDataSearchMode,
  shouldRunTavilyForTask,
  shouldRunBrightDataForTask,
} from "./discoveryRouting.js";
import { executePlanStage } from "./stages/planStage.js";
import { executeRetrieveStage } from "./stages/retrieveStage.js";
import { executeFuseStage } from "./stages/fuseStage.js";
import {
  executeExtractStage,
  type EvidenceMeta,
} from "./stages/extractStage.js";
import { executeVerifyStage } from "./stages/verifyStage.js";
import { executeEnrichStage } from "./stages/enrichStage.js";
import { executeJudgeStage } from "./stages/judgeStage.js";
import { executeSelectStage } from "./stages/selectStage.js";
import { executePersistStage } from "./stages/persistStage.js";
import type {
  SessionConfig,
  PipelineSessionState,
  PipelinePorts,
  SessionContext,
  MiningSessionCheckpoint,
} from "./pipelineTypes.js";
import { LeadQueryRunTracker } from "./pipelineTypes.js";
import { fuseObservations, type ScoutObservation } from "./observations.js";
import { buildScoutEvidence, selectDiversifiedLeads } from "./scoutScoring.js";
import {
  chunkEvidenceBlocksByTokenBudget,
  estimateTokenCount,
  fitOutputTokenBudget,
} from "./llmBudget.js";
import {
  buildDeterministicProspectContract,
  buildProspectContractPrompt,
  buildRecoveryQueryPrompt,
  enforceContractQueries,
  normalizeProspectContract,
  prospectContractSchema,
  PROSPECT_CONTRACT_POLICY_VERSION,
  searchSpecFromProspectContract,
  type ProspectContract,
} from "./prospectContract.js";
import {
  FINALIST_JUDGE_SYSTEM_PROMPT,
  buildFinalistJudgePrompt,
  finalistCandidateFromLead,
  finalistJudgeSchema,
  partitionCandidatesByStrictEvidence,
  validateFinalistJudgments,
  type FinalistCandidate,
} from "./finalistJudge.js";
import { buildRoundDiagnostics } from "./roundDiagnostics.js";
import {
  buildCollectionCapacity,
  shouldKeepCollectingAfterStall,
} from "./collectionCapacity.js";
import { scheduleAdaptiveRetrievalTasks } from "./adaptiveScheduler.js";
import { runProviderQueue } from "./providerQueue.js";
import { runLinkedInPostIntentEnrichment } from "./linkedinPostIntent.js";
import {
  effectiveScore as sharedEffectiveScore,
  buildFallbackEvidence,
  findEvidenceForLead,
  incrementCounter,
  sleepWithAbort,
  buildCheckpointEvidence,
  computeEarlyStopThreshold,
  clampEnvFloat,
  clampEnvInt,
  type SessionEvidenceMeta,
} from "./sessionHelpers.js";

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
  persistence?: {
    createdCount: number;
    updatedCount: number;
    duplicateCount: number;
  };
  persistenceStatus?: "complete" | "partial" | "failed";
  sandboxMode?: boolean;
  stopReason?: string;
  cancelled?: boolean;
}

export function candidateStableId(
  lead: Record<string, any>,
  rawUrl?: string,
): string {
  const url =
    rawUrl ||
    lead.contactDetails?.linkedinUrl ||
    lead.profile?.contactDetails?.linkedinUrl ||
    lead.sourceUrl ||
    lead.profile?.sourceUrl ||
    lead.url ||
    "";
  const username = extractLinkedInUsername(url);
  if (username) return `linkedin:${username.toLowerCase()}`;
  const normalizedUrl = normalizeLinkedInUrl(url);
  if (normalizedUrl && normalizedUrl.includes("linkedin.com/in/"))
    return `url:${normalizedUrl.toLowerCase()}`;
  const name = normalizeDedupeValue(lead.fullName || lead.profile?.fullName);
  const company = normalizeDedupeValue(
    lead.currentCompany || lead.company || lead.profile?.currentCompany,
  );
  if (name && company) return `text:${name}@${company}`;
  if (name) return `text:${name}`;
  return `id:${crypto.randomUUID()}`;
}

// Canonical candidate-to-lead mapping lives in leadMapping.ts; re-exported here
// so checkpoint persistence and existing tests share one implementation.
export { mapCandidateToPersistedLead } from "./leadMapping.js";

import { mapCandidateToPersistedLead } from "./leadMapping.js";

export type ExecuteDiscoveryOptions = {
  sessionId: string;
  promptQuery: string;
  requestedLimit: number;
  startedAt: number;
  sessionAbortController: AbortController;
  activeSessions: Map<string, string[]>;
  activeSessionLogTotals?: Map<string, number>;
  activeSessionControllers: Map<string, AbortController>;
  activeSessionEvents: Map<string, MiningTelemetryRecorder>;
  cancelledSessions: Set<string>;
  searchSpec?: SearchSpec;
  discoveryMode?: DiscoveryMode;
  discoveryProviderMode?: string;
  excludeList?: string[];
  savedSearchId?: string;
  initialCheckpoint?: MiningSessionCheckpoint;
  listener?: DiscoveryEventListener;
};

export async function executeDiscoverySession(
  options: ExecuteDiscoveryOptions,
): Promise<DiscoveryResult> {
  const {
    sessionId,
    promptQuery,
    requestedLimit,
    startedAt,
    sessionAbortController,
    activeSessions,
    activeSessionLogTotals,
    activeSessionControllers,
    activeSessionEvents,
    cancelledSessions,
  } = options;

  const sessionLogs: string[] = [];
  const debugLogs: any[] = [];
  const throwIfCancelled = () => {
    if (
      !cancelledSessions.has(sessionId) &&
      !sessionAbortController.signal.aborted
    )
      return;
    const error = new Error("Lead discovery was cancelled.");
    error.name = "AbortError";
    throw error;
  };
  const structuredLogs =
    String(process.env.APEX_STRUCTURED_LOGS || "")
      .trim()
      .toLowerCase() === "true";
  const logEvent = (msg: string) => {
    throwIfCancelled();
    const line = structuredLogs
      ? JSON.stringify({ ts: new Date().toISOString(), sessionId, msg })
      : `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    sessionLogs.push(line);
    if (activeSessionLogTotals) {
      activeSessionLogTotals.set(
        sessionId,
        (activeSessionLogTotals.get(sessionId) || 0) + 1,
      );
    }
    // Bound session log memory for very long sessions (last 1,500 lines kept).
    if (sessionLogs.length > 1500) {
      sessionLogs.splice(0, sessionLogs.length - 1500);
    }
    activeSessions.set(sessionId, sessionLogs);
    if (options.listener?.onLog) options.listener.onLog(line);
  };

  let generatedQueries: string[] = [];
  let rawResultsCount = 0;
  let leadsFound = 0;
  if (!promptQuery || promptQuery.length > 2_000) {
    throw new Error(
      "query must be a non-empty string of 2,000 characters or fewer.",
    );
  }
  const telemetry = new MiningTelemetryRecorder(
    sessionId,
    promptQuery,
    requestedLimit,
    new Date(startedAt).toISOString(),
  );
  upsertMiningSession({
    id: sessionId,
    status: "running",
    prompt: promptQuery,
    requestedLimit,
    startedAt: new Date(startedAt).toISOString(),
  });
  activeSessionControllers.set(sessionId, sessionAbortController);
  // Store the recorder reference once (not per-event array copies) so live
  // trace consumers read the bounded internal buffer directly.
  activeSessionEvents.set(sessionId, telemetry);
  const recordTrace = (
    event: Omit<MiningTraceEvent, "id" | "timestamp"> & { timestamp?: string },
  ) => {
    const recorded = telemetry.record(event);
    if (options.listener?.onTraceEvent) {
      try {
        options.listener.onTraceEvent(recorded);
      } catch (err) {
        console.warn(
          `[find-leads] ${sessionId}: listener.onTraceEvent threw error:`,
          err,
        );
      }
    }
    return recorded;
  };
  const traceLogFields = () => {
    const trace = telemetry.getTrace();
    // Size guard: trace_events can reach megabytes on long sessions. If the
    // serialized payload exceeds ~2MB, persist summary fields only - the
    // summaries (provider/cost/phase) carry the aggregate signal anyway.
    let events = trace.events;
    if (JSON.stringify(events).length > 2_000_000) {
      console.warn(
        `[find-leads] ${sessionId}: trace_events exceeded 2MB; persisting summary-only.`,
      );
      events = [];
    }
    return {
      traceEvents: events,
      providerSummary: trace.providerSummary,
      costSummary: trace.costSummary,
      phaseTimeline: trace.phaseTimeline,
      schemaVersion: trace.schemaVersion,
    };
  };
  const safeInsertSearchLog = (
    entry: Parameters<typeof insertSearchLog>[0],
  ) => {
    try {
      insertSearchLog({ ...entry, ...traceLogFields() });
    } catch (error) {
      console.warn(
        "[find-leads] failed to write search log:",
        error instanceof Error ? error.message : String(error),
      );
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
    usage?: LLMUsage,
  ) => {
    const route = getLLMRouteLabel();
    const successfulAttempt = providerAttempts.find(
      (attempt) => attempt.status === "success",
    );
    const inputTokens = usage ? usage.inputTokens : estimateTokens(promptText);
    const outputTokens = usage
      ? usage.outputTokens
      : estimateTokens(
          typeof output === "string" ? output : JSON.stringify(output || ""),
        );
    return {
      purpose,
      model: usage?.model || successfulAttempt?.model || route.model,
      route: usage?.provider || successfulAttempt?.provider || route.route,
      fallbackUsed: providerAttempts.some(
        (attempt) => attempt.status === "error" || attempt.status === "skipped",
      ),
      providerAttempts,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCostUsd: estimateLLMCostUsd(inputTokens, outputTokens),
      parseRetries,
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
    probesSucceeded: 0,
    rejectionReasons: {} as Record<string, number>,
    failureReasons: {} as Record<string, number>,
  };

  const trackableBrightDataSearch = async (
    query: string,
    options: BrightDataSearchOptions = {},
    phaseLabel: string = "search",
  ): Promise<BrightDataSearchResult[]> => {
    brightDataStats.searchAttempted++;
    const results = await brightDataSearch(query, {
      ...options,
      onEngineAttempt: (engine) => {
        if (engine === "google") brightDataStats.searchGoogleAttempted++;
        else if (engine === "bing") brightDataStats.searchBingAttempted++;
        options.onEngineAttempt?.(engine);
      },
      onBingFallback: (evt) => {
        brightDataStats.searchBingRecovered++;
        if (options.onBingFallback) {
          options.onBingFallback(evt);
        } else {
          logEvent(
            `[Search Fallback] [${phaseLabel}] Google SERP challenged; Bing fallback rescued ${evt.resultsCount} result(s) for "${query}".`,
          );
        }
      },
    });

    brightDataStats.searchSucceeded++;
    const isBing = results.some((r) => r.sourceEngine === "bing");
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
    stopReason: "not_started",
    rejectionReasons: {} as Record<string, number>,
    queryRuns: [] as QueryRunStats[],
    brightData: brightDataStats,
    sourceProvider: "tavily" as "tavily" | "brightdata_search" | "mixed",
    brightDataSearchResults: 0,
    scout: {
      mode: "person_first" as DiscoveryMode,
      maxPerCompany: 2,
      spec: null as SearchSpec | null,
      contract: null as any,
      discoveryProviderMode: "hybrid" as string,
      brightDataSearchMode: "primary" as string,
      creditReservation: "disabled" as string,
      freeTier: {} as Record<string, unknown>,
      lightweightEvidenceUpgrades: 0,
      brightDataEvidenceUpgrades: 0,
      adaptiveScheduler: null as null | {
        active: boolean;
        totalOutcomeRuns: number;
        selected: string[];
        deferred: string[];
      },
    },
    rerank: {
      poolTarget: 0,
      poolSize: 0,
      returned: 0,
    },
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
  const hasDuplicateKeys = (profile: any, existingKeys: Set<string>) =>
    hasDuplicateProfile(profile || {}, existingKeys);
  const addProfileKeys = (profile: any, existingKeys: Set<string>) => {
    profileKeys(profile).forEach((key) => existingKeys.add(key));
  };

  const fallbackEvidenceForLead = (lead: any): SessionEvidenceMeta =>
    buildFallbackEvidence(lead, promptQuery, stats.rounds || 1);

  const effectiveScore = sharedEffectiveScore;

  const acceptedLeads: any[] = [];
  let persistedCount = 0;
  const persistedLeadIds = new Set<string>();

  try {
    throwIfCancelled();
    logEvent(`--- NEW ADAPTIVE MINING SESSION: ${sessionId} ---`);
    recordTrace({
      phase: "session",
      operation: "start",
      status: "started",
      provider: "system",
      counts: { requested: stats.requested },
      metadata: { queryLength: String(promptQuery || "").length },
    });
    safeInsertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries: [],
      status: "running",
      errorMessage: "",
      rawResultsCount: 0,
      leadsFound: 0,
      detailedLogs: sessionLogs.join("\n"),
      debugLogs: JSON.stringify(debugLogs),
    });

    const query = promptQuery;
    const excludeList = options.excludeList || [];
    if (!query) throw new Error("Search criteria/query is required");
    if (!hasOpenAIKey())
      throw new Error(
        "No LLM API key configured. Add BYESU_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY to your .env file.",
      );

    const targetLimit = stats.requested;
    const rerankPoolMultiplier = process.env.LEAD_SEARCH_RERANK_POOL_MULTIPLIER
      ? Math.min(
          Math.max(
            Number(process.env.LEAD_SEARCH_RERANK_POOL_MULTIPLIER),
            1,
          ),
          5,
        )
      : undefined;

    const requestedMode = [
      "person_first",
      "account_first",
      "signal_first",
      "local_business",
    ].includes(
      options.discoveryMode || options.discoveryProviderMode || "person_first",
    )
      ? ((options.discoveryMode ||
          options.discoveryProviderMode ||
          "person_first") as DiscoveryMode)
      : "person_first";

    let searchSpec = normalizeSearchSpec(options.searchSpec, query);
    if (!options.searchSpec) {
      searchSpec = buildFallbackSearchSpec(query, requestedMode);
      const specStarted = Date.now();
      try {
        searchSpec = normalizeSearchSpec(
          await openAIStructured(
            buildSearchSpecPrompt(query),
            searchSpecSchema,
            STRATEGIST_SYSTEM_PROMPT,
            {
              maxTokens: 700,
              temperature: 0,
              signal: sessionAbortController.signal,
            },
          ),
          query,
        );
        recordTrace({
          phase: "strategy",
          operation: "search_spec_compile",
          status: "success",
          provider: "llm",
          latencyMs: Date.now() - specStarted,
          metadata: { mode: searchSpec.mode },
        });
      } catch (error: any) {
        logEvent(
          `WARN: Search-spec compiler failed: ${error.message || String(error)}. Using deterministic spec.`,
        );
        recordTrace({
          phase: "strategy",
          operation: "search_spec_compile",
          status: "error",
          provider: "llm",
          latencyMs: Date.now() - specStarted,
          error: { message: error.message || String(error) },
        });
      }
    }

    // Build deterministic contract first as fallback (or restore from checkpoint).
    const fallbackContract =
      options.initialCheckpoint?.contract ||
      buildDeterministicProspectContract(query, searchSpec);

    // Compile contract using LLM if OpenAI/Byesu key is configured and not resuming from existing contract.
    let contract = options.initialCheckpoint?.contract || fallbackContract;
    if (!options.initialCheckpoint?.contract) {
      const cacheKey = query.trim().toLowerCase();
      const cached = getProspectContractCache(cacheKey, PROSPECT_CONTRACT_POLICY_VERSION);
      if (cached) {
        contract = cached;
        logEvent(
          `Hydrated prospect quality contract v${contract.policyVersion} from contract cache.`,
        );
      } else if (hasOpenAIKey()) {
        const contractStarted = Date.now();
        const contractPrompt = buildProspectContractPrompt(query);
        try {
          const compiled = await openAIStructured<any>(
            contractPrompt,
            prospectContractSchema,
            `You are an expert B2B lead generation strategist. Compile the targeting contract.`,
            {
              maxTokens: 1800,
              temperature: 0,
              signal: sessionAbortController.signal,
            },
          );
          contract = normalizeProspectContract(compiled, query, fallbackContract);
          const hardCount = contract.requirements.filter(
            (req) => req.importance === "hard",
          ).length;
          logEvent(
            `Compiled prospect quality contract v${contract.policyVersion} with ${hardCount} hard requirements.`,
          );
          upsertProspectContractCache(cacheKey, query, PROSPECT_CONTRACT_POLICY_VERSION, contract);
        } catch (err: any) {
          logEvent(
            `WARN: Prospect contract compiler failed: ${err.message || String(err)}. Using deterministic contract.`,
          );
        }
      }
    }
    stats.scout.contract = contract;

    // Record contract classification telemetry (Phase 1)
    const taxonomySummary = summarizeContractClassification(contract);
    recordTrace({
      phase: "strategy",
      provider: "system",
      operation: "contract_taxonomy_classification",
      query: "contract.taxonomy.classification",
      status: "info",
      metadata: taxonomySummary,
    });

    // Apply contract synonyms to searchSpec
    searchSpec = searchSpecFromProspectContract(searchSpec, contract);

    const contractHardCount = contract.requirements.filter(
      (req) => req.importance === "hard",
    ).length;
    let collectionCapacity = buildCollectionCapacity({
      targetLimit,
      poolMultiplier: rerankPoolMultiplier,
      poolMax: Math.max(
        Number(process.env.LEAD_SEARCH_RERANK_POOL_MAX || 240),
        targetLimit,
      ),
      baseRounds: Number(process.env.LEAD_SEARCH_BASE_ROUNDS || 4),
      contractHardReqCount: contractHardCount,
      maxRoundsCap:
        Number(process.env.LEAD_SEARCH_MAX_ROUNDS || 0) || undefined,
    });
    let rerankPoolTarget = collectionCapacity.rerankPoolTarget;
    stats.rerank.poolTarget = rerankPoolTarget;
    let maxRounds = collectionCapacity.maxRounds;
    if (collectionCapacity.poolCapped) {
      logEvent(
        `Requested ${targetLimit} prospects exceeds the ${collectionCapacity.rerankPoolTarget}-candidate evidence-pool safety cap; continuing on a best-effort basis.`,
      );
    }

    const minScore = Math.min(
      Math.max(Number(process.env.LEAD_SEARCH_MIN_SCORE || 6), 1),
      10,
    );
    const ttlDays = Math.min(
      Math.max(Number(process.env.BRIGHTDATA_CACHE_TTL_DAYS || 7), 1),
      30,
    );
    const enrichmentCap = Math.min(
      Math.max(
        Number(process.env.BRIGHTDATA_ENRICHMENT_CAP || 0) ||
          Math.max(targetLimit * 3, 20),
        1,
      ),
      500,
    );
    // Default 15-minute safety timeout for synchronous sessions; set
    // LEAD_SEARCH_TIMEOUT_MS=0 to disable entirely.
    const safetyTimeoutMs =
      process.env.LEAD_SEARCH_TIMEOUT_MS !== undefined &&
      process.env.LEAD_SEARCH_TIMEOUT_MS !== ""
        ? Number(process.env.LEAD_SEARCH_TIMEOUT_MS) || 0
        : 15 * 60 * 1000;

    const discoveryProviderMode = resolveDiscoveryProviderMode({
      brightDataConfigured: isBrightDataConfigured(),
      tavilyConfigured: hasTavilyKey(),
    });
    const brightDataSearchMode = resolveBrightDataSearchMode({
      discoveryMode: discoveryProviderMode,
    });
    const configuredBrightDataSearchRetryMax = Number(
      process.env.BRIGHTDATA_SEARCH_RETRY_MAX ?? 1,
    );
    const brightDataSearchRetryMax = Number.isFinite(
      configuredBrightDataSearchRetryMax,
    )
      ? Math.min(Math.max(Math.floor(configuredBrightDataSearchRetryMax), 0), 2)
      : 1;
    const configuredBrightDataSearchRetryDelay = Number(
      process.env.BRIGHTDATA_SEARCH_RETRY_BASE_DELAY_MS ?? 750,
    );
    const brightDataSearchRetryBaseDelayMs = Number.isFinite(
      configuredBrightDataSearchRetryDelay,
    )
      ? Math.min(
          Math.max(Math.floor(configuredBrightDataSearchRetryDelay), 0),
          10_000,
        )
      : 750;
    const profileConcurrency = Math.max(
      Number(process.env.BRIGHTDATA_PROFILE_CONCURRENCY || 1),
      1,
    );
    const profileMaxPerSearch = Math.max(
      Number(process.env.BRIGHTDATA_PROFILE_MAX_PER_SEARCH || 0) ||
        Math.max(targetLimit * 2, 10),
      0,
    );
    const companyIntentEnabled =
      process.env.BRIGHTDATA_COMPANY_INTENT_ENABLED === "true";
    const companyIntentMinScore = Math.min(
      Math.max(Number(process.env.BRIGHTDATA_COMPANY_INTENT_MIN_SCORE || 8), 1),
      10,
    );
    const companyIntentMaxPerSearch = Math.max(
      Number(process.env.BRIGHTDATA_COMPANY_INTENT_MAX_PER_SEARCH || 3),
      0,
    );
    const linkedinPostIntentEnabled =
      String(process.env.LINKEDIN_POST_INTENT_ENABLED || "").toLowerCase() !==
      "false";
    // Default to on_demand profile enrichment (search snippet grounding + public company site probing)
    const profileEnrichmentStage =
      process.env.BRIGHTDATA_PROFILE_ENRICHMENT_STAGE || "on_demand";

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
      creditReservation: creditReservationEnabled ? "enabled" : "disabled",
      freeTier: {
        tavily: tavilyCapabilities,
        brightData: brightDataCapabilities,
        session: freeTierBudget.snapshot(),
      },
      lightweightEvidenceUpgrades: 0,
      brightDataEvidenceUpgrades: 0,
      adaptiveScheduler: null,
    };
    logEvent(
      `Discovery mode=${discoveryProviderMode}, Bright Data search=${brightDataSearchMode}, creditReservation=${creditReservationEnabled ? "enabled" : "disabled (key rotation)"}.`,
    );

    const expiredRows = pruneExpiredEnrichmentCache();
    if (expiredRows > 0)
      logEvent(`Pruned ${expiredRows} expired enrichment cache rows.`);

    const existingKeys = readExistingIdentityKeys();
    const excludedValues = new Set<string>();
    for (const exclusion of excludeList) {
      const normalized = normalizeDedupeValue(exclusion);
      if (!normalized) continue;
      excludedValues.add(normalized);
      if (normalized.startsWith("linkedin:")) {
        existingKeys.add(normalized);
        const handle = normalized.slice("linkedin:".length);
        if (handle) excludedValues.add(handle);
      } else if (normalized.startsWith("email:")) {
        existingKeys.add(normalized);
        const email = normalized.slice("email:".length);
        if (email) excludedValues.add(email);
      } else {
        existingKeys.add(`email:${normalized}`);
        if (normalized.includes("linkedin.com/in/")) {
          const user = extractLinkedInUsername(normalized);
          if (user) {
            existingKeys.add(`linkedin:${user}`);
            excludedValues.add(`linkedin:${user}`);
            excludedValues.add(user);
          }
        }
        existingKeys.add(`name:${normalized}`);
      }
    }

    const matchesExcludeList = (lead: any) => {
      if (excludedValues.size === 0) return false;
      const name = normalizeDedupeValue(lead?.fullName);
      const email = normalizeDedupeValue(lead?.contactDetails?.email);
      const linkedin = normalizeDedupeValue(lead?.contactDetails?.linkedinUrl);
      const username = extractLinkedInUsername(
        lead?.contactDetails?.linkedinUrl || "",
      );
      const canonicalKey = username ? `linkedin:${username}` : "";
      for (const exclusion of excludedValues) {
        if (email && email === exclusion) return true;
        if (
          linkedin &&
          (linkedin === exclusion || linkedin.includes(exclusion))
        )
          return true;
        if (name && name === exclusion) return true;
        if (username && (username === exclusion || exclusion === canonicalKey))
          return true;
      }
      return false;
    };

    const checkpointAcceptedLeads = (candidates: any[], stageLabel: string) => {
      if (!candidates || candidates.length === 0) return;
      const persistStart = Date.now();
      try {
        const mapped = candidates.map((c) => mapCandidateToPersistedLead(c));
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
          phase: "persistence",
          operation: "checkpoint_leads",
          status: "success",
          provider: "sqlite",
          latencyMs: Date.now() - persistStart,
          counts: { candidates: candidates.length, persistedCount },
          metadata: { checkpointStage: stageLabel },
        });
        logEvent(
          `[Checkpoint] Auto-persisted ${candidates.length} leads (${stageLabel}).`,
        );
      } catch (err: any) {
        console.warn(
          `[Checkpoint] Warning: incremental checkpoint failed at ${stageLabel}:`,
          err,
        );
        recordTrace({
          phase: "persistence",
          operation: "checkpoint_leads",
          status: "error",
          provider: "sqlite",
          latencyMs: Date.now() - persistStart,
          error: { message: err.message || String(err) },
          metadata: { checkpointStage: stageLabel },
        });
      }
    };
    const leadQueryRuns = new LeadQueryRunTracker();
    const seenCandidateKeys = new Set<string>();
    const seenQueryTexts = new Set<string>();
    const evidenceByUrl = new Map<string, EvidenceMeta>();
    const getEvidenceForLead = (lead: any): EvidenceMeta =>
      findEvidenceForLead(lead, evidenceByUrl) || fallbackEvidenceForLead(lead);
    let brightDataReady = shouldAttemptBrightData();
    let brightDataProviderDisabled = !brightDataReady;
    let brightDataToolDegraded = false;
    let brightDataTransportRetryAfter = 0;
    const urlRetryQueue = new Set<string>();
    let previousRoundSummary: Record<string, any> = {};
    const llmCircuitBreaker = createLLMSessionCircuitBreaker(
      Number(process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD || 2),
    );
    const failedExtractionRoundsBeforeStop = Math.min(
      Math.max(
        Number(process.env.LEAD_EXTRACTION_FAILURE_ROUNDS_BEFORE_STOP || 2),
        1,
      ),
      4,
    );
    let consecutiveFailedExtractionRounds = 0;

    if (!brightDataReady) {
      const status = getBrightDataStatus();
      brightDataProviderDisabled =
        status.health === "provider_disabled" ||
        status.health === "unconfigured";
      logEvent(
        isBrightDataConfigured()
          ? "Bright Data is temporarily unavailable. Continuing with cache/Tavily fallbacks."
          : "Bright Data token not configured. Continuing Tavily-only.",
      );
    }

    let consecutiveStalledRounds = 0;
    let providerImpairedStallRounds = 0;
    let acceptedCountBeforeRound = 0;
    const defaultJudgePassRate = clampEnvFloat(
      "LEAD_JUDGE_PASS_RATE_ASSUMPTION",
      0.7,
      0.3,
      1.0,
    );

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
      extractionConcurrency: Math.min(
        Math.max(Number(process.env.LEAD_EXTRACTION_CONCURRENCY || 2), 1),
        4,
      ),
      judgeConcurrency: Math.min(
        Math.max(Number(process.env.FINALIST_JUDGE_CONCURRENCY || 3), 1),
        6,
      ),
    };

    // Delta-serialization cursor: how many queryRuns previous checkpoints
    // already captured. Checkpoints serialize only the tail beyond this.
    let checkpointedQueryRunCount = 0;

    const initialSignalStore = SignalStore.fromJSON(
      options.initialCheckpoint?.signalStoreState,
    );

    const sessionState: PipelineSessionState = {
      round: 1,
      seenCandidateKeys,
      existingKeys,
      queryRuns: stats.queryRuns,
      acceptedLeads,
      qualifiedLeads,
      finalLeads: [],
      rejectionCounts: stats.rejectionReasons,
      brightDataStats,
      freeTierBudget,
      llmCircuitBreaker,
      abortController: sessionAbortController,
      telemetry,
      debugLogs,
      urlRetryQueue,
      previousRoundSummary,
      signalStore: initialSignalStore,
      recoveryAttempts: Number(
        options.initialCheckpoint?.recoveryAttempts || 0,
      ),
    };

    const pipelinePorts: PipelinePorts = {
      brightDataSearch: (q, opts, label) =>
        trackableBrightDataSearch(q, opts, label),
      tavilySearch: (q, opts) => tavilySearch(q, opts),
      scrapeMarkdown: (url) => scrapeAsMarkdown(url),
      scrapeBatchMarkdown: (urls) => scrapeBatchAsMarkdown(urls),
    };

    const sessionCtx: SessionContext = {
      config: sessionConfig,
      state: sessionState,
      ports: pipelinePorts,
      logEvent,
      recordTrace,
    };

    if (options.initialCheckpoint) {
      const cp = options.initialCheckpoint;
      logEvent(
        `[Resume] Resuming session ${sessionId} from round ${cp.round} (${(cp.acceptedLeads || []).length} accepted leads).`,
      );
      stats.rounds = cp.round;
      // Restore query runs from either format: legacy checkpoints carry the
      // full array in `queryRuns`; delta checkpoints carry only new runs in
      // `queryRunsDelta`. Both merge through the same dedupe guard.
      const restoredRuns = [
        ...(Array.isArray(cp.queryRuns) ? cp.queryRuns : []),
        ...(Array.isArray(cp.queryRunsDelta) ? cp.queryRunsDelta : []),
      ];
      if (restoredRuns.length > 0) {
        // Guard against double-counting when a checkpoint was saved twice at the
        // same round boundary (crash between checkpoint write and next stage).
        const restoredKeys = new Set(
          stats.queryRuns.map((run) => `${run.round}:${run.query}`),
        );
        for (const run of restoredRuns) {
          const key = `${run.round}:${run.query}`;
          if (restoredKeys.has(key)) continue;
          restoredKeys.add(key);
          stats.queryRuns.push(run);
          if (run.query) seenQueryTexts.add(run.query);
        }
      }
      // Replace (not merge) counters so a re-saved checkpoint at the same
      // boundary cannot double rejection/failure tallies.
      stats.rejectionReasons = { ...(cp.rejectionCounts || {}) };
      sessionState.rejectionCounts = stats.rejectionReasons;
      if (brightDataStats.failureReasons) {
        brightDataStats.failureReasons = { ...(cp.failureCounts || {}) };
      }
      if (cp.brightDataStats)
        Object.assign(brightDataStats, cp.brightDataStats);
      if (cp.previousRoundSummary)
        previousRoundSummary = cp.previousRoundSummary;
      if (Array.isArray(cp.acceptedLeads)) {
        for (const lead of cp.acceptedLeads) {
          acceptedLeads.push(lead);
          buildProfileDedupeKeys(lead).forEach((k) => existingKeys.add(k));
          // Tier-B rebuild (ADR-0002): re-seed seen-candidate keys so resumed
          // rounds cannot re-extract candidates already collected pre-crash.
          const linkedinUrl =
            lead?.contactDetails?.linkedinUrl || lead?.sourceUrl || "";
          const username = extractLinkedInUsername(linkedinUrl);
          if (username) {
            seenCandidateKeys.add(`linkedin:${username}`);
            seenCandidateKeys.add(username);
          }
          const normalized = normalizeLinkedInUrl(linkedinUrl);
          if (normalized) seenCandidateKeys.add(normalized);
        }
      }
      if (Array.isArray(cp.qualifiedLeads)) {
        qualifiedLeads.push(...cp.qualifiedLeads);
      }
      if (cp.evidenceByUrl && typeof cp.evidenceByUrl === "object") {
        for (const [url, meta] of Object.entries(cp.evidenceByUrl)) {
          evidenceByUrl.set(url, meta as EvidenceMeta);
        }
      }
      if (cp.leadQueryRunMap) {
        leadQueryRuns.fromJSON(cp.leadQueryRunMap);
      }
      // Restore crash-time debug context so post-resume diagnostics retain
      // what happened before the interruption.
      if (Array.isArray(cp.debugLogsTail) && cp.debugLogsTail.length > 0) {
        debugLogs.push(...cp.debugLogsTail.slice(-100));
      }
    }

    const isResumingAtJudging = options.initialCheckpoint?.stage === "judge";
    const skipCollection = isResumingAtJudging;
    const initialRound =
      options.initialCheckpoint?.round &&
      options.initialCheckpoint.stage === "enrich"
        ? options.initialCheckpoint.round + 1
        : options.initialCheckpoint?.round || 1;

    let nextPlanPromise: Promise<any> | null = null;
    let speculativeAbortController: AbortController | null = null;
    const planningGeneration = { value: 0 };
    let lastRecoveryProbeAt = 0;

    if (skipCollection) {
      logEvent(
        `Resuming session directly at Finalist Judging stage with ${acceptedLeads.length} checkpointed candidate leads and restored evidence map.`,
      );
    } else {
      for (
        let round = initialRound;
        round <= maxRounds && acceptedLeads.length < rerankPoolTarget;
        round++
      ) {
        if (safetyTimeoutMs > 0 && Date.now() - startedAt > safetyTimeoutMs) {
          stats.stopReason = "timeout";
          break;
        }

        // Proactive Bright Data recovery: once cooldown expires, probe with a
        // minimal search instead of waiting for the next real task to fail.
        if (
          brightDataProviderDisabled &&
          isBrightDataConfigured() &&
          Date.now() - lastRecoveryProbeAt > 60_000
        ) {
          lastRecoveryProbeAt = Date.now();
          const recovered = await probeBrightDataRecovery().catch(() => false);
          if (recovered) {
            brightDataProviderDisabled = false;
            brightDataReady = true;
            brightDataStats.probesSucceeded =
              (brightDataStats.probesSucceeded || 0) + 1;
            logEvent(
              "Bright Data recovered via proactive recovery probe; re-enabling lane.",
            );
          }
        }

        stats.rounds = round;
        sessionState.round = round;
        sessionState.previousRoundSummary = previousRoundSummary;
        acceptedCountBeforeRound = acceptedLeads.length;
        const remaining = Math.max(rerankPoolTarget - acceptedLeads.length, 0);

        const currentGen = planningGeneration.value;
        const planResult = nextPlanPromise
          ? await nextPlanPromise
          : await executePlanStage(sessionCtx, {
              round,
              remaining,
              generatedQueries,
              seenQueryTexts,
              searchSpec,
              discoveryProviderMode,
              stats,
              generation: currentGen,
            });
        nextPlanPromise = null;
        speculativeAbortController = null;

        if (planResult.stopReason) {
          stats.stopReason = planResult.stopReason;
          break;
        }

        // Commit scheduler state and debug logs from the accepted plan
        if (planResult.adaptiveSchedulerState) {
          stats.scout.adaptiveScheduler = planResult.adaptiveSchedulerState;
        }
        if (
          Array.isArray(planResult.debugLogs) &&
          planResult.debugLogs.length > 0
        ) {
          debugLogs.push(...planResult.debugLogs);
        }

        // Commit queries from the accepted plan to seenQueryTexts and generatedQueries
        if (Array.isArray(planResult.proposedQueries)) {
          for (const q of planResult.proposedQueries) {
            const key = q.toLowerCase();
            seenQueryTexts.add(key);
            generatedQueries.push(q);
          }
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
          stats,
        });

        const { roundItems } = retrieveResult;
        brightDataProviderDisabled = retrieveResult.brightDataProviderDisabled;
        brightDataTransportRetryAfter =
          retrieveResult.brightDataTransportRetryAfter;

        // Fuse provider observations before extraction. This retains independent
        // corroboration rather than discarding Bright Data results as duplicates.
        const fuseResult = await executeFuseStage(sessionCtx, {
          round,
          roundItems,
          roundPlans,
          queryRuns,
          searchSpec,
          stats,
        });

        if (fuseResult.stopReason) {
          stats.stopReason = fuseResult.stopReason;
          break;
        }

        const { candidateItems, roundCandidateKeys } = fuseResult;
        rawResultsCount = seenCandidateKeys.size + roundCandidateKeys.size;
        stats.rawCandidates = rawResultsCount;

        // Stage Pipelining: Pre-compute plan for round N+1 speculatively in background while extract/verify/enrich execute
        if (
          round + 1 <= maxRounds &&
          acceptedLeads.length < rerankPoolTarget &&
          !previousRoundSummary?.shouldRecover
        ) {
          speculativeAbortController = new AbortController();
          const currentGen = planningGeneration.value;
          const abortSig = speculativeAbortController.signal;
          nextPlanPromise = executePlanStage(sessionCtx, {
            round: round + 1,
            remaining: Math.max(rerankPoolTarget - acceptedLeads.length, 0),
            generatedQueries: [...generatedQueries],
            seenQueryTexts: new Set(seenQueryTexts),
            searchSpec,
            discoveryProviderMode,
            stats,
            generation: currentGen,
            signal: abortSig,
            isSpeculative: true,
          })
            .then((res) => {
              if (planningGeneration.value !== currentGen) {
                return { roundPlans: [], queryRuns: [], proposedQueries: [] };
              }
              return res;
            })
            .catch((err) => {
              if (abortSig.aborted) {
                return { roundPlans: [], queryRuns: [], proposedQueries: [] };
              }
              logEvent(
                `WARN: Pipelined plan for round ${round + 1} failed: ${err.message || String(err)}`,
              );
              return { roundPlans: [], queryRuns: [], proposedQueries: [] };
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
          stats,
        });

        brightDataProviderDisabled = extractResult.brightDataProviderDisabled;
        consecutiveFailedExtractionRounds =
          extractResult.consecutiveFailedExtractionRounds;

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
          stats,
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
          searchSpec,
          brightDataProviderDisabled,
          brightDataTransportRetryAfter,
          stats,
          leadQueryRuns,
          trackableBrightDataSearch,
        });

        brightDataProviderDisabled = enrichResult.brightDataProviderDisabled;
        brightDataTransportRetryAfter =
          enrichResult.brightDataTransportRetryAfter;

        const roundRuns = stats.queryRuns.filter((run) => run.round === round);
        for (const run of roundRuns) {
          recordQueryPerformance({
            family: run.family || "general",
            lane: run.lane || "person",
            provider: run.providerPreference || "tavily",
            rawCandidates: run.rawCandidates,
            uniqueCandidates: run.uniqueCandidates,
            extractedCandidates: run.extractedLeads,
            acceptedCandidates: run.acceptedLeads,
            duplicateCandidates: Number(
              run.rejectionReasons.duplicate_existing_lead || 0,
            ),
            searchLatencyMs: run.searchLatencyMs,
            providerUnits: run.providerUnits,
          });
        }
        const roundDiagnosticsObj = buildRoundDiagnostics({
          round,
          rawCandidates: roundRuns.reduce(
            (sum, run) => sum + run.rawCandidates,
            0,
          ),
          extractedCandidates: roundRuns.reduce(
            (sum, run) => sum + run.extractedLeads,
            0,
          ),
          leads: acceptedLeads.filter(
            (lead) => lead.evidence?.sourceRound === round,
          ),
          contract,
          targetLimit,
          alreadyQualified: acceptedCountBeforeRound,
        });

        previousRoundSummary = {
          rawCandidates: roundDiagnosticsObj.rawCandidates,
          uniqueCandidates: roundRuns.reduce(
            (sum, run) => sum + run.uniqueCandidates,
            0,
          ),
          extractedLeads: roundDiagnosticsObj.extractedCandidates,
          acceptedLeads: roundRuns.reduce(
            (sum, run) => sum + run.acceptedLeads,
            0,
          ),
          viableCandidates: roundDiagnosticsObj.viableCandidates,
          shouldRecover: roundDiagnosticsObj.shouldRecover,
          missingHardRequirementIds:
            roundDiagnosticsObj.missingHardRequirementIds,
          rejectionReasons: stats.rejectionReasons,
        };

        // Invalidate speculative plan if post-judging diagnostics demand recovery
        if (
          roundDiagnosticsObj.shouldRecover &&
          (sessionState.recoveryAttempts || 0) < 2
        ) {
          planningGeneration.value++;
          if (speculativeAbortController) {
            speculativeAbortController.abort();
            speculativeAbortController = null;
          }
          nextPlanPromise = null;
          logEvent(
            `Round ${round}: shouldRecover triggered for missing criteria [${(roundDiagnosticsObj.missingHardRequirementIds || []).join(", ")}]. Speculative plan N+1 invalidated; switching to authoritative recovery plan.`,
          );
        }

        logEvent(
          `Round ${round} diagnostics: ${previousRoundSummary.viableCandidates} candidates show all hard terms; recovery=${previousRoundSummary.shouldRecover ? "needed" : "not needed"}.`,
        );
        checkpointAcceptedLeads(
          acceptedLeads.slice(acceptedCountBeforeRound),
          `round_${round}`,
        );
        saveMiningSessionCheckpoint(sessionId, {
          sessionId,
          round,
          stage: "enrich",
          promptQuery,
          targetLimit,
          contract,
          searchSpec,
          queryRuns: [],
          queryRunsDelta: stats.queryRuns.slice(checkpointedQueryRunCount),
          acceptedLeads: acceptedLeads.slice(0, 240),
          qualifiedLeads: qualifiedLeads.slice(0, 240),
          finalLeads: [],
          rejectionCounts: stats.rejectionReasons,
          failureCounts: brightDataStats.failureReasons,
          brightDataStats,
          previousRoundSummary,
          evidenceByUrl: buildCheckpointEvidence(
            evidenceByUrl,
            acceptedLeads.slice(0, 240),
          ),
          leadQueryRunMap: leadQueryRuns.toJSON(),
          debugLogsTail: debugLogs.slice(-100),
          signalStoreState: sessionState.signalStore?.toJSON(),
          recoveryAttempts: sessionState.recoveryAttempts,
          updatedAt: new Date().toISOString(),
        });
        checkpointedQueryRunCount = stats.queryRuns.length;

        // Early shortlist termination:
        // Dynamic early-stop threshold based on assumed or observed judge pass rate.
        const judgePassRateEstimate =
          Number(previousRoundSummary?.judgePassRateEstimate) ||
          defaultJudgePassRate;
        const earlyStopTargetThreshold = computeEarlyStopThreshold(
          targetLimit,
          judgePassRateEstimate,
        );
        previousRoundSummary.judgePassRateEstimate = judgePassRateEstimate;

        if (
          acceptedLeads.length >= earlyStopTargetThreshold &&
          previousRoundSummary.viableCandidates >= targetLimit &&
          (!previousRoundSummary.missingHardRequirementIds ||
            previousRoundSummary.missingHardRequirementIds.length === 0)
        ) {
          logEvent(
            `Round ${round}: Sufficient high-quality candidates (accepted=${acceptedLeads.length}, viable=${previousRoundSummary.viableCandidates}, target=${targetLimit}, earlyStopThreshold=${earlyStopTargetThreshold}, passRateEstimate=${judgePassRateEstimate}) collected with all hard criteria met. Stopping discovery loop early.`,
          );
          stats.stopReason = "target_fulfilled_early";
          break;
        }

        const lastRoundProviderImpaired =
          extractResult.consecutiveFailedExtractionRounds > 0 ||
          brightDataProviderDisabled === true ||
          (candidateItems.length === 0 &&
            brightDataStats.searchAttempted > 0 &&
            (brightDataStats.searchSucceeded || 0) === 0);

        const newAcceptedInRound =
          acceptedLeads.length - acceptedCountBeforeRound;
        if (newAcceptedInRound === 0) {
          if (lastRoundProviderImpaired) {
            providerImpairedStallRounds++;
            logEvent(
              `Round ${round}: Stalled due to provider impairment (not query exhaustion); not counting toward stall exit (${providerImpairedStallRounds}/3).`,
            );
            if (providerImpairedStallRounds >= 3) {
              logEvent(
                `Round ${round}: 3 consecutive provider-impaired rounds. Stopping discovery loop due to provider exhaustion.`,
              );
              stats.stopReason = "provider_exhausted";
              break;
            }
          } else {
            consecutiveStalledRounds++;
            const canRecover =
              Boolean(
                previousRoundSummary?.shouldRecover ||
                (previousRoundSummary?.missingHardRequirementIds?.length || 0) >
                  0,
              ) && (sessionState.recoveryAttempts || 0) < 2;

            if (consecutiveStalledRounds >= 2 && acceptedLeads.length > 0) {
              if (canRecover && round < maxRounds) {
                logEvent(
                  `Round ${round}: 2 consecutive stalled rounds, but criteria are missing and recovery attempts remain (${sessionState.recoveryAttempts}/2). Continuing to recovery plan.`,
                );
              } else if (
                shouldKeepCollectingAfterStall({
                  completedRound: round,
                  maxRounds,
                  acceptedLeads: acceptedLeads.length,
                  rerankPoolTarget,
                })
              ) {
                logEvent(
                  `Round ${round}: 2 consecutive rounds produced 0 new accepted leads. Continuing bounded collection budget (${round}/${maxRounds}) with a new retrieval plan.`,
                );
              } else {
                logEvent(
                  `Round ${round}: collection budget exhausted after ${consecutiveStalledRounds} stalled rounds with ${acceptedLeads.length} leads.`,
                );
                stats.stopReason = "max_rounds";
                break;
              }
            }
            if (consecutiveStalledRounds >= 3 && acceptedLeads.length === 0) {
              if (canRecover && round < maxRounds) {
                logEvent(
                  `Round ${round}: 3 stalled rounds with 0 accepted leads, but recovery is available (${sessionState.recoveryAttempts}/2). Transitioning to recovery plan.`,
                );
              } else {
                logEvent(
                  `Round ${round}: 3 consecutive rounds produced 0 candidates. Early exiting round loop to prevent endless API token burning.`,
                );
                stats.stopReason = "exhausted";
                break;
              }
            }
          }
        } else {
          consecutiveStalledRounds = 0;
          providerImpairedStallRounds = 0;
        }
      }
    }

    if (acceptedLeads.length === 0) {
      throw new Error(
        "Could not extract any new qualified profiles from search results. Try more specific criteria.",
      );
    }

    saveMiningSessionCheckpoint(sessionId, {
      sessionId,
      round: stats.rounds || 1,
      stage: "judge",
      promptQuery,
      targetLimit,
      contract,
      searchSpec,
      queryRuns: [],
      queryRunsDelta: stats.queryRuns.slice(checkpointedQueryRunCount),
      acceptedLeads: acceptedLeads.slice(0, 240),
      qualifiedLeads: qualifiedLeads.slice(0, 240),
      finalLeads: [],
      rejectionCounts: stats.rejectionReasons,
      failureCounts: brightDataStats.failureReasons,
      brightDataStats,
      previousRoundSummary,
      evidenceByUrl: buildCheckpointEvidence(
        evidenceByUrl,
        acceptedLeads.slice(0, 240),
      ),
      leadQueryRunMap: leadQueryRuns.toJSON(),
      debugLogsTail: debugLogs.slice(-100),
      signalStoreState: sessionState.signalStore?.toJSON(),
      recoveryAttempts: sessionState.recoveryAttempts,
      updatedAt: new Date().toISOString(),
    });
    checkpointedQueryRunCount = stats.queryRuns.length;

    await executeJudgeStage(sessionCtx, {
      contract,
      evidenceByUrl,
      stats,
      leadQueryRuns,
      checkpointAcceptedLeads,
    });

    if (acceptedLeads.length > 0 && qualifiedLeads.length > 0) {
      const observedPassRate = Number(
        (qualifiedLeads.length / acceptedLeads.length).toFixed(2),
      );
      previousRoundSummary.judgePassRateEstimate = Math.min(
        Math.max(observedPassRate, 0.3),
        1.0,
      );
    }

    const selectResult = await executeSelectStage(sessionCtx, {
      contract,
      searchSpec,
      ttlDays,
      stats,
      leadQueryRuns,
      trackableBrightDataSearch,
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
      safeInsertSearchLog,
    });

    persistedCount = persistResult.persistedCount;
    return persistResult.result;
  } catch (error: any) {
    console.error("Error in /api/find-leads:", error);
    const cancelled =
      error?.name === "AbortError" ||
      String(error?.message || "").includes("cancelled");
    telemetry.finish("error", {
      ...stats,
      error: error.message || "Failed to locate leads.",
    });
    const traceSummary = telemetry.getSummary();
    // Report only what actually reached SQLite -- never inflate with unpersisted candidates.
    const effectiveLeadsFound = persistedCount;
    const persistenceStatus: "complete" | "partial" | "failed" =
      persistedCount > 0 ? "partial" : "failed";

    const detailedLogsText = `${sessionLogs.join("\n")}\n\nSTATS_SUMMARY:\n${JSON.stringify(stats, null, 2)}`;
    safeInsertSearchLog({
      id: sessionId,
      timestamp: new Date().toISOString(),
      prompt: promptQuery,
      generatedQueries,
      status: cancelled ? "cancelled" : "error",
      errorMessage: error.message || "Failed to locate leads.",
      rawResultsCount,
      leadsFound: effectiveLeadsFound,
      detailedLogs: detailedLogsText,
      debugLogs: JSON.stringify(debugLogs),
    });

    upsertMiningSession({
      id: sessionId,
      status: cancelled ? "cancelled" : "error",
      completedAt: new Date().toISOString(),
      errorMessage: error.message || "Failed to locate leads.",
      stats: { ...stats, persistedCount, persistenceStatus },
      traceSummary,
    });

    throw error;
  } finally {
    activeSessions.delete(sessionId);
    activeSessionLogTotals?.delete(sessionId);
    activeSessionEvents.delete(sessionId);
    cancelledSessions.delete(sessionId);
    activeSessionControllers.delete(sessionId);
    // Re-use healthy MCP subprocess connections across discovery runs for performance;
    // only close if the client encountered transport errors or entered a cooldown state.
    await closeBrightDataClient({
      onlyIfIdle: true,
      onlyIfUnhealthy: true,
      reason: "find-leads-complete",
    });
  }
}

export class SessionAlreadyActiveError extends Error {
  constructor(public readonly sessionId: string) {
    super(
      `A lead mining session with this sessionId is already active: ${sessionId}`,
    );
    this.name = "SessionAlreadyActiveError";
  }
}

export class DiscoverySessionEngine {
  private activeSessions = new Map<string, string[]>();
  private activeSessionLogTotals = new Map<string, number>();
  private activeSessionControllers = new Map<string, AbortController>();
  private activeSessionEvents = new Map<string, MiningTelemetryRecorder>();
  private cancelledSessions = new Set<string>();

  /**
   * Atomically claim a session slot. The has-check and the placeholder insert
   * happen synchronously with no await between them, so two concurrent
   * execute/resume calls can never both pass (fixes the TOCTOU race where the
   * route-level isActive() pre-check had already been bypassed).
   */
  private tryClaim(sessionId: string): boolean {
    if (this.activeSessions.has(sessionId)) return false;
    this.activeSessions.set(sessionId, []);
    this.activeSessionLogTotals.set(sessionId, 0);
    return true;
  }

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
    return this.activeSessionEvents.get(sessionId)?.getEvents() || null;
  }

  getLiveTraceTotal(sessionId: string): number {
    return (
      this.activeSessionEvents.get(sessionId)?.getTotalEventsRecorded() ??
      (this.activeSessionEvents.get(sessionId)?.getEvents()?.length || 0)
    );
  }

  getLiveLogs(sessionId: string): string[] | null {
    return this.activeSessions.get(sessionId) || null;
  }

  getLiveLogTotal(sessionId: string): number {
    return (
      this.activeSessionLogTotals.get(sessionId) ??
      (this.activeSessions.get(sessionId)?.length || 0)
    );
  }

  addLog(sessionId: string, message: string): void {
    const logs = this.activeSessions.get(sessionId) || [];
    logs.push(message);
    this.activeSessionLogTotals.set(
      sessionId,
      (this.activeSessionLogTotals.get(sessionId) || 0) + 1,
    );
    this.activeSessions.set(sessionId, logs);
  }

  async execute(
    request: DiscoveryRequest,
    listener?: DiscoveryEventListener,
  ): Promise<DiscoveryResult> {
    const promptQuery = String(request.promptQuery || "").trim();
    if (!promptQuery || promptQuery.length > 2000) {
      throw new Error(
        "query must be a non-empty string of 2,000 characters or fewer.",
      );
    }

    const sessionId =
      request.sessionId?.trim() ||
      (crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex"));
    if (!this.tryClaim(sessionId)) {
      throw new SessionAlreadyActiveError(sessionId);
    }

    const sessionAbortController = new AbortController();
    this.activeSessionControllers.set(sessionId, sessionAbortController);

    return executeDiscoverySession({
      sessionId,
      promptQuery,
      requestedLimit: Math.min(
        Math.max(Number(request.requestedLimit || 5), 1),
        200,
      ),
      startedAt: Date.now(),
      sessionAbortController,
      activeSessions: this.activeSessions,
      activeSessionLogTotals: this.activeSessionLogTotals,
      activeSessionControllers: this.activeSessionControllers,
      activeSessionEvents: this.activeSessionEvents,
      cancelledSessions: this.cancelledSessions,
      searchSpec: request.searchSpec,
      discoveryMode: request.discoveryMode,
      discoveryProviderMode: request.discoveryProviderMode,
      excludeList: request.excludeList,
      savedSearchId: request.savedSearchId,
      listener,
    });
  }

  getResumableSessions() {
    return readResumableMiningSessions();
  }

  async resume(
    sessionId: string,
    listener?: DiscoveryEventListener,
  ): Promise<DiscoveryResult> {
    const trimmedId = (sessionId || "").trim();
    if (!trimmedId) {
      throw new Error("sessionId is required to resume a mining session.");
    }
    // Claim BEFORE the checkpoint read so a concurrent resume cannot slip
    // through the gap between the isActive check and controller registration.
    if (!this.tryClaim(trimmedId)) {
      throw new SessionAlreadyActiveError(trimmedId);
    }
    const checkpoint = readMiningSessionCheckpoint(trimmedId);
    if (!checkpoint) {
      this.activeSessions.delete(trimmedId);
      this.activeSessionLogTotals.delete(trimmedId);
      throw new Error(
        `No resumable checkpoint found for session: ${trimmedId}`,
      );
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
      activeSessionLogTotals: this.activeSessionLogTotals,
      activeSessionControllers: this.activeSessionControllers,
      activeSessionEvents: this.activeSessionEvents,
      cancelledSessions: this.cancelledSessions,
      searchSpec: checkpoint.searchSpec,
      initialCheckpoint: checkpoint,
      listener,
    });
  }
}

export const discoveryEngine = new DiscoverySessionEngine();
