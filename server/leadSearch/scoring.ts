export type LeadSourceProvider = 'tavily' | 'brightdata' | 'cache' | 'manual' | 'import';
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
  if (provider === 'brightdata' || provider === 'manual') return 8;
  if (provider === 'cache' || provider === 'import') return 7;
  return 6;
};

const clampScore = (value: unknown, fallback: number) => scoreOrDefault(value, fallback);

const providerForLead = (lead: Record<string, any>): LeadSourceProvider => {
  const provider = lead.evidence?.sourceProvider || lead.sourceProvider;
  if (provider === 'brightdata') return 'brightdata';
  if (provider === 'cache') return 'cache';
  if (provider === 'manual') return 'manual';
  if (provider === 'import') return 'import';
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

export type AuditSummary = {
  identityConfidence?: number;
  employmentConfidence?: number;
  functionalRelevance?: number;
  authorityConfidence?: number;
  verdict?: 'auto_accept' | 'accept' | 'reject' | 'auto_reject';
};

function applyHardCaps(score: number, lead: Record<string, any>, auditInput?: AuditSummary): number {
  const audit = auditInput || lead.audit;
  let capped = score;

  if (audit) {
    if (audit.verdict === 'reject' || audit.verdict === 'auto_reject') {
      return Math.min(capped, 3.0);
    }
    if ((audit.identityConfidence !== undefined && audit.identityConfidence < 6) ||
        (audit.employmentConfidence !== undefined && audit.employmentConfidence < 6)) {
      capped = Math.min(capped, 6.0);
    }
  }

  const email = lead.profile?.contactDetails?.email || lead.emailDiscovery?.bestEmail || lead.publicEmail;
  const quality = lead.evidence?.evidenceQuality || lead.evidenceQuality;
  if (!email && (quality === 'weak' || quality === 'bad')) {
    capped = Math.min(capped, 7.5);
  }

  return Math.min(Math.max(capped, 1), 10);
}

export function rankLeadForFinalSelection(lead: Record<string, any>): number {
  const qualificationScore = Number(lead.qualification?.finalScore);
  if (lead.qualification?.verdict === 'qualified' && Number.isFinite(qualificationScore)) {
    return Number(Math.min(Math.max(qualificationScore, 0), 10).toFixed(2));
  }
  const audit: AuditSummary | undefined = lead.audit;
  const authorityScore = clampScore(lead.decisionMakerVerification?.confidence ?? audit?.authorityConfidence, 5);
  const companyScore = companyIntentScore(lead);
  const evidenceScore = evidenceQualityScore(evidenceQualityForLead(lead));
  const criteriaCoverageScore = clampScore(lead.scout?.criteriaCoverageScore, 5);
  const corroborationScore = clampScore(lead.scout?.corroborationScore, 4);
  const sourceScore = sourceConfidenceScore(providerForLead(lead));
  const baseScore = clampScore(lead.scoreBreakdown?.finalScore || lead.scoreOverride || lead.fitScore || audit?.functionalRelevance, 5);

  const rank = (
    authorityScore * 0.30 +
    companyScore * 0.20 +
    evidenceScore * 0.20 +
    corroborationScore * 0.15 +
    criteriaCoverageScore * 0.10 +
    sourceScore * 0.03 +
    baseScore * 0.02
  );

  const capped = applyHardCaps(rank, lead, audit);
  return Number(capped.toFixed(2));
}

export function computeScoreBreakdown(
  lead: Record<string, any>,
  quality: EvidenceQuality,
  provider: LeadSourceProvider,
  decisionMakerVerification?: {
    confidence: number;
    ignoredTitle: boolean;
  },
  audit?: AuditSummary
): ScoreBreakdown {
  const activeAudit = audit || lead.audit;
  const fitScore = scoreOrDefault(activeAudit?.functionalRelevance ?? lead.fitScore, 5);
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
  const dmConf = decisionMakerVerification?.confidence ?? activeAudit?.authorityConfidence;
  const dmIgnored = decisionMakerVerification?.ignoredTitle ?? false;

  if (dmConf !== undefined) {
    if (dmConf >= 8) {
      decisionMakerBonus = 0.7;
    } else if (dmConf >= 6) {
      decisionMakerBonus = 0.3;
    }

    if (dmIgnored) {
      ignoredTitlePenalty = 1.5;
    }
  }

  let finalScore = baseScore + decisionMakerBonus - ignoredTitlePenalty;
  finalScore = applyHardCaps(finalScore, lead, activeAudit);

  return {
    fitScore,
    intentScore,
    timingScore,
    evidenceQualityScore: eqScore,
    sourceConfidenceScore: scScore,
    finalScore: Number(finalScore.toFixed(1)),
  };
}
