import type { RetrievalTask } from './searchSpec.js';

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
};

export type AdaptiveScheduleDecision = {
  scopeKey: string;
  query: string;
  selected: boolean;
  score: number;
  outcomeRuns: number;
  reason: 'quality_history' | 'exploration' | 'person_lane_guard' | 'contract_guard' | 'cold_start';
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
};

const finiteCount = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

export const adaptiveScopeKey = (task: Pick<RetrievalTask, 'family' | 'lane' | 'providerPreference'>) =>
  [task.family || 'general', task.lane || 'person', task.providerPreference || 'tavily'].join('|').toLowerCase();

const rowScopeKey = (row: AdaptivePerformanceRow) =>
  [row.family || 'general', row.lane || 'person', row.provider || 'tavily'].join('|').toLowerCase();

export function scoreAdaptiveArm(
  row: AdaptivePerformanceRow | undefined,
  totalOutcomeRuns: number,
  explorationStrength = 1.25
) {
  const outcomeRuns = finiteCount(row?.outcome_runs);
  if (outcomeRuns === 0) {
    return {
      score: explorationStrength * Math.sqrt(Math.log(totalOutcomeRuns + 2)),
      outcomeRuns,
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

  // Finalist quality and actual returned-list contribution dominate. Raw/unique
  // volume is only a weak tie-breaker; rescues, provider spend, latency, and
  // duplicates reduce the reward so the scheduler cannot optimize for noise.
  const meanReward = (
    qualified * 2.5 +
    returned * 2 +
    unique * 0.04 -
    rescued * 1.25 -
    duplicates * 0.08 -
    providerUnits * 0.12 -
    latencySeconds * 0.002
  ) / outcomeRuns;
  const explorationBonus = explorationStrength * Math.sqrt(Math.log(totalOutcomeRuns + 1) / outcomeRuns);

  return { score: meanReward + explorationBonus, outcomeRuns, reason: 'quality_history' as const };
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
      selected: selectedQueries.has(item.task.query),
      score: Number(item.score.toFixed(4)),
      outcomeRuns: item.outcomeRuns,
      reason: guardedReasons.get(item.originalIndex) || item.reason
    }))
  };
}
