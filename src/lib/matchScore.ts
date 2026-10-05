import type { Lead } from '@/types';

/**
 * A single 0-100 "how good a match is this prospect" number, shown wherever the UI needs a
 * plain-language score. Every writer of these fields already uses a 0-100 scale, so no
 * rescaling is done here (see CrmOverview for the history of that bug).
 */
export function getMatchScore(lead: Lead): number | null {
  const score = lead.qualificationScore ?? lead.predictiveScore ?? lead.compositeScore;
  if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) return null;
  return Math.min(100, Math.round(score));
}

export type MatchTone = 'success' | 'brand' | 'warning' | 'neutral';

export function describeMatchScore(score: number | null): { label: string; tone: MatchTone } {
  if (score === null) return { label: 'Not scored yet', tone: 'neutral' };
  if (score >= 80) return { label: 'Strong match', tone: 'success' };
  if (score >= 60) return { label: 'Good match', tone: 'brand' };
  if (score >= 40) return { label: 'Possible match', tone: 'warning' };
  return { label: 'Weak match', tone: 'neutral' };
}

/** Plain-language reasons behind the score, drawn from fields the CRM already stores. */
export function explainMatchScore(lead: Lead, matchedCriteriaCount: number, uncertaintyCount: number): string[] {
  const reasons: string[] = [];
  if (typeof lead.compositeScore === 'number' && lead.compositeScore > 0) {
    reasons.push(`Ideal-customer fit score: ${Math.round(lead.compositeScore)} out of 100.`);
  }
  const fit = lead.scoreBreakdown?.fitScore ?? lead.fitScore;
  const intent = lead.scoreBreakdown?.intentScore ?? lead.intentScore;
  if (typeof fit === 'number') reasons.push(`Role and company fit: ${fit} out of 10.`);
  if (typeof intent === 'number') reasons.push(`Buying intent: ${intent} out of 10.`);
  if (matchedCriteriaCount > 0) {
    reasons.push(`Matches ${matchedCriteriaCount} of your search criteria.`);
  }
  if (uncertaintyCount > 0) {
    reasons.push(`${uncertaintyCount} open question${uncertaintyCount === 1 ? '' : 's'} could not be verified.`);
  }
  const signalCount = lead.buyingSignalsDetected?.length ?? 0;
  if (signalCount > 0) reasons.push(`${signalCount} live buying signal${signalCount === 1 ? '' : 's'} detected.`);
  if (reasons.length === 0) reasons.push('No scoring details were stored for this prospect.');
  return reasons;
}
