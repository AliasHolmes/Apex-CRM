import { Type } from '../services/llm.js';
import type { ProspectContract, ProspectRequirement } from './prospectContract.js';
import { hasStrictStructuredMatch, selectEvidenceForFinalist } from './evidenceSelection.js';
import { rankLeadForFinalSelection } from './scoring.js';

export type RequirementStatus = 'pass' | 'fail' | 'unknown';

export type RequirementAssessment = {
  requirementId: string;
  status: RequirementStatus;
  evidenceId?: string;
  evidenceQuote?: string;
  reason?: string;
};

export type FinalistJudgment = {
  candidateId: string;
  requirements: RequirementAssessment[];
  semanticFit: number;
  authorityFit: number;
  evidenceConfidence: number;
  verdict: 'qualified' | 'not_qualified';
  reason: string;
};

export type FinalistCandidate = {
  candidateId: string;
  lead: Record<string, any>;
  evidence: Array<{ id: string; text: string }>;
};

export type Qualification = {
  policyVersion: string;
  verdict: 'qualified';
  qualificationSource: 'llm' | 'deterministic';
  finalScore: number;
  requirements: RequirementAssessment[];
  reason: string;
  semanticFit: number;
  evidenceConfidence: number;
  authorityFit: number;
};

const clean = (value: unknown, max = 900) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const bounded = (value: unknown) => Math.min(10, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));

export const finalistJudgeSchema = {
  type: Type.OBJECT,
  properties: {
    judgments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          candidateId: { type: Type.STRING },
          requirements: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                requirementId: { type: Type.STRING },
                status: { type: Type.STRING },
                evidenceId: { type: Type.STRING },
                evidenceQuote: { type: Type.STRING },
                reason: { type: Type.STRING }
              },
              required: ['requirementId', 'status']
            }
          },
          semanticFit: { type: Type.NUMBER },
          authorityFit: { type: Type.NUMBER },
          evidenceConfidence: { type: Type.NUMBER },
          verdict: { type: Type.STRING },
          reason: { type: Type.STRING }
        },
        required: ['candidateId', 'requirements', 'semanticFit', 'authorityFit', 'evidenceConfidence', 'verdict', 'reason']
      }
    }
  },
  required: ['judgments']
};

export type FinalistOutcomeStatus = 'qualified' | 'hard_fail' | 'unknown' | 'unjudged';

export type CandidateOutcome = {
  candidateId: string;
  status: FinalistOutcomeStatus;
  qualification?: Qualification;
  requirements?: RequirementAssessment[];
  reason?: string;
};

export const FINALIST_JUDGE_SYSTEM_PROMPT = `You are a senior B2B sales intelligence evaluator. Assess each candidate's fit for the role described in the prospect contract.

CORE RULES:
1. Evaluate semantic fit, not exact keyword matching. Real B2B profiles rarely use the exact same phrasing as a search query.
2. LOCATION equivalence (always apply):
   - Any city, state, metro area, or region that is physically inside the target country = PASS
   - "San Francisco CA", "New York", "Boston", "United States", "US", "U.S.", "America" all satisfy "USA"
   - UK / United Kingdom / England / Scotland / London all satisfy "UK"
3. ROLE & OWNERSHIP equivalence:
   - "Founder", "Co-Founder", "Proprietor", "Owner" satisfy an ownership requirement.
   - "Partner" satisfies ownership ONLY when actual partnership/managing partner evidence exists.
   - "Director", "President", "VP", or hired C-Suite titles do NOT automatically satisfy an ownership requirement without explicit founder/ownership evidence.
4. COMPANY TYPE equivalence:
   - "AI agency", "AI consultancy", "AI services firm", "AI studio", "AI marketing agency" satisfy an AI agency requirement.
   - A generic AI software product company or tech vendor does NOT satisfy an AI agency requirement without client-service model evidence.
5. EVIDENCE rules:
   - A requirement status is enough when the shown evidence is clear. Include an evidence id, quote, or explanation only when it resolves real ambiguity.
   - "unknown" is used when evidence is insufficient or ambiguous.
   - "fail" is used when evidence explicitly contradicts a hard requirement.
6. A candidate passes a hard requirement when the evidence clearly supports the semantic intent of the requirement per the rules above.`;

export function buildFinalistJudgePrompt(contract: ProspectContract, candidates: FinalistCandidate[]) {
  const requirementText = contract.requirements.map(requirement =>
    `- ${requirement.id} [${requirement.importance}/${requirement.scope}]: ${requirement.description}; acceptable terms and semantic equivalents: ${requirement.acceptableTerms.join(' | ')}`
  ).join('\n');
  const candidateText = candidates.map(candidate => {
    const lead = candidate.lead;
    const evidence = candidate.evidence.map(item => `[${item.id}] ${clean(item.text) || 'No evidence.'}`).join('\n');
    return `### ${candidate.candidateId}\nName: ${clean(lead.fullName, 160) || 'Unknown'}\nTitle: ${clean(lead.currentTitle || lead.headline, 180) || 'Unknown'}\nCompany: ${clean(lead.currentCompany, 180) || 'Unknown'}\nLocation: ${clean(lead.location, 160) || 'Unknown'}\nEvidence:\n${evidence}`;
  }).join('\n\n');
  return `Prospect contract:\n${requirementText}\n\nCandidates:\n${candidateText}\n\nFor every listed candidate, assess every requirement. For each requirement return requirementId and status. Omit evidenceId, evidenceQuote, and reason unless they clarify an ambiguous verdict. Return judgments only.`;
}

const normalizeAssessment = (raw: any, candidate: FinalistCandidate, requirement: ProspectRequirement): RequirementAssessment => {
  const status: RequirementStatus = raw?.status === 'pass' || raw?.status === 'fail' ? raw.status : 'unknown';
  const evidenceId = clean(raw?.evidenceId, 100);
  const evidenceQuote = clean(raw?.evidenceQuote, 400);
  const evidence = candidate.evidence.find(item => item.id === evidenceId);

  const quoteValid = Boolean(status !== 'pass' || !evidenceQuote || (evidence && evidence.text.includes(evidenceQuote)));

  return {
    requirementId: requirement.id,
    status: quoteValid ? status : 'unknown',
    evidenceId: quoteValid ? evidenceId || undefined : undefined,
    evidenceQuote: quoteValid ? evidenceQuote || undefined : undefined,
    reason: clean(raw?.reason, 280) || undefined
  };
};

/**
 * Validate judgments and assign precise outcome statuses:
 * - Any valid failed hard requirement -> hard_fail
 * - Insufficient evidence for a hard requirement -> unknown
 * - Omitted or malformed candidate result -> unjudged
 * - Every hard requirement validly passes -> qualified
 */
export function validateFinalistJudgments(
  raw: unknown,
  contract: ProspectContract,
  candidates: FinalistCandidate[]
): {
  qualifications: Map<string, Qualification>;
  outcomes: Map<string, CandidateOutcome>;
  validJudgmentCount: number;
  expectedJudgmentCount: number;
  counts: { qualified: number; hardFail: number; unknown: number; unjudged: number };
} {
  const byCandidate = new Map(candidates.map(candidate => [candidate.candidateId, candidate]));
  const rawJudgments = Array.isArray((raw as any)?.judgments) ? (raw as any).judgments : [];
  const qualifications = new Map<string, Qualification>();
  const outcomes = new Map<string, CandidateOutcome>();
  let validJudgmentCount = 0;
  const counts = { qualified: 0, hardFail: 0, unknown: 0, unjudged: 0 };

  const hardRequirements = contract.requirements.filter(req => req.importance === 'hard');
  const hardCount = hardRequirements.length;

  for (const candidate of candidates) {
    outcomes.set(candidate.candidateId, { candidateId: candidate.candidateId, status: 'unjudged' });
  }

  for (const judgment of rawJudgments) {
    const candidateId = clean(judgment?.candidateId, 180);
    const candidate = byCandidate.get(candidateId);
    if (!candidate || !Array.isArray(judgment?.requirements)) continue;

    const assessmentById = new Map(judgment.requirements
      .filter((item: any) => item && typeof item.requirementId === 'string')
      .map((item: any) => [item.requirementId, item]));
    const requirements = contract.requirements.map(requirement => normalizeAssessment(assessmentById.get(requirement.id), candidate, requirement));
    validJudgmentCount++;

    const hardFails = requirements.filter(req => {
      const contractReq = contract.requirements.find(item => item.id === req.requirementId);
      return contractReq?.importance === 'hard' && req.status === 'fail';
    }).length;

    const hardPasses = requirements.filter(req => {
      const contractReq = contract.requirements.find(item => item.id === req.requirementId);
      return contractReq?.importance === 'hard' && req.status === 'pass';
    }).length;

    const semanticFit = bounded(judgment.semanticFit);
    const authorityFit = bounded(judgment.authorityFit);
    const evidenceConfidence = bounded(judgment.evidenceConfidence);
    const reason = clean(judgment.reason, 500) || 'Matches the prospect contract with cited public evidence.';

    let status: FinalistOutcomeStatus = 'unknown';
    if (hardFails > 0) {
      status = 'hard_fail';
      counts.hardFail++;
    } else if (hardPasses === hardCount) {
      status = 'qualified';
      counts.qualified++;
    } else {
      status = 'unknown';
      counts.unknown++;
    }

    if (status === 'qualified') {
      const corroboration = bounded(candidate.lead.scout?.corroborationScore ?? (candidate.evidence.length > 1 ? 7 : 4));
      const weighted = contract.authorityRequired
        ? semanticFit * 0.50 + evidenceConfidence * 0.25 + authorityFit * 0.15 + corroboration * 0.10
        : semanticFit * 0.65 + evidenceConfidence * 0.25 + corroboration * 0.10;

      const qual: Qualification = {
        policyVersion: contract.policyVersion,
        verdict: 'qualified',
        qualificationSource: 'llm',
        finalScore: Number(weighted.toFixed(2)),
        requirements,
        reason,
        semanticFit,
        evidenceConfidence,
        authorityFit
      };
      qualifications.set(candidate.candidateId, qual);
      outcomes.set(candidate.candidateId, { candidateId, status: 'qualified', qualification: qual, requirements, reason });
    } else {
      outcomes.set(candidate.candidateId, { candidateId, status, requirements, reason });
    }
  }

  counts.unjudged = candidates.length - validJudgmentCount;

  return { qualifications, outcomes, validJudgmentCount, expectedJudgmentCount: candidates.length, counts };
}

export function finalistCandidateFromLead(
  candidateId: string,
  lead: Record<string, any>,
  evidenceText?: string,
  contract?: ProspectContract
): FinalistCandidate {
  if (contract) {
    const selected = selectEvidenceForFinalist(lead, contract, evidenceText);
    return { candidateId, lead, evidence: selected.evidence };
  }
  const snippets = Array.isArray(lead.evidence?.snippets) ? lead.evidence.snippets : [];
  const structuredEvidence = `Name: ${lead.fullName || ''}\nTitle: ${lead.currentTitle || lead.headline || ''}\nCompany: ${lead.currentCompany || ''}\nLocation: ${lead.location || ''}\nHeadline: ${lead.headline || ''}`;
  const evidence = [
    { id: 'e0', text: clean(structuredEvidence, 400) },
    evidenceText || lead.evidence?.rawText || lead.evidence?.summary || lead.summary || '',
    ...snippets
  ].filter(item => item && (typeof item === 'string' ? item.trim() : item.text)).map((item, index) => {
    const text = typeof item === 'string' ? item : item.text;
    return { id: `e${index}`, text: clean(text, 1400) };
  });
  return { candidateId, lead, evidence: evidence.length ? evidence : [{ id: 'e1', text: 'No supporting evidence was retrieved.' }] };
}

export type DeterministicFinalist = {
  candidate: FinalistCandidate;
  qualification: Qualification;
};

/**
 * Fast-path only direct, typed profile matches. This intentionally avoids the
 * broader diagnostic matcher: it never treats a related role, city, or company
 * phrase as an equivalent one. Ambiguity always reaches the semantic judge.
 */
export function partitionCandidatesByStrictEvidence(
  candidates: FinalistCandidate[],
  contract: ProspectContract
): { autoQualified: DeterministicFinalist[]; needsJudge: FinalistCandidate[] } {
  const hardRequirements = contract.requirements.filter(requirement => requirement.importance === 'hard');
  const autoQualified: DeterministicFinalist[] = [];
  const needsJudge: FinalistCandidate[] = [];

  for (const candidate of candidates) {
    if (!hardRequirements.length || !hardRequirements.every(requirement => hasStrictStructuredMatch(candidate.lead, requirement))) {
      needsJudge.push(candidate);
      continue;
    }

    const requirements: RequirementAssessment[] = contract.requirements.map(requirement => ({
      requirementId: requirement.id,
      status: requirement.importance === 'hard' ? 'pass' : 'unknown',
      evidenceId: requirement.importance === 'hard' ? 'e0' : undefined
    }));
    const authorityFit = contract.authorityRequired
      ? bounded(candidate.lead.decisionMakerVerification?.confidence ?? candidate.lead.audit?.authorityConfidence ?? 7)
      : 0;
    const evidenceConfidence = bounded(candidate.lead.scout?.evidenceCoverageScore ?? candidate.lead.scoreBreakdown?.evidenceQualityScore ?? 7);
    autoQualified.push({
      candidate,
      qualification: {
        policyVersion: contract.policyVersion,
        verdict: 'qualified',
        qualificationSource: 'deterministic',
        // Use the same selection scorer as non-qualified/rescued leads instead
        // of inventing a founder/owner-specific or arbitrary score cap.
        finalScore: rankLeadForFinalSelection(candidate.lead),
        requirements,
        reason: 'Direct structured profile fields satisfy every hard requirement; no semantic inference was needed.',
        semanticFit: 10,
        evidenceConfidence,
        authorityFit
      }
    });
  }

  return { autoQualified, needsJudge };
}
