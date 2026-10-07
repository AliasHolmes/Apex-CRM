import {
  buildFinalistJudgePrompt,
  validateFinalistJudgments,
  finalistJudgeSchema,
  FINALIST_JUDGE_SYSTEM_PROMPT,
  checkStrictContradiction,
  type FinalistCandidate,
  type FinalistOutcomeStatus,
  type Qualification,
} from "../finalistJudge.js";
import {
  openAIStructured,
  DEFAULT_PRIMARY_MODEL,
  describeLLMRoute,
  type LLMProviderAttempt,
  type LLMUsage,
} from "../../services/llm.js";
import { estimateTokenCount } from "../llmBudget.js";
import { formatLatencySeconds } from "../terminalLog.js";
import { summarizeLLM } from "../telemetry.js";
import { rankLeadForFinalSelection } from "../scoring.js";
import { effectiveScore as sharedEffectiveScore } from "../sessionHelpers.js";
import {
  readPastUserDecisions,
  computeRequirementsFingerprint,
  upsertCandidateVerdict,
  getCandidateVerdict,
} from "../../db.js";
import { candidateVerdictKey, computeEvidenceHash, isCacheableFingerprint } from "../candidateVerdicts.js";
import type { SessionContext, LeadQueryRunTracker } from "../pipelineTypes.js";
import type { ProspectContract } from "../prospectContract.js";
import { deriveContractDomainCluster } from "../adaptiveScheduler.js";
import type { QueryRunStats } from "../strategist.js";
import {
  NON_DECISION_MAKER_REGEX,
  EXECUTIVE_OVERRIDE_REGEX as OWNER_TERMS_REGEX,
  classifyTitle,
  hasStudentSignal,
} from "../titleTriage.js";
import { runGatedCompanyAttribution } from "../companyAttribution.js";
import { runRollingPool } from "../rollingPool.js";
import { resolveTitleFromQualification } from "../titleResolution.js";
export { NON_DECISION_MAKER_REGEX, OWNER_TERMS_REGEX };

export function computeJudgeDynamicMaxTokens(
  batchLength: number,
  requirementCount = 4,
  hasReasoningModel = false,
): number {
  const safeBatch = Math.max(1, batchLength);
  const safeReqs = Math.max(1, requirementCount);
  const perCandidateTokens = safeReqs * 65 + 60;
  const jsonOutputBudget = safeBatch * perCandidateTokens + 300;
  const reasoningBuffer = hasReasoningModel ? 1500 : 400;
  return Math.min(8000, Math.max(1500, jsonOutputBudget + reasoningBuffer));
}

/** How many candidates fit one judge call on a provider with a hard output cap. */
export function computeJudgeBatchCapacity(
  outputTokenCap: number,
  requirementCount = 4,
  hasReasoningModel = false,
): number {
  if (!Number.isFinite(outputTokenCap)) return Number.MAX_SAFE_INTEGER;
  const perCandidate = Math.max(1, requirementCount) * 65 + 60;
  const overhead = 300 + (hasReasoningModel ? 1500 : 400);
  return Math.max(1, Math.floor((outputTokenCap - overhead) / perCandidate));
}

export function isEligibleForSafetyNet(
  lead: any,
  contract: ProspectContract,
  insight?: { status?: string; score?: number } | null,
): boolean {
  if (lead._autoFailed) return false;
  if (checkStrictContradiction(lead, contract) !== null) return false;
  if (insight && insight.status === "hard_fail") return false;
  return true;
}

export type PrimaryAdmission = { admit: boolean; reason?: string };

/**
 * Primary-admission gate: decides whether a judged lead may count toward the target.
 *
 * Why it exists: the judge treats an `unknown` on any context requirement as
 * `qualified_partial` (15% score discount), on the theory that snippets routinely omit
 * context such as location. That is sound for incidental context but wrong for the
 * requirement that *defines* the brief. For "AI service provider agency owner", the company
 * type is the brief; admitting a founder whose company type is unknown fills the quota with
 * people who are not what was asked for (observed: 7 of 20 leads in one session).
 *
 * Rules (a hard `company_type` requirement must exist for either to apply):
 *  1. It must be positively proven (`pass`). Absence of evidence is not admission. For an
 *     `any_of` group, one passing member suffices.
 *  2. A fresh company attribution that is neither `verified_fit` nor `matches_brief`
 *     overrides a judge `pass` (the two disagreed on one lead: the judge passed a company
 *     the attribution stage had classed as an adjacent software product). Stored-profile
 *     attributions are skipped: they carry placeholder "adjacent/unverified" values by design.
 *
 * Requirements the engine deliberately relaxed (ablation rescue) are not enforced.
 */
export function evaluatePrimaryAdmission(
  lead: any,
  qualification: Pick<Qualification, "requirements"> | undefined | null,
  contract: ProspectContract,
): PrimaryAdmission {
  const ablatedId = lead?._ablatedRequirementId;
  const defining = (contract?.requirements || []).filter(
    (r: any) =>
      r.importance === "hard" && r.scope === "company_type" && r.id !== ablatedId,
  );
  if (defining.length === 0) return { admit: true };

  const statusOf = (id: string) =>
    (qualification?.requirements || []).find((a: any) => a.requirementId === id)
      ?.status;

  const groups = new Map<string, any[]>();
  for (const req of defining as any[]) {
    const key =
      req.groupId && req.matchRule === "any_of" ? `g:${req.groupId}` : `r:${req.id}`;
    groups.set(key, [...(groups.get(key) || []), req]);
  }
  for (const members of groups.values()) {
    if (!members.some((m) => statusOf(m.id) === "pass")) {
      return {
        admit: false,
        reason: `Company type is the defining requirement of this brief and was not proven (${members.map((m) => statusOf(m.id) || "missing").join("/")}).`,
      };
    }
  }

  const attr = lead?.companyAttribution;
  if (
    attr &&
    !attr.fromStoredProfile &&
    attr.verdict !== "verified_fit" &&
    attr.queryAlignment &&
    attr.queryAlignment !== "matches_brief"
  ) {
    return {
      admit: false,
      reason: `Company attribution found the company ${attr.queryAlignment} to the brief (${attr.businessModel || "unknown model"}); judge pass overridden.`,
    };
  }
  return { admit: true };
}

export function shouldParkWithheldCandidate(
  lead: any,
  qualification: Pick<Qualification, "requirements"> | undefined | null,
  contract: ProspectContract,
): boolean {
  if (!lead || !qualification || !contract) return false;

  // 1. Did the person_role requirement pass?
  const personRoleReqs = (contract.requirements || []).filter(
    (r: any) => r.importance === "hard" && r.scope === "person_role",
  );
  if (personRoleReqs.length === 0) return false;
  const roleAssessments = (qualification.requirements || []).filter((a: any) =>
    personRoleReqs.some((r: any) => r.id === a.requirementId),
  );
  const rolePassed =
    roleAssessments.length > 0 &&
    roleAssessments.every((a: any) => a.status === "pass");
  if (!rolePassed) return false;

  // 2. Is company_type solely unproven (not contradicted)?
  const companyTypeReqs = (contract.requirements || []).filter(
    (r: any) => r.importance === "hard" && r.scope === "company_type",
  );
  if (companyTypeReqs.length === 0) return false;
  const companyAssessments = (qualification.requirements || []).filter((a: any) =>
    companyTypeReqs.some((r: any) => r.id === a.requirementId),
  );

  // If any company requirement explicitly failed, it is contradicted, not unproven
  const anyCompanyFailed = companyAssessments.some((a: any) => a.status === "fail");
  if (anyCompanyFailed) return false;

  // If company requirement already passed, it is not withheld for company_type
  const anyCompanyPassed = companyAssessments.some((a: any) => a.status === "pass");
  if (anyCompanyPassed) return false;

  // Attribution check: must not contradict brief
  const attr = lead.companyAttribution;
  if (
    attr &&
    !attr.fromStoredProfile &&
    attr.queryAlignment === "contradicts_brief"
  ) {
    return false;
  }

  return true;
}

export function isParkWithheldEnabled(): boolean {
  return (
    process.env.LEAD_PARK_WITHHELD === "true" ||
    process.env.LEAD_PARK_WITHHELD === "1"
  );
}

export function parkCandidate(
  state: any,
  candidate: FinalistCandidate,
  round: number,
): boolean {
  if (!state) return false;
  state.parkedCandidates = state.parkedCandidates || [];
  const candidateKey =
    candidate.lead.contactDetails?.linkedinUrl ||
    candidate.lead.sourceUrl ||
    candidate.candidateId;
  const companyKey = (
    candidate.lead.currentCompany ||
    candidate.lead.company ||
    ""
  )
    .toLowerCase()
    .trim();

  // If already parked, don't duplicate
  if (state.parkedCandidates.some((p: any) => p.candidateKey === candidateKey)) {
    return false;
  }

  // Cap: 20 entries, oldest first eviction
  if (state.parkedCandidates.length >= 20) {
    state.parkedCandidates.shift();
  }

  state.parkedCandidates.push({
    candidateKey,
    companyKey,
    parkedRound: round,
    cause: candidate.lead.evidence?.companyProbeOutcome || "no_domain",
    recheckAttempts: 0,
    candidate: {
      candidateId: candidate.candidateId,
      lead: candidate.lead,
      evidence: [...(candidate.evidence || [])],
    },
  });
  return true;
}

export type SafetyNetPromotionResult = {
  /** Number of leads actually pushed onto `qualifiedLeads`. */
  promoted: number;
  /** Number of accepted leads that passed the eligibility filter before the slice. */
  considered: number;
};

/**
 * Close a shortfall by promoting the highest-scoring non-disqualified accepted leads.
 *
 * Gated by `ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION`; the call site owns the gate, this
 * function owns the policy. Extracted from `discoveryEngine` so the promotion rule is a
 * named, testable unit rather than an inline block - it previously existed in two places
 * with *different* semantics (the judge-stage copy and the engine copy), which is exactly
 * the drift the 2026-09-13 audit was written about.
 *
 * Mutates in place: sets `finalSelectionScore` on every considered lead, and on each
 * promoted lead sets `qualification` (only when absent), `whyThisLead`, `isRescued`, and
 * appends it to `qualifiedLeads`.
 *
 * A lead already present in `qualifiedLeads` is never promoted twice - matched by `id` and
 * by LinkedIn/source URL, since the two are not always both present.
 */
export function promoteSafetyNetCandidates(args: {
  acceptedLeads: any[];
  qualifiedLeads: any[];
  contract: ProspectContract;
  shortfall: number;
}): SafetyNetPromotionResult {
  const { acceptedLeads, qualifiedLeads, contract, shortfall } = args;

  const qualifiedUrls = new Set(
    qualifiedLeads
      .map((l) => l.contactDetails?.linkedinUrl || l.sourceUrl || "")
      .filter(Boolean),
  );
  const qualifiedIds = new Set(qualifiedLeads.map((l) => l.id).filter(Boolean));

  const safetyNetCandidates = acceptedLeads.filter((lead) => {
    if (lead.id && qualifiedIds.has(lead.id)) return false;
    const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl;
    if (url && qualifiedUrls.has(url)) return false;
    if (!isEligibleForSafetyNet(lead, contract, lead.judgmentInsight)) {
      return false;
    }
    if (
      (lead.qualification as any)?.status === "hard_fail" ||
      lead.qualification?.verdict === "disqualified"
    ) {
      return false;
    }
    return true;
  });

  for (const lead of safetyNetCandidates) {
    lead.finalSelectionScore = rankLeadForFinalSelection(lead);
  }

  safetyNetCandidates.sort((a, b) => {
    const rankDelta =
      Number(b.finalSelectionScore || 0) - Number(a.finalSelectionScore || 0);
    if (rankDelta !== 0) return rankDelta;
    return sharedEffectiveScore(b) - sharedEffectiveScore(a);
  });

  const promoted = safetyNetCandidates.slice(0, Math.max(0, shortfall));
  for (const lead of promoted) {
    lead.qualification = lead.qualification || {
      verdict: "rescued",
      reason:
        "Safety Net: Best-effort delivery for top-scoring candidate from discovery pool",
      finalScore: lead.finalSelectionScore || 5.0,
    };
    lead.whyThisLead =
      lead.whyThisLead ||
      "Safety Net: Best-effort delivery for top-scoring candidate from discovery pool";
    lead.isRescued = true;
    qualifiedLeads.push(lead);
    if (lead.id) qualifiedIds.add(lead.id);
    const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl;
    if (url) qualifiedUrls.add(url);
  }

  return { promoted: promoted.length, considered: safetyNetCandidates.length };
}

export function filterNonDecisionMakers(
  candidates: FinalistCandidate[],
  contract: ProspectContract,
): {
  admitted: FinalistCandidate[];
  rejected: FinalistCandidate[];
} {
  const requiresLeadershipRole = contract.requirements.some(
    (r) =>
      r.scope === "person_role" &&
      r.importance === "hard" &&
      /\b(owner|founder|director|partner|head|ceo|executive)\b/i.test(
        r.description + " " + (r.acceptableTerms || []).join(" "),
      ),
  );

  if (!requiresLeadershipRole) {
    return { admitted: candidates, rejected: [] };
  }

  const admitted: FinalistCandidate[] = [];
  const rejected: FinalistCandidate[] = [];

  for (const candidate of candidates) {
    const rawTitle = String(
      candidate.lead.currentTitle ||
        candidate.lead.title ||
        "",
    );
    const headline = String(candidate.lead.headline || "");
    const title = rawTitle || headline;
    const classification = classifyTitle(title, contract);
    const studentSignal = hasStudentSignal(rawTitle, headline);
    if (classification.isIC || studentSignal) {
      rejected.push(candidate);
    } else {
      admitted.push(candidate);
    }
  }

  return { admitted, rejected };
}


export type IncrementalJudgeInput = {
  candidates: FinalistCandidate[];
  contract: ProspectContract;
  stats: any;
  leadQueryRuns?:
    | LeadQueryRunTracker
    | WeakMap<Record<string, any>, QueryRunStats>;
  round: number;
  targetCushion?: number;
  currentQualifiedCount?: number;
};

export type IncrementalJudgeOutput = {
  qualifiedCandidates: any[];
  judgmentInsights: Map<
    string,
    { status: FinalistOutcomeStatus; score: number; reason?: string }
  >;
  requirementFailCounts?: Record<string, number>;
};

export async function evaluateIncrementalJudgeBatches(
  ctx: SessionContext,
  input: IncrementalJudgeInput,
): Promise<IncrementalJudgeOutput> {
  const {
    candidates,
    contract,
    stats: _stats,
    leadQueryRuns,
    round,
    targetCushion,
  } = input;
  const { config, state, logEvent, recordTrace } = ctx;
  const { llmCircuitBreaker } = state;

  const judgmentInsights = new Map<
    string,
    { status: FinalistOutcomeStatus; score: number; reason?: string }
  >();
  const qualifiedCandidates: any[] = [];
  const batchRequirementFailCounts: Record<string, number> = {};

  if (!candidates || candidates.length === 0) {
    return {
      qualifiedCandidates,
      judgmentInsights,
      requirementFailCounts: batchRequirementFailCounts,
    };
  }

  const reqFingerprint = computeRequirementsFingerprint(contract?.requirements);

  const passVerdictTtlDays = Math.min(
    Math.max(Number(process.env.LEAD_PASS_VERDICT_TTL_DAYS ?? 14) || 14, 1),
    60,
  );
  const applyQualification = (
    lead: any,
    qualification: Qualification,
    fallbackReason?: string,
    candidateEvidence?: any[],
  ) => {
    lead.qualification = qualification;
    lead.whyThisLead = qualification.reason || fallbackReason;
    lead.finalSelectionScore = qualification.finalScore;
    if (lead.scoreBreakdown) {
      lead.scoreBreakdown.finalScore = qualification.finalScore;
    }
    lead.scoreOverride = qualification.finalScore;

    const titleRes = resolveTitleFromQualification({
      lead,
      qualification,
      contract,
      evidence: candidateEvidence,
    });
    if (titleRes?.title) {
      lead.currentTitle = titleRes.title;
      lead.titleSource = titleRes.source;
    }
  };

  const recordCandidateJudgeOutcome = (
    candidate: FinalistCandidate,
    status: FinalistOutcomeStatus | undefined,
    failedReqIds: string[],
    source: "llm" | "deterministic",
  ) => {
    for (const reqId of failedReqIds) {
      if (reqId) {
        batchRequirementFailCounts[reqId] =
          (batchRequirementFailCounts[reqId] || 0) + 1;
      }
    }

    // Only LLM verdicts are remembered across sessions: a regex triage mistake must
    // not hide a candidate for 30 days.
    if (status === "hard_fail" && source === "llm" && isCacheableFingerprint(reqFingerprint)) {
      const key = candidateVerdictKey(candidate.lead);
      if (key) {
        upsertCandidateVerdict({
          identityKey: key,
          requirementHash: reqFingerprint,
          verdict: "hard_fail",
          reason: judgmentInsights.get(candidate.candidateId)?.reason || "Disqualified by finalist judge",
          failedRequirementId: failedReqIds[0],
        });
      }
    }

    const queryRun =
      leadQueryRuns?.get?.(candidate.lead) || leadQueryRuns?.get?.(candidate);
    if (!queryRun) return;
    queryRun.judgedCandidates = (queryRun.judgedCandidates || 0) + 1;
    if (status === "hard_fail") {
      queryRun.hardFailedCandidates = (queryRun.hardFailedCandidates || 0) + 1;
    } else if (status === "unknown" || status === "unjudged") {
      queryRun.unknownCandidates = (queryRun.unknownCandidates || 0) + 1;
    }
    if (failedReqIds.length > 0) {
      if (!queryRun.requirementFailCounts) {
        queryRun.requirementFailCounts = {};
      }
      for (const reqId of failedReqIds) {
        if (reqId) {
          queryRun.requirementFailCounts[reqId] =
            (queryRun.requirementFailCounts[reqId] || 0) + 1;
        }
      }
    }
  };

  // Pre-Judge Role Triage: Discard obvious non-decision makers deterministically before spending LLM tokens
  const { admitted: vettedCandidates, rejected: triageRejected } =
    filterNonDecisionMakers(candidates, contract);

  for (const candidate of triageRejected) {
    const title = String(
      candidate.lead.currentTitle ||
        candidate.lead.title ||
        candidate.lead.headline ||
        "",
    );
    const triageInsight = {
      status: "hard_fail" as FinalistOutcomeStatus,
      score: -100,
      reason: `Pre-judge triage: title "${title}" is an individual contributor/non-decision-maker role.`,
    };
    judgmentInsights.set(candidate.candidateId, triageInsight);
    candidate.lead.judgmentInsight = triageInsight;
    candidate.lead.qualification = {
      policyVersion: contract.policyVersion,
      verdict: "hard_fail",
      qualificationSource: "deterministic",
      finalScore: 0,
      requirements: contract.requirements.map((r) => ({
        requirementId: r.id,
        status: r.scope === "person_role" ? "fail" : "unknown",
      })),
      reason: `Title "${title}" does not meet decision maker requirement.`,
    };
    const roleReqIds = contract.requirements
      .filter((r) => r.scope === "person_role")
      .map((r) => r.id);
    recordCandidateJudgeOutcome(candidate, "hard_fail", roleReqIds, "deterministic");
  }

  if (triageRejected.length > 0) {
    logEvent(
      `Round ${round} Pre-Judge Role Triage: Discarded ${triageRejected.length} non-decision-maker candidate(s) in 0ms without invoking LLM judge.`,
    );
  }

  const companyAttributionEnabled =
    process.env.LEAD_COMPANY_ATTRIBUTION_ENABLED !== "false";

  // Dynamic token-weight micro-batching: pack up to ~4,500 evidence tokens per batch (1-12 candidates),
  // or honor FINALIST_JUDGE_MICRO_BATCH_SIZE when explicitly configured.
  const explicitBatchSize = Number(process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE || 0);
  const configuredMaxBatchCandidates =
    Number.isFinite(explicitBatchSize) && explicitBatchSize > 0
      ? Math.max(1, Math.min(12, Math.floor(explicitBatchSize)))
      : 10;
  const firstPassRoute = describeLLMRoute("fast");
  const maxBatchCandidates = Math.min(
    configuredMaxBatchCandidates,
    computeJudgeBatchCapacity(
      firstPassRoute.outputTokenCap,
      contract?.requirements?.length || 4,
      firstPassRoute.reasoning,
    ),
  );
  const targetBatchTokens = Number(process.env.FINALIST_JUDGE_BATCH_TOKEN_TARGET || 4500);
  const judgeConcurrency = Math.max(
    1,
    Math.min(8, Number(process.env.FINALIST_JUDGE_CONCURRENCY || config.judgeConcurrency || 1)),
  );

  const reusedQualified: any[] = [];
  let withheldByAdmissionGate = 0;
  const withheldCauseCounts: Record<string, number> = {
    no_domain: 0,
    probe_cap: 0,
    negative_cache: 0,
    probe_failed: 0,
    thin_text: 0,
  };
  const candidatesToJudge: FinalistCandidate[] = [];
  for (const candidate of vettedCandidates) {
    const identityKey = isCacheableFingerprint(reqFingerprint) ? candidateVerdictKey(candidate.lead) : "";
    const evidenceHash = identityKey ? computeEvidenceHash(candidate.evidence) : "";
    const cached = identityKey && evidenceHash ? getCandidateVerdict(identityKey, reqFingerprint) : null;
    if (cached?.verdict === "pass" && cached.evidenceHash === evidenceHash && cached.qualification) {
      const qualification = cached.qualification as Qualification;
      const reuseAdmission = evaluatePrimaryAdmission(candidate.lead, qualification, contract);
      if (!reuseAdmission.admit) {
        const withheld = {
          status: "unknown" as FinalistOutcomeStatus,
          score: -1,
          reason: reuseAdmission.reason || "Withheld by primary admission gate.",
        };
        judgmentInsights.set(candidate.candidateId, withheld);
        candidate.lead.judgmentInsight = withheld;
        withheldByAdmissionGate++;
        const cause = candidate.lead.evidence?.companyProbeOutcome || "no_domain";
        withheldCauseCounts[cause] = (withheldCauseCounts[cause] || 0) + 1;
        if (
          isParkWithheldEnabled() &&
          shouldParkWithheldCandidate(candidate.lead, qualification, contract)
        ) {
          parkCandidate(state, candidate, round);
        }
        continue;
      }
      applyQualification(candidate.lead, qualification, cached.reason, candidate.evidence);
      const insight = {
        status: qualification.verdict as FinalistOutcomeStatus,
        score: qualification.finalScore,
        reason: qualification.reason,
      };
      judgmentInsights.set(candidate.candidateId, insight);
      candidate.lead.judgmentInsight = insight;
      reusedQualified.push(candidate.lead);
      continue;
    }
    candidatesToJudge.push(candidate);
  }
  if (withheldByAdmissionGate > 0) {
    logEvent(
      `Round ${round} Judge: admission gate withheld ${withheldByAdmissionGate} stored qualification(s) whose defining company-type requirement was never proven.`,
    );
  }
  if (reusedQualified.length > 0) {
    qualifiedCandidates.push(...reusedQualified);
    logEvent(
      `Round ${round} Judge: reused ${reusedQualified.length} stored qualification(s) with unchanged evidence; 0 LLM tokens spent.`,
    );
  }

  const microBatches: FinalistCandidate[][] = [];
  let currentBatch: FinalistCandidate[] = [];
  let currentBatchTokens = 0;
  for (const cand of candidatesToJudge) {
    const evText = Array.isArray(cand.evidence)
      ? cand.evidence
          .slice(0, 6)
          .map((e) => String(e?.text || "").slice(0, 2400))
          .join("\n")
      : "";
    const candTokens = Math.max(150, estimateTokenCount(evText) + 120);
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxBatchCandidates ||
        currentBatchTokens + candTokens > targetBatchTokens)
    ) {
      microBatches.push(currentBatch);
      currentBatch = [cand];
      currentBatchTokens = candTokens;
    } else {
      currentBatch.push(cand);
      currentBatchTokens += candTokens;
    }
  }
  if (currentBatch.length > 0) {
    microBatches.push(currentBatch);
  }

  const pastDecisions = readPastUserDecisions({
    requirementsFingerprint: reqFingerprint,
    domainCluster: deriveContractDomainCluster(contract, config.promptQuery),
    limit: 6,
  });

  let cumulativeQualified = (input.currentQualifiedCount || 0) + reusedQualified.length;

  const fallbackResilientCandidates = (
    candidatesToFallback: FinalistCandidate[],
    reasonMsg: string,
  ): any[] => {
    return candidatesToFallback.map((candidate) => {
      const existingScore = sharedEffectiveScore(candidate.lead);
      const finalScore = Math.min(
        10,
        Math.max(
          1,
          Math.round(
            candidate.lead.finalSelectionScore ??
              candidate.lead.score ??
              (existingScore > 0 ? existingScore : 5),
          ),
        ),
      );
      const fallbackQualification: Qualification = {
        policyVersion: contract.policyVersion,
        verdict: "unverified",
        qualificationSource: "deterministic",
        finalScore,
        requirements: contract.requirements.map((r) => ({
          requirementId: r.id,
          status: "unknown",
        })),
        reason: `Not LLM-judged (model unavailable): ${reasonMsg}. Treated as unverified.`,
        semanticFit: finalScore,
        evidenceConfidence: 5,
        authorityFit: finalScore,
      };
      candidate.lead.qualification = fallbackQualification;
      candidate.lead.whyThisLead = fallbackQualification.reason;
      candidate.lead.finalSelectionScore = finalScore;
      if (candidate.lead.scoreBreakdown) {
        candidate.lead.scoreBreakdown.finalScore = finalScore;
      }
      candidate.lead.scoreOverride = finalScore;
      candidate.lead._qualificationFallback = "fallback_unverified";
      candidate.lead.judgmentInsight = {
        status: "unverified",
        score: finalScore,
        reason: fallbackQualification.reason,
      };
      judgmentInsights.set(candidate.candidateId, {
        status: "unverified",
        score: finalScore,
        reason: fallbackQualification.reason,
      });
      return candidate.lead;
    });
  };

  const evaluateSingleBatch = async (
    batch: FinalistCandidate[],
    batchIndex: number,
    depth = 0,
    retries = 0,
  ): Promise<any[]> => {
    const judgeStarted = Date.now();
    const judgeAttempts: LLMProviderAttempt[] = [];
    let judgeUsage: LLMUsage | undefined;
    const judgePrompt = buildFinalistJudgePrompt(contract, batch, pastDecisions);
    const dynamicMaxTokens = computeJudgeDynamicMaxTokens(
      batch.length,
      contract?.requirements?.length || 4,
      describeLLMRoute(depth > 0 ? "reasoning" : "fast").reasoning,
    );
    const estimatedInputTokens = estimateTokenCount(judgePrompt);

    try {
      const judgmentResult = await openAIStructured<any>(
        judgePrompt,
        finalistJudgeSchema,
        FINALIST_JUDGE_SYSTEM_PROMPT,
        {
          maxTokens: dynamicMaxTokens,
          temperature: 0,
          retryOnParseFailure: false,
          timeoutMs: Math.min(
            120_000,
            Number(
              process.env.LLM_FINALIST_TIMEOUT_MS ||
                process.env.LLM_TIMEOUT_MS ||
                90_000,
            ),
          ),
          circuitBreaker: llmCircuitBreaker,
          signal: state.abortController.signal,
          routingTier: depth > 0 ? "reasoning" : "fast",
          metadata: {
            stage: "judge",
            candidateCount: batch.length,
            promptSize: judgePrompt.length,
            sessionId: config.sessionId,
          },
          onProviderAttempt: (attempt) => judgeAttempts.push(attempt),
          onUsage: (usage) => {
            judgeUsage = usage;
          },
        },
      );

      const validation = validateFinalistJudgments(
        judgmentResult,
        contract,
        batch,
      );

      // If zero judgments were returned and batch is divisible, split immediately
      if (validation.validJudgmentCount === 0 && batch.length > 1 && depth < 2) {
        logEvent(
          `Incremental Judge: Batch ${batchIndex + 1} yielded 0 judgments; splitting ${batch.length} candidates.`,
        );
        const mid = Math.ceil(batch.length / 2);
        const [left, right] = await Promise.all([
          evaluateSingleBatch(batch.slice(0, mid), batchIndex, depth + 1),
          evaluateSingleBatch(batch.slice(mid), batchIndex, depth + 1),
        ]);
        return [...left, ...right];
      }

      for (const [judgedId, outcome] of validation.outcomes) {
        judgmentInsights.set(judgedId, {
          status: outcome.status,
          score:
            outcome.qualification?.finalScore ??
            (outcome.status === "hard_fail" ? -100 : -1),
          reason: outcome.reason,
        });
      }

      const batchQualified = batch.flatMap((candidate) => {
        const outcome = validation.outcomes.get(candidate.candidateId);
        if (
          !outcome ||
          (outcome.status !== "qualified" &&
            outcome.status !== "qualified_partial")
        ) {
          return [];
        }
        const qualification =
          outcome.qualification ||
          validation.qualifications.get(candidate.candidateId);
        if (!qualification) return [];
        const lead = candidate.lead;
        const admission = evaluatePrimaryAdmission(lead, qualification, contract);
        if (!admission.admit) {
          const withheld = {
            status: "unknown" as FinalistOutcomeStatus,
            score: -1,
            reason: admission.reason || "Withheld by primary admission gate.",
          };
          judgmentInsights.set(candidate.candidateId, withheld);
          withheldByAdmissionGate++;
          const cause = lead.evidence?.companyProbeOutcome || "no_domain";
          withheldCauseCounts[cause] = (withheldCauseCounts[cause] || 0) + 1;
          if (
            isParkWithheldEnabled() &&
            shouldParkWithheldCandidate(lead, qualification, contract)
          ) {
            parkCandidate(state, candidate, round);
          }
          logEvent(
            `Round ${round} Admission gate withheld ${String(lead.fullName || lead.currentCompany || candidate.candidateId)} (${cause}): ${withheld.reason}`,
          );
          return [];
        }
        applyQualification(lead, qualification, outcome.reason, candidate.evidence);
        if (isCacheableFingerprint(reqFingerprint) && qualification.qualificationSource !== "deterministic") {
          const identityKey = candidateVerdictKey(lead);
          const evidenceHash = computeEvidenceHash(candidate.evidence);
          if (identityKey && evidenceHash) {
            upsertCandidateVerdict({
              identityKey,
              requirementHash: reqFingerprint,
              verdict: "pass",
              reason: qualification.reason,
              evidenceHash,
              qualification,
              ttlDays: passVerdictTtlDays,
            });
          }
        }
        return [lead];
      });

      // Track requirement failures per query run:
      const rawJudgments = Array.isArray((judgmentResult as any)?.judgments)
        ? (judgmentResult as any).judgments
        : [];
      const judgmentsByCandidateId = new Map<string, any>();
      for (const j of rawJudgments) {
        const cid = String(j?.candidateId || "").trim();
        if (cid) judgmentsByCandidateId.set(cid, j);
      }
      for (const candidate of batch) {
        const ins = judgmentInsights.get(candidate.candidateId);
        if (ins) {
          candidate.lead.judgmentInsight = ins;
        }
        const jm = judgmentsByCandidateId.get(candidate.candidateId);
        const failedReqIds: string[] = [];
        if (Array.isArray(jm?.requirements)) {
          for (const req of jm.requirements) {
            if (
              req &&
              req.requirementId &&
              /^(fail|failed|disqualified)$/i.test(String(req.status || "").trim())
            ) {
              failedReqIds.push(String(req.requirementId));
            }
          }
        }
        recordCandidateJudgeOutcome(candidate, ins?.status, failedReqIds, "llm");
      }

      const successfulAttempt = judgeAttempts.find((a) => a.status === "success");
      const resolvedModel =
        judgeUsage?.model ||
        successfulAttempt?.actualModel ||
        successfulAttempt?.model ||
        process.env.OPENAI_MODEL ||
        DEFAULT_PRIMARY_MODEL;
      const latency = Date.now() - judgeStarted;
      const tokens = judgeUsage?.totalTokens;
      logEvent(
        `[LLM 200 OK] ${successfulAttempt?.provider || "LLM"} \u00b7 model: ${resolvedModel} \u00b7 ${formatLatencySeconds(latency)}${tokens ? ` \u00b7 ${tokens.toLocaleString()} tok` : ""} [Incremental Judge: ${batchQualified.length}/${batch.length} qualified]`,
      );

      recordTrace({
        phase: "candidate_processing",
        operation: "incremental_finalist_judge",
        status: "success",
        provider: "llm",
        model: resolvedModel,
        round,
        latencyMs: latency,
        counts: {
          batchSize: batch.length,
          validJudgments: validation.validJudgmentCount,
          qualified: batchQualified.length,
        },
        llm: summarizeLLM(
          "incremental_finalist_judge",
          judgePrompt,
          judgmentResult,
          latency,
          0,
          judgeAttempts,
          judgeUsage,
        ),
        metadata: {
          batch: `${batchIndex + 1}_d${depth}`,
          policyVersion: contract.policyVersion,
          estimatedInputTokens,
          requestedOutputTokens: dynamicMaxTokens,
        },
      });

      // Rescue unjudged candidates omitted due to output cutoff or model skipping:
      const unjudgedCandidates = batch.filter(
        (c) => validation.outcomes.get(c.candidateId)?.status === "unjudged",
      );
      let rescuedQualified: any[] = [];
      if (unjudgedCandidates.length > 0 && depth < 2) {
        logEvent(
          `Incremental Judge: Batch ${batchIndex + 1} omitted ${unjudgedCandidates.length}/${batch.length} candidate(s); evaluating unjudged candidates in a remainder batch.`,
        );
        rescuedQualified = await evaluateSingleBatch(
          unjudgedCandidates,
          batchIndex,
          depth + 1,
        );
      }

      return [...batchQualified, ...rescuedQualified];
    } catch (error: any) {
      const failedAttempt = judgeAttempts[judgeAttempts.length - 1];
      const failedModel = failedAttempt?.actualModel || failedAttempt?.model;
      logEvent(
        `[LLM ERROR] Incremental judge batch ${batchIndex + 1} failed: ${error.message || String(error)}`,
      );
      recordTrace({
        phase: "candidate_processing",
        operation: "incremental_finalist_judge",
        status: "error",
        provider: "llm",
        model: failedModel,
        round,
        latencyMs: Date.now() - judgeStarted,
        error: { message: error.message || String(error) },
        llm: summarizeLLM(
          "incremental_finalist_judge",
          judgePrompt,
          "",
          Date.now() - judgeStarted,
          0,
          judgeAttempts,
          judgeUsage,
        ),
        metadata: {
          batch: `${batchIndex + 1}_d${depth}`,
          policyVersion: contract.policyVersion,
          estimatedInputTokens,
          requestedOutputTokens: dynamicMaxTokens,
        },
      });
      // A cancelled session must never reach the resilient fallback below: that path invents
      // `qualified_partial` verdicts with fabricated scores for candidates the LLM never
      // evaluated, and they would still be persisted. Bail out instead of splitting and
      // retrying, which would also spend more tokens on a run the user already stopped.
      if (state.abortController.signal.aborted) {
        logEvent(
          `Incremental judge batch ${batchIndex + 1} aborted; discarding ${batch.length} unjudged candidate(s).`,
        );
        return [];
      }
      const isTokenOrSizeError =
        error.isTokenLimit ||
        /413|payload too large|too many tokens|finish_reason.*length|context length|rate_limit_exceeded|429|rate[-_ ]?limit/i.test(
          error.message || "",
        );
      if (batch.length > 1 && (isTokenOrSizeError || depth < 2)) {
        logEvent(
          `Incremental judge batch ${batchIndex + 1} failed (${error.message || String(error)}); splitting ${batch.length} candidates${isTokenOrSizeError ? " immediately without doomed retry" : ""}.`,
        );
        const mid = Math.ceil(batch.length / 2);
        const [left, right] = await Promise.all([
          evaluateSingleBatch(batch.slice(0, mid), batchIndex, depth + 1),
          evaluateSingleBatch(batch.slice(mid), batchIndex, depth + 1),
        ]);
        return [...left, ...right];
      }
      if (retries < 1) {
        logEvent(
          `Incremental judge batch ${batchIndex + 1} failed (${error.message || String(error)}); retrying once...`,
        );
        return evaluateSingleBatch(batch, batchIndex, depth, retries + 1);
      }
      logEvent(
        `WARN: Incremental judge batch ${batchIndex + 1} failed completely (${error.message || String(error)}); marking ${batch.length} candidate(s) as unverified.`,
      );
      fallbackResilientCandidates(
        batch,
        `incremental judge batch failed: ${error.message || String(error)}`,
      );
      return [];
    }
  };

  // Attribution and judging run per micro-batch inside a rolling pool, so a slow batch never
  // holds back its siblings and attribution for one batch overlaps judging of the others.
  const judgeMicroBatch = async (
    batch: FinalistCandidate[],
    batchIndex: number,
  ): Promise<any[]> => {
    if (companyAttributionEnabled && batch.length > 0) {
      const attrSummary = await runGatedCompanyAttribution(
        batch,
        contract,
        {
          signal: state.abortController?.signal,
          logEvent,
          circuitBreaker: llmCircuitBreaker,
          timeoutMs: 45_000,
          batchSize: Math.max(6, maxBatchCandidates),
          sessionId: config.sessionId,
          round,
          recordTrace,
          concurrency: 2,
        },
      );
      if (attrSummary.attributedCount > 0) {
        logEvent(
          `Round ${round} Company Attribution: evaluated ${attrSummary.attributedCount} candidates (${attrSummary.verifiedCount} verified fit, ${attrSummary.contradictionCount} disqualifying contradictions).`,
        );
      }
    }

    const activeCandidates: FinalistCandidate[] = [];
    for (const candidate of batch) {
      if (candidate.lead._autoFailed && candidate.lead._contradictionReason) {
        const contradictionInsight = {
          status: "hard_fail" as FinalistOutcomeStatus,
          score: -100,
          reason: candidate.lead._contradictionReason,
        };
        judgmentInsights.set(candidate.candidateId, contradictionInsight);
        candidate.lead.judgmentInsight = contradictionInsight;
        candidate.lead.qualification = {
          policyVersion: contract.policyVersion,
          verdict: "hard_fail",
          qualificationSource: "deterministic",
          finalScore: 0,
          requirements: contract.requirements.map((r) => ({
            requirementId: r.id,
            status:
              r.scope === "company_type" || r.scope === "company_industry"
                ? "fail"
                : "unknown",
          })),
          reason: candidate.lead._contradictionReason,
        };
        const companyReqIds = contract.requirements
          .filter(
            (r) => r.scope === "company_type" || r.scope === "company_industry",
          )
          .map((r) => r.id);
        recordCandidateJudgeOutcome(candidate, "hard_fail", companyReqIds, "deterministic");
      } else {
        activeCandidates.push(candidate);
      }
    }

    if (activeCandidates.length === 0) {
      return [];
    }
    return evaluateSingleBatch(activeCandidates, batchIndex);
  };

  let completedBatches = 0;
  const cushionReached = () =>
    targetCushion !== undefined && cumulativeQualified >= targetCushion;
  const { results: batchResults, startedCount } = await runRollingPool(
    microBatches,
    async (batch, batchIndex) => {
      const newlyQualified = await judgeMicroBatch(batch, batchIndex);
      cumulativeQualified += newlyQualified.length;
      completedBatches++;
      return newlyQualified;
    },
    {
      concurrency: judgeConcurrency,
      // Stop dequeuing as soon as the cushion is met; in-flight batches finish on their own.
      // Never before the first batch completes, so the first `judgeConcurrency` batches
      // always run (the old first wave) even when earlier rounds already met the cushion.
      shouldStop: () =>
        Boolean(state.abortController?.signal.aborted) ||
        (completedBatches > 0 && cushionReached()),
    },
  );
  // Appended in batch order, not completion order, so output is deterministic.
  for (const newlyQualified of batchResults) {
    if (newlyQualified) qualifiedCandidates.push(...newlyQualified);
  }

  if (startedCount < microBatches.length && cushionReached()) {
    logEvent(
      `Incremental Judge Round ${round}: reached target cushion (${cumulativeQualified}/${targetCushion}); skipped ${microBatches.length - startedCount} of ${microBatches.length} remaining batch(es).`,
    );
    for (let bIdx = startedCount; bIdx < microBatches.length; bIdx++) {
      for (const skippedCand of microBatches[bIdx]) {
        if (!judgmentInsights.has(skippedCand.candidateId)) {
          const skippedInsight = {
            status: "unjudged" as FinalistOutcomeStatus,
            score: -1,
            reason: `Target quota satisfied (${cumulativeQualified}/${targetCushion}); candidate reserved in audit log.`,
          };
          judgmentInsights.set(skippedCand.candidateId, skippedInsight);
          skippedCand.lead.judgmentInsight = skippedInsight;
        }
      }
    }
  }

  if (withheldByAdmissionGate > 0) {
    logEvent(
      `Admission gate withheld ${withheldByAdmissionGate}: no_domain=${withheldCauseCounts.no_domain || 0} probe_cap=${withheldCauseCounts.probe_cap || 0} probe_failed=${withheldCauseCounts.probe_failed || 0} thin_text=${withheldCauseCounts.thin_text || 0} negative_cache=${withheldCauseCounts.negative_cache || 0}`,
    );
  }

  return {
    qualifiedCandidates,
    judgmentInsights,
    requirementFailCounts: batchRequirementFailCounts,
  };
}
