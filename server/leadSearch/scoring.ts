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

const clampScore = (value: unknown, fallback: number) => scoreOrDefault(value, fallback);

const providerForLead = (lead: Record<string, any>): LeadSourceProvider => {
  const provider = lead.evidence?.sourceProvider || lead.sourceProvider;
  if (provider === 'brightdata') return 'brightdata';
  if (provider === 'cache') return 'cache';
  return 'tavily';
};

const evidenceQualityForLead = (lead: Record<string, any>): EvidenceQuality => {
  const quality = lead.evidence?.evidenceQuality;
  return quality === 'good' || quality === 'partial' ? quality : 'weak';
};

const companyIntentScore = (lead: Record<string, any>) => {
  const companyIntent = lead.companyIntentEvidence;
  if (companyIntent?.evidenceQuality === 'good') return 9;
  if (companyIntent?.evidenceQuality === 'partial') return 7;
  const accountScore = Number(lead.companyAccount?.operationalPainScore);
  if (Number.isFinite(accountScore) && accountScore > 0) {
    return accountScore > 10 ? Math.min(accountScore / 10, 10) : Math.min(accountScore, 10);
  }
  return 5;
};

export function rankLeadForFinalSelection(lead: Record<string, any>): number {
  const authorityScore = clampScore(lead.decisionMakerVerification?.confidence, 5);
  const companyScore = companyIntentScore(lead);
  const evidenceScore = evidenceQualityScore(evidenceQualityForLead(lead));
  const criteriaCoverageScore = clampScore(lead.scout?.criteriaCoverageScore, 5);
  const corroborationScore = clampScore(lead.scout?.corroborationScore, 4);
  const sourceScore = sourceConfidenceScore(providerForLead(lead));
  const baseScore = clampScore(lead.scoreBreakdown?.finalScore || lead.scoreOverride || lead.fitScore, 5);

  const rank = (
    authorityScore * 0.30 +
    companyScore * 0.20 +
    evidenceScore * 0.20 +
    corroborationScore * 0.15 +
    criteriaCoverageScore * 0.10 +
    sourceScore * 0.03 +
    baseScore * 0.02
  );

  return Number(Math.min(Math.max(rank, 1), 10).toFixed(2));
}

export function computeScoreBreakdown(
  lead: Record<string, any>,
  quality: EvidenceQuality,
  provider: LeadSourceProvider,
  decisionMakerVerification?: {
    confidence: number;
    ignoredTitle: boolean;
  }
): ScoreBreakdown {
  const fitScore = scoreOrDefault(lead.fitScore, 5);
  const intentScore = scoreOrDefault(lead.intentScore, 5);
  const timingScore = scoreOrDefault(lead.timingScore, 5);
  const eqScore = evidenceQualityScore(quality);
  const scScore = sourceConfidenceScore(provider);
  
  let baseScore = (
    fitScore * 0.35 +
    intentScore * 0.30 +
    timingScore * 0.15 +
    eqScore * 0.15 +
    scScore * 0.05
  );

  let decisionMakerBonus = 0;
  let ignoredTitlePenalty = 0;

  if (decisionMakerVerification) {
    if (decisionMakerVerification.confidence >= 8) {
      decisionMakerBonus = 0.7;
    } else if (decisionMakerVerification.confidence >= 6) {
      decisionMakerBonus = 0.3;
    }

    if (decisionMakerVerification.ignoredTitle) {
      ignoredTitlePenalty = 1.5;
    }
  }

  let finalScore = baseScore + decisionMakerBonus - ignoredTitlePenalty;
  finalScore = Math.min(Math.max(finalScore, 1), 10); // clamp 1-10

  return {
    fitScore,
    intentScore,
    timingScore,
    evidenceQualityScore: eqScore,
    sourceConfidenceScore: scScore,
    finalScore: Number(finalScore.toFixed(1)),
  };
}
