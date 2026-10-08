import {
  readQueryPerformance,
  readStoredCompanyNames,
  readStoredCompanyDomains,
  readStoredMetroSaturation,
  readDiscoveredCompanyNames,
  readOutcomeRate,
  readOutcomeRateByScope,
} from "../../db.js";
import { looksLikeCompanyHint } from "../observations.js";
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
  COUNTRY_TO_METROS,
  metroWithCountry,
} from "../prospectContract.js";
import {
  buildQuerySignature,
  isNearDuplicateQuery,
  isSignatureExhausted,
  type QuerySignature,
} from "../querySignature.js";
import {
  computeStallLevel,
  buildStallDirectives,
  buildStallGridQueries,
  buildDirectoryDiscoveryQueries,
} from "../stallLadder.js";
import { formatLatencySeconds } from "../terminalLog.js";
import {
  scheduleAdaptiveRetrievalTasks,
  deriveContractDomainCluster,
  quantizeBriefToCentroid,
  centroidScopeKey,
  buildScopeKey,
} from "../adaptiveScheduler.js";
import { clampEnvInt } from "../sessionHelpers.js";
import { resolveGeo } from "../queryUnderstanding.js";
import { summarizeLLM } from "../telemetry.js";
import { mineQueryRefinements } from "../collectionCapacity.js";
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

export function resolvePlannerProviderOrder(): string[] {
  const env = process.env.LEAD_PLANNER_PROVIDER_ORDER;
  if (env && env.trim()) {
    return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  // Fast tier: prefer the low-latency router (Byesu) for query planning, then the primary
  // engine provider (Atria), then the OpenRouter/Mistral failsafe. Heavy reasoning models
  // are deprioritized for this low-latency planning call. See docs/adr/0011.
  return ["primary", "atria", "openrouter"];
}

export async function executePlanStage(
  ctx: SessionContext,
  input: PlanStageInput,
): Promise<PlanStageOutput> {
  const {
    round,
    remaining,
    generatedQueries,
    searchSpec,
    discoveryProviderMode,
    stats,
  } = input;
  // Speculative planning is a dry run: proposed queries must be inspectable
  // without mutating the caller's committed dedupe set. Operate on a copy so a
  // speculative pass never pollutes the running round's seen-query state.
  const seenQueryTexts = input.isSpeculative
    ? new Set(input.seenQueryTexts)
    : input.seenQueryTexts;
  const { config, state, logEvent, recordTrace } = ctx;

  const briefText = config.contract?.brief || config.promptQuery || "";
  const centroidEnabled = process.env.LEAD_ADAPTIVE_CENTROID_ENABLED === "true";
  const domainCluster = centroidEnabled
    ? quantizeBriefToCentroid(config.contract || briefText)
    : deriveContractDomainCluster(config.contract, briefText);
  const existingPlanCache = (state as any)._planStageCache;
  (state as any)._planStageCache = {
    historicalPerformance: readQueryPerformance(100, domainCluster),
    crmCompanies: existingPlanCache?.crmCompanies ?? readStoredCompanyNames(100),
    crmDomains: existingPlanCache?.crmDomains ?? readStoredCompanyDomains(50),
    metroSaturation: existingPlanCache?.metroSaturation ?? readStoredMetroSaturation(),
  };
  const { historicalPerformance, crmCompanies, crmDomains, metroSaturation } = (state as any)._planStageCache;
  // G5: key by domain_cluster|family|lane|provider so cluster rows and
  // CRM feedback rows no longer collide on one key and overwrite each other.
  // Compact to top 12 relevant entries to keep strategist prompt tokens lean & fast.
  const historicalYield = Object.fromEntries(
    historicalPerformance.slice(0, 12).map((row: any) => [
      centroidEnabled
        ? centroidScopeKey(
            {
              family: row.family || "general",
              lane: row.lane || "person",
              providerPreference: row.provider || "tavily",
            },
            row.domain_cluster && row.domain_cluster !== "global" ? row.domain_cluster : domainCluster,
          )
        : buildScopeKey({
            domainCluster: row.domain_cluster && row.domain_cluster !== "global" ? row.domain_cluster : domainCluster,
            family: row.family,
            lane: row.lane,
            provider: row.provider,
          }),
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
    const missingSoftSignals =
      Array.isArray((state.previousRoundSummary as any)?.missingSoftSignalIds)
        ? (state.previousRoundSummary as any).missingSoftSignalIds
        : [];
    const allMissing = [...missingHardReqs, ...missingSoftSignals];
    logEvent(
      `Round ${round}: executing recovery query planning (attempt ${currentRecoveryAttempt}/2) with Scout Strategist for missing criteria: [${allMissing.join(", ")}].`,
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

  // G14: merge cross-session discovered companies so earlier discoveries
  // inform the strategist prompt instead of being write-only.
  const discoveredCompanies = readDiscoveredCompanyNames(25).filter(looksLikeCompanyHint);
  const knownCompanyEntities = Array.from(
    new Set([...crmCompanies, ...signalCompanies, ...discoveredCompanies]),
  ).slice(0, 30);

  const envTasks = Number(process.env.LEAD_ADAPTIVE_TASKS_PER_ROUND);
  const prevAccepted = Number(
    (state.previousRoundSummary as any)?.acceptedLeads ??
      (state.previousRoundSummary as any)?.accepted ??
      -1,
  );
  const lowYieldBoost = isRecoveryMode || (round > 1 && prevAccepted >= 0 && prevAccepted <= 2) ? 1.5 : 1.0;
  const shortfallDrivenTasks = Math.ceil(Math.max(remaining, config.capacity?.candidateBatchSize || 12) / 3.5);
  const maxTasks =
    Number.isFinite(envTasks) && envTasks > 0
      ? envTasks
      : Math.min(
          12,
          Math.max(
            3,
            Math.ceil(shortfallDrivenTasks * lowYieldBoost),
          ),
        );

  // 1. Geography resolution and unvisited regional metros
  const resolvedGeo = resolveGeo(briefText);
  let targetCountryCanonical: string | null = resolvedGeo.countryAnchor;
  if (!targetCountryCanonical && config.contract?.identitySpec?.locations?.length) {
    for (const loc of config.contract.identitySpec.locations) {
      const geo = resolveGeo(loc);
      if (geo.countryAnchor) {
        targetCountryCanonical = geo.countryAnchor;
        break;
      }
    }
  }

  const allKnownMetros = Array.from(new Set(Object.values(COUNTRY_TO_METROS).flat()));
  const lowerPrevQueries = (generatedQueries || []).map((q) => q.toLowerCase());
  const exploredMetros = allKnownMetros.filter((metro) =>
    lowerPrevQueries.some((q) => q.includes(metro.toLowerCase())),
  );
  // Non-rigid saturation: If user specifically locked query to a single metro, preserve it;
  // otherwise, flag high-saturation metros (>=20 leads) to encourage geographic exploration.
  const isSingleMetroBrief = resolvedGeo.metros.length === 1;
  const saturatedMetros = allKnownMetros.filter((metro) => {
    if (isSingleMetroBrief && resolvedGeo.metros[0].toLowerCase() === metro.toLowerCase()) {
      return false;
    }
    const count = metroSaturation[metro.toLowerCase()] || 0;
    return count >= 20;
  });

  const eligibleMetros: string[] = [];
  if (targetCountryCanonical) {
    const rawMetros =
      COUNTRY_TO_METROS[targetCountryCanonical.toLowerCase()] ||
      COUNTRY_TO_METROS[
        (COUNTRY_CANONICAL_MAP[targetCountryCanonical.toLowerCase()] || "").toLowerCase()
      ] || [];
    for (const m of rawMetros) {
      eligibleMetros.push(metroWithCountry(m, targetCountryCanonical));
    }
  }
  const unvisitedMetros = eligibleMetros.filter((m) => {
    const mLower = m.toLowerCase();
    const isExplored = exploredMetros.some((em) => mLower.includes(em.toLowerCase()));
    const isSaturated = saturatedMetros.some((sm) => mLower.includes(sm.toLowerCase()));
    return !isExplored && !isSaturated;
  });

  // 2. Stall Ladder and Exhausted Signatures (Novelty Feedback + Cross-Session Saturation)
  const roundHistory = (state as any).roundHistory || ((state as any).previousRoundSummary ? [(state as any).previousRoundSummary] : []);
  const stallLevel = computeStallLevel(roundHistory);

  const exhaustedSigs: QuerySignature[] = [];
  const previousQueryRuns: QueryRunStats[] = (state as any).queryRuns || [];
  for (const qr of previousQueryRuns) {
    const raw = Number(qr.rawCandidates ?? 0);
    const unique = Number(qr.uniqueCandidates ?? 0);
    const novelty = unique / Math.max(raw, 1);
    if (raw >= 5 && novelty < 0.20 && qr.query) {
      exhaustedSigs.push(buildQuerySignature(qr.query, { contract: config.contract }));
    }
  }


  const minedRefinementTerms = mineQueryRefinements(
    (state as any).acceptedLeads || (state as any).qualifiedLeads || [],
    config.contract,
    round,
  );

  const stallDirective = buildStallDirectives(stallLevel, config.contract, {
    unvisitedMetros,
    minedRefinements: minedRefinementTerms,
  });
  if (stallDirective.effectiveLevel > 0) {
    logEvent(`Round ${round}: [Strategist] Injected ${stallDirective.summary}.`);
  }

  let planItems: SearchQueryPlanItem[] = [];

  // Round 1 optimization: use contract.initialQueries directly when available,
  // avoiding a redundant 5-20s Strategist LLM call (the contract compiler already
  // generated these queries during prospect contract compilation).
  if (
    round === 1 &&
    !isRecoveryMode &&
    Array.isArray(config.contract?.initialQueries) &&
    config.contract.initialQueries.length >= Math.max(2, Math.min(maxTasks, 4))
  ) {
    planItems = config.contract.initialQueries;
    logEvent(
      `Round 1: using ${planItems.length} contract-compiled initial queries (skipping redundant Strategist LLM call).`,
    );
  }

  if (planItems.length === 0) {
    const failedQueries = ((state as any).queryRuns || [])
      .filter((r: any) => ((r.acceptedLeads ?? r.acceptedCandidates ?? 0) === 0) && r.query)
      .map((r: any) => r.query as string);

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
      minedRefinementTerms,
      failedQueries,
      logEvent,
    });

    const effectivePrompt = stallDirective.directiveText
      ? `${strategistPrompt}\n${stallDirective.directiveText}`
      : strategistPrompt;

    const strategyStarted = Date.now();
    const strategyProviderAttempts: LLMProviderAttempt[] = [];
    let strategyUsage: LLMUsage | undefined;
    const label = isRecoveryMode ? `recovery_round_${round}` : `strategist_round_${round}`;
    const strategistMaxTokens = Math.max(
      1200,
      maxTasks * 250 + (isRecoveryMode ? 600 : 0),
    );

    try {
      recordTrace({
        phase: "strategy",
        operation: isRecoveryMode ? "recovery_planning" : "strategist_planning",
        status: "started",
        provider: "llm",
        round,
        metadata: { promptLength: effectivePrompt.length, isRecovery: isRecoveryMode, remaining },
      });
      const queryResult = await openAIStructured<any>(
        effectivePrompt,
        searchQueriesSchema,
        STRATEGIST_SYSTEM_PROMPT,
        {
          maxTokens: strategistMaxTokens,
          temperature: 0.1,
          circuitBreaker: state.llmCircuitBreaker,
          signal: effectiveSignal,
          tierProviderOrder: resolvePlannerProviderOrder(),
          providerHardTimeoutMs: { primary: 20_000, openrouter: 25_000, atria: 25_000 },
          maxRetries: 0,
          reasoningEffort: "low",
          metadata: {
            stage: "strategist",
            round,
            itemCount: maxTasks,
            promptSize: strategistPrompt.length,
            sessionId: config.sessionId,
          },
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
        `[LLM 200 OK] ${successfulAttempt?.provider || "LLM"} \u00b7 model: ${resolvedModel} \u00b7 ${formatLatencySeconds(latency)}${tokens ? ` \u00b7 ${tokens.toLocaleString()} tok` : ""} [Strategist Planning: ${normalizeQueryPlanItems(queryResult).length} queries]`,
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

  const rawTasks = buildRetrievalTasks(planItems, searchSpec).map(t => ({
    ...t,
    domainCluster: t.domainCluster || domainCluster,
    centroid: centroidEnabled ? quantizeBriefToCentroid(config.contract || briefText) : undefined,
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
      outcomeRate: readOutcomeRate().rate,
      outcomeRateByScope: new Map(
        Array.from(readOutcomeRateByScope(10).entries()).map(([k, v]) => [k, v.shrunkRate])
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

  // Filter against seenQueryTexts and canonical query signatures
  const proposedQueries: string[] = [];
  const historySigs: QuerySignature[] = (generatedQueries || []).map((q) =>
    buildQuerySignature(q, { contract: config.contract }),
  );

  const candidatePlans = adaptiveSchedule.tasks.map((item) => {
    const isPerson = item.lane === "person" || !item.lane;
    const executableQuery = isPerson ? toLinkedInSearchQuery(item) : item.query;
    return {
      item: { ...item, domainCluster: item.domainCluster || domainCluster },
      executableQuery,
    };
  });

  const roundPlans: ExecutableQueryPlan[] = [];
  for (const plan of candidatePlans) {
    const key = plan.executableQuery.toLowerCase().trim();
    if (seenQueryTexts.has(key)) continue;
    const sig = buildQuerySignature(plan.executableQuery, { contract: config.contract });
    if (isSignatureExhausted(sig, exhaustedSigs)) {
      logEvent(
        `Round ${round}: Dropping query "${plan.executableQuery}" - signature [${sig.roleClass}|${sig.orgClass}|${sig.geoAnchor}] exhausted by low novelty rate.`,
      );
      continue;
    }
    if (isNearDuplicateQuery(sig, historySigs)) {
      logEvent(
        `Round ${round}: Dropping query "${plan.executableQuery}" - near-duplicate of previously planned query signature.`,
      );
      continue;
    }
    historySigs.push(sig);
    seenQueryTexts.add(key);
    proposedQueries.push(plan.executableQuery);
    roundPlans.push(plan);
  }

  // Stall Level 2+ Deterministic Grid Backfill (Phase 3D)
  if (roundPlans.length < Math.min(4, maxTasks) && config.contract && stallLevel >= 2) {
    const needed = Math.min(4, maxTasks) - roundPlans.length;
    logEvent(
      `Round ${round}: Level ${stallLevel} Stall - backfilling ${needed} query slot(s) with deterministic stall grid.`,
    );
    const gridItems = buildStallGridQueries(config.contract, unvisitedMetros, round);
    const gridTasks = buildRetrievalTasks(gridItems, searchSpec);
    for (const task of gridTasks) {
      if (roundPlans.length >= Math.min(4, maxTasks)) break;
      const isPerson = task.lane === "person" || !task.lane;
      const executableQuery = isPerson ? toLinkedInSearchQuery(task) : task.query;
      const key = executableQuery.toLowerCase().trim();
      if (seenQueryTexts.has(key)) continue;
      const sig = buildQuerySignature(executableQuery, { contract: config.contract });
      if (isSignatureExhausted(sig, exhaustedSigs) || isNearDuplicateQuery(sig, historySigs)) {
        continue;
      }
      historySigs.push(sig);
      seenQueryTexts.add(key);
      proposedQueries.push(executableQuery);
      roundPlans.push({
        item: { ...task, domainCluster: task.domainCluster || domainCluster },
        executableQuery,
      });
    }
  }

  // Stall Level 3 Directory Discovery (Phase 3E)
  if (stallLevel === 3 && config.contract && roundPlans.length < maxTasks) {
    const dirItems = buildDirectoryDiscoveryQueries(config.contract, targetCountryCanonical);
    const dirTasks = buildRetrievalTasks(dirItems, searchSpec);
    for (const task of dirTasks) {
      if (roundPlans.length >= maxTasks) break;
      const executableQuery = task.query;
      const key = executableQuery.toLowerCase().trim();
      if (seenQueryTexts.has(key)) continue;
      const sig = buildQuerySignature(executableQuery, { contract: config.contract });
      if (isNearDuplicateQuery(sig, historySigs)) continue;
      historySigs.push(sig);
      seenQueryTexts.add(key);
      proposedQueries.push(executableQuery);
      roundPlans.push({
        item: { ...task, domainCluster: task.domainCluster || domainCluster },
        executableQuery,
      });
    }
  }

  if (roundPlans.length === 0 && config.contract) {
    const roles = config.contract.identitySpec?.roles || ['founder', 'owner', 'CEO', 'managing partner', 'director'];
    const rawLocations = (config.contract.identitySpec?.locations || []).length > 0
      ? config.contract.identitySpec!.locations!
      : [];
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
      // Shared resolver: pronoun-colliding ISO codes ("help us", "contact me") never anchor geo.
      contractCountry =
        resolveGeo(String(config.contract?.brief || config.promptQuery || "")).countryAnchor || "";
    }

    const locations = rawLocations.map((loc) => {
      if (contractCountry && !loc.toLowerCase().includes(contractCountry.toLowerCase()) && !/^(any|all|global|worldwide|remote)$/i.test(loc)) {
        return `${loc} ${contractCountry}`;
      }
      return loc;
    });

    const candidateVariants: string[] = [];
    const locPool = locations.length > 0 ? locations : [''];
    for (const role of roles) {
      for (const comp of companyTypes) {
        for (const loc of locPool) {
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
      const lowerQ = candidateQuery.toLowerCase().trim();
      if (seenQueryTexts.has(lowerQ) || proposedQueries.includes(candidateQuery)) continue;
      const sig = buildQuerySignature(candidateQuery, { contract: config.contract });
      if (isNearDuplicateQuery(sig, historySigs)) continue;
      historySigs.push(sig);
      seenQueryTexts.add(lowerQ);
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
