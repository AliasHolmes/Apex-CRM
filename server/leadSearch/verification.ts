export type DecisionMakerVerification = {
  titleMatched: boolean;
  companyMatched: boolean;
  ignoredTitle: boolean;
  confidence: number;
  reason: string;
  trajectoryScore?: number;
};

const POSITIVE_TITLE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'founder', pattern: /\b(co[-\s]?founder|founder|founding partner)\b/ },
  { label: 'owner', pattern: /\b(practice owner|broker owner|agency owner|business owner|company owner|owner[\/\s-]?operator|operator owner|proprietor)\b/ },
  { label: 'owner', pattern: /\bowner\s+(of|at)\b/ },
  { label: 'c-suite', pattern: /\b(ceo|cfo|coo|cto|cio|cro|cmo|chro|cso|cpo)\b/ },
  { label: 'c-suite', pattern: /\bchief\s+[a-z&\s-]{2,40}\s+officer\b/ },
  { label: 'president', pattern: /\b(president|general manager)\b/ },
  { label: 'partner', pattern: /\b(managing partner|partner)\b/ },
  { label: 'managing director', pattern: /\bmanaging director\b/ },
  { label: 'head', pattern: /\bhead\s+of\s+(growth|sales|revenue|marketing|engineering|operations|business development|customer success|product|technology|it)\b/ },
  { label: 'vp', pattern: /\b(vp|svp|evp|vice president)\b/ },
  { label: 'director', pattern: /\b(director|executive director)\b/ },
  { label: 'principal', pattern: /\bprincipal\b(?!\s+(engineer|software|architect|developer|designer|researcher|scientist|consultant))\b/ }
];

const POSITIVE_SENIORITY_PATTERNS = [
  /\b(c[-\s]?suite|executive|founder|owner|partner|vp|vice president|head|director)\b/
];

const WEAK_TITLE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'assistant', pattern: /\b(executive assistant|assistant\s+(to|for)\s+(the\s+)?(ceo|cfo|coo|cto|cio|cro|cmo|chief|president|founder|owner|partner)|assistant\s+(director|manager|principal)|assistant)\b/ },
  { label: 'student', pattern: /\b(student|student club|student organization|campus club|university club|college club)\b/ },
  { label: 'intern', pattern: /\bintern(ship)?\b/ },
  { label: 'coordinator', pattern: /\bcoordinator\b/ },
  { label: 'associate', pattern: /\bassociate\b/ },
  { label: 'specialist', pattern: /\bspecialist\b/ },
  { label: 'representative', pattern: /\brepresentative\b/ },
  { label: 'consultant', pattern: /\bconsultant\b/ }
];

const WEAK_REQUEST_PATTERNS = [
  /\b(interns?|students?|assistants?|coordinators?|associates?|specialists?|representatives?|consultants?)\b/,
  /\bstudent\s+(clubs?|organizations?)\b/
];

const normalizeForTitleMatching = (value?: string) => (value || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const collectMatches = (text: string, patterns: Array<{ label: string; pattern: RegExp }>) => (
  patterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label)
);

/**
 * Calculates Career Trajectory Discounted Cumulative Relevance (DCR).
 * Models past and current roles using exponential recency decay and domain authority:
 * TrajectoryScore = min(10, Sum_{i=0..M-1} [ Seniority(R_i) * DomainRel(R_i) / (1 + gamma)^i ] / Sum_{j=0..M-1} (1 + gamma)^(-j))
 */
export function computeCareerTrajectoryDCR(
  experiences: Array<{ title?: string; company?: string; description?: string }>,
  domainKeywords: string[] = [],
  discountRate = 0.25
): { trajectoryScore: number; roleCount: number } {
  if (!Array.isArray(experiences) || experiences.length === 0) {
    return { trajectoryScore: 5.0, roleCount: 0 };
  }

  const normalizedDomain = domainKeywords.map(k => k.toLowerCase().trim()).filter(Boolean);
  let weightedSum = 0;
  let normalizer = 0;

  for (let i = 0; i < Math.min(experiences.length, 6); i++) {
    const exp = experiences[i];
    const roleText = normalizeForTitleMatching(`${exp.title || ''} ${exp.company || ''} ${exp.description || ''}`);
    const posMatches = collectMatches(roleText, POSITIVE_TITLE_PATTERNS);
    
    // Base seniority weight for role i
    let roleSeniority = 4.0;
    if (posMatches.includes('founder') || posMatches.includes('owner') || posMatches.includes('c-suite')) roleSeniority = 10.0;
    else if (posMatches.includes('president') || posMatches.includes('managing partner')) roleSeniority = 9.0;
    else if (posMatches.includes('vp') || posMatches.includes('head') || posMatches.includes('managing director')) roleSeniority = 8.0;
    else if (posMatches.includes('director')) roleSeniority = 7.0;
    else if (/\b(lead|manager|principal|supervisor)\b/.test(roleText)) roleSeniority = 5.5;

    // Domain relevance (base 0.75 for general tech/business leadership, up to 1.0 for exact keyword matches)
    let domainRel = 0.75;
    if (normalizedDomain.length > 0) {
      const matchCount = normalizedDomain.filter(k => roleText.includes(k)).length;
      domainRel = matchCount > 0 ? Math.min(1.0, 0.85 + matchCount * 0.15) : 0.75;
    } else {
      domainRel = 0.85;
    }

    const discount = Math.pow(1 + discountRate, i);
    weightedSum += (roleSeniority * domainRel) / discount;
    normalizer += 1 / discount;
  }

  const finalScore = normalizer > 0 ? (weightedSum / normalizer) : 5.0;
  return {
    trajectoryScore: Number(Math.min(10, Math.max(1, finalScore)).toFixed(2)),
    roleCount: experiences.length
  };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'are', 'that', 'this', 'from', 'they', 'have',
  'who', 'what', 'where', 'their', 'our', 'can', 'not', 'all', 'has', 'but',
  'looking', 'target', 'prospects', 'companies', 'leads', 'want', 'need'
]);

const QUALIFIED_CONSULTANT_PREFIXES = /\b(principal|senior|managing|strategy|technical|security|healthcare|medical|financial|lead|chief)\b/i;

export function verifyDecisionMakerFromEvidence(input: {
  query: string;
  fullName?: string;
  currentTitle?: string;
  currentCompany?: string;
  headline?: string;
  seniorityLevel?: string;
  evidenceText?: string;
  experiences?: Array<{ title?: string; company?: string; description?: string }>;
}): DecisionMakerVerification {
  const queryText = normalizeForTitleMatching(input.query);
  const roleText = normalizeForTitleMatching([
    input.currentTitle || '',
    input.headline || ''
  ].join(' '));
  const seniorityText = normalizeForTitleMatching(input.seniorityLevel);
  const evidenceText = normalizeForTitleMatching(input.evidenceText);
  const profileIdentityText = [roleText, seniorityText].filter(Boolean).join(' ');
  const textToSearch = [roleText, seniorityText, evidenceText].filter(Boolean).join(' ');

  // If query explicitly asks for a weak title (e.g. "I want interns"), don't ignore it.
  const isWeakTitleRequested = WEAK_REQUEST_PATTERNS.some(pattern => pattern.test(queryText));

  const positiveMatches = collectMatches(textToSearch, POSITIVE_TITLE_PATTERNS);
  const seniorityPositive = POSITIVE_SENIORITY_PATTERNS.some(pattern => pattern.test(seniorityText));
  const rawWeakMatches = collectMatches(profileIdentityText, WEAK_TITLE_PATTERNS);
  const weakMatches = rawWeakMatches.filter(label => {
    if (label === 'consultant' && QUALIFIED_CONSULTANT_PREFIXES.test(profileIdentityText)) return false;
    if (label === 'specialist' && QUALIFIED_CONSULTANT_PREFIXES.test(profileIdentityText)) return false;
    return true;
  });
  const hasStudentOrgConflict = /\b(student|campus|university|college)\s+(club|organization|society|association)\b/.test(profileIdentityText);
  const hasAssistantAuthorityConflict = /\bassistant\s+(to|for)\s+(the\s+)?(ceo|cfo|coo|cto|cio|cro|cmo|chief|president|founder|owner|partner)\b/.test(profileIdentityText);

  const hasPositiveTitle = positiveMatches.length > 0 || seniorityPositive;
  const hasWeakTitle = weakMatches.length > 0;
  const weakConflictOverridesPositive = hasStudentOrgConflict || hasAssistantAuthorityConflict;
  const ignoredTitle = !isWeakTitleRequested && hasWeakTitle && (!hasPositiveTitle || weakConflictOverridesPositive);

  const companyMatched = Boolean(input.currentCompany && textToSearch.includes(normalizeForTitleMatching(input.currentCompany)));
  
  // Calculate Career Trajectory DCR Score:
  const domainKeywords = queryText.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));
  const trajectory = computeCareerTrajectoryDCR(input.experiences || [], domainKeywords);

  let confidence = 0;
  let reason = '';

  const hasEvidenceLink = Boolean(input.evidenceText && (/\b(?:link|url):\s*https?:\/\//i.test(input.evidenceText) || input.evidenceText.includes('LINK:')));

  if (ignoredTitle) {
    confidence = 2;
    reason = weakConflictOverridesPositive
      ? 'Weak context overrides authority keyword'
      : 'Weak or ignored title';
  } else if (hasPositiveTitle && companyMatched && hasEvidenceLink) {
    confidence = 9;
    reason = 'Authority title with company support and good evidence';
  } else if (hasPositiveTitle) {
    confidence = 7;
    reason = 'Authority title identified';
  } else if (input.currentTitle || input.headline) {
    confidence = 5;
    reason = 'Role context exists but authority unclear';
  } else {
    confidence = 4;
    reason = 'Minimal role context';
  }

  // Boost confidence if career trajectory demonstrates proven executive authority (e.g. serial founder / ex-VP)
  if (trajectory.roleCount >= 2 && trajectory.trajectoryScore >= 7.5 && !ignoredTitle) {
    confidence = Math.min(10, Number((confidence + 0.5).toFixed(1)));
  }

  return {
    titleMatched: hasPositiveTitle,
    companyMatched,
    ignoredTitle,
    confidence,
    reason,
    trajectoryScore: trajectory.trajectoryScore
  };
}
