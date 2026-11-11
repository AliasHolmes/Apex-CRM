/**
 * Shared duplicate-collision thresholds for the discovery pipeline.
 *
 * Three cut points coexist on purpose, each tied to a different decision:
 *   - DUPLICATE_DAMPEN_RATE (0.20): cancel full reruns; dampen Tavily recall volume.
 *   - DUPLICATE_PAGE2_RATE   (0.30): worth an extra SERP page fetch for the round.
 *   - STALL_DUPLICATE_RATE   (0.40): terminal stall - stop mining this surface entirely.
 *   - PLAN_NOVELTY_RATE      (0.20): novelty floor for planTask compaction.
 *
 * They were originally magic literals scattered across retrieveStage, planStage and
 * stallLadder. Keep them here so the ladder is explicit and reviewable.
 */
export const DUPLICATE_DAMPEN_RATE = 0.2;
export const DUPLICATE_PAGE2_RATE = 0.3;
export const STALL_DUPLICATE_RATE = 0.4;
export const PLAN_NOVELTY_RATE = 0.2;
