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

import { applySigmoidScaling, computeMMRDiversitySelection, normalizeScorePool, computeParetoFrontier, rankLeadForFinalSelection } from './scoring.js';

const candidateKey = (c: any): string => {
  return String(
    c?.id ||
    c?.stableId ||
    c?.candidateId ||
    c?.fullName ||
    c?.profile?.fullName ||
    c?.contactDetails?.linkedinUrl ||
    c?.profile?.contactDetails?.linkedinUrl ||
    c?.linkedinUrl ||
    c?.sourceUrl ||
    c?.evidence?.sourceUrl ||
    c?.email ||
    c?.profile?.email ||
    (c ? JSON.stringify(c) : 'unknown')
  );
};

/** Select high-quality prospects while preventing one account from consuming a run and balancing portfolio diversity via MMR. */
export function selectDiversifiedLeads<T extends Record<string, any>>(
  candidates: T[],
  limit: number,
  maxPerCompany: number,
  logEvent?: (msg: string) => void
) {
  // --- Step 0: Shannon Entropy Normalization & Sigmoid Scaling ---
  // Widen score distribution when candidates cluster tightly (low entropy),
  // so MMR and Sigmoid can meaningfully differentiate them.
  const rawScores = candidates.map(c => {
    const raw = Number(
      (c as any).finalSelectionScore ??
      (c as any).profile?.finalSelectionScore ??
      (c as any).scoreBreakdown?.finalScore ??
      (c as any).qualification?.finalScore ??
      (c as any).profile?.qualification?.finalScore ??
      (c as any).effectiveScore ??
      rankLeadForFinalSelection(c)
    );
    return raw <= 1.0 && raw > 0 ? raw * 10 : raw;
  });
  const entropyNormalizedScores = normalizeScorePool(rawScores);
  if (logEvent && rawScores.length >= 2) {
    const rawAvg = (rawScores.reduce((a, b) => a + b, 0) / rawScores.length).toFixed(2);
    const normAvg = (entropyNormalizedScores.reduce((a, b) => a + b, 0) / entropyNormalizedScores.length).toFixed(2);
    logEvent(`[Shannon Entropy] Normalized ${rawScores.length} candidate scores: mean raw=${rawAvg} -> mean normalized=${normAvg}`);
  }
  const scoredCandidates = candidates.map((c, i) => {
    const normalized_score = entropyNormalizedScores[i];
    const baseScore = typeof normalized_score === 'number' && Number.isFinite(normalized_score)
      ? normalized_score
      : rawScores[i] || 5;
    const finalSelectionScore = applySigmoidScaling(baseScore);
    return { ...c, finalSelectionScore };
  }) as T[];

  // --- Step 1: Pareto Skyline Optimization ---
  // Identify non-dominated candidates across (authority, company intent, post intent, evidence quality)
  // to protect specialist outlier leads from aggregate linear score washout.
  const { skyline } = computeParetoFrontier(scoredCandidates);
  if (logEvent && skyline.length > 0) {
    logEvent(`[Pareto Skyline] Identified ${skyline.length}/${candidates.length} non-dominated Pareto Front candidates across authority, company intent, post intent, and evidence quality.`);
  }

  const GENERIC_INDEPENDENT_COMPANIES = new Set([
    'self-employed',
    'self employed',
    'freelance',
    'freelancer',
    'independent',
    'independent consultant',
    'consultant',
    'stealth',
    'stealth startup',
    'confidential',
    'various',
    'multiple',
    'n/a',
    'unknown',
    'owner',
    'founder',
    'ceo'
  ]);

  const extractCompanyKey = (candidate: any, cKey: string) => {
    const raw = normalized(
      candidate.currentCompany ||
      candidate.company ||
      candidate.profile?.currentCompany ||
      candidate.profile?.company ||
      candidate.companyAccount?.name
    );
    if (!raw || GENERIC_INDEPENDENT_COMPANIES.has(raw)) {
      return `independent:${cKey}`;
    }
    return raw;
  };

  // Sort skyline by candidate rank to take top-scoring non-dominated candidates first
  const sortedSkyline = [...skyline].sort((a, b) => rankLeadForFinalSelection(b) - rankLeadForFinalSelection(a));

  // Reserve up to 30% of slots for top Pareto non-dominated candidates, respecting maxPerCompany
  const paretoReservation = Math.max(0, Math.ceil(limit * 0.30));
  const perCompany = new Map<string, number>();
  const paretoGuaranteed: T[] = [];

  for (const candidate of sortedSkyline) {
    if (paretoGuaranteed.length >= paretoReservation) break;
    const cKey = candidateKey(candidate);
    const compKey = extractCompanyKey(candidate, cKey);
    const currentCount = perCompany.get(compKey) || 0;
    if (currentCount < maxPerCompany) {
      paretoGuaranteed.push(candidate);
      perCompany.set(compKey, currentCount + 1);
    }
  }
  const paretoIds = new Set(paretoGuaranteed.map(candidateKey));

  // --- Step 2: Per-company cap on remaining candidates ---
  const filtered: T[] = [];
  const ordered = [...scoredCandidates].sort((a, b) => Number((b as any).finalSelectionScore || 0) - Number((a as any).finalSelectionScore || 0));
  for (const candidate of ordered) {
    const cKey = candidateKey(candidate);
    if (paretoIds.has(cKey)) continue; // Already guaranteed and counted in perCompany
    const companyKey = extractCompanyKey(candidate, cKey);
    const currentCount = perCompany.get(companyKey) || 0;
    if (currentCount >= maxPerCompany) continue;
    filtered.push(candidate);
    perCompany.set(companyKey, currentCount + 1);
  }

  // --- Step 3: MMR Diversity Selection ---
  const mmrLimit = Math.max(0, limit - paretoGuaranteed.length);
  const mmrSelected = computeMMRDiversitySelection(filtered, mmrLimit, 0.75);
  const finalSelected = [...paretoGuaranteed, ...mmrSelected].slice(0, limit);

  if (logEvent) {
    logEvent(`[MMR Selection] Selected ${finalSelected.length}/${candidates.length} candidates using MMR diversity (lambda=0.75, maxPerCompany=${maxPerCompany}, paretoGuaranteed=${paretoGuaranteed.length}).`);
  }
  return finalSelected;
}
