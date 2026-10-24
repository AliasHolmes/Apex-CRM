import {
  EXECUTIVE_OVERRIDE_REGEX,
  classifyTitle,
  STRICT_IC_REGEX,
  STUDENT_INTERN_ROLE_REGEX,
  STUDENT_CAMPUS_ORG_REGEX,
  SUBORDINATE_ROLE_REGEX,
} from './titleTriage.js';

import type { DecisionMakerVerification } from '../../src/types.js';

export type { DecisionMakerVerification };

const POSITIVE_TITLE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'founder', pattern: /\b(co[-\s]?founder|founder|founding partner)\b/ },
  { label: 'owner', pattern: /\b(practice owner|broker owner|agency owner|business owner|company owner|owner[\/\s-]?operator|operator owner|proprietor)\b/ },
  { label: 'owner', pattern: /\bowner\s+(of|at)\b/ },
  { label: 'fractional_cxo', pattern: /\b(fractional|interim|virtual|part[-\s]?time)\s+(ceo|cfo|coo|cto|cio|cro|cmo|chro|cso|cpo|caio|cgo|cdo|ciso|vp|vice president|director|executive)\b/ },
  { label: 'c-suite', pattern: /\b(ceo|cfo|coo|cto|cio|cro|cmo|chro|cso|cpo|caio|cgo|cdo|ciso|cxo)\b/ },
  { label: 'c-suite', pattern: /\bchief\s+[a-z&\s-]{2,40}\s+officer\b/ },
  { label: 'president', pattern: /\b(president|general manager)\b/ },
  { label: 'partner', pattern: /\b(managing partner|founding partner|partner|equity partner|senior partner)\b/ },
  { label: 'practice_lead', pattern: /\bpractice\s+(lead|director|head|leader|partner|principal)\b/ },
  { label: 'managing director', pattern: /\bmanaging director\b/ },
  { label: 'head', pattern: /\bhead\s+of\s+(growth|sales|revenue|revops|revenue\s+operations|gtm|go[-\s]?to[-\s]?market|demand\s+gen|marketing|engineering|operations|strategy|partnerships|business development|customer success|product|technology|it|commercial|client\s+services|delivery|ai|data)\b/ },
  { label: 'vp', pattern: /\b(vp|svp|evp|vice president)\b/ },
  { label: 'director', pattern: /\b(director|executive director)\b/ },
  { label: 'principal', pattern: /\b(managing\s+principal|senior\s+principal|principal\s+consultant|principal\s+advisor|principal\s+partner)\b/ },
  { label: 'principal', pattern: /\bprincipal\b(?!\s+(?:(?:software|ai|ml|data|systems?|machine\s+learning)\s+)?(?:engineer|software|architect|developer|designer|researcher|scientist))\b/ }
];

const POSITIVE_SENIORITY_PATTERNS = [
  /\b(c[-\s]?suite|executive|founder|owner|partner|vp|vice president|head|director|fractional|interim)\b/,
  EXECUTIVE_OVERRIDE_REGEX,
];

const WEAK_TITLE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'assistant', pattern: /\b(executive assistant|assistant\s+(?:to|for)|assistant\s+(?:director|manager|principal)|assistant)\b/i },
  { label: 'student', pattern: STUDENT_INTERN_ROLE_REGEX },
  { label: 'intern', pattern: /\bintern(ship)?\b/i },
  { label: 'coordinator', pattern: /\bcoordinator\b/i },
  { label: 'associate', pattern: /\bassociate\b/i },
  { label: 'specialist', pattern: /\bspecialist\b/i },
  { label: 'representative', pattern: /\brepresentative\b/i },
  { label: 'consultant', pattern: /\bconsultant\b(?!\s+(principal|lead|director))/i }
];

const WEAK_REQUEST_PATTERNS = [
  /\b(interns?|students?|assistants?|coordinators?|associates?|specialists?|representatives?)\b/,
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
    if (posMatches.includes('founder') || posMatches.includes('owner') || posMatches.includes('c-suite') || posMatches.includes('fractional_cxo')) roleSeniority = 10.0;
    else if (posMatches.includes('president') || posMatches.includes('partner') || posMatches.includes('managing partner')) roleSeniority = 9.0;
    else if (posMatches.includes('vp') || posMatches.includes('head') || posMatches.includes('managing director') || posMatches.includes('practice_lead')) roleSeniority = 8.0;
    else if (posMatches.includes('director') || posMatches.includes('principal')) roleSeniority = 7.5;
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
    if ((label === 'consultant' || label === 'specialist') && !STRICT_IC_REGEX.test(profileIdentityText)) return false;
    return true;
  });
  const hasStudentOrgConflict = STUDENT_CAMPUS_ORG_REGEX.test(profileIdentityText);
  const hasAssistantAuthorityConflict = SUBORDINATE_ROLE_REGEX.test(profileIdentityText);
  const classification = classifyTitle(profileIdentityText);
  const hasPositiveTitle = positiveMatches.length > 0 || seniorityPositive || classification.isExecutive;
  const hasWeakTitle = weakMatches.length > 0 || classification.isIC;
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
  } else if (hasPositiveTitle) {
    reason = companyMatched && hasEvidenceLink
      ? 'Authority title with company support and good evidence'
      : 'Authority title identified';

    // Base authority score starts at 7.0 for positive authority matches.
    // Calibrated continuous breakdown (B11):
    // 1. Role authority gradient (0.1 - 0.5 pts)
    const isOwnerOrFounder =
      /\b(founder|co-founder|owner|ceo|chief executive|managing director|managing partner|proprietor|president)\b/i.test(profileIdentityText);
    const isLeadershipRole =
      /\b(vp|vice president|head of|director|chief|cfo|coo|cto|cro|cmo|cpo|partner)\b/i.test(profileIdentityText);
    const authorityBonus = isOwnerOrFounder ? 0.5 : isLeadershipRole ? 0.3 : 0.1;

    // 2. Corroborated company entity match (1.0 pt)
    const companyBonus = companyMatched ? 1.0 : 0.0;

    // 3. Valid source evidence link (0.8 pts)
    const evidenceBonus = hasEvidenceLink ? 0.8 : 0.0;

    // 4. Continuous career trajectory bonus (0.0 - 0.7 pts)
    const trajectoryBonus =
      trajectory.roleCount >= 2 && trajectory.trajectoryScore >= 5.0
        ? Math.min(0.7, Number(((trajectory.trajectoryScore / 10) * 0.7).toFixed(1)))
        : 0.0;

    confidence = Math.min(10, Number((7.0 + authorityBonus + companyBonus + evidenceBonus + trajectoryBonus).toFixed(1)));
  } else if (input.currentTitle || input.headline) {
    confidence = 5;
    reason = 'Role context exists but authority unclear';
  } else {
    confidence = 4;
    reason = 'Minimal role context';
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
