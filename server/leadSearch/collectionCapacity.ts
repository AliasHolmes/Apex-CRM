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
};

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
}): CollectionCapacity {
  const targetLimit = clampInteger(input.targetLimit, 1, 200);
  const poolMultiplier = clampInteger(input.poolMultiplier ?? 4, 2, 5);
  const poolMax = clampInteger(input.poolMax ?? MAX_CANDIDATE_POOL, 24, MAX_CANDIDATE_POOL);

  // Derive a sensible base round budget from contract complexity.
  // Fewer hard requirements = search snippets can satisfy them more easily,
  // so the scout converges in fewer rounds.
  const hardReqCount = clampInteger(input.contractHardReqCount ?? 3, 0, 10);
  const baseRoundsByComplexity = hardReqCount <= 1 ? 4 : hardReqCount <= 2 ? 5 : 7;
  const baseRounds = clampInteger(input.baseRounds ?? baseRoundsByComplexity, 2, MAX_COLLECTION_ROUNDS);

  const candidateBatchSize = Math.min(Math.max(targetLimit * 2, 4), 12);
  const desiredPool = Math.max(targetLimit * poolMultiplier, targetLimit);
  const rerankPoolTarget = Math.min(desiredPool, poolMax);
  const requiredRounds = Math.ceil(rerankPoolTarget / candidateBatchSize);

  // Two extra retrieval rounds let the scout compensate for duplicate or weak
  // public results instead of stopping immediately when a batch is rejected.
  // Cap at 10 rounds hard to prevent runaway recovery loops.
  const maxRounds = Math.min(
    Math.max(baseRounds, requiredRounds + 2),
    MAX_COLLECTION_ROUNDS
  );

  return {
    candidateBatchSize,
    rerankPoolTarget,
    requestedJudgePool: rerankPoolTarget,
    requiredRounds,
    maxRounds,
    poolCapped: desiredPool > poolMax
  };
}

/** A distinct, contract-safe retrieval form for every dynamic collection round. */
export function collectionRefinementForRound(round: number): string {
  const index = clampInteger(round, 3, MAX_COLLECTION_ROUNDS) - 3;
  return RETRIEVAL_REFINEMENTS[index] || RETRIEVAL_REFINEMENTS[RETRIEVAL_REFINEMENTS.length - 1];
}
