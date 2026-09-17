import {
  readQueryPerformance,
  readStoredCompanyNames,
  readStoredCompanyDomains,
  readStoredMetroSaturation,
} from "../../db.js";
import {
  openAIStructured,
  searchQueriesSchema,
  STRATEGIST_SYSTEM_PROMPT,
  DEFAULT_PRIMARY_MODEL,
  type LLMProviderAttempt,
  type LLMUsage,
} from "../../services/llm.js";
import {
  normalizeQueryPlanItems,
  toLinkedInSearchQuery,
  type QueryRunStats,
  type SearchQueryPlanItem,
} from "../strategist.js";
import {
  buildFallbackQueryPlan as buildScoutFallbackQueryPlan,
  buildRetrievalTasks,
  buildStrategistPrompt as buildScoutStrategistPrompt,
  type SearchSpec,
  type RetrievalTask,
} from "../searchSpec.js";
import {
  enforceContractQueries,
  COUNTRY_CANONICAL_MAP,
} from "../prospectContract.js";
import { scheduleAdaptiveRetrievalTasks, deriveDomainCluster } from "../adaptiveScheduler.js";
import { clampEnvInt } from "../sessionHelpers.js";
import { summarizeLLM } from "../telemetry.js";
import type { SessionContext } from "../pipelineTypes.js";

export type PlanStageInput = {
  round: number;
  remaining: number;
  generatedQueries: string[];
  seenQueryTexts: Set<string>;
  searchSpec: SearchSpec;
  discoveryProviderMode: any;
  stats: any;
  generation?: number;
  signal?: AbortSignal;
  isRecovery?: boolean;
  isSpeculative?: boolean;
  maxRounds?: number;
  domainCluster?: string;
  brightDataSearchMode?: any;
  brightDataReady?: boolean;
  brightDataProviderDisabled?: boolean;
  brightDataTransportRetryAfter?: number;
  tavilyCapabilities?: any;
  brightDataCapabilities?: any;
  [key: string]: any;
};

export type ExecutableQueryPlan = {
  item: RetrievalTask;
  executableQuery: string;
};

export type PlanStageOutput = {
  roundPlans: ExecutableQueryPlan[];
  queryRuns: QueryRunStats[];
  proposedQueries: string[];
  stopReason?: string;
  generation?: number;
  adaptiveSchedulerState?: any;
  debugLogs?: any[];
};

const pushStateDebugLog = (state: { debugLogs: any[] }, log: any, maxLogs = 500) => {
  if (state.debugLogs.length >= maxLogs) {
    state.debugLogs.splice(0, state.debugLogs.length - maxLogs + 1);
  }
  state.debugLogs.push(log);
};

export async function executePlanStage(
  ctx: SessionContext,
  input: PlanStageInput,
): Promise<PlanStageOutput> {
  const {
    round,
    remaining,
    generatedQueries,
    seenQueryTexts,
    searchSpec,
    discoveryProviderMode,
    stats,
  } = input;
  const { config, state, logEvent, recordTrace } = ctx;

  const domainCluster = deriveDomainCluster(config.contract?.brief || config.promptQuery || "");
  if (!(state as any)._planStageCache) {
    (state as any)._planStageCache = {
      historicalPerformance: readQueryPerformance(100, domainCluster),
      crmCompanies: readStoredCompanyNames(100),
      crmDomains: readStoredCompanyDomains(50),
      metroSaturation: readStoredMetroSaturation(),
    };
  }
  const { historicalPerformance, crmCompanies, crmDomains, metroSaturation } = (state as any)._planStageCache;
  const historicalYield = Object.fromEntries(
    historicalPerformance.slice(0, 30).map((row: any) => [
      [row.family || "general", row.lane || "person", row.provider || "tavily"]
        .join("|")
        .toLowerCase(),
      {
        runs: Number(row.runs || 0),
        outcomeRuns: Number(row.outcome_runs || 0),
        accepted: Number(row.accepted_candidates || 0),
        qualified: Number(row.qualified_candidates || 0),
        rescued: Number(row.rescued_candidates || 0),
        returned: Number(row.returned_candidates || 0),
        unique: Number(row.unique_candidates || 0),
        duplicates: Number(row.duplicate_candidates || 0),
        providerUnits: Number(row.provider_units || 0),
        searchLatencyMs: Number(row.search_latency_ms || 0),
        requirementFailDigest: row.requirement_fail_digest || undefined,
      },
    ]),
  );

  const effectiveSignal = input.signal || state.abortController.signal;
  const isRecoveryMode = Boolean(
    input.isRecovery ||
      (state.previousRoundSummary?.shouldRecover && (state.recoveryAttempts || 0) < 2),
  );

  const localDebugLogs: any[] = [];
  const currentRecoveryAttempt = isRecoveryMode ? ((state.recoveryAttempts || 0) + 1) : 0;
  if (isRecoveryMode) {
    const missingHardReqs =
      Array.isArray((state.previousRoundSummary as any)?.missingHardRequirementIds)
        ? (state.previousRoundSummary as any).missingHardRequirementIds
        : [];
    logEvent(
      `Round ${round}: executing recovery query planning (attempt ${currentRecoveryAttempt}/2) with Scout Strategist for missing criteria: [${missingHardReqs.join(", ")}].`,
    );
  }

  const signalCompanies = ctx.state.signalStore
    ? ctx.state.signalStore.getUniqueCompanyNames()
    : [];


  if (crmDomains.length > 0) {
    searchSpec.exclusions = searchSpec.exclusions || { companies: [], domains: [] };
    searchSpec.exclusions.domains = Array.from(
      new Set([...(searchSpec.exclusions.domains || []), ...crmDomains]),
    ).slice(0, 30);
  }

  const knownCompanyEntities = Array.from(
    new Set([...crmCompanies, ...signalCompanies]),
  );

  const strategistPrompt = buildScoutStrategistPrompt({
    query: config.promptQuery,
    spec: searchSpec,
    round,
    maxRounds: config.maxRounds,
    remaining,
    previousQueries: generatedQueries,
    previousRoundSummary: state.previousRoundSummary as any,
    queryPerformance: historicalYield,
    discoveryMode: discoveryProviderMode,
    contract: config.contract,
    missingRequirementIds: (state.previousRoundSummary as any)
      ?.missingHardRequirementIds,
    discoveredCompanies: signalCompanies,
    knownCompanyEntities,
    metroSaturation,
    isRecovery: isRecoveryMode,
    recoveryAttempt: currentRecoveryAttempt,
    logEvent,
  });

  let planItems: SearchQueryPlanItem[] = [];
  const strategyStarted = Date.now();
  const strategyProviderAttempts: LLMProviderAttempt[] = [];
  let strategyUsage: LLMUsage | undefined;
  const label = isRecoveryMode ? `recovery_round_${round}` : `strategist_round_${round}`;

  try {
    recordTrace({
      phase: "strategy",
      operation: isRecoveryMode ? "recovery_planning" : "strategist_planning",
      status: "started",
      provider: "llm",
      round,
      metadata: { promptLength: strategistPrompt.length, isRecovery: isRecoveryMode, remaining },
    });
    const queryResult = await openAIStructured<any>(
      strategistPrompt,
      searchQueriesSchema,
      STRATEGIST_SYSTEM_PROMPT,
      {
        maxTokens: 800,
        temperature: 0.1,
        circuitBreaker: state.llmCircuitBreaker,
        signal: effectiveSignal,
        onProviderAttempt: (attempt) =>
          strategyProviderAttempts.push(attempt),
        onUsage: (usage) => {
          strategyUsage = usage;
        },
      },
    );
    const successfulAttempt = strategyProviderAttempts.find(
      (attempt) => attempt.status === "success",
    );
    const resolvedModel =
      strategyUsage?.model ||
      successfulAttempt?.actualModel ||
      successfulAttempt?.model ||
      process.env.OPENAI_MODEL ||
      DEFAULT_PRIMARY_MODEL;
    const latency = Date.now() - strategyStarted;
    const tokens = strategyUsage?.totalTokens;
    logEvent(
      `[LLM 200 OK] ${successfulAttempt?.provider || "LLM"} \u00b7 model: ${resolvedModel} \u00b7 ${latency}ms${tokens ? ` \u00b7 ${tokens.toLocaleString()} tok` : ""} [Strategist Planning: ${normalizeQueryPlanItems(queryResult).length} queries]`,
    );

    const reqLog = {
      timestamp: new Date().toISOString(),
      type: "llm_request",
      label,
      model: resolvedModel,
      prompt: strategistPrompt,
      systemInstruction: STRATEGIST_SYSTEM_PROMPT,
      response: queryResult,
    };
    localDebugLogs.push(reqLog);
    if (!input.isSpeculative) {
      pushStateDebugLog(state, reqLog);
    }
    planItems = normalizeQueryPlanItems(queryResult);
    if (isRecoveryMode && planItems.length > 0 && !input.isSpeculative) {
      state.recoveryAttempts = (state.recoveryAttempts || 0) + 1;
    }
    recordTrace({
      phase: "strategy",
      operation: isRecoveryMode ? "recovery_planning" : "strategist_planning",
      status: "success",
      provider: "llm",
      model: resolvedModel,
      round,
      latencyMs: latency,
      counts: { generatedQueries: planItems.length },
      llm: summarizeLLM(
        "strategy",
        strategistPrompt,
        queryResult,
        latency,
        0,
        strategyProviderAttempts,
        strategyUsage,
      ),
    });
  } catch (e: any) {
    if (effectiveSignal?.aborted) {
      logEvent(`Round ${round}: planning was aborted by generation guard.`);
      return { roundPlans: [], queryRuns: [], proposedQueries: [], generation: input.generation };
    }
    const failedAttempt = strategyProviderAttempts[strategyProviderAttempts.length - 1];
    const failedModel = failedAttempt?.actualModel || failedAttempt?.model;
    recordTrace({
      phase: "strategy",
      operation: isRecoveryMode ? "recovery_planning" : "strategist_planning",
      status: "error",
      provider: "llm",
      model: failedModel,
      round,
      latencyMs: Date.now() - strategyStarted,
      error: { message: e.message || String(e) },
      llm: summarizeLLM(
        "strategy",
        strategistPrompt,
        "",
        Date.now() - strategyStarted,
        0,
        strategyProviderAttempts,
        strategyUsage,
      ),
    });
    logEvent(
      `[LLM ERROR] Strategist failed in round ${round}: ${e.message}. Using fallback queries.`,
    );
    const errLog = {
      timestamp: new Date().toISOString(),
      type: "llm_error",
      label,
      prompt: strategistPrompt,
      error: e.message,
    };
    localDebugLogs.push(errLog);
    if (!input.isSpeculative) {
      pushStateDebugLog(state, errLog);
    }
  }

  if (planItems.length === 0) {
    if (
      round === 1 &&
      Array.isArray(config.contract?.initialQueries) &&
      config.contract.initialQueries.length > 0
    ) {
      planItems = config.contract.initialQueries;
      logEvent(
        `Round 1: using ${planItems.length} initial contract fallback queries.`,
      );
    } else {
      planItems = buildScoutFallbackQueryPlan(config.promptQuery, searchSpec);
      logEvent(
        `Round ${round}: using ${planItems.length} deterministic fallback queries.`,
      );
    }
  }

  planItems = enforceContractQueries(planItems, config.contract);

  const envTasks = Number(process.env.LEAD_ADAPTIVE_TASKS_PER_ROUND);
  const maxTasks =
    Number.isFinite(envTasks) && envTasks > 0
      ? envTasks
      : Math.min(
          8,
          Math.max(
            3,
            Math.ceil((config.capacity?.candidateBatchSize || 12) / 4),
          ),
        );

  const rawTasks = buildRetrievalTasks(planItems, searchSpec).map(t => ({
    ...t,
    domainCluster: t.domainCluster || domainCluster
  }));

  const adaptiveSchedule = scheduleAdaptiveRetrievalTasks(
    rawTasks,
    historicalPerformance,
    {
      enabled: process.env.LEAD_ADAPTIVE_SCHEDULER_ENABLED !== "false",
      maxTasks,
      minOutcomeRuns: Number(process.env.LEAD_ADAPTIVE_MIN_OUTCOME_RUNS || 8),
      explorationStrength: Number(
        process.env.LEAD_ADAPTIVE_EXPLORATION_STRENGTH || 1.25,
      ),
      round,
      explorationFloorEvery: clampEnvInt(
        "LEAD_ADAPTIVE_EXPLORATION_FLOOR_EVERY",
        3,
        0,
        10,
      ),
    },
  );

  const adaptiveSchedulerState = {
    active: adaptiveSchedule.active,
    totalOutcomeRuns: adaptiveSchedule.totalOutcomeRuns,
    selected: adaptiveSchedule.decisions
      .filter((decision) => decision.selected)
      .map((decision) => decision.scopeKey),
    deferred: adaptiveSchedule.decisions
      .filter((decision) => !decision.selected)
      .map((decision) => decision.scopeKey),
  };

  if (!input.isSpeculative) {
    stats.scout.adaptiveScheduler = adaptiveSchedulerState;
  }

  if (adaptiveSchedule.active) {
    logEvent(
      `Round ${round}: adaptive scheduler selected ${adaptiveSchedule.tasks.length}/${planItems.length} tasks using finalist-attributed outcomes.`,
    );
    const scheduleLog = {
      timestamp: new Date().toISOString(),
      type: "adaptive_schedule",
      round,
      decisions: adaptiveSchedule.decisions,
    };
    localDebugLogs.push(scheduleLog);
    if (!input.isSpeculative) {
      pushStateDebugLog(state, scheduleLog);
    }
  }

  // Filter against seenQueryTexts without directly mutating caller state here
  const proposedQueries: string[] = [];
  const roundPlans = adaptiveSchedule.tasks
    .map((item) => {
      const isPerson = item.lane === "person" || !item.lane;
      const executableQuery = isPerson ? toLinkedInSearchQuery(item) : item.query;
      return {
        item: { ...item, domainCluster: item.domainCluster || domainCluster },
        executableQuery,
      };
    })
    .filter((plan) => {
      const key = plan.executableQuery.toLowerCase();
      if (seenQueryTexts.has(key)) return false;
      proposedQueries.push(plan.executableQuery);
      return true;
    });

  if (roundPlans.length === 0 && config.contract) {
    const roles = config.contract.identitySpec?.roles || ['founder', 'owner', 'CEO', 'managing partner', 'director'];
    const rawLocations = (config.contract.identitySpec?.locations || []).length > 0
      ? config.contract.identitySpec!.locations!
      : ['United States', 'United Kingdom', 'Canada', 'Australia'];
    const companyTypes = (config.contract.identitySpec?.companyTypes || []).length > 0
      ? config.contract.identitySpec!.companyTypes!
      : ['agency', 'consultancy', 'firm', 'studio'];
    const tooling = config.contract.intentSpec?.toolingKeywords || [];
    const painSignals = config.contract.intentSpec?.painSignals || [];
    const suffixes = ['executive profile', 'leadership', 'founder profile', 'portfolio', 'team leadership'];

    let contractCountry = "";
    const locTerms = (config.contract?.requirements || [])
      .filter((r: any) => r.scope === "person_location")
      .flatMap((r: any) => r.acceptableTerms || [])
      .filter(Boolean);
    for (const term of [...locTerms, ...rawLocations]) {
      const cleanTerm = String(term || "").trim().toLowerCase();
      if (COUNTRY_CANONICAL_MAP[cleanTerm]) {
        contractCountry = COUNTRY_CANONICAL_MAP[cleanTerm];
        break;
      }
    }
    if (!contractCountry) {
      const briefLower = String(config.contract?.brief || config.promptQuery || "").toLowerCase();
      for (const [cKey, cName] of Object.entries(COUNTRY_CANONICAL_MAP)) {
        if (new RegExp(`\\b${cKey}\\b`, "i").test(briefLower)) {
          contractCountry = cName;
          break;
        }
      }
    }

    const locations = rawLocations.map((loc) => {
      if (contractCountry && !loc.toLowerCase().includes(contractCountry.toLowerCase()) && !/^(any|all|global|worldwide|remote)$/i.test(loc)) {
        return `${loc} ${contractCountry}`;
      }
      return loc;
    });

    const candidateVariants: string[] = [];
    for (const role of roles) {
      for (const comp of companyTypes) {
        for (const loc of locations) {
          candidateVariants.push(`${role} ${comp} ${loc}`.trim());
          if (tooling.length > 0) {
            candidateVariants.push(`${role} ${comp} ${tooling[0]} ${loc}`.trim());
          }
          if (painSignals.length > 0) {
            candidateVariants.push(`${role} ${comp} ${painSignals[0]} ${loc}`.trim());
          }
          for (const suffix of suffixes) {
            candidateVariants.push(`${role} ${comp} ${loc} ${suffix}`.trim());
          }
        }
      }
    }

    const maxFallbackPlans = Math.max(4, maxTasks);
    for (const candidateQuery of candidateVariants) {
      const lowerQ = candidateQuery.toLowerCase();
      if (!seenQueryTexts.has(lowerQ) && !proposedQueries.includes(candidateQuery)) {
        proposedQueries.push(candidateQuery);
        roundPlans.push({
          item: {
            query: candidateQuery,
            family: 'persona_title',
            intent: 'find_decision_makers',
            priority: roundPlans.length + 1,
            lane: 'person',
            providerPreference: 'tavily',
            domainCluster,
            tavily: { searchDepth: 'basic', topic: 'general' }
          } as any,
          executableQuery: toLinkedInSearchQuery({ query: candidateQuery, lane: 'person' })
        });
        if (roundPlans.length >= maxFallbackPlans) break;
      }
    }
    if (roundPlans.length > 0) {
      logEvent(`Round ${round}: generated ${roundPlans.length} novel dynamic semantic fallback queries.`);
    }
  }

  if (roundPlans.length === 0) {
    logEvent(`Round ${round}: strategist produced no new queries.`);
    return {
      roundPlans: [],
      queryRuns: [],
      proposedQueries: [],
      stopReason: "exhausted",
      generation: input.generation,
      adaptiveSchedulerState,
      debugLogs: localDebugLogs,
    };
  }

  const queryRuns: QueryRunStats[] = roundPlans.map((plan) => {
    const run: QueryRunStats = {
      round,
      query: plan.executableQuery,
      family: plan.item.family,
      intent: plan.item.intent,
      rawCandidates: 0,
      uniqueCandidates: 0,
      evidenceBlocks: 0,
      extractedLeads: 0,
      acceptedLeads: 0,
      rejectionReasons: {},
      lane: plan.item.lane,
      providerPreference: plan.item.providerPreference,
      tavilySearchDepth: plan.item.tavily?.searchDepth ?? "basic",
      corroboratedCandidates: 0,
      searchLatencyMs: 0,
      providerUnits: 0,
      qualifiedFinalists: 0,
      rescuedFinalists: 0,
      returnedFinalists: 0,
    };
    return run;
  });

  return {
    roundPlans,
    queryRuns,
    proposedQueries,
    generation: input.generation,
    adaptiveSchedulerState,
    debugLogs: localDebugLogs,
  };
}
