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
  type LLMProviderAttempt,
  type LLMUsage,
} from "../../services/llm.js";
import { estimateTokenCount } from "../llmBudget.js";
import { summarizeLLM } from "../telemetry.js";
import { rankLeadForFinalSelection } from "../scoring.js";
import { effectiveScore as sharedEffectiveScore } from "../sessionHelpers.js";
import type { SessionContext, LeadQueryRunTracker } from "../pipelineTypes.js";
import type { ProspectContract } from "../prospectContract.js";
import type { QueryRunStats } from "../strategist.js";
import {
  NON_DECISION_MAKER_REGEX,
  EXECUTIVE_OVERRIDE_REGEX as OWNER_TERMS_REGEX,
  classifyTitle,
} from "../titleTriage.js";
import { runGatedCompanyAttribution } from "../companyAttribution.js";
export { NON_DECISION_MAKER_REGEX, OWNER_TERMS_REGEX };

export function computeJudgeDynamicMaxTokens(batchLength: number): number {
  return Math.min(2400, Math.max(500, batchLength * 350));
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
    const title = String(
      candidate.lead.currentTitle ||
        candidate.lead.title ||
        candidate.lead.headline ||
        "",
    );
    const classification = classifyTitle(title);
    if (classification.isIC) {
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

  if (!candidates || candidates.length === 0) {
    return { qualifiedCandidates, judgmentInsights };
  }

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
  }

  if (triageRejected.length > 0) {
    logEvent(
      `Round ${round} Pre-Judge Role Triage: Discarded ${triageRejected.length} non-decision-maker candidate(s) in 0ms without invoking LLM judge.`,
    );
  }

  const companyAttributionEnabled =
    process.env.LEAD_COMPANY_ATTRIBUTION_ENABLED !== "false";

  // Micro-batch size: 6 candidates per batch for optimal context utilization on modern LLMs
  const microBatchSize = Math.max(
    1,
    Math.min(8, Number(process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE || 6)),
  );
  const judgeConcurrency = Math.max(
    1,
    Math.min(4, Number(process.env.FINALIST_JUDGE_CONCURRENCY || config.judgeConcurrency || 1)),
  );

  const microBatches: FinalistCandidate[][] = [];
  for (let i = 0; i < vettedCandidates.length; i += microBatchSize) {
    microBatches.push(vettedCandidates.slice(i, i + microBatchSize));
  }

  // Chunk micro-batches into waves according to concurrency
  const waves: FinalistCandidate[][][] = [];
  for (let i = 0; i < microBatches.length; i += judgeConcurrency) {
    waves.push(microBatches.slice(i, i + judgeConcurrency));
  }

  let cumulativeQualified = input.currentQualifiedCount || 0;

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
    const judgePrompt = buildFinalistJudgePrompt(contract, batch);
    const dynamicMaxTokens = computeJudgeDynamicMaxTokens(batch.length);
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

      const minimumValid = Math.ceil(batch.length * 0.6);
      if (validation.validJudgmentCount < minimumValid && batch.length > 1 && depth < 2) {
        logEvent(
          `Incremental Judge: Batch ${batchIndex + 1} omitted judgments; splitting ${batch.length} candidates.`,
        );
        const mid = Math.ceil(batch.length / 2);
        const left = await evaluateSingleBatch(batch.slice(0, mid), batchIndex, depth + 1);
        const right = await evaluateSingleBatch(batch.slice(mid), batchIndex, depth + 1);
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
        lead.qualification = qualification;
        lead.whyThisLead = qualification.reason || outcome.reason;
        lead.finalSelectionScore = qualification.finalScore;
        if (lead.scoreBreakdown) {
          lead.scoreBreakdown.finalScore = qualification.finalScore;
        }
        lead.scoreOverride = qualification.finalScore;
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
        const queryRun =
          leadQueryRuns?.get?.(candidate.lead) ||
          leadQueryRuns?.get?.(candidate);
        if (queryRun) {
          const jm = judgmentsByCandidateId.get(candidate.candidateId);
          if (Array.isArray(jm?.requirements)) {
            if (!queryRun.requirementFailCounts) {
              queryRun.requirementFailCounts = {};
            }
            for (const req of jm.requirements) {
              if (req && req.status === "fail" && req.requirementId) {
                queryRun.requirementFailCounts[req.requirementId] =
                  (queryRun.requirementFailCounts[req.requirementId] || 0) + 1;
              }
            }
          }
        }
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
        `[LLM 200 OK] ${successfulAttempt?.provider || "LLM"} \u00b7 model: ${resolvedModel} \u00b7 ${latency}ms${tokens ? ` \u00b7 ${tokens.toLocaleString()} tok` : ""} [Incremental Judge: ${batchQualified.length}/${batch.length} qualified]`,
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

      return batchQualified;
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
      if (retries < 1) {
        logEvent(
          `Incremental judge batch ${batchIndex + 1} failed (${error.message || String(error)}); retrying once...`,
        );
        return evaluateSingleBatch(batch, batchIndex, depth, retries + 1);
      }
      const isTokenOrSizeError =
        error.isTokenLimit ||
        /413|payload too large|too many tokens|rate_limit_exceeded|429|rate[-_ ]?limit/i.test(
          error.message || "",
        );
      if (batch.length > 1 && (isTokenOrSizeError || depth < 2)) {
        logEvent(
          `Incremental judge batch ${batchIndex + 1} failed (${error.message || String(error)}); splitting ${batch.length} candidates.`,
        );
        const mid = Math.ceil(batch.length / 2);
        const left = await evaluateSingleBatch(
          batch.slice(0, mid),
          batchIndex,
          depth + 1,
        );
        const right = await evaluateSingleBatch(
          batch.slice(mid),
          batchIndex,
          depth + 1,
        );
        return [...left, ...right];
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

  for (let w = 0; w < waves.length; w++) {
    const waveBatches = waves[w];
    const waveCandidates = waveBatches.flat();

    if (companyAttributionEnabled && waveCandidates.length > 0) {
      const attrSummary = await runGatedCompanyAttribution(
        waveCandidates,
        contract,
        {
          signal: state.abortController?.signal,
          logEvent,
        },
      );
      if (attrSummary.attributedCount > 0) {
        logEvent(
          `Round ${round} Company Attribution: evaluated ${attrSummary.attributedCount} candidates (${attrSummary.verifiedCount} verified fit, ${attrSummary.contradictionCount} disqualifying contradictions).`,
        );
      }
    }

    const activeWaveCandidates: FinalistCandidate[] = [];
    for (const candidate of waveCandidates) {
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
      } else {
        activeWaveCandidates.push(candidate);
      }
    }

    if (activeWaveCandidates.length === 0) {
      continue;
    }

    const activeWaveBatches: FinalistCandidate[][] = [];
    for (let i = 0; i < activeWaveCandidates.length; i += microBatchSize) {
      activeWaveBatches.push(activeWaveCandidates.slice(i, i + microBatchSize));
    }

    const waveResults: any[][] = await Promise.all(
      activeWaveBatches.map((batch, idx) =>
        evaluateSingleBatch(batch, w * judgeConcurrency + idx),
      ),
    );
    const newlyQualified = waveResults.flat();
    qualifiedCandidates.push(...newlyQualified);
    cumulativeQualified += newlyQualified.length;

    // Check wave short-circuit:
    if (
      targetCushion !== undefined &&
      cumulativeQualified >= targetCushion &&
      w < waves.length - 1
    ) {
      logEvent(
        `Incremental Judge Round ${round}: Wave ${w + 1}/${waves.length} reached target cushion (${cumulativeQualified}/${targetCushion}); short-circuiting remaining ${waves.length - w - 1} wave(s).`,
      );
      break;
    }
  }

  return { qualifiedCandidates, judgmentInsights };
}
