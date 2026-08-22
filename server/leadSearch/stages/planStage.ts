import { readQueryPerformance } from '../../db.js';
import {
  openAIStructured,
  searchQueriesSchema,
  STRATEGIST_SYSTEM_PROMPT,
  type LLMProviderAttempt
} from '../../services/llm.js';
import {
  normalizeQueryPlanItems,
  type QueryRunStats,
  type SearchQueryPlanItem
} from '../strategist.js';
import {
  buildFallbackQueryPlan as buildScoutFallbackQueryPlan,
  buildRetrievalTasks,
  buildStrategistPrompt as buildScoutStrategistPrompt,
  type DiscoveryMode,
  type SearchSpec,
  type RetrievalTask
} from '../searchSpec.js';
import { enforceContractQueries } from '../prospectContract.js';
import { scheduleAdaptiveRetrievalTasks } from '../adaptiveScheduler.js';
import { summarizeLLM } from '../telemetry.js';
import type { SessionContext } from '../pipelineTypes.js';

export type PlanStageInput = {
  round: number;
  remaining: number;
  generatedQueries: string[];
  seenQueryTexts: Set<string>;
  searchSpec: SearchSpec;
  discoveryProviderMode: any;
  stats: any;
};

export type ExecutableQueryPlan = {
  item: RetrievalTask;
  executableQuery: string;
};

export type PlanStageOutput = {
  roundPlans: ExecutableQueryPlan[];
  queryRuns: QueryRunStats[];
  stopReason?: string;
};

export async function executePlanStage(
  ctx: SessionContext,
  input: PlanStageInput
): Promise<PlanStageOutput> {
  const { round, remaining, generatedQueries, seenQueryTexts, searchSpec, discoveryProviderMode, stats } = input;
  const { config, state, logEvent, recordTrace } = ctx;

  const historicalPerformance = readQueryPerformance(100);
  const historicalYield = Object.fromEntries(historicalPerformance.slice(0, 30).map((row: any) => [
    `${row.family}:${row.lane}:${row.provider}`,
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
      searchLatencyMs: Number(row.search_latency_ms || 0)
    }
  ]));

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
    missingRequirementIds: (state.previousRoundSummary as any)?.missingHardRequirementIds,
    logEvent
  });

  let planItems: SearchQueryPlanItem[] = [];
  if (remaining <= 2 && round > 1) {
    logEvent(`Round ${round}: target near completion (remaining: ${remaining}). Skipping LLM Strategist planning to optimize efficiency.`);
  } else {
    const strategyStarted = Date.now();
    const strategyProviderAttempts: LLMProviderAttempt[] = [];
    try {
      recordTrace({
        phase: 'strategy',
        operation: 'strategist_planning',
        status: 'started',
        provider: 'llm',
        round,
        metadata: { promptLength: strategistPrompt.length }
      });
      const queryResult = await openAIStructured<any>(
        strategistPrompt,
        searchQueriesSchema,
        STRATEGIST_SYSTEM_PROMPT,
        {
          maxTokens: 800,
          temperature: 0.1,
          circuitBreaker: state.llmCircuitBreaker,
          onProviderAttempt: attempt => strategyProviderAttempts.push(attempt)
        }
      );
      state.debugLogs.push({
        timestamp: new Date().toISOString(),
        type: 'llm_request',
        label: `strategist_round_${round}`,
        model: process.env.OPENAI_MODEL || 'gpt-5.5',
        prompt: strategistPrompt,
        systemInstruction: STRATEGIST_SYSTEM_PROMPT,
        response: queryResult
      });
      planItems = normalizeQueryPlanItems(queryResult);
      recordTrace({
        phase: 'strategy',
        operation: 'strategist_planning',
        status: 'success',
        provider: 'llm',
        round,
        latencyMs: Date.now() - strategyStarted,
        counts: { generatedQueries: planItems.length },
        llm: summarizeLLM('strategy', strategistPrompt, queryResult, Date.now() - strategyStarted, 0, strategyProviderAttempts)
      });
    } catch (e: any) {
      recordTrace({
        phase: 'strategy',
        operation: 'strategist_planning',
        status: 'error',
        provider: 'llm',
        round,
        latencyMs: Date.now() - strategyStarted,
        error: { message: e.message || String(e) },
        llm: summarizeLLM('strategy', strategistPrompt, '', Date.now() - strategyStarted, 0, strategyProviderAttempts)
      });
      logEvent(`WARN: Strategist failed in round ${round}: ${e.message}. Using fallback queries.`);
      state.debugLogs.push({
        timestamp: new Date().toISOString(),
        type: 'llm_error',
        label: `strategist_round_${round}`,
        prompt: strategistPrompt,
        error: e.message
      });
    }
  }

  if (planItems.length === 0) {
    planItems = buildScoutFallbackQueryPlan(config.promptQuery, searchSpec);
    logEvent(`Round ${round}: using ${planItems.length} deterministic fallback queries.`);
  }

  planItems = enforceContractQueries(planItems, config.contract);

  const adaptiveSchedule = scheduleAdaptiveRetrievalTasks(
    buildRetrievalTasks(planItems, searchSpec),
    historicalPerformance,
    {
      enabled: process.env.LEAD_ADAPTIVE_SCHEDULER_ENABLED !== 'false',
      maxTasks: Number(process.env.LEAD_ADAPTIVE_TASKS_PER_ROUND || 3),
      minOutcomeRuns: Number(process.env.LEAD_ADAPTIVE_MIN_OUTCOME_RUNS || 8),
      explorationStrength: Number(process.env.LEAD_ADAPTIVE_EXPLORATION_STRENGTH || 1.25)
    }
  );

  stats.scout.adaptiveScheduler = {
    active: adaptiveSchedule.active,
    totalOutcomeRuns: adaptiveSchedule.totalOutcomeRuns,
    selected: adaptiveSchedule.decisions.filter(decision => decision.selected).map(decision => decision.scopeKey),
    deferred: adaptiveSchedule.decisions.filter(decision => !decision.selected).map(decision => decision.scopeKey)
  };

  if (adaptiveSchedule.active) {
    logEvent(`Round ${round}: adaptive scheduler selected ${adaptiveSchedule.tasks.length}/${planItems.length} tasks using finalist-attributed outcomes.`);
    state.debugLogs.push({ timestamp: new Date().toISOString(), type: 'adaptive_schedule', round, decisions: adaptiveSchedule.decisions });
  }

  const roundPlans = adaptiveSchedule.tasks
    .map(item => ({ item, executableQuery: item.query }))
    .filter(plan => {
      const key = plan.executableQuery.toLowerCase();
      if (seenQueryTexts.has(key)) return false;
      seenQueryTexts.add(key);
      return true;
    });

  if (roundPlans.length === 0) {
    logEvent(`Round ${round}: strategist produced no new queries.`);
    return { roundPlans: [], queryRuns: [], stopReason: 'exhausted' };
  }

  generatedQueries.push(...roundPlans.map(plan => plan.executableQuery));

  const queryRuns: QueryRunStats[] = roundPlans.map(plan => {
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
      tavilySearchDepth: plan.item.tavily.searchDepth,
      corroboratedCandidates: 0,
      searchLatencyMs: 0,
      providerUnits: 0,
      qualifiedFinalists: 0,
      rescuedFinalists: 0,
      returnedFinalists: 0
    };
    stats.queryRuns.push(run);
    return run;
  });

  return { roundPlans, queryRuns };
}
