import type { CompanyAccount, LinkedInProfile } from '../types';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Rescale a server-supplied score that may have arrived on the 0-1 probability scale
 * onto the 1-10 scale used by the UI.
 *
 * The upper bound is EXCLUSIVE on purpose. `1` is a valid and meaningful 1-10 score -
 * the worst a candidate can receive, and the value the engine clamps every judge-marked
 * reject to - so treating `<= 1` as a probability multiplies the weakest candidate by
 * ten. `compositeScore` then scales it again, turning a score of 1 into 100.
 *
 * Mirrors `normalizeToTenScale` in server/leadSearch/scoring.ts so the client and server
 * halves cannot drift apart. Returns `undefined` for absent or non-finite input so each
 * caller keeps its own fallback (`scoreLeadDeterministically` vs `0`) rather than
 * silently adopting a default here.
 */
export function normalizeServerScore(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > 0 && value < 1.0 ? value * 10 : value;
}

/**
 * A transparent fallback for leads that have not gone through the server-side
 * scoring pipeline. It intentionally avoids pretending that an unknown record
 * is highly qualified, while keeping imports and manual additions sortable.
 */
export function scoreLeadDeterministically(profile: Partial<LinkedInProfile>, companyAccount?: Partial<CompanyAccount>) {
  const title = `${profile.currentTitle || ''} ${profile.headline || ''}`.toLowerCase();
  const seniority = (profile.seniorityLevel || '').toLowerCase();
  const companySize = profile.companySizeEst || '';
  const signals = profile.painIndicators?.length || 0;

  let score = 25;
  if (/\b(founder|owner|chief|c[eo]o|president|partner)\b/.test(title) || /c-suite|founder/.test(seniority)) score += 35;
  else if (/\b(vp|vice president|head of|director)\b/.test(title) || /vp|head|director/.test(seniority)) score += 25;
  else if (/\b(manager|lead)\b/.test(title) || /manager/.test(seniority)) score += 12;
  if (companySize && companySize !== 'UNKNOWN') score += 8;
  score += Math.min(signals, 4) * 5;
  score += Math.round(clamp(Number(companyAccount?.operationalPainScore || 0), 0, 10) * 2);

  return clamp(Math.round(score), 0, 100);
}

export function predictiveScoreFromComposite(compositeScore: number, hasAccountContext = false) {
  if (!Number.isFinite(compositeScore) || compositeScore <= 0) return 0;
  return clamp(Math.round(compositeScore * (hasAccountContext ? 0.96 : 0.9)), 0, 96);
}
