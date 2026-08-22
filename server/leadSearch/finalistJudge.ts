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
  verdict: 'qualified' | 'qualified_partial' | 'not_qualified';
  reason: string;
};

export type FinalistCandidate = {
  candidateId: string;
  lead: Record<string, any>;
  evidence: Array<{ id: string; text: string }>;
};

export type Qualification = {
  policyVersion: string;
  verdict: 'qualified' | 'qualified_partial';
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
const normalizeScoreTo10 = (value: unknown, defaultVal = 7): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultVal;
  // If the score was returned on a 0.0 - 1.0 probability/unit scale, scale it to 0 - 10
  if (num <= 1.0 && num > 0) return Math.min(10, Math.max(0, Number((num * 10).toFixed(2))));
  return Math.min(10, Math.max(0, Number(num.toFixed(2))));
};
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
          semanticFit: { type: Type.NUMBER, description: 'Semantic fit score from 1 to 10 evaluating how well the candidate matches the contract role and requirements.' },
          authorityFit: { type: Type.NUMBER, description: 'Authority fit score from 1 to 10 evaluating seniority and decision-making power.' },
          evidenceConfidence: { type: Type.NUMBER, description: 'Evidence confidence score from 1 to 10 evaluating proof clarity and certainty.' },
          verdict: { type: Type.STRING },
          reason: { type: Type.STRING }
        },
        required: ['candidateId', 'requirements', 'semanticFit', 'authorityFit', 'evidenceConfidence', 'verdict', 'reason']
      }
    }
  },
  required: ['judgments']
};

export type FinalistOutcomeStatus = 'qualified' | 'qualified_partial' | 'hard_fail' | 'unknown' | 'unjudged';

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
6. A candidate passes a hard requirement when the evidence clearly supports the semantic intent of the requirement per the rules above.
7. SIGNAL REQUIREMENTS: If a requirement represents a dynamic buying signal (e.g. hiring triggers, funding events, tooling/tech stack signals), assign status "unknown" -- never "fail" -- when the candidate's evidence packet lacks job postings or open-web signal snippets. Only assign "fail" if the evidence explicitly contradicts the requirement (e.g. business is defunct). Never reject a verified decision-maker solely because an open-web signal could not be corroborated from their profile bio.
8. SCORING SCALE: For semanticFit, authorityFit, and evidenceConfidence, return a score on a 1 to 10 scale (where 10 = perfect match, 8-9 = strong match, 6-7 = good match, 4-5 = moderate match, 1-3 = weak match).`;

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
 * - Any valid failed hard profile requirement -> hard_fail
 * - All hard profile requirements pass + all hard signal requirements pass -> qualified
 * - All hard profile requirements pass + hard signal requirements unknown -> qualified_partial
 * - Insufficient evidence for a hard profile requirement -> unknown
 * - Omitted or malformed candidate result -> unjudged
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
  const profileHardReqs = hardRequirements.filter(r => (r.evidenceModality || (r.scope === 'signal' ? 'open_web_signal' : 'structured_profile')) !== 'open_web_signal');
  const signalHardReqs = hardRequirements.filter(r => (r.evidenceModality || (r.scope === 'signal' ? 'open_web_signal' : 'structured_profile')) === 'open_web_signal');

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

    const profileFails = requirements.filter(req => {
      const contractReq = contract.requirements.find(item => item.id === req.requirementId);
      const isSignal = (contractReq?.evidenceModality || (contractReq?.scope === 'signal' ? 'open_web_signal' : 'structured_profile')) === 'open_web_signal';
      return contractReq?.importance === 'hard' && !isSignal && req.status === 'fail';
    }).length;

    const profilePasses = requirements.filter(req => {
      const contractReq = contract.requirements.find(item => item.id === req.requirementId);
      const isSignal = (contractReq?.evidenceModality || (contractReq?.scope === 'signal' ? 'open_web_signal' : 'structured_profile')) === 'open_web_signal';
      return contractReq?.importance === 'hard' && !isSignal && req.status === 'pass';
    }).length;

    const signalPasses = requirements.filter(req => {
      const contractReq = contract.requirements.find(item => item.id === req.requirementId);
      const isSignal = (contractReq?.evidenceModality || (contractReq?.scope === 'signal' ? 'open_web_signal' : 'structured_profile')) === 'open_web_signal';
      return contractReq?.importance === 'hard' && isSignal && req.status === 'pass';
    }).length;

    const semanticFit = normalizeScoreTo10(judgment.semanticFit, 7);
    const authorityFit = normalizeScoreTo10(judgment.authorityFit, 7);
    const evidenceConfidence = normalizeScoreTo10(judgment.evidenceConfidence, 7);
    const reason = clean(judgment.reason, 500) || 'Matches the prospect contract with cited public evidence.';

    let status: FinalistOutcomeStatus = 'unknown';
    if (profileFails > 0) {
      status = 'hard_fail';
      counts.hardFail++;
    } else if (profilePasses === profileHardReqs.length && (signalHardReqs.length === 0 || signalPasses === signalHardReqs.length)) {
      status = 'qualified';
      counts.qualified++;
    } else if (profilePasses === profileHardReqs.length) {
      // Identity and role fully verified; signal uncorroborated but candidate is genuine
      status = 'qualified_partial';
      counts.qualified++;
    } else {
      status = 'unknown';
      counts.unknown++;
    }

    if (status === 'qualified' || status === 'qualified_partial') {
      const corroboration = normalizeScoreTo10(candidate.lead.scout?.corroborationScore ?? (candidate.evidence.length > 1 ? 7 : 4), 5);
      const weighted = contract.authorityRequired
        ? semanticFit * 0.50 + evidenceConfidence * 0.25 + authorityFit * 0.15 + corroboration * 0.10
        : semanticFit * 0.65 + evidenceConfidence * 0.25 + corroboration * 0.10;

      // Partial qualification applies a modest 15% discount because dynamic signal was not corroborated
      const scoreMultiplier = status === 'qualified_partial' ? 0.85 : 1.0;
      const finalScore = Number((weighted * scoreMultiplier).toFixed(2));

      const qual: Qualification = {
        policyVersion: contract.policyVersion,
        verdict: status,
        qualificationSource: 'llm',
        finalScore,
        requirements,
        reason: status === 'qualified_partial'
          ? `${reason} (Decision maker verified; signal requirement uncorroborated)`
          : reason,
        semanticFit,
        evidenceConfidence,
        authorityFit
      };
      qualifications.set(candidate.candidateId, qual);
      outcomes.set(candidate.candidateId, { candidateId, status, qualification: qual, requirements, reason: qual.reason });
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
    evidenceText || lead.evidence?.evidenceBlock || lead.evidence?.rawText || lead.evidence?.summary || lead.summary || '',
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
  // Auto-qualify gate uses only structured_profile hard requirements.
  // Signal requirements (open_web_signal) are always passed to the semantic judge.
  const hardRequirements = contract.requirements.filter(requirement =>
    requirement.importance === 'hard' &&
    (requirement.evidenceModality || (requirement.scope === 'signal' ? 'open_web_signal' : 'structured_profile')) !== 'open_web_signal'
  );
  const hasOpenWebSignalHardReqs = contract.requirements.some(r =>
    r.importance === 'hard' &&
    (r.evidenceModality || (r.scope === 'signal' ? 'open_web_signal' : 'structured_profile')) === 'open_web_signal'
  );

  const autoQualified: DeterministicFinalist[] = [];
  const needsJudge: FinalistCandidate[] = [];

  for (const candidate of candidates) {
    // If there are open_web_signal hard requirements, always send to the judge so signals are evaluated
    if (hasOpenWebSignalHardReqs || !hardRequirements.length || !hardRequirements.every(requirement => hasStrictStructuredMatch(candidate.lead, requirement))) {
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
