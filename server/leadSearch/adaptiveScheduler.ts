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
  accepted_candidates?: number;
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
  outcomeRate?: number;
  outcomeRateByScope?: Map<string, number> | Record<string, number>;
};

const finiteCount = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

export function buildScopeKey(input: {
  domainCluster?: string;
  centroid?: string;
  family?: string;
  lane?: string;
  provider?: string;
}): string {
  const prefix = input.centroid
    ? input.centroid.trim().toLowerCase()
    : (input.domainCluster && input.domainCluster.trim().toLowerCase() !== 'global'
        ? input.domainCluster.trim().toLowerCase()
        : '');
  const family = (input.family || 'general').trim().toLowerCase();
  const lane = (input.lane || 'person').trim().toLowerCase();
  const provider = (input.provider || 'tavily').trim().toLowerCase();
  return [prefix, family, lane, provider].filter(Boolean).join('|');
}

export function deriveDomainCluster(queryOrBrief: string): string {
  const text = String(queryOrBrief || '').toLowerCase();
  if (!text.trim()) return 'global';

  const clusters: Array<{ id: string; pattern: RegExp }> = [
    { id: 'b2b_agency', pattern: /\b(agenc(?:y|ies)|lead[-\s]?gen|seo|creative|copywriting|performance marketing|growth marketing|media buyer(?:s)?|advertising)\b/gi },
    { id: 'executive_coaching', pattern: /\b(coach(?:es|ing)?|executive coach(?:es)?|mastermind(?:s)?|mentor(?:s|ship)?|management consultan(?:t|ts|cy|cies)|management consulting|leadership advisory|advisory)\b/gi },
    { id: 'b2b_saas', pattern: /\b(saas|software|platform(?:s)?|cloud|api(?:s)?|fintech|edtech|healthtech|devops|cybersecurity)\b/gi },
    { id: 'local_services', pattern: /\b(dental|dentist(?:s)?|clinic(?:s)?|doctor(?:s)?|plumbing|hvac|roofing|electrician(?:s)?|contractor(?:s)?|realtor(?:s)?|real estate)\b/gi },
    { id: 'ecommerce_retail', pattern: /\b(ecommerce|e-commerce|shopify|d2c|apparel|retail|store(?:s)?)\b/gi },
    { id: 'healthcare_life_sciences', pattern: /\b(biotech|pharma|clinical|healthcare|hospital(?:s)?|medical)\b/gi },
    { id: 'professional_services', pattern: /\b(legal|law firm(?:s)?|attorney(?:s)?|accounting|cpa(?:s)?|tax firm(?:s)?)\b/gi },
    { id: 'manufacturing_industrial', pattern: /\b(manufacturing|industrial|factory|factories|fabrication|plant manager(?:s)?|industrial production)\b/gi },
  ];

  let bestCluster = 'global';
  let bestScore = 0;
  let isTie = false;
  for (const { id, pattern } of clusters) {
    const matches = text.match(pattern);
    const score = matches ? matches.length : 0;
    if (score > bestScore) {
      bestScore = score;
      bestCluster = id;
      isTie = false;
    } else if (score > 0 && score === bestScore) {
      isTie = true;
    }
  }
  return isTie ? 'global' : bestCluster;
}

export function deriveContractDomainCluster(
  contractOrSpec: any,
  briefFallback = '',
): string {
  if (!contractOrSpec) return deriveDomainCluster(briefFallback);
  const parts: string[] = [];
  if (typeof contractOrSpec.brief === 'string') parts.push(contractOrSpec.brief);
  if (briefFallback) parts.push(briefFallback);

  const idSpec = contractOrSpec.identitySpec || contractOrSpec;
  if (Array.isArray(idSpec.industries)) parts.push(...idSpec.industries);
  if (Array.isArray(idSpec.companyTypes)) parts.push(...idSpec.companyTypes);
  if (Array.isArray(idSpec.roles)) parts.push(...idSpec.roles);
  if (Array.isArray(idSpec.includeTitles)) parts.push(...idSpec.includeTitles);

  const combined = parts.filter(Boolean).join(' ');
  return deriveDomainCluster(combined || briefFallback);
}

export const adaptiveScopeKey = (task: Pick<RetrievalTask, 'family' | 'lane' | 'providerPreference'> & { domainCluster?: string; centroid?: string }) =>
  buildScopeKey({
    domainCluster: task.domainCluster,
    centroid: (task as any).centroid,
    family: task.family,
    lane: task.lane,
    provider: task.providerPreference,
  });

/**
 * Quantized semantic centroids for cross-session MAB pooling.
 * Deterministic slot key: slot:<cluster>:<role>:<industry>:<geo>
 */
export function quantizeBriefToCentroid(briefOrContract: unknown): string {
  if (!briefOrContract) return 'slot:global:all:all:all';
  if (typeof briefOrContract === 'string') {
    const text = briefOrContract.toLowerCase().trim();
    if (!text) return 'slot:global:all:all:all';
    const cluster = deriveDomainCluster(text);
    return `slot:${cluster}:all:all:all`;
  }
  const obj = briefOrContract as Record<string, any>;
  const cluster = deriveContractDomainCluster(obj, obj.brief || '');
  const idSpec = obj.identitySpec || obj;
  const role = Array.isArray(idSpec.roles) && idSpec.roles[0]
    ? String(idSpec.roles[0]).toLowerCase().replace(/[^a-z0-9]/g, '')
    : (Array.isArray(idSpec.includeTitles) && idSpec.includeTitles[0]
        ? String(idSpec.includeTitles[0]).toLowerCase().replace(/[^a-z0-9]/g, '')
        : 'all');
  const industry = Array.isArray(idSpec.industries) && idSpec.industries[0]
    ? String(idSpec.industries[0]).toLowerCase().replace(/[^a-z0-9]/g, '')
    : 'all';
  const geo = Array.isArray(idSpec.locations) && idSpec.locations[0]
    ? String(idSpec.locations[0]).toLowerCase().replace(/[^a-z0-9]/g, '')
    : 'all';
  return `slot:${cluster}:${role || 'all'}:${industry || 'all'}:${geo || 'all'}`;
}

export const centroidScopeKey = (
  task: Pick<RetrievalTask, 'family' | 'lane' | 'providerPreference'>,
  centroid: string,
) =>
  buildScopeKey({
    centroid,
    family: task.family,
    lane: task.lane,
    provider: task.providerPreference,
  });

const rowScopeKey = (row: AdaptivePerformanceRow & { domain_cluster?: string; domainCluster?: string; scope_key?: string; scopeKey?: string }) => {
  if (row.scope_key) return row.scope_key.toLowerCase();
  if (row.scopeKey) return row.scopeKey.toLowerCase();
  return buildScopeKey({
    domainCluster: row.domain_cluster || row.domainCluster,
    family: row.family,
    lane: row.lane,
    provider: row.provider,
  });
};

/**
 * G6: seedable RNG for deterministic scheduling in tests. Production uses
 * Math.random; tests call seedAdaptiveRandom(n) for identical selections.
 */
let adaptiveRandomSource: () => number = Math.random;
export function setAdaptiveRandomSource(fn: () => number) {
  adaptiveRandomSource = fn;
}
export function seedAdaptiveRandom(seed: number) {
  let s = seed >>> 0;
  adaptiveRandomSource = () => {
    s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) + 0x45d9f3b) | 0;
    s = (Math.imul(s ^ (s >>> 16), 0x45d9f3b) + 0x45d9f3b) | 0;
    s ^= s >>> 16;
    return (s >>> 0) / 4294967296;
  };
}
export function resetAdaptiveRandomSource() {
  adaptiveRandomSource = Math.random;
}

/**
 * Marsaglia and Tsang method for generating standard Gamma(alpha, 1) variates.
 */
export function sampleGamma(alpha: number): number {
  if (alpha < 1) {
    const u = adaptiveRandomSource();
    return sampleGamma(1 + alpha) * Math.pow(Math.max(u, 1e-10), 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let z = 0;
    let v = 0;
    do {
      const u1 = adaptiveRandomSource();
      const u2 = adaptiveRandomSource();
      z = Math.sqrt(-2.0 * Math.log(u1 || 1e-10)) * Math.cos(2.0 * Math.PI * u2);
      v = 1 + c * z;
    } while (v <= 0);
    v = v * v * v;
    const u = adaptiveRandomSource();
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
  useThompsonSampling = true,
  // G17: binary outcome rate (positive/total from lead_outcomes). Global until
  // outcomes are arm-attributed; weighted above retrieval-count proxies.
  // Callers pass it in so this function stays pure (no SQLite reads here).
  outcomeRate = 0
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

  const safeOutcomeRuns = Math.max(1, outcomeRuns);
  const qualified = finiteCount(row?.qualified_candidates) / safeOutcomeRuns;
  const returned = finiteCount(row?.returned_candidates) / safeOutcomeRuns;
  const rescued = finiteCount(row?.rescued_candidates) / safeOutcomeRuns;
  const unique = finiteCount(row?.unique_candidates) / safeOutcomeRuns;
  const duplicates = finiteCount(row?.duplicate_candidates) / safeOutcomeRuns;
  const providerUnits = finiteCount(row?.provider_units) / safeOutcomeRuns;
  const latencySeconds = (finiteCount(row?.search_latency_ms) / 1_000) / safeOutcomeRuns;
  // G17: hard fails were stored but never read -- penalize harder than rescues.
  const hardFailed = finiteCount((row as any)?.hard_failed_candidates) / safeOutcomeRuns;

  if (isFlagEnabled.adaptiveRewardV2()) {
    const rawReturned = finiteCount(row?.returned_candidates);
    const rawQualified = finiteCount(row?.qualified_candidates);
    const rawRescued = finiteCount(row?.rescued_candidates);
    const v2Returned = rawReturned / safeOutcomeRuns;
    const qualifiedOnly = Math.max(0, rawQualified - rawReturned) / safeOutcomeRuns;
    const v2Rescued = rawRescued / safeOutcomeRuns;

    const successes = v2Returned * 1.0 + qualifiedOnly * 0.5 + v2Rescued * 0.25;
    const observedTrials = (
      finiteCount((row as any)?.judged_candidates) ||
      finiteCount(row?.accepted_candidates) ||
      finiteCount(row?.unique_candidates)
    ) / safeOutcomeRuns;
    const trials = Math.max(Math.ceil(successes), observedTrials);
    const failures = Math.max(0, trials - successes) + hardFailed * 0.5;

    const outcomeBoost = Math.max(0, Math.min(1, Number(outcomeRate) || 0)) * 4.0;
    const alphaPost = 1.0 + successes + outcomeBoost;
    const betaPost = 1.0 + failures;
    const theta = useThompsonSampling
      ? sampleBeta(alphaPost, betaPost)
      : alphaPost / (alphaPost + betaPost);

    const costUnits = Math.max(0.5, providerUnits + latencySeconds * 0.15);
    const ucbExplorationBonus = explorationStrength * Math.sqrt(Math.log(totalOutcomeRuns + 1) / safeOutcomeRuns);
    const score = (theta * 10 / costUnits) + ucbExplorationBonus;

    return {
      score,
      outcomeRuns,
      thompsonSample: theta,
      alpha: alphaPost,
      beta: betaPost,
      reason: 'quality_history' as const
    };
  }

  let classBonus = 0;
  if (isFlagEnabled.classAwareScheduler()) {
    const idPasses = finiteCount(row?.identity_pass_count);
    const ctxPasses = finiteCount(row?.context_pass_count);
    const sigPasses = finiteCount(row?.signal_pass_count);
    classBonus = (idPasses * 1.5 + ctxPasses * 1.0 + sigPasses * 1.2) / safeOutcomeRuns;
  }

  // Beta-Bernoulli conjugate posteriors:
  // Successes (alpha): Qualified finalists, returned list members, unique discoveries, binary outcomes
  // Failures (beta): Hard fails, rescued low-tier candidates, duplicates, provider burn, latency
  const alphaPrior = 1.0;
  const betaPrior = 1.0;
  const outcomeBoost = Math.max(0, Math.min(1, Number(outcomeRate) || 0)) * 4.0;
  const alphaPost = alphaPrior + qualified * 3.5 + returned * 2.5 + unique * 0.1 + outcomeBoost + (classBonus > 0 ? classBonus * 0.5 : 0);
  const betaPost = betaPrior + hardFailed * 2.0 + rescued * 1.25 + duplicates * 1.5 + providerUnits * 0.12 + latencySeconds * 0.002;
  const thompsonSample = sampleBeta(alphaPost, betaPost);

  // Finalist quality and actual returned-list contribution dominate.
  const meanReward = (
    qualified * 3.5 +
    returned * 2.5 +
    unique * 0.1 +
    outcomeBoost -
    hardFailed * 2.0 -
    rescued * 1.25 -
    duplicates * 1.2 -
    providerUnits * 0.12 -
    latencySeconds * 0.002 +
    classBonus
  );
  const ucbExplorationBonus = explorationStrength * Math.sqrt(Math.log(totalOutcomeRuns + 1) / safeOutcomeRuns);

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

export const scoreQueryPerformanceRow = scoreAdaptiveArm;
export const scheduleAdaptiveSearchTasks = scheduleAdaptiveRetrievalTasks;

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
  const active = enabled && tasks.length >= maxTasks && totalOutcomeRuns >= minOutcomeRuns;

  const resolveTaskRow = (task: RetrievalTask) => {
    const slotKey = (task as any).centroid;
    const slotScopeKey = slotKey
      ? buildScopeKey({ centroid: slotKey, family: task.family, lane: task.lane, provider: task.providerPreference })
      : undefined;
    const clusterScopeKey = buildScopeKey({ domainCluster: task.domainCluster, family: task.family, lane: task.lane, provider: task.providerPreference });
    const globalScopeKey = buildScopeKey({ domainCluster: 'global', family: task.family, lane: task.lane, provider: task.providerPreference });

    const row = (slotScopeKey ? rowsByScope.get(slotScopeKey) : undefined)
      ?? rowsByScope.get(clusterScopeKey)
      ?? rowsByScope.get(globalScopeKey);

    const scopeKey = (slotScopeKey && rowsByScope.has(slotScopeKey))
      ? slotScopeKey
      : (rowsByScope.has(clusterScopeKey) ? clusterScopeKey : (slotScopeKey ?? clusterScopeKey));

    return { row, scopeKey };
  };

  const getOutcomeRateForScope = (scopeKey: string) => {
    if (options.outcomeRateByScope instanceof Map) {
      return options.outcomeRateByScope.get(scopeKey) ?? options.outcomeRate ?? 0;
    }
    if (options.outcomeRateByScope && typeof options.outcomeRateByScope === 'object') {
      return (options.outcomeRateByScope as Record<string, number>)[scopeKey] ?? options.outcomeRate ?? 0;
    }
    return options.outcomeRate ?? 0;
  };

  if (!active) {
    return {
      tasks,
      active: false,
      totalOutcomeRuns,
      decisions: tasks.map(task => {
        const { row, scopeKey } = resolveTaskRow(task);
        return {
          scopeKey,
          query: task.query,
          selected: true,
          score: 0,
          outcomeRuns: finiteCount(row?.outcome_runs),
          reason: 'cold_start' as const
        };
      })
    };
  }

  const ranked = tasks.map((task, originalIndex) => {
    const { row, scopeKey } = resolveTaskRow(task);
    const armOutcomeRate = getOutcomeRateForScope(scopeKey);
    const arm = scoreAdaptiveArm(row, totalOutcomeRuns, explorationStrength, true, armOutcomeRate);
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
  // G6: contract_guard entries are correctness constraints, not optional
  // arms -- only trim non-guard entries. If everything is a guard, correctness
  // wins over pruning and the cap is exceeded.
  const hardCap = maxTasks + 2;
  if (selected.length > hardCap) {
    const guards = selected.filter(s => guardedReasons.get(s.originalIndex) === 'contract_guard');
    const others = selected.filter(s => guardedReasons.get(s.originalIndex) !== 'contract_guard')
      .sort((a, b) => b.score - a.score);
    const room = Math.max(0, hardCap - guards.length);
    const kept = [...guards, ...others.slice(0, room)];
    selected.length = 0;
    selected.push(...kept);
    selectedIndexes.clear();
    for (const s of selected) selectedIndexes.add(s.originalIndex);
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
