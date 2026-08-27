import type { ProspectContract, ProspectRequirement, RequirementClass } from './prospectContract.js';
import { isFlagEnabled } from './featureFlags.js';

export type RequirementDiagnostic = {
  requirementId: string;
  pass: number;
  fail: number;
  unknown: number;
  passRate: number;
};

export type ClassDiagnosticSummary = {
  identityPassRate: number;
  contextPassRate: number;
  evidencePassRate: number;
  bottleneckClass: RequirementClass | null;
};

export type RoundDiagnostics = {
  round: number;
  rawCandidates: number;
  extractedCandidates: number;
  viableCandidates: number;
  requirements: RequirementDiagnostic[];
  missingHardRequirementIds: string[];
  shouldRecover: boolean;
  classSummary?: ClassDiagnosticSummary;
};

const normalize = (value: unknown) => String(value || '').toLowerCase();
const candidateText = (lead: Record<string, any>) => normalize([
  lead.fullName, lead.currentTitle, lead.headline, lead.currentCompany, lead.location,
  lead.summary, lead.evidence?.rawText, lead.evidence?.summary, ...(lead.evidence?.snippets || [])
].filter(Boolean).join(' '));

const matchesRequirement = (lead: Record<string, any>, requirement: ProspectRequirement) => {
  const text = candidateText(lead);
  const terms = requirement.acceptableTerms.map(normalize).filter(Boolean);

  // 1. Direct substring match against compiled acceptable terms
  if (terms.some(term => text.includes(term))) return true;

  // 2. Multi-Signal Role Evaluation: If scope is person_role, authority verification or executive title satisfies role
  if (requirement.scope === 'person_role') {
    if (lead.decisionMakerVerification?.verified === true) return true;
    const title = normalize(lead.currentTitle || lead.title || lead.headline || '');
    if (/\b(founder|co-founder|cofounder|owner|ceo|president|partner|managing director|principal)\b/i.test(title)) {
      return true;
    }
  }

  // 3. Multi-Signal Company / Industry Evaluation:
  // If requirement has multi-word terms (e.g. "marketing agency"), match if all significant constituent
  // words (e.g. "marketing" and "agency") appear across the candidate profile/evidence text.
  if (requirement.scope === 'company_type' || requirement.scope === 'company_industry') {
    for (const term of terms) {
      const words = term.split(/\s+/).filter(w => w.length > 2);
      if (words.length > 1 && words.every(w => text.includes(w))) {
        return true;
      }
    }
  }

  // 4. Multi-Signal Location Evaluation: Check candidate location field directly
  if (requirement.scope === 'person_location') {
    const loc = normalize(lead.location || lead.profile?.location || '');
    if (terms.some(term => loc.includes(term))) return true;
  }

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

  let classSummary: ClassDiagnosticSummary | undefined;
  if (isFlagEnabled.enhancedDiagnostics()) {
    const calcClassRate = (cls: RequirementClass) => {
      const matchingReqs = params.contract.requirements.filter(r => (r.requirementClass || (r.scope === 'person_role' ? 'identity_hard' : 'context_hard')) === cls && r.importance === 'hard');
      if (!matchingReqs.length) return 1.0;
      const diagMatches = requirements.filter(d => matchingReqs.some(m => m.id === d.requirementId));
      const avg = diagMatches.reduce((sum, d) => sum + d.passRate, 0) / diagMatches.length;
      return Number(avg.toFixed(2));
    };

    const identityPassRate = calcClassRate('identity_hard');
    const contextPassRate = calcClassRate('context_hard');
    const evidencePassRate = calcClassRate('evidence_required');

    let bottleneckClass: RequirementClass | null = null;
    const lowest = Math.min(identityPassRate, contextPassRate, evidencePassRate);
    if (lowest < 0.5) {
      if (lowest === identityPassRate) bottleneckClass = 'identity_hard';
      else if (lowest === contextPassRate) bottleneckClass = 'context_hard';
      else bottleneckClass = 'evidence_required';
    }

    classSummary = {
      identityPassRate,
      contextPassRate,
      evidencePassRate,
      bottleneckClass
    };
  }

  const banked = params.alreadyQualified ?? 0;
  return {
    round: params.round,
    rawCandidates: params.rawCandidates,
    extractedCandidates: params.extractedCandidates,
    viableCandidates,
    requirements,
    missingHardRequirementIds,
    shouldRecover: (banked + viableCandidates) < Math.ceil(params.targetLimit * 0.5) || missingHardRequirementIds.length > 0,
    classSummary
  };
}

