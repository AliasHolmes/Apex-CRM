import crypto from 'crypto';
import type { Request, Response } from 'express';
import {
  hasOpenAIKey,
  openAIStructured,
  tavilySearch,
  createLLMSessionCircuitBreaker,
  searchSpecSchema,
  leadsArraySchema,
  searchQueriesSchema,
  type LLMProviderAttempt,
  type LLMUsage,
  hasTavilyKey
} from '../services/llm.js';
import {
  isBrightDataConfigured,
  shouldAttemptBrightData,
  brightDataSearch
} from '../services/brightdata.js';
import {
  extractLinkedInUsername,
  normalizeLinkedInUrl
} from '../services/linkedinEvidence.js';
import {
  buildProfileDedupeKeys,
  hasDuplicateProfile,
  normalizeDedupeValue
} from '../../src/utils/leadDedupe.js';
import {
  readStoredLeads,
  insertSearchLog,
  readQueryPerformance,
  upsertMiningSession
} from '../db.js';
import { compileIntentSignals, buildFallbackIntentSignals } from './intentSignals.js';
import { runIntentEnrichment } from './intentEnrichment.js';
import {
  normalizeSearchSpec,
  buildFallbackSearchSpec,
  buildSearchSpecPrompt,
  buildRetrievalTasks,
  buildFallbackQueryPlan,
  buildStrategistPrompt,
  type DiscoveryMode,
  type SearchSpec,
  type RetrievalTask,
  type SearchQueryPlanItem
} from './searchSpec.js';
import { toLinkedInSearchQuery } from './strategist.js';
import {
  buildDeterministicProspectContract,
  buildProspectContractPrompt,
  prospectContractSchema,
  normalizeProspectContract,
  searchSpecFromProspectContract,
  type ProspectContract
} from './prospectContract.js';
import {
  getRecoveryCandidateCeiling,
  getQueryExecutionCeiling
} from './collectionCapacity.js';
import {
  FINALIST_JUDGE_SYSTEM_PROMPT,
  buildFinalistJudgePrompt,
  finalistCandidateFromLead,
  finalistJudgeSchema,
  partitionCandidatesByStrictEvidence,
  validateFinalistJudgments,
  type CandidateOutcome
} from './finalistJudge.js';
import { computeScoreBreakdown, type EvidenceQuality } from './scoring.js';
import { verifyDecisionMakerFromEvidence } from './verification.js';
import { resolveDiscoveryProviderMode, resolveBrightDataSearchMode } from './discoveryRouting.js';
import { ScoutFreeTierBudget } from './freeTier.js';
import {
  extractCompanyHintDeterministic,
  extractCompanyHintFromProfile,
  extractCompanyHintFromSignal,
  fuseObservations,
  isSignalObservation,
  type ScoutObservation
} from './observations.js';
import { SignalStore } from './signalStore.js';
import { chunkEvidenceBlocksByTokenBudget, estimateTokenCount } from './llmBudget.js';
import { runProviderQueue } from './providerQueue.js';
import { selectDiversifiedLeads, buildScoutEvidence } from './scoutScoring.js';
import { scheduleAdaptiveRetrievalTasks } from './adaptiveScheduler.js';

const addProfileKeys = (profile: any, existingKeys: Set<string>) => {
  buildProfileDedupeKeys(profile || {}).forEach(key => existingKeys.add(key));
};
import {
  MiningTelemetryRecorder,
  type MiningTraceEvent,
  type TargetEffortStats,
  type FinalistJudgeStats,
  getLLMRouteLabel,
  estimateLLMCostUsd
} from './telemetry.js';

const EXTRACTION_SYSTEM_PROMPT = `Extract B2B prospects from source-labeled text into structured JSON.`;
const STRATEGIST_SYSTEM_PROMPT = `You are a B2B prospecting strategist.`;

export type TargetFulfillmentOptions = {
  req: Request;
  res: Response;
  sessionId: string;
  promptQuery: string;
  requestedLimit: number;
  startedAt: number;
  sessionAbortController: AbortController;
  activeSessions: Map<string, string[]>;
  activeSessionControllers: Map<string, AbortController>;
  activeSessionEvents: Map<string, any[]>;
  cancelledSessions: Set<string>;
};

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

export async function executeTargetFulfillmentSession(options: TargetFulfillmentOptions): Promise<any> {
  const {
    req,
    res,
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
  };

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
    activeSessionEvents.set(sessionId, telemetry.getEvents().slice(-100));
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
    queryRuns: [] as any[],
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
      adaptiveScheduler: null as any
    },
    rerank: {
      poolTarget: 0,
      poolSize: 0,
      returned: 0
    },
    signalMatching: {
      observations: 0,
      storedBlocks: 0,
      duplicateBlocks: 0,
      unresolvedCompanies: 0,
      llmFallbackAttempts: 0,
      llmFallbackResolved: 0,
      candidatesChecked: 0,
      candidatesMatched: 0,
      missingCandidateCompany: 0,
      noCompanyMatch: 0,
      blocksAttached: 0
    }
  };

  const target = requestedLimit;
  const candidateCeiling = getRecoveryCandidateCeiling(target);
  const queryExecutionCeiling = getQueryExecutionCeiling(target);

  const excludeList: string[] = Array.isArray(req.body?.excludeList) ? req.body.excludeList : [];
  const existingKeys = new Set<string>();
  const excludedValues = new Set<string>();

  for (const lead of readStoredLeads() as any[]) {
    buildProfileDedupeKeys(lead.profile || lead).forEach(k => existingKeys.add(k));
  }
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

  const requestedMode = ['person_first', 'account_first', 'signal_first', 'local_business'].includes(req.body?.discoveryMode)
    ? req.body.discoveryMode as DiscoveryMode
    : 'person_first';

  let searchSpec = normalizeSearchSpec(req.body?.searchSpec, promptQuery);
  if (!req.body?.searchSpec) {
    searchSpec = buildFallbackSearchSpec(promptQuery, requestedMode);
    if (hasOpenAIKey()) {
      const specStarted = Date.now();
      try {
        searchSpec = normalizeSearchSpec(await openAIStructured(
          buildSearchSpecPrompt(promptQuery),
          searchSpecSchema,
          STRATEGIST_SYSTEM_PROMPT,
          { maxTokens: 700, temperature: 0 }
        ), promptQuery);
        recordTrace({
          phase: 'strategy', operation: 'search_spec_compile', status: 'success', provider: 'llm',
          latencyMs: Date.now() - specStarted, metadata: { mode: searchSpec.mode }
        });
      } catch (error: any) {
        logEvent(`WARN: Search-spec compiler failed: ${error.message || String(error)}. Using deterministic spec.`);
      }
    }
  }

  const fallbackContract = buildDeterministicProspectContract(promptQuery, searchSpec);
  let contract = fallbackContract;
  if (hasOpenAIKey()) {
    try {
      const compiled = await openAIStructured<any>(
        buildProspectContractPrompt(promptQuery, searchSpec),
        prospectContractSchema,
        `You are an expert B2B lead generation strategist. Compile the targeting contract.`,
        { maxTokens: 1000, temperature: 0 }
      );
      contract = normalizeProspectContract(compiled, promptQuery, fallbackContract);
      logEvent(`Compiled prospect quality contract v${contract.policyVersion} with ${contract.requirements.filter(r => r.importance === 'hard').length} hard requirements.`);
    } catch (err: any) {
      logEvent(`WARN: Prospect contract compiler failed: ${err.message || String(err)}. Using deterministic contract.`);
    }
  }
  searchSpec = searchSpecFromProspectContract(searchSpec, contract);
  stats.scout.contract = contract;

  const discoveryProviderMode = resolveDiscoveryProviderMode({
    brightDataConfigured: isBrightDataConfigured(),
    tavilyConfigured: hasTavilyKey()
  });
  const brightDataSearchMode = resolveBrightDataSearchMode({ discoveryMode: discoveryProviderMode });

  const llmCircuitBreaker = createLLMSessionCircuitBreaker(Number(process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD || 2));
  let brightDataReady = shouldAttemptBrightData();
  let brightDataProviderDisabled = !brightDataReady;

  const companyIntentEnabled = process.env.BRIGHTDATA_COMPANY_INTENT_ENABLED === 'true';
  const envIntentCapRaw = process.env.BRIGHTDATA_COMPANY_INTENT_MAX_PER_SEARCH;
  const envIntentCap = Number.isFinite(Number(envIntentCapRaw))
    ? Math.max(Math.floor(Number(envIntentCapRaw)), 0)
    : 30;
  // Dynamically scale intent enrichment cap to cover at least the requested target prospect count
  const companyIntentMaxPerSearch = envIntentCapRaw === '0' ? 0 : Math.max(target, envIntentCap);
  const companyIntentConcurrency = Number.isFinite(Number(process.env.BRIGHTDATA_COMPANY_INTENT_CONCURRENCY))
    ? Math.max(Math.floor(Number(process.env.BRIGHTDATA_COMPANY_INTENT_CONCURRENCY)), 1)
    : 2;
  const ttlDays = Math.min(Math.max(Number(process.env.BRIGHTDATA_CACHE_TTL_DAYS || 7), 1), 30);

  if (companyIntentEnabled && hasOpenAIKey()) {
    const signalStarted = Date.now();
    try {
      contract.intentSignals = await compileIntentSignals(promptQuery, contract, llmCircuitBreaker);
      recordTrace({
        phase: 'strategy',
        operation: 'intent_signals_compiled',
        status: 'success',
        provider: 'llm',
        latencyMs: Date.now() - signalStarted,
        counts: { dynamic: contract.intentSignals.dynamic.length, universal: contract.intentSignals.universal.length }
      });
      logEvent(`Intent signals compiled: ${contract.intentSignals.dynamic.length} dynamic, ${contract.intentSignals.universal.length} universal.`);
    } catch (err: any) {
      contract.intentSignals = buildFallbackIntentSignals();
      recordTrace({
        phase: 'strategy',
        operation: 'intent_signals_compiled',
        status: 'error',
        provider: 'llm',
        latencyMs: Date.now() - signalStarted,
        error: { message: err?.message || String(err) }
      });
      logEvent(`WARN: Intent signal compilation failed: ${err?.message || String(err)}. Using universal fallback.`);
    }
  } else {
    contract.intentSignals = buildFallbackIntentSignals();
  }

  const discoveredCandidateKeys = new Set<string>();
  const processedCandidateKeys = new Set<string>();
  const deferredCandidateQueue: Array<{ lead: any; evidenceMeta: any; queryRun?: any }> = [];
  const qualifiedLeadsMap = new Map<string, any>();
  const seenQueriesWithProvider = new Set<string>();

  let autoQualifiedCount = 0;
  let judgeBatchesRun = 0;
  let judgeBatchesSkipped = 0;
  let judgeRetriesCount = 0;
  let judgeReviewedCount = 0;
  let judgeQualifiedCount = 0;
  let judgeHardFailCount = 0;
  let judgeUnknownCount = 0;
  let judgeUnjudgedCount = 0;
  let totalQueryExecutions = 0;
  let emptyWavesCount = 0;
  let judgeWaveCount = 0;
  let terminationReason = 'query_space_exhausted';

  const getSelectableQualified = () => selectDiversifiedLeads(Array.from(qualifiedLeadsMap.values()), target, searchSpec.maxPerCompany, logEvent);
  const isTargetFulfilled = () => getSelectableQualified().length >= target;

  const evidenceByUrl = new Map<string, any>();
  const signalStore = new SignalStore();
  const signalCompanyLlmFallbackLimit = 3;
  let currentRound = 0;
  let previousRoundSummary: Record<string, any> = {};
  let consecutiveEmptyQueryWaves = 0;

  logEvent(`Starting Target-First Lead Engine session: target=${target}, candidateCeiling=${candidateCeiling}, queryExecutionCeiling=${queryExecutionCeiling}.`);

  while (!isTargetFulfilled()) {
    throwIfCancelled();
    currentRound++;
    stats.rounds = currentRound;

    if (totalQueryExecutions >= queryExecutionCeiling) {
      terminationReason = 'query_budget_exhausted';
      logEvent(`Reached query execution ceiling (${queryExecutionCeiling}). Terminating loop.`);
      break;
    }
    if (discoveredCandidateKeys.size >= candidateCeiling) {
      terminationReason = 'candidate_ceiling_reached';
      logEvent(`Reached candidate ceiling (${candidateCeiling}). Terminating loop.`);
      break;
    }

    let roundQueryTasks: SearchQueryPlanItem[] = [];

    if (currentRound === 1 && contract.initialQueries && contract.initialQueries.length > 0) {
      logEvent(`Round 1: using ${contract.initialQueries.length} contract initial queries without Strategist LLM call.`);
      roundQueryTasks = contract.initialQueries.map((q, idx) => ({ ...q, priority: idx + 1 }));
    } else {
      const decidableJudgments = judgeQualifiedCount + judgeHardFailCount + judgeUnknownCount;
      let estimatedYield = 0.25;
      if (decidableJudgments >= 12) {
        estimatedYield = Math.min(0.75, Math.max(0.10, judgeQualifiedCount / decidableJudgments));
      } else {
        const hist = readQueryPerformance(100);
        const totalHistOutcome = hist.reduce((s, r) => s + Number(r.outcome_runs || 0), 0);
        const totalHistQual = hist.reduce((s, r) => s + Number(r.qualified_candidates || 0), 0);
        if (totalHistOutcome >= 8 && totalHistQual > 0) {
          estimatedYield = Math.min(0.75, Math.max(0.10, totalHistQual / Math.max(1, totalHistOutcome * 5)));
        }
      }

      const currentShortfall = target - getSelectableQualified().length;
      const neededCandidatesTranche = Math.max(12, Math.ceil(currentShortfall / estimatedYield * 1.25));
      logEvent(`Round ${currentRound}: target shortfall=${currentShortfall}, yieldEst=${(estimatedYield * 100).toFixed(1)}%, target candidate tranche=${neededCandidatesTranche}.`);

      const strategistPrompt = buildStrategistPrompt({
        query: promptQuery,
        spec: searchSpec,
        round: currentRound,
        maxRounds: 24,
        remaining: currentShortfall,
        previousQueries: Array.from(seenQueriesWithProvider),
        previousRoundSummary,
        discoveryMode: discoveryProviderMode
      });

      try {
        const queryResult = await openAIStructured<any>(
          strategistPrompt,
          { type: 'object', properties: { queries: { type: 'array', items: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }, required: ['queries'] },
          STRATEGIST_SYSTEM_PROMPT,
          { maxTokens: 800, temperature: 0.1, circuitBreaker: llmCircuitBreaker }
        );
        roundQueryTasks = Array.isArray(queryResult?.queries) ? queryResult.queries : [];
      } catch (err: any) {
        logEvent(`WARN: Strategist LLM call failed in round ${currentRound}: ${err.message}. Falling back to deterministic contract queries.`);
        roundQueryTasks = buildFallbackQueryPlan(promptQuery, searchSpec);
      }
    }

    if (roundQueryTasks.length === 0) {
      roundQueryTasks = buildFallbackQueryPlan(promptQuery, searchSpec);
    }

    const adaptiveSchedule = scheduleAdaptiveRetrievalTasks(
      buildRetrievalTasks(roundQueryTasks, searchSpec),
      readQueryPerformance(100),
      { enabled: true, maxTasks: 4 }
    );
    const retrievalTasks = adaptiveSchedule.tasks;

    const executableTasks: RetrievalTask[] = [];
    for (const task of retrievalTasks) {
      const dedupKey = `${task.query.toLowerCase()}|${task.providerPreference}|${contract.policyVersion}`;
      if (seenQueriesWithProvider.has(dedupKey)) continue;
      seenQueriesWithProvider.add(dedupKey);
      executableTasks.push(task);
    }

    if (executableTasks.length === 0) {
      logEvent(`Round ${currentRound}: no new unseen query/provider combinations generated.`);
      consecutiveEmptyQueryWaves++;
      if (consecutiveEmptyQueryWaves >= 2 && deferredCandidateQueue.length === 0) {
        logEvent(`Exhausted new query generation after 2 empty waves.`);
        terminationReason = 'query_space_exhausted';
        break;
      }
      continue;
    }

    consecutiveEmptyQueryWaves = 0;
    logEvent(`Executing ${executableTasks.length} search queries in round ${currentRound}.`);

    const tavilyTasks = executableTasks.filter(t => t.providerPreference !== 'brightdata' && hasTavilyKey());
    const tavilyResultsMap = new Map<number, any>();

    await runProviderQueue(tavilyTasks.map((task, idx) => ({
      id: `${sessionId}:tavily:r${currentRound}:${idx}`,
      run: async () => {
        totalQueryExecutions++;
        const res = await tavilySearch(task.query, task.tavily);
        tavilyResultsMap.set(idx, { task, res });
      }
    })), { concurrency: 3, signal: sessionAbortController.signal });

    let roundObservations: ScoutObservation[] = [];
    for (const [, { task, res }] of tavilyResultsMap.entries()) {
      const items = Array.isArray(res?.items) ? res.items : [];
      for (const item of items) {
        roundObservations.push({
          title: String(item.title || ''),
          url: String(item.url || ''),
          content: String(item.content || item.snippet || ''),
          provider: 'tavily',
          query: task.query,
          round: currentRound,
          lane: task.lane,
          raw: item
        });
      }
    }

    if (brightDataReady && !brightDataProviderDisabled && brightDataSearchMode !== 'off') {
      const bdTasks = executableTasks.filter(t => t.providerPreference === 'brightdata' || t.providerPreference === 'corroborate');
      if (bdTasks.length > 0) {
        await runProviderQueue(bdTasks.map((task, idx) => ({
          id: `${sessionId}:bd:r${currentRound}:${idx}`,
          run: async () => {
            totalQueryExecutions++;
            try {
              const lq = toLinkedInSearchQuery({ query: task.query });
              const res = await brightDataSearch(lq || task.query);
              for (const item of res) {
                roundObservations.push({
                  title: String(item.title || ''),
                  url: String(item.url || ''),
                  content: String(item.content || ''),
                  provider: 'brightdata',
                  query: task.query,
                  round: currentRound,
                  lane: task.lane,
                  raw: item
                });
              }
            } catch (error: any) {
              logEvent(`WARN: Bright Data search failed for task ${task.query}: ${error.message}`);
            }
          }
        })), { concurrency: 2, signal: sessionAbortController.signal });
      }
    }

    const fused = fuseObservations(roundObservations);
    logEvent(`Round ${currentRound}: ${roundObservations.length} raw observations fused into ${fused.length} unique candidates.`);

    // Pass 1: collect non-LinkedIn signal observations into signalStore
    for (const obs of fused) {
      if (!isSignalObservation(obs)) continue;
      if (!obs.content || obs.content.length < 60) continue;
      stats.signalMatching.observations++;

      let companyHint = extractCompanyHintDeterministic(obs);
      if (
        !companyHint
        && hasOpenAIKey()
        && stats.signalMatching.llmFallbackAttempts < signalCompanyLlmFallbackLimit
      ) {
        stats.signalMatching.llmFallbackAttempts++;
        companyHint = await extractCompanyHintFromSignal(
          obs,
          (p, s, sys, opt) => openAIStructured(p, s, sys, opt)
        );
        if (companyHint) stats.signalMatching.llmFallbackResolved++;
      }
      if (!companyHint) {
        stats.signalMatching.unresolvedCompanies++;
        continue;
      }

      const previousSize = signalStore.size;
      signalStore.add({
        companyName: companyHint,
        text: obs.content.slice(0, 800),
        url: obs.url,
        query: obs.query,
        lane: obs.lane || 'signal',
        round: currentRound,
        provider: obs.provider
      });
      if (signalStore.size > previousSize) stats.signalMatching.storedBlocks++;
      else stats.signalMatching.duplicateBlocks++;
    }

    // Pass 2: admit LinkedIn candidates as identity anchors
    for (const obs of fused) {
      if (isSignalObservation(obs)) continue;
      const username = extractLinkedInUsername(obs.url);
      const normalizedUrl = normalizeLinkedInUrl(obs.url);
      if (!username || !normalizedUrl) continue;
      if (existingKeys.has(`linkedin:${username}`) || existingKeys.has(`linkedin:${normalizedUrl}`)) continue;

      const stableId = candidateStableId({ contactDetails: { linkedinUrl: obs.url } }, obs.url);
      if (discoveredCandidateKeys.has(stableId)) continue;
      discoveredCandidateKeys.add(stableId);

      const candidateItem = {
        id: stableId,
        url: obs.url,
        title: obs.title,
        content: obs.content,
        sourceProvider: obs.sourceProviders.includes('brightdata') ? 'brightdata' : 'tavily',
        normalizedUrl,
        username,
        sourceQuery: obs.query,
        sourceRound: currentRound,
        sourceProviders: obs.sourceProviders,
        sourceCount: obs.sourceCount,
        lanes: obs.lanes,
        corroborated: obs.corroborated
      };

      const evidenceMeta = {
        evidenceBlock: obs.content,
        evidenceQuality: 'weak' as EvidenceQuality,
        sourceProvider: candidateItem.sourceProvider,
        sourceUrl: obs.url,
        sourceQuery: obs.query,
        sourceRound: currentRound,
        sourceProviders: obs.sourceProviders,
        sourceCount: obs.sourceCount,
        lanes: obs.lanes,
        corroborated: obs.corroborated,
        candidateCompanyHint: extractCompanyHintFromProfile(obs),
        signalBlocks: []
      };

      evidenceByUrl.set(normalizedUrl, evidenceMeta);
      deferredCandidateQueue.push({ lead: candidateItem, evidenceMeta });
    }

    if (deferredCandidateQueue.length > 0) {
      const extractionBatch = deferredCandidateQueue.splice(0, deferredCandidateQueue.length);
      const evidenceBlocks = extractionBatch.map(
        item => `--- PROFILE CANDIDATE ---\nLINK: ${item.lead.url}\n${item.evidenceMeta.evidenceBlock}\n\n`
      );
      const chunks = chunkEvidenceBlocksByTokenBudget(evidenceBlocks, 1800);

      const extractionResults: any[] = [];
      for (const chunk of chunks) {
        const prompt = `Extract distinct B2B prospects from the source-labeled evidence below.

Rules:
- Set contactDetails.linkedinUrl ONLY to the exact LINK value from the same "--- PROFILE CANDIDATE ---" block. Never copy an external website or third-party URL found inside snippet text.
- If the LINK value is not a linkedin.com/in/ URL or is missing, leave contactDetails.linkedinUrl empty.
- Do not invent or hallucinate URLs.

User search criteria:
${promptQuery}

Evidence:
${chunk}`;
        try {
          const extracted = await openAIStructured<any[]>(
            prompt,
            { type: 'array', items: { type: 'object', properties: { fullName: { type: 'string' }, currentTitle: { type: 'string' }, currentCompany: { type: 'string' }, contactDetails: { type: 'object', properties: { linkedinUrl: { type: 'string' } } } }, required: ['fullName'] } },
            EXTRACTION_SYSTEM_PROMPT,
            { maxTokens: 2500, temperature: 0 }
          );
          if (Array.isArray(extracted)) extractionResults.push(...extracted);
        } catch (e: any) {
          logEvent(`WARN: LLM extraction chunk failed: ${e.message}`);
        }
      }

      for (const extractedLead of extractionResults) {
        if (!extractedLead || !extractedLead.fullName) continue;

        // Post-extraction URL sanitization fence:
        const rawExtractedUrl = extractedLead.contactDetails?.linkedinUrl;
        let validExtractedUrl = (rawExtractedUrl && extractLinkedInUsername(rawExtractedUrl)) ? rawExtractedUrl : '';

        // Backfill from batch anchor if URL is missing/invalid and chunk had a single candidate anchor
        if (!validExtractedUrl && extractionBatch.length === 1) {
          const batchUrl = extractionBatch[0].lead.url;
          if (batchUrl && extractLinkedInUsername(batchUrl)) {
            validExtractedUrl = batchUrl;
          }
        }

        if (extractedLead.contactDetails) {
          extractedLead.contactDetails.linkedinUrl = validExtractedUrl;
        } else if (validExtractedUrl) {
          extractedLead.contactDetails = { linkedinUrl: validExtractedUrl };
        }

        if (matchesExcludeList(extractedLead) || hasDuplicateProfile(extractedLead, existingKeys)) continue;

        const stableId = candidateStableId(extractedLead);
        if (processedCandidateKeys.has(stableId)) continue;
        processedCandidateKeys.add(stableId);

        const normalizedLeadUrl = normalizeLinkedInUrl(extractedLead.contactDetails?.linkedinUrl || extractedLead.sourceUrl || '');
        let matchingMeta = evidenceByUrl.get(normalizedLeadUrl || '');
        if (!matchingMeta && extractionBatch.length === 1) {
          matchingMeta = extractionBatch[0].evidenceMeta;
        }
        stats.signalMatching.candidatesChecked++;
        const signalMatch = signalStore.getForCandidates([
          extractedLead.currentCompany,
          matchingMeta?.candidateCompanyHint
        ]);
        if (!signalMatch.companyName) {
          stats.signalMatching.missingCandidateCompany++;
        } else if (signalMatch.blocks.length === 0) {
          stats.signalMatching.noCompanyMatch++;
        } else {
          stats.signalMatching.candidatesMatched++;
          stats.signalMatching.blocksAttached += signalMatch.blocks.length;
          if (matchingMeta) {
            matchingMeta.evidenceQuality = 'partial';
            matchingMeta.corroborated = true;
            matchingMeta.signalBlocks = signalMatch.blocks;
          }
        }
        const signalText = Array.isArray(matchingMeta?.signalBlocks)
          ? matchingMeta.signalBlocks
            .map((block: any) => `[OPEN-WEB SIGNAL: ${block.url || 'source'}]\n${block.text || ''}`)
            .join('\n\n')
          : '';
        const mergedEvidenceText = [matchingMeta?.evidenceBlock, signalText].filter(Boolean).join('\n\n') || extractedLead.summary || undefined;

        if (matchingMeta) {
          extractedLead.evidence = {
            sourceUrl: matchingMeta.sourceUrl,
            sourceProvider: matchingMeta.sourceProvider,
            sourceQuery: matchingMeta.sourceQuery,
            sourceRound: matchingMeta.sourceRound,
            evidenceQuality: matchingMeta.evidenceQuality,
            snippets: [mergedEvidenceText || extractedLead.summary || ''].filter(Boolean),
            whyThisLead: extractedLead.whyThisLead || extractedLead.summary
          };
          extractedLead.scout = buildScoutEvidence(extractedLead, searchSpec, {
            sourceProviders: matchingMeta.sourceProviders,
            lanes: matchingMeta.lanes,
            sourceCount: matchingMeta.sourceCount
          });
        }

        const dmVerification = verifyDecisionMakerFromEvidence({
          query: promptQuery,
          fullName: extractedLead.fullName,
          currentTitle: extractedLead.currentTitle,
          currentCompany: extractedLead.currentCompany,
          headline: extractedLead.headline,
          seniorityLevel: extractedLead.seniorityLevel,
          evidenceText: mergedEvidenceText || extractedLead.summary || ''
        });

        extractedLead.decisionMakerVerification = dmVerification;
        const scoreProvider = matchingMeta?.sourceProvider === 'brightdata' ? 'brightdata' : 'tavily';
        extractedLead.scoreBreakdown = computeScoreBreakdown(
          extractedLead,
          matchingMeta?.evidenceQuality || 'weak',
          scoreProvider,
          dmVerification
        );
        extractedLead.scoreOverride = extractedLead.scoreBreakdown.finalScore;

        const finalistCandidate = finalistCandidateFromLead(stableId, extractedLead, mergedEvidenceText, contract);
        const { autoQualified, needsJudge } = partitionCandidatesByStrictEvidence([finalistCandidate], contract);

        if (autoQualified.length > 0) {
          autoQualifiedCount++;
          const qualifiedLead = autoQualified[0].candidate.lead;
          qualifiedLead.qualification = autoQualified[0].qualification;
          qualifiedLead.whyThisLead = autoQualified[0].qualification.reason;
          qualifiedLead.finalSelectionScore = autoQualified[0].qualification.finalScore;
          // Preserve prior score for Kalman fusion on next enrichment round
          const existingEntry = qualifiedLeadsMap.get(stableId);
          if (existingEntry?.finalSelectionScore) qualifiedLead._priorScore = existingEntry.finalSelectionScore;
          qualifiedLeadsMap.set(stableId, qualifiedLead);
          addProfileKeys(qualifiedLead, existingKeys);
          logEvent(`Auto-qualified candidate: ${qualifiedLead.fullName} (${qualifiedLead.currentTitle} at ${qualifiedLead.currentCompany})`);
        } else if (needsJudge.length > 0) {
          const candidateToJudge = needsJudge[0];
          const judgeBatch = [candidateToJudge];

          judgeWaveCount++;
          judgeBatchesRun++;

          try {
            const judgePrompt = buildFinalistJudgePrompt(contract, judgeBatch);
            const judgmentResult = await openAIStructured<any>(judgePrompt, finalistJudgeSchema, FINALIST_JUDGE_SYSTEM_PROMPT, {
              maxTokens: 1500,
              temperature: 0,
              circuitBreaker: llmCircuitBreaker
            });

            const validation = validateFinalistJudgments(judgmentResult, contract, judgeBatch);
            judgeReviewedCount += validation.expectedJudgmentCount;
            judgeQualifiedCount += validation.counts.qualified;
            judgeHardFailCount += validation.counts.hardFail;
            judgeUnknownCount += validation.counts.unknown;
            judgeUnjudgedCount += validation.counts.unjudged;

            const outcome = validation.outcomes.get(candidateToJudge.candidateId);
            if (outcome && outcome.status === 'qualified' && outcome.qualification) {
              const lead = candidateToJudge.lead;
              lead.qualification = outcome.qualification;
              lead.whyThisLead = outcome.qualification.reason;
              lead.finalSelectionScore = outcome.qualification.finalScore;
              // Preserve prior score for Kalman fusion on next enrichment round
              const existingJudgeEntry = qualifiedLeadsMap.get(candidateToJudge.candidateId);
              if (existingJudgeEntry?.finalSelectionScore) lead._priorScore = existingJudgeEntry.finalSelectionScore;
              qualifiedLeadsMap.set(candidateToJudge.candidateId, lead);
              addProfileKeys(lead, existingKeys);
              logEvent(`Finalist Judge QUALIFIED candidate: ${lead.fullName}`);
            }
          } catch (err: any) {
            logEvent(`WARN: Finalist Judge failed for candidate ${candidateToJudge.candidateId}: ${err.message}`);
          }
        }

        if (isTargetFulfilled()) {
          logEvent(`Diversified qualified target (${target}) reached. Stopping candidate judging early.`);
          terminationReason = 'target_reached';
          break;
        }
      }
    }

    if (isTargetFulfilled()) {
      terminationReason = 'target_reached';
      break;
    }
  }

  // === PHASE 4: POST-COLLECTION INTENT ENRICHMENT ===
  if (companyIntentEnabled && companyIntentMaxPerSearch > 0 && qualifiedLeadsMap.size > 0) {
    logEvent(`Phase 4: intent enrichment starting. Pool: ${qualifiedLeadsMap.size} qualified leads. Cap: ${companyIntentMaxPerSearch}. Concurrency: ${companyIntentConcurrency}.`);
    const intentStats = await runIntentEnrichment({
      qualifiedLeads: qualifiedLeadsMap,
      contract,
      companyIntentMaxPerSearch,
      companyIntentConcurrency,
      ttlDays,
      brightDataSearch,
      tavilySearchFallback: async (query: string) => {
        if (!hasTavilyKey()) return [];
        const res: any = await tavilySearch(query).catch(() => null);
        const items = res?.results || res?.items || [];
        return items.map((item: any) => ({
          title: item.title || '',
          url: item.url || item.uri || '',
          content: item.snippet || item.content || ''
        }));
      },
      sessionAbortSignal: sessionAbortController.signal,
      logEvent,
      recordTrace
    });
    (stats as any).intentEnrichment = intentStats;
    logEvent(`Phase 4 complete: ${intentStats.succeeded} enriched, ${intentStats.cacheHits} cache hits, ${intentStats.noSite} no-site, ${intentStats.noSignal} no-signal, ${intentStats.failed} failed.`);
  }
  // === END PHASE 4 ===

  const selectedQualified = getSelectableQualified();
  const returnedLeads = selectedQualified.map(lead => {
    delete lead.audit;
    delete lead._priorScore;
    return lead;
  });

  const finalShortfall = Math.max(0, target - returnedLeads.length);
  if (returnedLeads.length >= target) {
    terminationReason = 'target_reached';
  }

  logEvent(`Session complete: returned ${returnedLeads.length}/${target} qualified prospects (shortfall=${finalShortfall}). Termination reason: ${terminationReason}.`);

  const targetEffortStats: TargetEffortStats = {
    mode: 'exhaustive_bounded',
    requested: target,
    selectableQualified: returnedLeads.length,
    shortfall: finalShortfall,
    waves: judgeWaveCount,
    queryExecutions: totalQueryExecutions,
    maxQueryExecutions: queryExecutionCeiling,
    acceptedCandidates: discoveredCandidateKeys.size,
    candidateCeiling,
    emptyWaves: emptyWavesCount,
    estimatedQualificationYield: judgeReviewedCount > 0 ? Number((judgeQualifiedCount / judgeReviewedCount).toFixed(2)) : 0.25,
    terminationReason
  };

  const finalistJudgeStats: FinalistJudgeStats = {
    autoQualified: autoQualifiedCount,
    reviewed: judgeReviewedCount,
    qualified: judgeQualifiedCount + autoQualifiedCount,
    hardFailed: judgeHardFailCount,
    unknown: judgeUnknownCount,
    unjudged: judgeUnjudgedCount,
    batchesRun: judgeBatchesRun,
    batchesSkipped: judgeBatchesSkipped,
    retries: judgeRetriesCount,
    rescued: 0
  };

  logEvent(
    `Signal matching summary: stored=${stats.signalMatching.storedBlocks}, `
    + `matchedCandidates=${stats.signalMatching.candidatesMatched}, `
    + `attachedBlocks=${stats.signalMatching.blocksAttached}, `
    + `unresolvedSignals=${stats.signalMatching.unresolvedCompanies}.`
  );
  recordTrace({
    phase: 'filtering',
    operation: 'signal_matching_summary',
    status: stats.signalMatching.storedBlocks > 0 ? 'success' : 'skipped',
    provider: 'system',
    counts: { ...stats.signalMatching }
  });

  telemetry.finish(returnedLeads.length > 0 ? 'success' : 'error', {
    returned: returnedLeads.length,
    stopReason: terminationReason
  });

  upsertMiningSession({
    id: sessionId,
    status: returnedLeads.length > 0 ? 'success' : 'error',
    prompt: promptQuery,
    requestedLimit: target,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    stats: {
      targetEffort: targetEffortStats,
      finalistJudge: finalistJudgeStats,
      signalMatching: stats.signalMatching
    },
    traceSummary: telemetry.getSummary()
  });

  safeInsertSearchLog({
    id: sessionId,
    timestamp: new Date().toISOString(),
    prompt: promptQuery,
    generatedQueries: Array.from(seenQueriesWithProvider),
    status: returnedLeads.length > 0 ? 'success' : 'error',
    errorMessage: finalShortfall > 0 ? `Found ${returnedLeads.length}/${target} verified matches after exhausting ${totalQueryExecutions} search queries.` : '',
    rawResultsCount: discoveredCandidateKeys.size,
    leadsFound: returnedLeads.length,
    detailedLogs: sessionLogs.join('\n'),
    debugLogs: JSON.stringify(debugLogs)
  });

  activeSessions.delete(sessionId);
  activeSessionControllers.delete(sessionId);

  return res.status(200).json({
    leads: returnedLeads,
    total: returnedLeads.length,
    requestedLimit: target,
    sessionId,
    shortfall: finalShortfall,
    shortfallReason: finalShortfall > 0 ? `Found ${returnedLeads.length}/${target} verified matches after exhausting search queries.` : undefined,
    stats: {
      ...stats,
      returned: returnedLeads.length,
      stopReason: terminationReason,
      targetEffort: targetEffortStats,
      finalistJudge: finalistJudgeStats
    }
  });
}
