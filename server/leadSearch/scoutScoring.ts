import type { SearchSpec } from './searchSpec.js';

export type ScoutEvidence = {
  matchedCriteria: string[];
  sourceCount: number;
  sourceProviders: string[];
  lanes: string[];
  criteriaCoverageScore: number;
  corroborationScore: number;
  evidenceCoverageScore: number;
  uncertainties: string[];
};

const unique = (values: string[]) => Array.from(new Set(values.filter(Boolean)));
const normalized = (value: unknown) => String(value || '').toLowerCase();
const clamp10 = (value: number) => Math.min(10, Math.max(1, Number(value.toFixed(2))));

const haystackForLead = (lead: Record<string, any>) => normalized([
  lead.fullName,
  lead.currentTitle,
  lead.jobTitle,
  lead.currentCompany,
  lead.company,
  lead.location,
  lead.summary,
  lead.evidence?.summary,
  lead.evidence?.rawText,
  lead.companyAccount?.industry,
  lead.companyAccount?.description
].filter(Boolean).join(' '));

const criterionMatches = (label: string, values: string[], haystack: string) => (
  values.some((value) => haystack.includes(normalized(value))) ? label : ''
);

/**
 * Records why a prospect is present without turning the scout stage into
 * account enrichment or contact discovery.
 */
export function buildScoutEvidence(
  lead: Record<string, any>,
  spec: SearchSpec,
  options: { sourceProviders?: string[]; lanes?: string[]; sourceCount?: number } = {}
): ScoutEvidence {
  const haystack = haystackForLead(lead);
  const matchedCriteria = unique([
    criterionMatches('target title', spec.person.includeTitles, haystack),
    criterionMatches('target seniority', spec.person.seniorities, haystack),
    criterionMatches('target location', spec.person.locations, haystack),
    criterionMatches('company industry', spec.company.industries, haystack),
    criterionMatches('company keyword', spec.company.keywords, haystack),
    criterionMatches('buying signal', spec.signals.include, haystack)
  ]);
  const requestedCriteria = [
    spec.person.includeTitles.length,
    spec.person.seniorities.length,
    spec.person.locations.length,
    spec.company.industries.length,
    spec.company.keywords.length,
    spec.signals.include.length
  ].filter(Boolean).length || 1;
  const sourceProviders = unique(options.sourceProviders || [String(lead.evidence?.sourceProvider || lead.sourceProvider || 'tavily')]);
  const sourceCount = Math.max(options.sourceCount || sourceProviders.length, 1);
  const lanes = unique(options.lanes || [String(lead.discoveryLane || 'person')]);
  const criteriaCoverageScore = clamp10(2 + (matchedCriteria.length / requestedCriteria) * 8);
  const corroborationScore = clamp10(2 + Math.min(sourceProviders.length, 3) * 2.5 + Math.min(sourceCount, 4) * 0.75);
  const evidenceText = String(lead.evidence?.rawText || lead.evidence?.summary || lead.summary || '');
  const evidenceCoverageScore = clamp10(2 + Math.min(evidenceText.length / 180, 1) * 5 + (matchedCriteria.length ? 2 : 0));
  const uncertainties = unique([
    lead.evidence?.evidenceQuality === 'weak' ? 'Search result has limited supporting detail.' : '',
    !(lead.currentCompany || lead.company) || !(lead.currentTitle || lead.jobTitle) ? 'Company or role is incomplete in the public result.' : '',
    sourceProviders.length < 2 ? 'Not independently corroborated yet.' : ''
  ]);

  return {
    matchedCriteria,
    sourceCount,
    sourceProviders,
    lanes,
    criteriaCoverageScore,
    corroborationScore,
    evidenceCoverageScore,
    uncertainties
  };
}

import { applySigmoidScaling, computeMMRDiversitySelection, normalizeScorePool, computeParetoFrontier } from './scoring.js';

/** Select high-quality prospects while preventing one account from consuming a run and balancing portfolio diversity via MMR. */
export function selectDiversifiedLeads<T extends Record<string, any>>(
  candidates: T[],
  limit: number,
  maxPerCompany: number,
  logEvent?: (msg: string) => void
) {
  // --- Step 0: Pareto Skyline Optimization ---
  // Identify non-dominated candidates across (authority, intent, evidence quality)
  // to protect specialist outlier leads from aggregate linear score washout.
  const { skyline } = computeParetoFrontier(candidates);
  if (logEvent && skyline.length > 0) {
    logEvent(`[Pareto Skyline] Identified ${skyline.length}/${candidates.length} non-dominated Pareto Front candidates across authority, intent, and evidence quality.`);
  }

  // --- Step 1: Shannon Entropy Normalization ---
  // Widen score distribution when candidates cluster tightly (low entropy),
  // so MMR and Sigmoid can meaningfully differentiate them.
  const rawScores = candidates.map(c => Number((c as any).finalSelectionScore ?? 0));
  const entropyNormalizedScores = normalizeScorePool(rawScores);
  if (logEvent && rawScores.length >= 2) {
    const rawAvg = (rawScores.reduce((a, b) => a + b, 0) / rawScores.length).toFixed(2);
    const normAvg = (entropyNormalizedScores.reduce((a, b) => a + b, 0) / entropyNormalizedScores.length).toFixed(2);
    logEvent(`[Shannon Entropy] Normalized ${rawScores.length} candidate scores: mean raw=${rawAvg} -> mean normalized=${normAvg}`);
  }
  const scoredCandidates = candidates.map((c, i) => {
    const normalized_score = entropyNormalizedScores[i];
    return typeof normalized_score === 'number' && Number.isFinite(normalized_score)
      ? { ...c, finalSelectionScore: normalized_score }
      : c;
  }) as T[];

  // --- Step 2: Per-company cap + Sigmoid scaling ---
  const perCompany = new Map<string, number>();
  const filtered: T[] = [];
  const ordered = [...scoredCandidates].sort((a, b) => Number(b.finalSelectionScore || 0) - Number(a.finalSelectionScore || 0));
  for (const candidate of ordered) {
    if ((candidate as any).finalSelectionScore !== undefined) {
      (candidate as any).finalSelectionScore = applySigmoidScaling(Number((candidate as any).finalSelectionScore));
    }
    const companyKey = normalized(candidate.currentCompany || candidate.company || candidate.companyAccount?.name) || `unknown:${candidate.id || candidate.fullName}`;
    const currentCount = perCompany.get(companyKey) || 0;
    if (currentCount >= maxPerCompany) continue;
    filtered.push(candidate);
    perCompany.set(companyKey, currentCount + 1);
  }

  // --- Step 3: MMR Diversity Selection ---
  const finalSelected = computeMMRDiversitySelection(filtered, limit, 0.75);
  if (logEvent) {
    logEvent(`[MMR Selection] Selected ${finalSelected.length}/${candidates.length} candidates using MMR diversity (lambda=0.75, maxPerCompany=${maxPerCompany}).`);
  }
  return finalSelected;
}
