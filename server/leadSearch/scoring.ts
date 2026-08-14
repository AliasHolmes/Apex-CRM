export type LeadSourceProvider = 'tavily' | 'brightdata' | 'cache' | 'manual' | 'import';
export type EvidenceQuality = 'weak' | 'partial' | 'good';

export type ScoreBreakdown = {
  fitScore: number;
  intentScore: number;
  timingScore: number;
  evidenceQualityScore: number;
  sourceConfidenceScore: number;
  finalScore: number;
  confidenceInterval?: {
    lower: number;
    upper: number;
    uncertainty: number;
  };
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
  if (!companyIntent) return 5;
  const tfidfBonus = typeof companyIntent.tfidfWeightedScore === 'number' ? companyIntent.tfidfWeightedScore * 2 : 0;
  if (companyIntent.evidenceQuality === 'good') return Math.min(10, Number((9 + tfidfBonus).toFixed(2)));
  if (companyIntent.evidenceQuality === 'partial') return Math.min(10, Number((7 + tfidfBonus).toFixed(2)));
  if (Array.isArray(companyIntent.buyingSignals) && companyIntent.buyingSignals.length >= 4) return 6;
  const accountScore = Number(lead.companyAccount?.operationalPainScore);
  if (Number.isFinite(accountScore) && accountScore > 0) {
    return accountScore > 10 ? Math.min(accountScore / 10, 10) : Math.min(accountScore, 10);
  }
  return 5;
};

export function computeBayesianIntentDelta(intent: Record<string, any>, cacheAgeDays = 0): number {
  if (!intent) return 0;

  const dynamicMatches = Array.isArray(intent.dynamicSignals) ? intent.dynamicSignals.length : 0;
  const universalMatches = Array.isArray(intent.universalSignals) ? intent.universalSignals.length : 0;
  const pagesMatched = Number(intent.pagesMatched) || 1;

  if (dynamicMatches === 0 && universalMatches === 0 && intent.evidenceQuality !== 'good' && intent.evidenceQuality !== 'partial') {
    return 0;
  }

  // Prior probability P0 = 0.25; likelihood factor scales with signal density & multi-page hits
  const prior = 0.25;
  const signalDensity = (dynamicMatches * 1.8) + (universalMatches * 0.4);
  const likelihoodFactor = Math.max(0.5, signalDensity * Math.min(pagesMatched, 3));
  
  // Bayesian update: P(Intent | Evidence) = (prior * L) / (prior * L + (1 - prior))
  const posterior = (prior * likelihoodFactor) / (prior * likelihoodFactor + (1 - prior));

  const baseDelta = intent.evidenceQuality === 'good'
    ? Math.max(0.80, posterior * 1.20)
    : intent.evidenceQuality === 'partial'
      ? Math.max(0.40, posterior * 0.70)
      : posterior * 0.30;

  // Exponential recency time-decay (14-day half-life: lambda = 0.05)
  const decayFactor = Math.exp(-0.05 * Math.max(0, cacheAgeDays));

  return Number((baseDelta * decayFactor).toFixed(2));
}

export function applySigmoidScaling(rawScore: number, midpoint = 5.5, steepness = 0.45): number {
  const clamped = Math.min(Math.max(rawScore, 1), 10);
  const sigmoid = 1 / (1 + Math.exp(-steepness * (clamped - midpoint)));
  const minSigmoid = 1 / (1 + Math.exp(-steepness * (1 - midpoint)));
  const maxSigmoid = 1 / (1 + Math.exp(-steepness * (10 - midpoint)));
  const scaled = 1 + 9 * ((sigmoid - minSigmoid) / (maxSigmoid - minSigmoid));
  return Number(scaled.toFixed(2));
}

/**
 * Kalman filter for fusing sequential score observations of the same lead.
 * Merges a new observed score (newObservation) into an existing estimate
 * (priorEstimate) using provider reliability (processNoise) and observation
 * noise (observationNoise) to compute an optimal Kalman-weighted blend.
 *
 * K = P / (P + R)   ->   estimate = prior + K * (obs - prior)
 */
export function computeKalmanFusedScore(
  priorEstimate: number,
  newObservation: number,
  processNoise = 1.0,
  observationNoise = 2.0
): number {
  const kalmanGain = processNoise / (processNoise + observationNoise);
  const fused = priorEstimate + kalmanGain * (newObservation - priorEstimate);
  return Number(Math.min(Math.max(fused, 1), 10).toFixed(2));
}

/**
 * Shannon entropy normalization for a session-wide pool of scores.
 * Widens the score distribution when it is tightly clustered (low entropy)
 * and leaves it untouched when it is already diverse (high entropy).
 *
 * H = -Sum(p_i * log2(p_i)),  p_i = S_i / Sum(S_j)
 * adjustment = alpha * (H_max - H) / H_max,  alpha = 0.15
 */
export function normalizeScorePool(scores: number[], alpha = 0.15): number[] {
  if (scores.length < 2) return scores;
  const total = scores.reduce((s, v) => s + v, 0);
  if (total === 0) return scores;

  const probs = scores.map(s => s / total);
  const entropy = -probs.reduce((h, p) => h + (p > 0 ? p * Math.log2(p) : 0), 0);
  const maxEntropy = Math.log2(scores.length);
  if (maxEntropy === 0) return scores;

  // Low entropy -> tightly clustered -> amplify spread
  const spreadFactor = 1 + alpha * ((maxEntropy - entropy) / maxEntropy);

  const mean = total / scores.length;
  const normalized = scores.map(s => {
    const adjusted = mean + (s - mean) * spreadFactor;
    return Number(Math.min(Math.max(adjusted, 1), 10).toFixed(2));
  });
  return normalized;
}

/**
 * TF-IDF weight for a single intent signal term across a corpus of scraped pages.
 * signalCount  = occurrences of the term in this company's scraped text (TF proxy).
 * totalDocs    = total companies scraped this session.
 * docsWithTerm = how many companies contained this term (DF).
 *
 * weight = signalCount * log(totalDocs / (1 + docsWithTerm))
 */
export function computeTfIdfSignalWeight(
  signalCount: number,
  totalDocs: number,
  docsWithTerm: number
): number {
  if (signalCount <= 0 || totalDocs <= 0) return 0;
  const idf = Math.log(totalDocs / (1 + docsWithTerm));
  return Number(Math.max(0, signalCount * idf).toFixed(4));
}

export function applyIntentEnrichmentDelta(lead: Record<string, any>, cacheAgeDays = 0): number {
  const base = Number(lead.finalSelectionScore ?? lead.qualification?.finalScore ?? rankLeadForFinalSelection(lead));
  const intent = lead.companyIntentEvidence;
  if (!intent) return base;

  const delta = computeBayesianIntentDelta(intent, cacheAgeDays);
  const rawEnriched = applyHardCaps(base + delta, lead);

  // Kalman fusion: if this lead was already scored in a prior round (priorObservedScore),
  // fuse the current enriched score with the earlier observation rather than discarding it.
  // processNoise=1.0, observationNoise=2.0 -> Kalman gain ~= 0.33 (conservatively trusts prior)
  const priorObservedScore = Number(lead._priorScore);
  const finalScore = Number.isFinite(priorObservedScore) && priorObservedScore > 0
    ? computeKalmanFusedScore(priorObservedScore, rawEnriched, 1.0, 2.0)
    : rawEnriched;

  return Number(finalScore.toFixed(2));
}

export function computeMMRDiversitySelection<T extends Record<string, any>>(
  candidates: T[],
  targetCount: number,
  lambda = 0.70
): T[] {
  if (candidates.length <= targetCount) return candidates;

  const selected: T[] = [];
  const pool = [...candidates].sort((a, b) => rankLeadForFinalSelection(b) - rankLeadForFinalSelection(a));

  selected.push(pool.shift()!);

  while (selected.length < targetCount && pool.length > 0) {
    let bestIdx = 0;
    let bestMMR = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i];
      const score = rankLeadForFinalSelection(candidate) / 10;

      let maxSim = 0;
      for (const sel of selected) {
        let sim = 0;
        const candCompany = (candidate.currentCompany || candidate.company || '').toLowerCase();
        const selCompany = (sel.currentCompany || sel.company || '').toLowerCase();
        if (candCompany && selCompany && candCompany === selCompany) sim += 0.8;

        const candLoc = (candidate.location || '').toLowerCase();
        const selLoc = (sel.location || '').toLowerCase();
        if (candLoc && selLoc && candLoc === selLoc) sim += 0.2;

        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * score - (1 - lambda) * maxSim;
      if (mmr > bestMMR) {
        bestMMR = mmr;
        bestIdx = i;
      }
    }

    selected.push(pool.splice(bestIdx, 1)[0]);
  }

  return selected;
}

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

export function rankLeadForFinalSelection(lead: Record<string, any>, corpusStats?: BM25CorpusStats): number {
  const qualificationScore = Number(lead.qualification?.finalScore ?? lead.finalSelectionScore);
  if ((lead.qualification?.verdict === 'qualified' || Number.isFinite(lead.finalSelectionScore)) && Number.isFinite(qualificationScore)) {
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

  // BM25+ Profile & Evidence Text Relevance:
  const queryTerms = Array.isArray(lead.scout?.matchedCriteria) ? lead.scout.matchedCriteria : [];
  const profileDoc = `${lead.headline || ''} ${lead.summary || ''} ${lead.currentTitle || ''} ${lead.currentCompany || ''}`;
  const bm25Bonus = queryTerms.length > 0
    ? computeBM25PlusScore(profileDoc, queryTerms, corpusStats) * 0.05
    : 0;

  // Pareto Skyline anti-starvation bonus (+0.30 if lead is non-dominated):
  const paretoBonus = lead.paretoSkyline ? 0.30 : 0;

  const rank = (
    authorityScore * 0.30 +
    companyScore * 0.20 +
    evidenceScore * 0.20 +
    corroborationScore * 0.15 +
    criteriaCoverageScore * 0.10 +
    sourceScore * 0.03 +
    baseScore * 0.02 +
    bm25Bonus +
    paretoBonus
  );

  const capped = applyHardCaps(rank, lead, audit);
  return Number(capped.toFixed(2));
}

export type BM25CorpusStats = {
  avgDocLength: number;
  totalDocs: number;
  docFrequencies: Map<string, number>;
};

export class BM25CorpusTracker {
  private totalDocs = 0;
  private totalLength = 0;
  private docFrequencies = new Map<string, number>();

  public registerDocument(text: string) {
    if (!text) return;
    const tokens = text.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    this.totalDocs++;
    this.totalLength += tokens.length;
    const seen = new Set(tokens);
    for (const term of seen) {
      this.docFrequencies.set(term, (this.docFrequencies.get(term) ?? 0) + 1);
    }
  }

  public getStats(): BM25CorpusStats {
    return {
      avgDocLength: this.totalDocs > 0 ? this.totalLength / this.totalDocs : 50,
      totalDocs: this.totalDocs,
      docFrequencies: this.docFrequencies
    };
  }
}

/**
 * Computes Okapi BM25+ score with document length normalization and term saturation.
 * BM25+(D, Q) = Sum_t IDF(t) * [ (TF * (k1 + 1)) / (TF + k1 * (1 - b + b * (|D| / avgdl))) + delta ]
 */
export function computeBM25PlusScore(
  documentText: string,
  queryTerms: string[],
  stats?: BM25CorpusStats,
  k1 = 1.2,
  b = 0.75,
  delta = 0.5
): number {
  if (!documentText || !queryTerms || queryTerms.length === 0) return 0;
  const docTokens = documentText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const docLength = docTokens.length;
  if (docLength === 0) return 0;

  const avgdl = stats?.avgDocLength || 50;
  const totalDocs = Math.max(stats?.totalDocs || 1, 1);
  const docFreqMap = stats?.docFrequencies || new Map<string, number>();

  const tfMap = new Map<string, number>();
  for (const token of docTokens) {
    tfMap.set(token, (tfMap.get(token) ?? 0) + 1);
  }

  let totalScore = 0;
  for (const rawTerm of queryTerms) {
    const term = rawTerm.toLowerCase().trim();
    if (!term || term.length <= 2) continue;
    const tf = tfMap.get(term) ?? 0;
    if (tf === 0) continue;

    const df = docFreqMap.get(term) ?? 1;
    // Robertson-Sparck Jones IDF with smoothing: ln(1 + (N - df + 0.5) / (df + 0.5))
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const termSaturation = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / avgdl)));
    totalScore += Math.max(0, idf) * (termSaturation + delta);
  }

  // Normalize to [0, 10] range
  const normalized = Math.min(10, Math.max(0, totalScore * 1.5));
  return Number(normalized.toFixed(2));
}

export type ParetoObjectiveVector = {
  authority: number;
  intent: number;
  evidenceQuality: number;
};

export function extractObjectiveVector(lead: Record<string, any>): ParetoObjectiveVector {
  const authority = clampScore(lead.decisionMakerVerification?.confidence ?? lead.audit?.authorityConfidence, 5);
  const intent = companyIntentScore(lead);
  const eq = evidenceQualityScore(evidenceQualityForLead(lead));
  return { authority, intent, evidenceQuality: eq };
}

/**
 * Fast Non-Dominated Sorting for extracting the Pareto Skyline Front (Front 1).
 * A candidate a Pareto-dominates b iff a is >= b in all 3 objectives and > in at least one.
 */
export function computeParetoFrontier<T extends Record<string, any>>(candidates: T[]): {
  skyline: T[];
  nonSkyline: T[];
} {
  if (candidates.length <= 1) return { skyline: candidates, nonSkyline: [] };

  const vectors = candidates.map(c => extractObjectiveVector(c));
  const isDominated = new Array<boolean>(candidates.length).fill(false);

  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const u = vectors[j];
      const v = vectors[i];
      const dominates = (
        u.authority >= v.authority &&
        u.intent >= v.intent &&
        u.evidenceQuality >= v.evidenceQuality &&
        (u.authority > v.authority || u.intent > v.intent || u.evidenceQuality > v.evidenceQuality)
      );
      if (dominates) {
        isDominated[i] = true;
        break;
      }
    }
  }

  const skyline: T[] = [];
  const nonSkyline: T[] = [];
  candidates.forEach((c, idx) => {
    if (!isDominated[idx]) {
      (c as any).paretoSkyline = true;
      skyline.push(c);
    } else {
      (c as any).paretoSkyline = false;
      nonSkyline.push(c);
    }
  });

  return { skyline, nonSkyline };
}

/**
 * Estimates epistemic uncertainty and calculates 95% Credible Interval [mu - 1.96*sigma, mu + 1.96*sigma].
 */
export function computeEpistemicCredibleInterval(
  lead: Record<string, any>,
  pointEstimate: number
): { lower: number; upper: number; uncertainty: number } {
  const snippets = Array.isArray(lead.evidence?.snippets) ? lead.evidence.snippets.length : 0;
  const sourceCount = Math.max(1, Number(lead.scout?.sourceCount || 1));
  const quality = evidenceQualityForLead(lead);

  // Variance components:
  // 1. Information volume uncertainty:
  const sigmaInfo = 1.0 / (1.0 + 0.35 * Math.min(snippets, 6));
  // 2. Corroboration cross-check uncertainty:
  const sigmaCorrob = 0.85 / Math.sqrt(sourceCount);
  // 3. Intent scrape verification uncertainty:
  const sigmaIntent = quality === 'good' ? 0.15 : quality === 'partial' ? 0.35 : 0.70;

  const totalVariance = (sigmaInfo * sigmaInfo + sigmaCorrob * sigmaCorrob + sigmaIntent * sigmaIntent) / 3;
  const sigma = Math.sqrt(totalVariance);

  const lower = Math.max(0, Number((pointEstimate - 1.96 * sigma).toFixed(2)));
  const upper = Math.min(10, Number((pointEstimate + 1.96 * sigma).toFixed(2)));

  return {
    lower,
    upper,
    uncertainty: Number(sigma.toFixed(3))
  };
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

  const confidenceInterval = computeEpistemicCredibleInterval(lead, finalScore);

  return {
    fitScore,
    intentScore,
    timingScore,
    evidenceQualityScore: eqScore,
    sourceConfidenceScore: scScore,
    finalScore: Number(finalScore.toFixed(1)),
    confidenceInterval,
  };
}
