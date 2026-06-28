export type RejectionReason =
  | 'duplicate_candidate'
  | 'duplicate_existing_lead'
  | 'missing_identity'
  | 'missing_role_context'
  | 'score_below_minimum'
  | 'weak_evidence'
  | 'brightdata_login_wall'
  | 'brightdata_low_quality'
  | 'brightdata_failed'
  | 'llm_extraction_empty'
  | 'not_decision_maker';

export type RejectionCounts = Record<string, number>;

export const incrementRejection = (counts: RejectionCounts, reason: RejectionReason) => {
  counts[reason] = (counts[reason] || 0) + 1;
};

export const mergeRejections = (target: RejectionCounts, source: RejectionCounts) => {
  for (const [reason, count] of Object.entries(source)) {
    target[reason] = (target[reason] || 0) + count;
  }
};

export const mapBrightDataRejection = (reason?: string): RejectionReason => {
  if (reason === 'blocked_or_login_wall') return 'brightdata_login_wall';
  if (reason === 'empty_or_too_short' || reason === 'missing_core_identity') return 'brightdata_low_quality';
  return 'brightdata_low_quality';
};
