import type { CompanyAccount, LinkedInProfile } from '../types';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

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
