/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified Title Triage & Decision-Maker Classification Engine.
 * Single source of truth across judgeStage, verification, finalistJudge, verifyStage, and enrichStage.
 */

export const NON_DECISION_MAKER_REGEX =
  /\b(?:intern|student|trainee|apprentice|volunteer|assistant|coordinator|associate|specialist|representative|consultant|recruiter|talent acquisition|sourcer|staffing|sdr|bdr|sales development|account executive|account manager|key account manager|brand ambassador|ambassador|community manager|community lead|customer success|support specialist|customer\s+support|support\s+agent|customer\s+care|clerk|cashier|accountant|bookkeeper|mayor|city\s+council|politician|retired|individual contributor|staff\s+(?:software\s+|ai\s+|ml\s+|data\s+|systems?\s+|machine\s+learning\s+)?engineer|software\s+engineer(?:\s+ii|\s+iii|\s+iv)?|swe|frontend engineer|backend engineer|full stack engineer|data scientist|data analyst|machine learning engineer|ml engineer|devops engineer|site reliability engineer|sre|qa engineer|test engineer|product manager|product leader|group product manager|associate product manager|apm|project manager|scrum master|business analyst|partnership manager|alliances manager|principal\s+(?:software\s+|ai\s+|ml\s+|data\s+|systems?\s+|machine\s+learning\s+)?engineer|principal\s+product\s+manager|principal\s+architect|principal\s+scientist|research\s+scientist|applied\s+scientist)\b/i;

export const EXECUTIVE_OVERRIDE_REGEX =
  /\b(?:(?<!product\s+|process\s+|content\s+|component\s+)owner|co-owner|founder|co-founder|founding\s+member|founding\s+partner|practice\s+lead|ceo|chief executive|managing partner|general partner|proprietor|president|principal(?!\s+(?:software\s+|ai\s+|ml\s+|data\s+|systems?\s+|machine\s+learning\s+)?(?:engineer|architect|scientist|developer|designer|product manager))\b|partner|chair|chairwoman|chairman|director|vp|vice president|head of|chief|cto|cmo|coo|cfo|cro|cio|cpo)\b/i;

/** Roles that serve an executive rather than hold the authority ("Executive Assistant to the CEO"). */
export const SUBORDINATE_ROLE_REGEX =
  /\b(?:assistant|secretary|aide|ea|pa)\s+(?:to|for)\b|\bchief\s+of\s+staff\s+to\b|\boffice\s+of\s+the\s+(?:ceo|founder|president|chairman)\b/i;

/** Student, intern, and trainee roles must never be promoted to executive decision-makers even if they claim "founder". */
export const STUDENT_INTERN_ROLE_REGEX =
  /\b(?:(?<!former\s+|ex-)(?:student|intern|trainee|apprentice|studying|undergraduate|currently\s+enrolled|(?:pursuing\s+(?:a|an)?\s*(?:degree|bachelor|master|mba|phd))|(?:(?:bachelor|master|mba|phd)'?s?\s*candidate))(?:\s+(?:at\b|founder|researcher))?)\b/i;

export function hasStudentSignal(...texts: (string | undefined | null)[]): boolean {
  const combined = texts.filter(Boolean).join(" ");
  return STUDENT_INTERN_ROLE_REGEX.test(combined);
}

const OWNER_OPERATOR_REGEX =
  /\b(?:independent|solo|freelance|boutique|fractional|advisory|principal|managing|founding)\s+(?:[a-z0-9.&+#-]+\s+){0,2}(?:consultant|specialist|advisor|practitioner|partner)\b|\b(?:consultant|specialist|advisor)\s*(?:&|and|\/|\|)\s*(?:founder|owner|director|principal|president|ceo)\b|\b(?:owner[- ]operator|self[- ]employed)\b/i;

/** Titles that are individual-contributor roles even when they contain "consultant" or "specialist". */
export const STRICT_IC_REGEX = /\b(?:intern|student|trainee|apprentice|volunteer|assistant|coordinator|associate|representative|recruiter|talent acquisition|sourcer|staffing|sdr|bdr|sales development|account executive|account manager|key account manager|brand ambassador|ambassador|community manager|community lead|customer success|support specialist|customer\s+support|support\s+agent|customer\s+care|clerk|cashier|accountant|bookkeeper|mayor|city\s+council|politician|retired|individual contributor|staff\s+(?:software\s+|ai\s+|ml\s+|data\s+|systems?\s+|machine\s+learning\s+)?engineer|software\s+engineer(?:\s+ii|\s+iii|\s+iv)?|swe|frontend engineer|backend engineer|full stack engineer|data scientist|data analyst|machine learning engineer|ml engineer|devops engineer|site reliability engineer|sre|qa engineer|test engineer|product manager|product leader|group product manager|associate product manager|apm|project manager|scrum master|business analyst|partnership manager|alliances manager|principal\s+(?:software\s+|ai\s+|ml\s+|data\s+|systems?\s+|machine\s+learning\s+)?engineer|principal\s+product\s+manager|principal\s+architect|principal\s+scientist|research\s+scientist|applied\s+scientist)\b/i;

export const DM_MIN_CONFIDENCE = 4;

export interface TitleClassification {
  isIC: boolean;
  isExecutive: boolean;
  confidence: number;
}

/**
 * Precedence Rule: EXECUTIVE OVERRIDE & OWNER-OPERATOR STRICTLY WIN.
 * If title matches EXECUTIVE_OVERRIDE_REGEX or OWNER_OPERATOR_REGEX, isExecutive = true and isIC = false.
 * If contract context permits consultants/specialists, they are evaluated by the semantic judge rather than auto-dropped.
 */
export function classifyTitle(
  title: string,
  contractOrContext?: any,
): TitleClassification {
  const cleanTitle = (title || "").trim();
  if (!cleanTitle) {
    return { isIC: false, isExecutive: false, confidence: 5 };
  }

  if (SUBORDINATE_ROLE_REGEX.test(cleanTitle)) {
    return { isIC: true, isExecutive: false, confidence: 2 };
  }

  if (STUDENT_INTERN_ROLE_REGEX.test(cleanTitle)) {
    return { isIC: true, isExecutive: false, confidence: 1 };
  }

  // Phase 4: alias-aware normalization -- expand standalone acronyms (MD, VP)
  // so "MD at Acme" matches managing-director executive patterns.
  const expandedTitle = cleanTitle
    .replace(/\bMD\b/g, 'Managing Director')
    .replace(/\bVP\b/g, 'Vice President')
    .replace(/\bCEO\b/gi, 'CEO')
    .replace(/\bCTO\b/g, 'Chief Technology Officer')
    .replace(/\bCRO\b/g, 'Chief Revenue Officer');

  const isExecutive =
    EXECUTIVE_OVERRIDE_REGEX.test(expandedTitle) ||
    EXECUTIVE_OVERRIDE_REGEX.test(cleanTitle);
  if (isExecutive) {
    return { isIC: false, isExecutive: true, confidence: 9 };
  }

  // Owner-operators, solo consultants, independent practitioners
  const isOwnerOperator =
    OWNER_OPERATOR_REGEX.test(expandedTitle) ||
    OWNER_OPERATOR_REGEX.test(cleanTitle);
  if (isOwnerOperator) {
    return { isIC: false, isExecutive: true, confidence: 8 };
  }

  // Check if contract explicitly accepts consultant or specialist
  let allowsConsultantOrSpecialist = false;
  if (Array.isArray(contractOrContext)) {
    allowsConsultantOrSpecialist = contractOrContext.some((t) =>
      /\b(consultant|specialist)\b/i.test(String(t || "")),
    );
  } else if (contractOrContext && typeof contractOrContext === "object") {
    const brief = String(contractOrContext.brief || "");
    const reqs = Array.isArray(contractOrContext.requirements)
      ? contractOrContext.requirements
      : [];
    allowsConsultantOrSpecialist =
      /\b(consultant|specialist)\b/i.test(brief) ||
      reqs.some((r: any) =>
        r.scope === "person_role" &&
        (/\b(consultant|specialist)\b/i.test(r.description || "") ||
          (r.acceptableTerms || []).some((t: string) =>
            /\b(consultant|specialist)\b/i.test(String(t || "")),
          )),
      );
  }

  const isAmbiguousConsultantSpecialist = /\b(?:consultant|specialist)\b/i.test(cleanTitle);

  if (allowsConsultantOrSpecialist && isAmbiguousConsultantSpecialist) {
    // If the contract explicitly accepts consultant/specialist, and title contains it,
    // do not flag as IC -- send to LLM judge with neutral confidence
    return { isIC: false, isExecutive: false, confidence: 6 };
  }

  const isIC = NON_DECISION_MAKER_REGEX.test(cleanTitle);
  if (isIC) {
    // A bare consultant/specialist title is ambiguous: solo practitioners and agency
    // owners use it as often as employees do, so the semantic judge decides.
    if (isAmbiguousConsultantSpecialist && !STRICT_IC_REGEX.test(cleanTitle)) {
      return { isIC: false, isExecutive: false, confidence: 4 };
    }
    return { isIC: true, isExecutive: false, confidence: 2 };
  }

  return { isIC: false, isExecutive: false, confidence: 6 };
}

export interface DecisionMakerGateInput {
  ignoredTitle?: boolean;
  confidence?: number;
  effectiveScore?: number;
  minScore?: number;
  authorityRequired?: boolean;
}

export function evaluateDecisionMakerGate(input: DecisionMakerGateInput): {
  pass: boolean;
  reason?: string;
} {
  const {
    ignoredTitle,
    confidence = 0,
    effectiveScore = 0,
    minScore = 5,
    authorityRequired = false,
  } = input;

  // 1. Hard check when authority is strictly required: reject explicit non-DM with confidence <= 2
  if (authorityRequired && ignoredTitle && confidence <= 2) {
    return {
      pass: false,
      reason: "Explicit non-decision maker or entry-level role with low authority",
    };
  }

  // 2. Standard pipeline gate: reject ONLY IF title is flagged as ignored AND confidence is low AND score is below threshold
  if (ignoredTitle && confidence < DM_MIN_CONFIDENCE && effectiveScore < minScore) {
    return {
      pass: false,
      reason: `Low decision-maker confidence (${confidence}/${DM_MIN_CONFIDENCE}) on flagged role`,
    };
  }

  return { pass: true };
}
