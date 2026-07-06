export type DecisionMakerVerification = {
  titleMatched: boolean;
  companyMatched: boolean;
  ignoredTitle: boolean;
  confidence: number;
  reason: string;
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

export function verifyDecisionMakerFromEvidence(input: {
  query: string;
  fullName?: string;
  currentTitle?: string;
  currentCompany?: string;
  headline?: string;
  seniorityLevel?: string;
  evidenceText?: string;
}): DecisionMakerVerification {
  const queryText = normalizeForTitleMatching(input.query);
  const roleText = normalizeForTitleMatching([
    input.currentTitle || '',
    input.headline || ''
  ].join(' '));
  const seniorityText = normalizeForTitleMatching(input.seniorityLevel);
  const evidenceText = normalizeForTitleMatching(input.evidenceText);
  const textToSearch = [roleText, seniorityText, evidenceText].filter(Boolean).join(' ');

  // If query explicitly asks for a weak title (e.g. "I want interns"), don't ignore it.
  const isWeakTitleRequested = WEAK_REQUEST_PATTERNS.some(pattern => pattern.test(queryText));

  const positiveMatches = collectMatches(textToSearch, POSITIVE_TITLE_PATTERNS);
  const seniorityPositive = POSITIVE_SENIORITY_PATTERNS.some(pattern => pattern.test(seniorityText));
  const weakMatches = collectMatches(textToSearch, WEAK_TITLE_PATTERNS);
  const hasStudentOrgConflict = /\b(student|campus|university|college)\s+(club|organization|society|association)\b/.test(textToSearch);
  const hasAssistantAuthorityConflict = /\bassistant\s+(to|for)\s+(the\s+)?(ceo|cfo|coo|cto|cio|cro|cmo|chief|president|founder|owner|partner)\b/.test(textToSearch);

  const hasPositiveTitle = positiveMatches.length > 0 || seniorityPositive;
  const hasWeakTitle = weakMatches.length > 0;
  const weakConflictOverridesPositive = hasStudentOrgConflict || hasAssistantAuthorityConflict;
  const ignoredTitle = !isWeakTitleRequested && hasWeakTitle && (!hasPositiveTitle || weakConflictOverridesPositive);

  const companyMatched = Boolean(input.currentCompany && textToSearch.includes(normalizeForTitleMatching(input.currentCompany)));
  
  let confidence = 0;
  let reason = '';

  if (ignoredTitle) {
    confidence = 2;
    reason = weakConflictOverridesPositive
      ? 'Weak context overrides authority keyword'
      : 'Weak or ignored title';
  } else if (hasPositiveTitle && companyMatched && input.evidenceText && input.evidenceText.includes('LINK:')) {
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

  return {
    titleMatched: hasPositiveTitle,
    companyMatched,
    ignoredTitle,
    confidence,
    reason
  };
}
