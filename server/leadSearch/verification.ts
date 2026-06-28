export type DecisionMakerVerification = {
  titleMatched: boolean;
  companyMatched: boolean;
  ignoredTitle: boolean;
  confidence: number;
  reason: string;
};

const POSITIVE_KEYWORDS = [
  'founder', 'co-founder', 'owner', 'ceo', 'president', 'principal',
  'partner', 'managing director', 'operator', 'practice owner',
  'broker owner', 'head of growth', 'vp', 'director', 'coo'
];

const WEAK_KEYWORDS = [
  'intern', 'student', 'assistant', 'coordinator', 'associate',
  'specialist', 'representative', 'consultant'
];

export function verifyDecisionMakerFromEvidence(input: {
  query: string;
  fullName?: string;
  currentTitle?: string;
  currentCompany?: string;
  headline?: string;
  evidenceText?: string;
}): DecisionMakerVerification {
  const queryLower = input.query.toLowerCase();
  
  const textToSearch = [
    input.currentTitle || '',
    input.headline || '',
    input.evidenceText || ''
  ].join(' ').toLowerCase();

  // If query explicitly asks for a weak title (e.g. "I want interns"), don't ignore it
  const isWeakTitleRequested = WEAK_KEYWORDS.some(kw => queryLower.includes(kw));
  
  const hasPositiveTitle = POSITIVE_KEYWORDS.some(kw => textToSearch.includes(kw));
  const hasWeakTitle = WEAK_KEYWORDS.some(kw => textToSearch.includes(kw));

  const ignoredTitle = !isWeakTitleRequested && hasWeakTitle && !hasPositiveTitle;
  
  const companyMatched = Boolean(input.currentCompany && textToSearch.includes(input.currentCompany.toLowerCase()));
  
  let confidence = 0;
  let reason = '';

  if (ignoredTitle) {
    confidence = 2;
    reason = 'Weak or ignored title';
  } else if (hasPositiveTitle && companyMatched && input.evidenceText && input.evidenceText.includes('LINK:')) {
    confidence = 9;
    reason = 'Positive title with company support and good evidence';
  } else if (hasPositiveTitle) {
    confidence = 7;
    reason = 'Positive title identified';
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
