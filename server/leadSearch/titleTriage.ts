/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified Title Triage & Decision-Maker Classification Engine.
 * Single source of truth across judgeStage, verification, finalistJudge, verifyStage, and enrichStage.
 */

export const NON_DECISION_MAKER_REGEX =
  /\b(?:intern|student|trainee|apprentice|volunteer|assistant|coordinator|associate|specialist|representative|consultant|recruiter|talent acquisition|sourcer|staffing|sdr|bdr|sales development|account executive|customer success|support specialist|individual contributor|staff\s+(?:software\s+|ai\s+|ml\s+|data\s+|systems?\s+|machine\s+learning\s+)?engineer|software\s+engineer(?:\s+ii|\s+iii|\s+iv)?|swe|frontend engineer|backend engineer|full stack engineer|data scientist|data analyst|machine learning engineer|ml engineer|devops engineer|site reliability engineer|sre|qa engineer|test engineer|product manager|associate product manager|apm|project manager|scrum master|business analyst|principal\s+(?:software\s+|ai\s+|ml\s+|data\s+|systems?\s+|machine\s+learning\s+)?engineer|principal\s+product\s+manager|principal\s+architect|principal\s+scientist|research\s+scientist|applied\s+scientist)\b/i;

export const EXECUTIVE_OVERRIDE_REGEX =
  /\b(?:(?<!product\s+|process\s+|content\s+|component\s+)owner|co-owner|founder|co-founder|ceo|chief executive|managing partner|general partner|proprietor|president|principal(?!\s+(?:software\s+|ai\s+|ml\s+|data\s+|systems?\s+|machine\s+learning\s+)?(?:engineer|architect|scientist|developer|designer|product manager))\b|partner|chair|chairwoman|chairman|director|vp|vice president|head of|chief|cto|cmo|coo|cfo|cro|cio|cpo)\b/i;

export const DM_MIN_CONFIDENCE = 4;

export interface TitleClassification {
  isIC: boolean;
  isExecutive: boolean;
  confidence: number;
}

/**
 * Precedence Rule: EXECUTIVE OVERRIDE STRICTLY WINS.
 * If title matches EXECUTIVE_OVERRIDE_REGEX, isExecutive = true and isIC = false,
 * even if it also matches NON_DECISION_MAKER_REGEX (e.g. "Principal Consultant", "VP Sales").
 */
export function classifyTitle(title: string): TitleClassification {
  const cleanTitle = (title || "").trim();
  if (!cleanTitle) {
    return { isIC: false, isExecutive: false, confidence: 5 };
  }

  const isExecutive = EXECUTIVE_OVERRIDE_REGEX.test(cleanTitle);
  if (isExecutive) {
    return { isIC: false, isExecutive: true, confidence: 9 };
  }

  const isIC = NON_DECISION_MAKER_REGEX.test(cleanTitle);
  if (isIC) {
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
