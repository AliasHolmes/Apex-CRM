export type LeadSourceProvider = 'tavily' | 'brightdata' | 'cache';
export type EvidenceQuality = 'weak' | 'partial' | 'good';

export type ScoreBreakdown = {
  fitScore: number;
  intentScore: number;
  timingScore: number;
  evidenceQualityScore: number;
  sourceConfidenceScore: number;
  finalScore: number;
};

const scoreOrDefault = (value: unknown, fallback: number) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.max(numeric, 1), 10);
};

export const evidenceQualityScore = (quality: EvidenceQuality) => {
  if (quality === 'good') return 9;
  if (quality === 'partial') return 7;
  return 4;
};

export const sourceConfidenceScore = (provider: LeadSourceProvider) => {
  if (provider === 'brightdata') return 8;
  if (provider === 'cache') return 7;
  return 6;
};

export function computeScoreBreakdown(
  lead: Record<string, any>,
  quality: EvidenceQuality,
  provider: LeadSourceProvider
): ScoreBreakdown {
  const fitScore = scoreOrDefault(lead.fitScore, 5);
  const intentScore = scoreOrDefault(lead.intentScore, 5);
  const timingScore = scoreOrDefault(lead.timingScore, 5);
  const eqScore = evidenceQualityScore(quality);
  const scScore = sourceConfidenceScore(provider);
  const finalScore = Number((
    fitScore * 0.35 +
    intentScore * 0.30 +
    timingScore * 0.15 +
    eqScore * 0.15 +
    scScore * 0.05
  ).toFixed(1));

  return {
    fitScore,
    intentScore,
    timingScore,
    evidenceQualityScore: eqScore,
    sourceConfidenceScore: scScore,
    finalScore,
  };
}
