import type { ProspectContract, ProspectRequirement } from './prospectContract.js';

export type RequirementDiagnostic = {
  requirementId: string;
  pass: number;
  fail: number;
  unknown: number;
  passRate: number;
};

export type RoundDiagnostics = {
  round: number;
  rawCandidates: number;
  extractedCandidates: number;
  viableCandidates: number;
  requirements: RequirementDiagnostic[];
  missingHardRequirementIds: string[];
  shouldRecover: boolean;
};

const normalize = (value: unknown) => String(value || '').toLowerCase();
const candidateText = (lead: Record<string, any>) => normalize([
  lead.fullName, lead.currentTitle, lead.headline, lead.currentCompany, lead.location,
  lead.summary, lead.evidence?.rawText, lead.evidence?.summary, ...(lead.evidence?.snippets || [])
].filter(Boolean).join(' '));

const USA_ALIASES = ['usa', 'united states', 'u.s.', 'us ', 'america', 'california', 'new york', 'texas', 'florida', 'illinois', 'washington', 'seattle', 'san francisco', 'los angeles', 'chicago', 'boston', 'austin', 'miami', 'denver', 'atlanta'];
const UK_ALIASES = ['uk', 'united kingdom', 'england', 'scotland', 'wales', 'london', 'manchester', 'birmingham'];
const OWNER_ROLE_ALIASES = ['owner', 'founder', 'co-founder', 'cofounder', 'ceo', 'chief executive', 'managing partner', 'managing director', 'principal', 'president', 'proprietor', 'director'];
const AI_AGENCY_ALIASES = ['ai agency', 'ai agencies', 'ai marketing agency', 'ai consultancy', 'ai studio', 'ai firm', 'artificial intelligence agency', 'ai-powered agency', 'agentic ai'];

const matchesRequirement = (lead: Record<string, any>, requirement: ProspectRequirement) => {
  const text = candidateText(lead);
  const terms = requirement.acceptableTerms.map(normalize);

  // Exact term matching first
  if (terms.some(term => term && text.includes(term))) return true;

  // Semantic expansion for location scope
  if (requirement.scope === 'person_location') {
    const isUSA = terms.some(t => ['usa', 'united states', 'us', 'america'].includes(t));
    if (isUSA && USA_ALIASES.some(alias => text.includes(alias))) return true;

    const isUK = terms.some(t => ['uk', 'united kingdom', 'britain', 'england'].includes(t));
    if (isUK && UK_ALIASES.some(alias => text.includes(alias))) return true;
  }

  // Semantic expansion for role scope
  if (requirement.scope === 'person_role') {
    const isOwnership = terms.some(t => OWNER_ROLE_ALIASES.includes(t));
    if (isOwnership && OWNER_ROLE_ALIASES.some(alias => text.includes(alias))) return true;
  }

  // Semantic expansion for company type scope
  if (requirement.scope === 'company_type') {
    const isAiAgency = terms.some(t => t.includes('ai agency') || t.includes('ai agencies') || t.includes('agency'));
    if (isAiAgency && AI_AGENCY_ALIASES.some(alias => text.includes(alias))) return true;
  }

  return false;
};

/** Deterministic recovery trigger based on this round only, not cumulative logs. */
export function buildRoundDiagnostics(params: {
  round: number;
  rawCandidates: number;
  extractedCandidates: number;
  leads: Record<string, any>[];
  contract: ProspectContract;
  targetLimit: number;
}): RoundDiagnostics {
  const requirements = params.contract.requirements.map(requirement => {
    let pass = 0;
    for (const lead of params.leads) if (matchesRequirement(lead, requirement)) pass++;
    const fail = Math.max(params.leads.length - pass, 0);
    return {
      requirementId: requirement.id,
      pass,
      fail,
      unknown: 0,
      passRate: params.leads.length ? Number((pass / params.leads.length).toFixed(2)) : 0
    };
  });
  const hardRequirementIds = new Set(params.contract.requirements.filter(item => item.importance === 'hard').map(item => item.id));
  const missingHardRequirementIds = requirements.filter(item => hardRequirementIds.has(item.requirementId) && item.passRate < 0.25).map(item => item.requirementId);
  const viableCandidates = params.leads.filter(lead => params.contract.requirements
    .filter(requirement => requirement.importance === 'hard')
    .every(requirement => matchesRequirement(lead, requirement))).length;
  return {
    round: params.round,
    rawCandidates: params.rawCandidates,
    extractedCandidates: params.extractedCandidates,
    viableCandidates,
    requirements,
    missingHardRequirementIds,
    shouldRecover: viableCandidates < Math.ceil(params.targetLimit * 0.5) || missingHardRequirementIds.length > 0
  };
}
