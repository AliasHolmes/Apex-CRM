import type { RetrievalTask } from './searchSpec.js';
import { isFlagEnabled } from './featureFlags.js';

export type AdaptivePerformanceRow = {
  family?: string;
  lane?: string;
  provider?: string;
  outcome_runs?: number;
  qualified_candidates?: number;
  rescued_candidates?: number;
  returned_candidates?: number;
  unique_candidates?: number;
  duplicate_candidates?: number;
  search_latency_ms?: number;
  provider_units?: number;
  identity_pass_count?: number;
  context_pass_count?: number;
  signal_pass_count?: number;
};

export type AdaptiveScheduleDecision = {
  scopeKey: string;
  query: string;
  selected: boolean;
  score: number;
  outcomeRuns: number;
  reason: 'quality_history' | 'exploration' | 'person_lane_guard' | 'contract_guard' | 'cold_start';
  promoted?: boolean;
};

export type AdaptiveScheduleResult = {
  tasks: RetrievalTask[];
  active: boolean;
  totalOutcomeRuns: number;
  decisions: AdaptiveScheduleDecision[];
};

export type AdaptiveSchedulerOptions = {
  enabled?: boolean;
  maxTasks?: number;
  minOutcomeRuns?: number;
  explorationStrength?: number;
  round?: number;
  explorationFloorEvery?: number;
};

const finiteCount = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

export const adaptiveScopeKey = (task: Pick<RetrievalTask, 'family' | 'lane' | 'providerPreference'> & { domainCluster?: string }) =>
  [task.domainCluster || '', task.family || 'general', task.lane || 'person', task.providerPreference || 'tavily']
    .filter(Boolean)
    .join('|')
    .toLowerCase();

const rowScopeKey = (row: AdaptivePerformanceRow & { domainCluster?: string }) =>
  [row.domainCluster || '', row.family || 'general', row.lane || 'person', row.provider || 'tavily']
    .filter(Boolean)
    .join('|')
    .toLowerCase();

/**
 * Marsaglia and Tsang method for generating standard Gamma(alpha, 1) variates.
 */
export function sampleGamma(alpha: number): number {
  if (alpha < 1) {
    const u = Math.random();
    return sampleGamma(1 + alpha) * Math.pow(Math.max(u, 1e-10), 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let z = 0;
    let v = 0;
    do {
      const u1 = Math.random();
      const u2 = Math.random();
      z = Math.sqrt(-2.0 * Math.log(u1 || 1e-10)) * Math.cos(2.0 * Math.PI * u2);
      v = 1 + c * z;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * z * z * z * z) return d * v;
    if (Math.log(u || 1e-10) < 0.5 * z * z + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * Beta(alpha, beta) variate generation via Gamma transforms:
 * X ~ Gamma(alpha), Y ~ Gamma(beta) => X / (X + Y) ~ Beta(alpha, beta).
 */
export function sampleBeta(alpha: number, beta: number): number {
  const safeAlpha = Math.max(alpha, 0.001);
  const safeBeta = Math.max(beta, 0.001);
  const gAlpha = sampleGamma(safeAlpha);
  const gBeta = sampleGamma(safeBeta);
  const sum = gAlpha + gBeta;
  return sum > 0 ? gAlpha / sum : 0.5;
}

export function scoreAdaptiveArm(
  row: AdaptivePerformanceRow | undefined,
  totalOutcomeRuns: number,
  explorationStrength = 1.25,
  useThompsonSampling = true
) {
  const outcomeRuns = finiteCount(row?.outcome_runs);
  if (outcomeRuns === 0) {
    const coldStartThompson = useThompsonSampling ? sampleBeta(1.5, 1.0) : 1.0;
    return {
      score: (explorationStrength * Math.sqrt(Math.log(totalOutcomeRuns + 2))) * (0.85 + 0.3 * coldStartThompson),
      outcomeRuns,
      thompsonSample: coldStartThompson,
      reason: 'exploration' as const
    };
  }

  const qualified = finiteCount(row?.qualified_candidates);
  const returned = finiteCount(row?.returned_candidates);
  const rescued = finiteCount(row?.rescued_candidates);
  const unique = finiteCount(row?.unique_candidates);
  const duplicates = finiteCount(row?.duplicate_candidates);
  const providerUnits = finiteCount(row?.provider_units);
  const latencySeconds = finiteCount(row?.search_latency_ms) / 1_000;

  let classBonus = 0;
  if (isFlagEnabled.classAwareScheduler()) {
    const idPasses = finiteCount(row?.identity_pass_count);
    const ctxPasses = finiteCount(row?.context_pass_count);
    const sigPasses = finiteCount(row?.signal_pass_count);
    classBonus = (idPasses * 1.5 + ctxPasses * 1.0 + sigPasses * 1.2) / outcomeRuns;
  }

  // Beta-Bernoulli conjugate posteriors:
  // Successes (alpha): Qualified finalists, returned list members, unique discoveries
  // Failures (beta): Rescued low-tier candidates, duplicates, provider burn, latency
  const alphaPrior = 1.0;
  const betaPrior = 1.0;
  const alphaPost = alphaPrior + qualified * 2.5 + returned * 2.0 + unique * 0.04 + (classBonus > 0 ? classBonus * 0.5 : 0);
  const betaPost = betaPrior + rescued * 1.25 + duplicates * 0.08 + providerUnits * 0.12 + latencySeconds * 0.002;
  const thompsonSample = sampleBeta(alphaPost, betaPost);

  // Finalist quality and actual returned-list contribution dominate.
  const meanReward = (
    qualified * 2.5 +
    returned * 2 +
    unique * 0.04 -
    rescued * 1.25 -
    duplicates * 0.08 -
    providerUnits * 0.12 -
    latencySeconds * 0.002 +
    classBonus
  ) / outcomeRuns;
  const ucbExplorationBonus = explorationStrength * Math.sqrt(Math.log(totalOutcomeRuns + 1) / outcomeRuns);

  // Fuse UCB1 with Thompson Sample:
  const fusedScore = useThompsonSampling
    ? (meanReward + ucbExplorationBonus) * 0.65 + (thompsonSample * 10) * 0.35
    : meanReward + ucbExplorationBonus;

  return {
    score: fusedScore,
    outcomeRuns,
    thompsonSample,
    alpha: alphaPost,
    beta: betaPost,
    reason: 'quality_history' as const
  };
}

export function scheduleAdaptiveRetrievalTasks(
  tasks: RetrievalTask[],
  rows: AdaptivePerformanceRow[],
  options: AdaptiveSchedulerOptions = {}
): AdaptiveScheduleResult {
  const enabled = options.enabled ?? true;
  const maxTasks = Math.min(Math.max(Math.floor(options.maxTasks ?? 3), 1), 8);
  const minOutcomeRuns = Math.max(Math.floor(options.minOutcomeRuns ?? 8), 1);
  const explorationStrength = Math.max(Number(options.explorationStrength ?? 1.25), 0);
  const rowsByScope = new Map(rows.map(row => [rowScopeKey(row), row]));
  const totalOutcomeRuns = rows.reduce((sum, row) => sum + finiteCount(row.outcome_runs), 0);
  const active = enabled && tasks.length > maxTasks && totalOutcomeRuns >= minOutcomeRuns;

  if (!active) {
    return {
      tasks,
      active: false,
      totalOutcomeRuns,
      decisions: tasks.map(task => ({
        scopeKey: adaptiveScopeKey(task),
        query: task.query,
        selected: true,
        score: 0,
        outcomeRuns: finiteCount(rowsByScope.get(adaptiveScopeKey(task))?.outcome_runs),
        reason: 'cold_start'
      }))
    };
  }

  const ranked = tasks.map((task, originalIndex) => {
    const scopeKey = adaptiveScopeKey(task);
    const arm = scoreAdaptiveArm(rowsByScope.get(scopeKey), totalOutcomeRuns, explorationStrength);
    return { task, originalIndex, scopeKey, ...arm };
  }).sort((a, b) => b.score - a.score || a.task.priority - b.task.priority || a.originalIndex - b.originalIndex);

  const selected: typeof ranked = [];
  const selectedIndexes = new Set<number>();
  const guardedReasons = new Map<number, AdaptiveScheduleDecision['reason']>();
  const addSelected = (item: typeof ranked[number], reason?: AdaptiveScheduleDecision['reason']) => {
    if (selectedIndexes.has(item.originalIndex)) return;
    selected.push(item);
    selectedIndexes.add(item.originalIndex);
    if (reason) guardedReasons.set(item.originalIndex, reason);
  };

  // Contract-enforced queries are correctness constraints, not optional arms.
  // Greedily retain the highest-scoring task covering each requirement. If the
  // contract needs more tasks than maxTasks, correctness wins over pruning.
  const uncoveredRequirements = new Set(tasks.flatMap(task => task.coveredRequirementIds || []));
  while (uncoveredRequirements.size > 0) {
    const bestCoverage = ranked
      .filter(item => !selectedIndexes.has(item.originalIndex))
      .map(item => ({
        item,
        coverage: (item.task.coveredRequirementIds || []).filter(id => uncoveredRequirements.has(id)).length
      }))
      .filter(candidate => candidate.coverage > 0)
      .sort((a, b) => b.coverage - a.coverage || b.item.score - a.item.score)[0];
    if (!bestCoverage) break;
    addSelected(bestCoverage.item, 'contract_guard');
    for (const id of bestCoverage.item.task.coveredRequirementIds || []) uncoveredRequirements.delete(id);
  }

  if (tasks.some(task => task.lane === 'person') && !selected.some(item => item.task.lane === 'person')) {
    const bestPerson = ranked.find(item => item.task.lane === 'person');
    if (bestPerson) addSelected(bestPerson, 'person_lane_guard');
  }
  for (const item of ranked) {
    if (selected.length >= maxTasks) break;
    addSelected(item);
  }

  const explorationFloorEvery = Math.max(0, Math.floor(options.explorationFloorEvery ?? 3));
  const round = Math.max(1, Math.floor(options.round ?? 1));
  const promotedOriginalIndexes = new Set<number>();

  // Exploration floor: every Nth round (default 3), ensure the top deferred arm is promoted
  // into the active task list if deferred tasks exist and haven't been selected yet.
  if (explorationFloorEvery > 0 && round % explorationFloorEvery === 0) {
    const topDeferred = ranked.find(item => !selectedIndexes.has(item.originalIndex));
    if (topDeferred) {
      addSelected(topDeferred, 'exploration');
      promotedOriginalIndexes.add(topDeferred.originalIndex);
    }
  }

  const selectedTasks = selected
    .sort((a, b) => b.score - a.score || a.task.priority - b.task.priority)
    .map((item, index) => ({ ...item.task, priority: index + 1 }));
  const selectedQueries = new Set(selectedTasks.map(task => task.query));

  return {
    tasks: selectedTasks,
    active: true,
    totalOutcomeRuns,
    decisions: ranked.map(item => ({
      scopeKey: item.scopeKey,
      query: item.task.query,
      selected: selectedIndexes.has(item.originalIndex),
      score: Number(item.score.toFixed(4)),
      outcomeRuns: item.outcomeRuns,
      reason: guardedReasons.get(item.originalIndex) || item.reason,
      promoted: promotedOriginalIndexes.has(item.originalIndex) ? true : undefined
    }))
  };
}
