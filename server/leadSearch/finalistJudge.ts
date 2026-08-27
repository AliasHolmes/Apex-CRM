import { Type } from "../services/llm.js";
import type {
  ProspectContract,
  ProspectRequirement,
} from "./prospectContract.js";
import {
  hasStrictStructuredMatch,
  selectEvidenceForFinalist,
} from "./evidenceSelection.js";
import { rankLeadForFinalSelection } from "./scoring.js";
import { isFlagEnabled } from "./featureFlags.js";

export type RequirementStatus = "pass" | "fail" | "unknown";

export type RequirementAssessment = {
  requirementId: string;
  status: RequirementStatus;
  evidenceId?: string;
  evidenceQuote?: string;
  reason?: string;
  /** True when the model claimed a pass but the cited quote was not found in the candidate evidence. */
  fabricatedPass?: boolean;
};

export type FinalistJudgment = {
  candidateId: string;
  requirements: RequirementAssessment[];
  semanticFit: number;
  authorityFit: number;
  evidenceConfidence: number;
  verdict: "qualified" | "qualified_partial" | "not_qualified";
  reason: string;
};

export type FinalistCandidate = {
  candidateId: string;
  lead: Record<string, any>;
  evidence: Array<{ id: string; text: string }>;
};

export type Qualification = {
  policyVersion: string;
  verdict: "qualified" | "qualified_partial";
  qualificationSource: "llm" | "deterministic";
  finalScore: number;
  requirements: RequirementAssessment[];
  reason: string;
  semanticFit: number;
  evidenceConfidence: number;
  authorityFit: number;
};

const clean = (value: unknown, max = 900) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const bounded = (value: unknown) =>
  Math.min(10, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
const normalizeScoreTo10 = (value: unknown, defaultVal = 7): number => {
  const num = Number(value);
  if (!Number.isFinite(num)) return defaultVal;
  // If the score was returned on a 0.0 - 1.0 probability/unit scale, scale it to 0 - 10
  if (num <= 1.0 && num > 0)
    return Math.min(10, Math.max(0, Number((num * 10).toFixed(2))));
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
                reason: { type: Type.STRING },
              },
              required: ["requirementId", "status"],
            },
          },
          semanticFit: {
            type: Type.NUMBER,
            description:
              "Semantic fit score from 1 to 10 evaluating how well the candidate matches the contract role and requirements.",
          },
          authorityFit: {
            type: Type.NUMBER,
            description:
              "Authority fit score from 1 to 10 evaluating seniority and decision-making power.",
          },
          evidenceConfidence: {
            type: Type.NUMBER,
            description:
              "Evidence confidence score from 1 to 10 evaluating proof clarity and certainty.",
          },
          verdict: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: [
          "candidateId",
          "requirements",
          "semanticFit",
          "authorityFit",
          "evidenceConfidence",
          "verdict",
          "reason",
        ],
      },
    },
  },
  required: ["judgments"],
};

export type FinalistOutcomeStatus =
  | "qualified"
  | "qualified_partial"
  | "hard_fail"
  | "unknown"
  | "unjudged";

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
   - "Founder", "Co-Founder", "Proprietor", "Owner", "Managing Partner", "Managing Director", "Principal", "CEO", "President" satisfy executive leadership and ownership requirements for agencies and businesses.
   - When a brief seeks agency owners/founders (e.g. "owner/founder", "agency owner", "founder or CEO"), verified Founders, Co-Founders, Owners, CEOs, and Managing Directors of the firm satisfy the person_role requirement.
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

const clampEnvInt = (
  name: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0
    ? Math.min(Math.max(Math.floor(raw), min), max)
    : fallback;
};

// Token-diet controls: evidence dominates judge prompt weight. Caps are env-
// tunable; term-matching evidence is always preserved regardless of caps.
const MAX_EVIDENCE_ITEMS = clampEnvInt(
  "FINALIST_JUDGE_MAX_EVIDENCE_ITEMS",
  3,
  1,
  6,
);
const EVIDENCE_CHARS = clampEnvInt(
  "FINALIST_JUDGE_EVIDENCE_CHARS",
  400,
  200,
  900,
);

export function buildFinalistJudgePrompt(
  contract: ProspectContract,
  candidates: FinalistCandidate[],
) {
  const requirementText = contract.requirements
    .map(
      (requirement) =>
        `- ${requirement.id} [${requirement.importance}/${requirement.scope}]: ${requirement.description}; acceptable terms and semantic equivalents: ${requirement.acceptableTerms.join(" | ")}`,
    )
    .join("\n");
  const allTerms = contract.requirements.flatMap((requirement) =>
    requirement.acceptableTerms.map((term) => String(term).toLowerCase()),
  );
  const candidateText = candidates
    .map((candidate) => {
      const lead = candidate.lead;
      // Keep the first item (primary profile evidence), then any item containing
      // a contract acceptable term, then fill remaining slots in order. This
      // prevents truncation from dropping the evidence a verdict hinges on.
      const selected: typeof candidate.evidence = [];
      for (const item of candidate.evidence) {
        if (selected.length >= MAX_EVIDENCE_ITEMS) break;
        if (item === candidate.evidence[0]) {
          selected.push(item);
          continue;
        }
        const text = String(item.text || "").toLowerCase();
        if (allTerms.some((term) => term && text.includes(term)))
          selected.push(item);
      }
      for (const item of candidate.evidence) {
        if (selected.length >= MAX_EVIDENCE_ITEMS) break;
        if (!selected.includes(item)) selected.push(item);
      }
      const evidence = selected
        .map(
          (item) =>
            `[${item.id}] ${clean(item.text, EVIDENCE_CHARS) || "No evidence."}`,
        )
        .join("\n");
      return `### ${candidate.candidateId}\nName: ${clean(lead.fullName, 160) || "Unknown"}\nTitle: ${clean(lead.currentTitle || lead.headline, 180) || "Unknown"}\nCompany: ${clean(lead.currentCompany, 180) || "Unknown"}\nLocation: ${clean(lead.location, 160) || "Unknown"}\nEvidence:\n${evidence}`;
    })
    .join("\n\n");
  return `Prospect contract:\n${requirementText}\n\nCandidates:\n${candidateText}\n\nFor every listed candidate, assess every requirement. For each requirement return requirementId and status. Omit evidenceId, evidenceQuote, and reason unless they clarify an ambiguous verdict. Return judgments only.`;
}

const normalizePassage = (text: string): string =>
  String(text || '')
    .replace(/[\u201C\u201D"'\u2018\u2019`]/g, ' ')
    .replace(/[\u2014\u2013-]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export function verifyEvidencePassage(
  evidenceText: string,
  citedQuote: string,
  threshold = 0.88
): { valid: boolean; similarity: number } {
  if (!citedQuote || !citedQuote.trim()) return { valid: true, similarity: 1.0 };
  if (!evidenceText || !evidenceText.trim()) return { valid: false, similarity: 0.0 };

  if (evidenceText.includes(citedQuote)) {
    return { valid: true, similarity: 1.0 };
  }

  const normEvidence = normalizePassage(evidenceText);
  const normQuote = normalizePassage(citedQuote);

  if (normEvidence.includes(normQuote)) {
    return { valid: true, similarity: 1.0 };
  }

  const quoteTokens = normQuote.split(' ').filter(Boolean);
  const evidenceTokens = normEvidence.split(' ').filter(Boolean);

  if (quoteTokens.length === 0) return { valid: true, similarity: 1.0 };
  if (evidenceTokens.length === 0) return { valid: false, similarity: 0.0 };

  const windowSize = quoteTokens.length;
  let maxSimilarity = 0;

  for (let i = 0; i <= evidenceTokens.length - Math.min(windowSize, evidenceTokens.length); i++) {
    const candidateSlice = evidenceTokens.slice(i, i + windowSize);
    let matchCount = 0;
    for (let j = 0; j < candidateSlice.length; j++) {
      if (candidateSlice[j] === quoteTokens[j]) {
        matchCount++;
      } else if (
        candidateSlice[j].length >= 3 &&
        quoteTokens[j].length >= 3 &&
        (candidateSlice[j].startsWith(quoteTokens[j]) || quoteTokens[j].startsWith(candidateSlice[j]))
      ) {
        matchCount += 0.8;
      }
    }
    const sim = matchCount / windowSize;
    if (sim > maxSimilarity) {
      maxSimilarity = sim;
    }
    if (maxSimilarity >= 1.0) break;
  }

  return {
    valid: maxSimilarity >= threshold,
    similarity: Number(maxSimilarity.toFixed(2))
  };
}

const normalizeAssessment = (
  raw: any,
  candidate: FinalistCandidate,
  requirement: ProspectRequirement,
): RequirementAssessment => {
  const status: RequirementStatus =
    raw?.status === "pass" || raw?.status === "fail" ? raw.status : "unknown";
  const evidenceId = clean(raw?.evidenceId, 100);
  const evidenceQuote = clean(raw?.evidenceQuote, 400);
  const evidence = candidate.evidence.find((item) => item.id === evidenceId);

  let quoteValid = false;
  if (status !== 'pass' || !evidenceQuote) {
    quoteValid = true;
  } else if (!evidence) {
    quoteValid = false;
  } else if (isFlagEnabled.fuzzyQuoteGrounding()) {
    quoteValid = verifyEvidencePassage(evidence.text, evidenceQuote).valid;
  } else {
    quoteValid = evidence.text.includes(evidenceQuote);
  }

  return {
    requirementId: requirement.id,
    status: quoteValid ? status : "unknown",
    fabricatedPass: status === "pass" && !quoteValid,
    evidenceId: quoteValid ? evidenceId || undefined : undefined,
    evidenceQuote: quoteValid ? evidenceQuote || undefined : undefined,
    reason: clean(raw?.reason, 280) || undefined,
  };
};

/**
 * Validate judgments and assign tiered outcome statuses:
 * - Any failed hard requirement (identity or context) -> hard_fail
 * - All hard profile requirements pass + all hard signal requirements pass -> qualified
 * - Identity (person_role) verified, but context attributes (location, company
 *   type, industry, size) and/or hard signals merely unknown -> qualified_partial
 *   (15% score discount). Search snippets routinely omit context fields, so an
 *   unverifiable context no longer discards a verified decision-maker.
 * - Identity unverifiable but the judge rates semantic fit >= 7 and authority
 *   fit >= 8 (>= 7 when authority is not required) -> qualified_partial
 * - A "pass" whose evidence quote is absent from the packet is treated as a
 *   fabrication signal and blocks qualification entirely -> unknown
 * - Omitted or malformed candidate result -> unjudged
 */
export function validateFinalistJudgments(
  raw: unknown,
  contract: ProspectContract,
  candidates: FinalistCandidate[],
): {
  qualifications: Map<string, Qualification>;
  outcomes: Map<string, CandidateOutcome>;
  validJudgmentCount: number;
  expectedJudgmentCount: number;
  counts: {
    qualified: number;
    hardFail: number;
    unknown: number;
    unjudged: number;
  };
} {
  const byCandidate = new Map(
    candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const rawJudgments = Array.isArray((raw as any)?.judgments)
    ? (raw as any).judgments
    : [];
  const qualifications = new Map<string, Qualification>();
  const outcomes = new Map<string, CandidateOutcome>();
  let validJudgmentCount = 0;
  const counts = { qualified: 0, hardFail: 0, unknown: 0, unjudged: 0 };

  const hardRequirements = contract.requirements.filter(
    (req) => req.importance === "hard",
  );
  const profileHardReqs = hardRequirements.filter(
    (r) =>
      (r.evidenceModality ||
        (r.scope === "signal" ? "open_web_signal" : "structured_profile")) !==
      "open_web_signal",
  );
  const signalHardReqs = hardRequirements.filter(
    (r) =>
      (r.evidenceModality ||
        (r.scope === "signal" ? "open_web_signal" : "structured_profile")) ===
      "open_web_signal",
  );

  for (const candidate of candidates) {
    outcomes.set(candidate.candidateId, {
      candidateId: candidate.candidateId,
      status: "unjudged",
    });
  }

  for (const judgment of rawJudgments) {
    const candidateId = clean(judgment?.candidateId, 180);
    const candidate = byCandidate.get(candidateId);
    if (!candidate || !Array.isArray(judgment?.requirements)) continue;

    const assessmentById = new Map(
      judgment.requirements
        .filter((item: any) => item && typeof item.requirementId === "string")
        .map((item: any) => [item.requirementId, item]),
    );
    const requirements = contract.requirements.map((requirement) =>
      normalizeAssessment(
        assessmentById.get(requirement.id),
        candidate,
        requirement,
      ),
    );
    validJudgmentCount++;

    // Tiered evaluation. person_role is the identity requirement that must be
    // positively verified. Context requirements (location, company type,
    // industry, size) tolerate "unknown" because search snippets routinely
    // omit them; unknown context demotes to qualified_partial instead of
    // discarding a verified decision-maker.
    let identityFails = 0,
      identityPasses = 0;
    let contextFails = 0,
      contextPasses = 0;
    let signalPasses = 0;
    let fabricatedHardPass = false;

    let identityHardTotal = profileHardReqs.filter(
      (req) => req.scope === "person_role",
    ).length;
    let contextHardTotal = profileHardReqs.length - identityHardTotal;

    if (isFlagEnabled.semanticGrouping()) {
      const anyOfGroups = new Map<string, ProspectRequirement[]>();
      const ungroupedHardReqs: ProspectRequirement[] = [];

      for (const contractReq of profileHardReqs) {
        if (contractReq.groupId && contractReq.matchRule === 'any_of') {
          const list = anyOfGroups.get(contractReq.groupId) || [];
          list.push(contractReq);
          anyOfGroups.set(contractReq.groupId, list);
        } else {
          ungroupedHardReqs.push(contractReq);
        }
      }

      let groupIdentityTotal = 0;
      let groupContextTotal = 0;
      for (const [_, groupReqs] of anyOfGroups) {
        const isIdentityGroup = groupReqs.some(r => r.scope === 'person_role');
        if (isIdentityGroup) groupIdentityTotal++;
        else groupContextTotal++;
      }

      identityHardTotal = ungroupedHardReqs.filter(r => r.scope === 'person_role').length + groupIdentityTotal;
      contextHardTotal = ungroupedHardReqs.filter(r => r.scope !== 'person_role').length + groupContextTotal;

      for (const contractReq of ungroupedHardReqs) {
        const req = requirements.find(r => r.requirementId === contractReq.id);
        if (!req) continue;
        if (req.fabricatedPass) fabricatedHardPass = true;
        const isIdentity = contractReq.scope === 'person_role';
        if (req.status === 'pass') {
          if (isIdentity) identityPasses++;
          else contextPasses++;
        } else if (req.status === 'fail') {
          if (isIdentity) identityFails++;
          else contextFails++;
        }
      }

      for (const [_, groupReqs] of anyOfGroups) {
        const isIdentityGroup = groupReqs.some(r => r.scope === 'person_role');
        const groupAssessments = groupReqs.map(gr => requirements.find(r => r.requirementId === gr.id)).filter(Boolean);
        if (groupAssessments.some(a => a?.fabricatedPass)) fabricatedHardPass = true;

        const anyPass = groupAssessments.some(a => a?.status === 'pass');
        const allFail = groupAssessments.length > 0 && groupAssessments.every(a => a?.status === 'fail');

        if (anyPass) {
          if (isIdentityGroup) identityPasses++;
          else contextPasses++;
        } else if (allFail) {
          if (isIdentityGroup) identityFails++;
          else contextFails++;
        }
      }

      for (const contractReq of signalHardReqs) {
        const req = requirements.find(r => r.requirementId === contractReq.id);
        if (req?.fabricatedPass) fabricatedHardPass = true;
        if (req?.status === 'pass') signalPasses++;
      }
    } else {
      for (const req of requirements) {
        const contractReq = contract.requirements.find(
          (item) => item.id === req.requirementId,
        );
        if (!contractReq || contractReq.importance !== "hard") continue;
        if (req.fabricatedPass) fabricatedHardPass = true;
        const isSignal =
          (contractReq.evidenceModality ||
            (contractReq.scope === "signal"
              ? "open_web_signal"
              : "structured_profile")) === "open_web_signal";
        if (isSignal) {
          if (req.status === "pass") signalPasses++;
          continue;
        }
        const isIdentity = contractReq.scope === "person_role";
        if (req.status === "pass") {
          if (isIdentity) identityPasses++;
          else contextPasses++;
        } else if (req.status === "fail") {
          if (isIdentity) identityFails++;
          else contextFails++;
        }
      }
    }

    const semanticFit = normalizeScoreTo10(judgment.semanticFit, 7);
    const authorityFit = normalizeScoreTo10(judgment.authorityFit, 7);
    const evidenceConfidence = normalizeScoreTo10(
      judgment.evidenceConfidence,
      7,
    );
    const reason =
      clean(judgment.reason, 500) ||
      "Matches the prospect contract with cited public evidence.";

    const identityVerified =
      identityFails === 0 && identityPasses === identityHardTotal;
    const contextVerified =
      contextFails === 0 && contextPasses === contextHardTotal;
    const signalsSatisfied =
      signalHardReqs.length === 0 || signalPasses === signalHardReqs.length;
    // When evidence packets are too thin to verify identity outright, the
    // judge's graded scores still carry decision weight instead of being
    // discarded: strong semantic + authority ratings qualify as partial.
    const stronglyRatedIdentity =
      semanticFit >= 6.5 && authorityFit >= (contract.authorityRequired ? 7.5 : 7.0);

    let status: FinalistOutcomeStatus = "unknown";
    if (fabricatedHardPass) {
      // A "pass" whose cited quote does not exist in the evidence packet is a
      // fabrication signal; it blocks qualification entirely.
      status = "unknown";
      counts.unknown++;
    } else if (identityFails > 0 || contextFails > 0) {
      status = "hard_fail";
      counts.hardFail++;
    } else if (identityVerified && contextVerified && signalsSatisfied) {
      status = "qualified";
      counts.qualified++;
    } else if (
      identityVerified ||
      (identityFails === 0 && stronglyRatedIdentity)
    ) {
      // Identity verified (or strongly rated); context attributes or dynamic
      // signals are uncorroborated (unknown) but the candidate is genuine.
      status = "qualified_partial";
      counts.qualified++;
    } else {
      status = "unknown";
      counts.unknown++;
    }

    if (status === "qualified" || status === "qualified_partial") {
      const corroboration = normalizeScoreTo10(
        candidate.lead.scout?.corroborationScore ??
          (candidate.evidence.length > 1 ? 7 : 4),
        5,
      );
      const weighted = contract.authorityRequired
        ? semanticFit * 0.5 +
          evidenceConfidence * 0.25 +
          authorityFit * 0.15 +
          corroboration * 0.1
        : semanticFit * 0.65 + evidenceConfidence * 0.25 + corroboration * 0.1;

      // Partial qualification applies a modest 15% discount because dynamic signal was not corroborated
      const scoreMultiplier = status === "qualified_partial" ? 0.85 : 1.0;
      const finalScore = Number((weighted * scoreMultiplier).toFixed(2));

      const qual: Qualification = {
        policyVersion: contract.policyVersion,
        verdict: status,
        qualificationSource: "llm",
        finalScore,
        requirements,
        reason:
          status === "qualified_partial"
            ? `${reason} (Decision maker verified; signal requirement uncorroborated)`
            : reason,
        semanticFit,
        evidenceConfidence,
        authorityFit,
      };
      qualifications.set(candidate.candidateId, qual);
      outcomes.set(candidate.candidateId, {
        candidateId,
        status,
        qualification: qual,
        requirements,
        reason: qual.reason,
      });
    } else {
      outcomes.set(candidate.candidateId, {
        candidateId,
        status,
        requirements,
        reason,
      });
    }
  }

  counts.unjudged = candidates.length - validJudgmentCount;

  return {
    qualifications,
    outcomes,
    validJudgmentCount,
    expectedJudgmentCount: candidates.length,
    counts,
  };
}

export function finalistCandidateFromLead(
  candidateId: string,
  lead: Record<string, any>,
  evidenceText?: string,
  contract?: ProspectContract,
): FinalistCandidate {
  if (contract) {
    const selected = selectEvidenceForFinalist(lead, contract, evidenceText);
    return { candidateId, lead, evidence: selected.evidence };
  }
  const snippets = Array.isArray(lead.evidence?.snippets)
    ? lead.evidence.snippets
    : [];
  const structuredEvidence = `Name: ${lead.fullName || ""}\nTitle: ${lead.currentTitle || lead.headline || ""}\nCompany: ${lead.currentCompany || ""}\nLocation: ${lead.location || ""}\nHeadline: ${lead.headline || ""}`;
  const evidence = [
    { id: "e0", text: clean(structuredEvidence, 400) },
    evidenceText ||
      lead.evidence?.evidenceBlock ||
      lead.evidence?.rawText ||
      lead.evidence?.summary ||
      lead.summary ||
      "",
    ...snippets,
  ]
    .filter(
      (item) => item && (typeof item === "string" ? item.trim() : item.text),
    )
    .map((item, index) => {
      const text = typeof item === "string" ? item : item.text;
      return { id: `e${index}`, text: clean(text, 1400) };
    });
  return {
    candidateId,
    lead,
    evidence: evidence.length
      ? evidence
      : [{ id: "e1", text: "No supporting evidence was retrieved." }],
  };
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
  contract: ProspectContract,
): { autoQualified: DeterministicFinalist[]; needsJudge: FinalistCandidate[] } {
  // Auto-qualify gate uses only structured_profile hard requirements.
  // Signal requirements (open_web_signal) are always passed to the semantic judge.
  const hardRequirements = contract.requirements.filter(
    (requirement) =>
      requirement.importance === "hard" &&
      (requirement.evidenceModality ||
        (requirement.scope === "signal"
          ? "open_web_signal"
          : "structured_profile")) !== "open_web_signal",
  );
  const hasOpenWebSignalHardReqs = contract.requirements.some(
    (r) =>
      r.importance === "hard" &&
      (r.evidenceModality ||
        (r.scope === "signal" ? "open_web_signal" : "structured_profile")) ===
        "open_web_signal",
  );

  const autoQualified: DeterministicFinalist[] = [];
  const needsJudge: FinalistCandidate[] = [];

  for (const candidate of candidates) {
    // If there are open_web_signal hard requirements, always send to the judge so signals are evaluated
    if (
      hasOpenWebSignalHardReqs ||
      !hardRequirements.length ||
      !hardRequirements.every((requirement) =>
        hasStrictStructuredMatch(candidate.lead, requirement),
      )
    ) {
      needsJudge.push(candidate);
      continue;
    }

    const requirements: RequirementAssessment[] = contract.requirements.map(
      (requirement) => ({
        requirementId: requirement.id,
        status: requirement.importance === "hard" ? "pass" : "unknown",
        evidenceId: requirement.importance === "hard" ? "e0" : undefined,
      }),
    );
    const authorityFit = contract.authorityRequired
      ? bounded(
          candidate.lead.decisionMakerVerification?.confidence ??
            candidate.lead.audit?.authorityConfidence ??
            7,
        )
      : 0;
    const evidenceConfidence = bounded(
      candidate.lead.scout?.evidenceCoverageScore ??
        candidate.lead.scoreBreakdown?.evidenceQualityScore ??
        7,
    );
    autoQualified.push({
      candidate,
      qualification: {
        policyVersion: contract.policyVersion,
        verdict: "qualified",
        qualificationSource: "deterministic",
        // Use the same selection scorer as non-qualified/rescued leads instead
        // of inventing a founder/owner-specific or arbitrary score cap.
        finalScore: rankLeadForFinalSelection(candidate.lead),
        requirements,
        reason:
          "Direct structured profile fields satisfy every hard requirement; no semantic inference was needed.",
        semanticFit: 10,
        evidenceConfidence,
        authorityFit,
      },
    });
  }

  return { autoQualified, needsJudge };
}
