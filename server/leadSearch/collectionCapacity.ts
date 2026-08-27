/**
 * Keep collection effort proportional to the requested number of prospects.
 * This does not weaken qualification: it only determines how much public
 * evidence to collect before the existing evidence judge makes a decision.
 */
const clampInteger = (value: unknown, minimum: number, maximum: number) => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : minimum;
};

export const MAX_COLLECTION_ROUNDS = 24;
export const MAX_CANDIDATE_POOL = 240;

const RETRIEVAL_REFINEMENTS = [
  'official website',
  'team page',
  'leadership team',
  'company leadership',
  'professional biography',
  'executive biography',
  'partner profile',
  'founder profile',
  'management profile',
  'leadership profile',
  'company about page',
  'team directory',
  'leadership contact',
  'executive team',
  'company leadership bio',
  'professional experience',
  'management team',
  'leadership experience',
  'company team bio',
  'business leadership',
  'executive contact',
  'leadership background'
] as const;

export type CollectionCapacity = {
  candidateBatchSize: number;
  rerankPoolTarget: number;
  requestedJudgePool: number;
  requiredRounds: number;
  maxRounds: number;
  poolCapped: boolean;
  candidateCeiling: number;
  queryExecutionCeiling: number;
};

export function getRecoveryCandidateCeiling(targetLimit: number): number {
  const target = clampInteger(targetLimit, 1, 200);
  return Math.min(1600, Math.max(24, target * 8));
}

export function getQueryExecutionCeiling(targetLimit: number): number {
  const target = clampInteger(targetLimit, 1, 200);
  return Math.min(240, Math.max(32, target * 2));
}

/**
 * A stalled round is not evidence that the search is exhausted. Keep using the
 * bounded collection budget while the evidence pool is still short; the route
 * loop remains responsible for cancellation, timeout, duplicate-query, and
 * maximum-round exits.
 */
export function shouldKeepCollectingAfterStall(input: {
  completedRound: number;
  maxRounds: number;
  acceptedLeads: number;
  rerankPoolTarget: number;
}): boolean {
  const completedRound = Math.max(0, Math.floor(Number(input.completedRound) || 0));
  const maxRounds = Math.max(0, Math.floor(Number(input.maxRounds) || 0));
  const acceptedLeads = Math.max(0, Math.floor(Number(input.acceptedLeads) || 0));
  const rerankPoolTarget = Math.max(0, Math.floor(Number(input.rerankPoolTarget) || 0));

  return completedRound < maxRounds && acceptedLeads < rerankPoolTarget;
}

export function buildCollectionCapacity(input: {
  targetLimit: number;
  poolMultiplier?: number;
  poolMax?: number;
  baseRounds?: number;
  /** Number of hard requirements in the prospect contract.
   * Simpler contracts converge faster; use this to shrink the round budget. */
  contractHardReqCount?: number;
  maxRoundsCap?: number;
}): CollectionCapacity {
  const targetLimit = clampInteger(input.targetLimit, 1, 200);

  // Dynamic pool multiplier:
  // For small targets (<= 20), 2.0x cushion is ample for diversity.
  // For medium targets (<= 50), 1.75x cushion provides strong candidate choices without round bloat.
  // For large targets (> 50), 1.5x cushion keeps token and search usage bounded.
  const defaultPoolMultiplier = targetLimit <= 20 ? 2.0 : targetLimit <= 50 ? 1.75 : 1.5;
  const poolMultiplier = input.poolMultiplier !== undefined
    ? Number(Math.min(Math.max(Number(input.poolMultiplier), 1.25), 4).toFixed(2))
    : defaultPoolMultiplier;

  const poolMax = clampInteger(input.poolMax ?? MAX_CANDIDATE_POOL, 24, MAX_CANDIDATE_POOL);

  // Base rounds from contract complexity
  const hardReqCount = clampInteger(input.contractHardReqCount ?? 3, 0, 10);
  const baseRoundsByComplexity = hardReqCount <= 1 ? 3 : hardReqCount <= 2 ? 4 : 5;
  const baseRounds = clampInteger(input.baseRounds ?? baseRoundsByComplexity, 2, 8);

  // Dynamic candidate batch scaling:
  // Scales throughput per round with target size so large requests do not degenerate into 12-20 rounds.
  const candidateBatchSize = clampInteger(Math.ceil(targetLimit * 0.6), 12, 36);

  const desiredPool = Math.ceil(targetLimit * poolMultiplier);
  const rerankPoolTarget = Math.min(desiredPool, poolMax);
  const requiredRounds = Math.max(1, Math.ceil(rerankPoolTarget / candidateBatchSize));

  // Hard ceiling on max rounds (default: 6 rounds for targets <= 30, 8 rounds for target <= 50, 12 for larger)
  const defaultMaxRoundsCap = targetLimit <= 30 ? 6 : targetLimit <= 50 ? 8 : 12;
  const maxRoundsCap = clampInteger(input.maxRoundsCap ?? defaultMaxRoundsCap, 3, MAX_COLLECTION_ROUNDS);

  // Add 1 recovery round pad, bounded by baseRounds and strictly capped by maxRoundsCap
  const maxRounds = Math.min(
    Math.max(baseRounds, requiredRounds + 1),
    maxRoundsCap
  );

  return {
    candidateBatchSize,
    rerankPoolTarget,
    requestedJudgePool: rerankPoolTarget,
    requiredRounds,
    maxRounds,
    poolCapped: desiredPool > poolMax,
    candidateCeiling: getRecoveryCandidateCeiling(targetLimit),
    queryExecutionCeiling: getQueryExecutionCeiling(targetLimit)
  };
}

/** A distinct, contract-safe retrieval form for every dynamic collection round. */
export function collectionRefinementForRound(round: number): string {
  const index = clampInteger(round, 3, MAX_COLLECTION_ROUNDS) - 3;
  return RETRIEVAL_REFINEMENTS[index] || RETRIEVAL_REFINEMENTS[RETRIEVAL_REFINEMENTS.length - 1];
}
