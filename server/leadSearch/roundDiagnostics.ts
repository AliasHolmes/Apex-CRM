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

const matchesRequirement = (lead: Record<string, any>, requirement: ProspectRequirement) => {
  const text = candidateText(lead);
  const terms = requirement.acceptableTerms.map(normalize);

  // Exact term matching against the contract's compiled acceptable terms (synonyms are already expanded in contract)
  if (terms.some(term => term && text.includes(term))) return true;

  return false;
};

/** Deterministic recovery trigger based on contract terms and session-wide progress. */
export function buildRoundDiagnostics(params: {
  round: number;
  rawCandidates: number;
  extractedCandidates: number;
  leads: Record<string, any>[];
  contract: ProspectContract;
  targetLimit: number;
  alreadyQualified?: number;
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

  const banked = params.alreadyQualified ?? 0;
  return {
    round: params.round,
    rawCandidates: params.rawCandidates,
    extractedCandidates: params.extractedCandidates,
    viableCandidates,
    requirements,
    missingHardRequirementIds,
    shouldRecover: (banked + viableCandidates) < Math.ceil(params.targetLimit * 0.5) || missingHardRequirementIds.length > 0
  };
}

