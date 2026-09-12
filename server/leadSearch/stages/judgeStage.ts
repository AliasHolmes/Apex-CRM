import {
  finalistCandidateFromLead,
  partitionCandidatesByStrictEvidence,
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
import { runProviderQueue } from "../providerQueue.js";
import { rankLeadForFinalSelection } from "../scoring.js";
import { normalizeLinkedInUrl } from "../../services/linkedinEvidence.js";
import { groundCandidateWithSiteProbe } from "../siteProbe.js";
import {
  effectiveScore as sharedEffectiveScore,
  buildFallbackEvidence,
  findEvidenceForLead,
  type SessionEvidenceMeta,
} from "../sessionHelpers.js";
import type { SessionContext, LeadQueryRunTracker } from "../pipelineTypes.js";
import type { ProspectContract } from "../prospectContract.js";
import type { EvidenceMeta } from "./extractStage.js";
import type { QueryRunStats } from "../strategist.js";

const normalizeDedupeValue = (value?: string) =>
  (value || "").trim().toLowerCase();

export function computeJudgeDynamicMaxTokens(batchLength: number): number {
  return Math.min(950, Math.max(500, batchLength * 350));
}

export type JudgeStageInput = {
  contract: ProspectContract;
  evidenceByUrl: Map<string, EvidenceMeta>;
  stats: any;
  leadQueryRuns?:
    | LeadQueryRunTracker
    | WeakMap<Record<string, any>, QueryRunStats>;
  checkpointAcceptedLeads: (leads: any[], stageLabel: string) => void;
  rerankPoolTarget?: number;
};

export type JudgeStageOutput = {
  qualifiedLeads: any[];
};

export async function executeJudgeStage(
  ctx: SessionContext,
  input: JudgeStageInput,
): Promise<JudgeStageOutput> {
  const {
    contract,
    evidenceByUrl,
    stats,
    leadQueryRuns,
    checkpointAcceptedLeads,
    rerankPoolTarget,
  } = input;
  const { config, state, logEvent, recordTrace } = ctx;
  const { acceptedLeads, qualifiedLeads, llmCircuitBreaker, debugLogs } = state;
  const { targetLimit } = config;

  if (acceptedLeads.length === 0) {
    throw new Error(
      "Could not extract any new qualified profiles from search results. Try more specific criteria.",
    );
  }

  stats.rerank = stats.rerank || {};
  stats.rerank.poolSize = acceptedLeads.length;

  // Graded judge output must influence final composition even when verdicts
  // fall short of 'qualified': rescue fills prefer judge-ranked candidates and
  // never resurrect candidates the judge explicitly hard-failed.
  const judgmentInsight = new Map<
    string,
    { status: FinalistOutcomeStatus; score: number; reason?: string }
  >();
  const judgeOutcomeTotals = {
    qualified: 0,
    hardFail: 0,
    unknown: 0,
    unjudged: 0,
  };

  const fallbackEvidenceForLead = (lead: any): SessionEvidenceMeta =>
    buildFallbackEvidence(lead, config.promptQuery, stats.rounds || 1);

  const getEvidenceForLead = (lead: any): EvidenceMeta =>
    findEvidenceForLead(lead, evidenceByUrl) || fallbackEvidenceForLead(lead);

  const effectiveScore = sharedEffectiveScore;

  // Stable candidate IDs keyed by LinkedIn identity (not array position) so
  // judgment lookups survive checkpoint/restore reordering.
  const candidateIdByLead = new Map<any, string>();
  const finalistCandidates: FinalistCandidate[] = acceptedLeads.map(
    (lead, index) => {
      const evidence = getEvidenceForLead(lead);
      const dedupeKey = normalizeDedupeValue(lead.contactDetails?.linkedinUrl || lead.sourceUrl || "");
      const stableId = dedupeKey ? `c${dedupeKey}` : (lead.id ? `c_${lead.id}` : `c_r${stats.rounds || 1}_${index}`);
      candidateIdByLead.set(lead, stableId);
      return finalistCandidateFromLead(
        stableId,
        lead,
        evidence?.evidenceBlock,
        contract,
      );
    },
  );

  const { autoQualified, needsJudge } = partitionCandidatesByStrictEvidence(
    finalistCandidates,
    contract,
  );
  const effectivePoolCap = Math.max(
    rerankPoolTarget || 0,
    Math.ceil(targetLimit * 1.35),
    finalistCandidates.length,
  );
  const candidatePoolCap = Math.max(
    targetLimit,
    Math.min(240, Math.max(effectivePoolCap, 24)),
  );
  const prioritizedNeedsJudge = needsJudge.length > candidatePoolCap
    ? [...needsJudge].sort((a, b) => (effectiveScore(b.lead) || 0) - (effectiveScore(a.lead) || 0)).slice(0, candidatePoolCap)
    : needsJudge;

  // 1. Fast Deterministic Role Triage (0ms - No LLM)
  const NON_DECISION_MAKER_REGEX =
    /\b(intern|internship|student|junior|staff engineer|software engineer|swe|ml engineer|machine learning engineer|data scientist|ai researcher|postdoc|phd candidate|recruiter|talent acquisition|account executive|sdr|bdr)\b/i;
  const OWNER_TERMS_REGEX =
    /\b(owner|founder|co-founder|chief|ceo|cto|cmo|coo|president|principal|partner|managing director|director|head|vp|vice president)\b/i;
  const requiresLeadershipRole = contract.requirements.some(
    (r) =>
      r.scope === "person_role" &&
      r.importance === "hard" &&
      /\b(owner|founder|director|partner|head|ceo|executive)\b/i.test(
        r.description + " " + (r.acceptableTerms || []).join(" "),
      ),
  );

  const vettedNeedsJudge: FinalistCandidate[] = [];
  let triageNonDecisionMakers = 0;

  for (const candidate of prioritizedNeedsJudge) {
    const title = String(
      candidate.lead.currentTitle ||
        candidate.lead.title ||
        candidate.lead.headline ||
        "",
    );
    if (
      requiresLeadershipRole &&
      NON_DECISION_MAKER_REGEX.test(title) &&
      !OWNER_TERMS_REGEX.test(title)
    ) {
      triageNonDecisionMakers++;
      judgmentInsight.set(candidate.candidateId, {
        status: "hard_fail",
        score: -100,
        reason: `Pre-judge triage: title "${title}" is an individual contributor/non-decision-maker role.`,
      });
      judgeOutcomeTotals.hardFail++;
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
      continue;
    }
    vettedNeedsJudge.push(candidate);
  }

  if (triageNonDecisionMakers > 0) {
    logEvent(
      `Pre-Judge Role Triage: Discarded ${triageNonDecisionMakers} non-decision-maker candidate(s) in 0ms without invoking LLM judge.`,
    );
  }

  // 2. Pre-Judge Lightweight Site Grounding for candidates needing semantic review
  const isAgencyBrief =
    /\b(agenc|consult|studio|firm|services|integrat)\b/i.test(contract.brief) ||
    contract.requirements.some(
      (r) =>
        (r.scope === "company_type" || r.scope === "company_industry") &&
        /\b(agenc|consult|studio|firm|services|integrat)\b/i.test(
          `${r.description} ${r.acceptableTerms.join(" ")}`,
        ),
    );

  if (isAgencyBrief && vettedNeedsJudge.length > 0) {
    for (const candidate of vettedNeedsJudge.slice(0, 15)) {
      try {
        const probed = await groundCandidateWithSiteProbe(candidate.lead, {
          abortSignal: state.abortController.signal,
          timeoutMs: 2000,
        });
        if (probed) {
          const refreshed = finalistCandidateFromLead(
            candidate.candidateId,
            candidate.lead,
            candidate.lead.evidence?.evidenceBlock || getEvidenceForLead(candidate.lead)?.evidenceBlock,
            contract,
          );
          candidate.evidence = refreshed.evidence;
        }
      } catch {}
    }
  }

  const maxBatchSize = Math.max(
    1,
    Math.min(18, Number(process.env.FINALIST_JUDGE_BATCH_SIZE || 3)),
  );
  const providerTokenBudget = Math.max(
    4_000,
    Number(process.env.LLM_PROVIDER_TOKEN_BUDGET || 7_200),
  );
  const maxBatchInputTokens = Math.min(
    4_200,
    Math.max(1_600, providerTokenBudget - 3_000),
  );
  const judgeBatches: FinalistCandidate[][] = [];
  let currentBatch: FinalistCandidate[] = [];

  for (const candidate of vettedNeedsJudge) {
    const proposedBatch = [...currentBatch, candidate];
    const proposedInputTokens = estimateTokenCount(
      buildFinalistJudgePrompt(contract, proposedBatch),
    );

    if (
      currentBatch.length >= maxBatchSize ||
      (currentBatch.length > 0 && proposedInputTokens > maxBatchInputTokens)
    ) {
      judgeBatches.push(currentBatch);
      currentBatch = [candidate];
    } else {
      currentBatch = proposedBatch;
    }
  }
  if (currentBatch.length > 0) {
    judgeBatches.push(currentBatch);
  }

  qualifiedLeads.length = 0;
  qualifiedLeads.push(
    ...autoQualified.map(({ candidate, qualification }) => {
      candidate.lead.qualification = qualification;
      candidate.lead.whyThisLead = qualification.reason;
      candidate.lead.finalSelectionScore = qualification.finalScore;
      return candidate.lead;
    }),
  );
  logEvent(
    `Finalist Judge: ${autoQualified.length} strict direct-profile qualifications; ${needsJudge.length} candidates need semantic review.`,
  );
  judgeOutcomeTotals.qualified += autoQualified.length;

  if (judgeBatches.length) {
    logEvent(
      `Running evidence-validated Finalist Judge on ${needsJudge.length} candidates in ${judgeBatches.length} prompt-aware batch(es), up to ${maxBatchInputTokens} input tokens each.`,
    );

    const fallbackResilientCandidates = (
      candidatesToFallback: FinalistCandidate[],
      reasonMsg: string,
    ): any[] => {
      return candidatesToFallback.map((candidate) => {
        // The 60 floor is deliberate: it keeps never-judged candidates competitive so an
        // upstream LLM failure does not silently drop them (see blueprintBlueprintCoverage
        // "ZERO candidates must be dropped on upstream failures"). The removed `|| 75`
        // invented a score for leads that have none; 0 is honest and the floor still applies.
        // semanticFit/evidenceConfidence/authorityFit below are 0 = "not evaluated" rather
        // than the previous hardcoded 7.5/7.0/7.0, which presented as a real judgment.
        const finalScore = Math.max(
          60,
          Math.round(
            candidate.lead.finalSelectionScore ?? candidate.lead.score ?? 0,
          ),
        );
        const fallbackQualification: Qualification = {
          policyVersion: contract.policyVersion,
          verdict: "qualified_partial",
          qualificationSource: "deterministic",
          finalScore,
          requirements: contract.requirements.map((r) => ({
            requirementId: r.id,
            status: "unknown",
          })),
          reason: `Not LLM-judged (model unavailable): ${reasonMsg}. Treated as unverified.`,
          semanticFit: 0,
          evidenceConfidence: 0,
          authorityFit: 0,
        };
        candidate.lead.qualification = fallbackQualification;
        candidate.lead.whyThisLead = fallbackQualification.reason;
        candidate.lead.finalSelectionScore = finalScore;
        if (candidate.lead.scoreBreakdown) {
          candidate.lead.scoreBreakdown.finalScore = finalScore;
        }
        candidate.lead.scoreOverride = finalScore;
        candidate.lead._qualificationFallback = "fallback_resilient";
        judgmentInsight.set(candidate.candidateId, {
          status: "qualified_partial",
          score: finalScore,
          reason: fallbackQualification.reason,
        });
        judgeOutcomeTotals.qualified += 1;
        return candidate.lead;
      });
    };

    const evaluateFinalistBatch = async (
      batch: FinalistCandidate[],
      batchIndex: number,
      attemptDepth = 0,
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
        for (const [judgedId, outcome] of validation.outcomes) {
          judgmentInsight.set(judgedId, {
            status: outcome.status,
            score:
              outcome.qualification?.finalScore ??
              (outcome.status === "hard_fail" ? -100 : -1),
            reason: outcome.reason,
          });
        }
        const minimumValid = Math.ceil(batch.length * 0.6);
        if (validation.validJudgmentCount < minimumValid) {
          recordTrace({
            phase: "candidate_processing",
            operation: "finalist_judge",
            status: "error",
            provider: "llm",
            round: stats.rounds,
            latencyMs: Date.now() - judgeStarted,
            counts: {
              batchSize: batch.length,
              validJudgments: validation.validJudgmentCount,
              minimumValid,
            },
            error: {
              message: "Finalist judge response omitted too many candidates.",
            },
            llm: summarizeLLM(
              "finalist_judge",
              judgePrompt,
              judgmentResult,
              Date.now() - judgeStarted,
              0,
              judgeAttempts,
              judgeUsage,
            ),
            metadata: {
              batch: `${batchIndex + 1}_d${attemptDepth}`,
              policyVersion: contract.policyVersion,
              estimatedInputTokens,
              requestedOutputTokens: dynamicMaxTokens,
            },
          });
          if (batch.length > 1 && attemptDepth < 1) {
            logEvent(
              `Finalist judge batch ${batchIndex + 1} omitted judgments; splitting into smaller batch.`,
            );
            const mid = Math.ceil(batch.length / 2);
            const left = await evaluateFinalistBatch(
              batch.slice(0, mid),
              batchIndex,
              attemptDepth + 1,
            );
            const right = await evaluateFinalistBatch(
              batch.slice(mid),
              batchIndex,
              attemptDepth + 1,
            );
            return [...left, ...right];
          }
          logEvent(
            `Finalist judge batch ${batchIndex + 1}: applying resilient fallback scoring for unjudged candidates.`,
          );
          const resilient = fallbackResilientCandidates(
            batch,
            "Finalist judge response omitted candidates",
          );
          judgeOutcomeTotals.unjudged += batch.length;
          return resilient;
        }

        judgeOutcomeTotals.qualified += validation.counts.qualified;
        judgeOutcomeTotals.hardFail += validation.counts.hardFail;
        judgeOutcomeTotals.unknown += validation.counts.unknown;
        judgeOutcomeTotals.unjudged += validation.counts.unjudged;
        const batchQualified = batch.flatMap((candidate) => {
          const qualification = validation.qualifications.get(
            candidate.candidateId,
          );
          if (!qualification) return [];
          candidate.lead.qualification = qualification;
          candidate.lead.whyThisLead = qualification.reason;
          candidate.lead.finalSelectionScore = qualification.finalScore;
          if (candidate.lead.scoreBreakdown)
            candidate.lead.scoreBreakdown.finalScore = qualification.finalScore;
          candidate.lead.scoreOverride = qualification.finalScore;
          return [candidate.lead];
        });

        const rawJudgments = Array.isArray(judgmentResult?.judgments)
          ? judgmentResult.judgments
          : [];
        const judgmentsByCandidateId = new Map<string, any>();
        for (const j of rawJudgments) {
          const cid = String(j?.candidateId || "").trim();
          if (cid) judgmentsByCandidateId.set(cid, j);
        }
        for (const candidate of batch) {
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
                    (queryRun.requirementFailCounts[req.requirementId] || 0) +
                    1;
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
          `[LLM 200 OK] ${successfulAttempt?.provider || "LLM"} \u00b7 model: ${resolvedModel} \u00b7 ${latency}ms${tokens ? ` \u00b7 ${tokens.toLocaleString()} tok` : ""} [Finalist Judge: ${batchQualified.length}/${batch.length} qualified]`,
        );

        debugLogs.push({
          timestamp: new Date().toISOString(),
          type: "llm_response",
          label: `finalist_judge_batch_${batchIndex + 1}_d${attemptDepth}`,
          model: resolvedModel,
          response: JSON.parse(JSON.stringify(judgmentResult)),
        });
        recordTrace({
          phase: "candidate_processing",
          operation: "finalist_judge",
          status: "success",
          provider: "llm",
          model: resolvedModel,
          round: stats.rounds,
          latencyMs: latency,
          counts: {
            batchSize: batch.length,
            validJudgments: validation.validJudgmentCount,
            qualified: batchQualified.length,
          },
          llm: summarizeLLM(
            "finalist_judge",
            judgePrompt,
            judgmentResult,
            latency,
            0,
            judgeAttempts,
            judgeUsage,
          ),
          metadata: {
            batch: `${batchIndex + 1}_d${attemptDepth}`,
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
          `[LLM ERROR] Finalist judge batch ${batchIndex + 1} failed: ${error?.message || String(error)}`,
        );
        recordTrace({
          phase: "candidate_processing",
          operation: "finalist_judge",
          status: "error",
          provider: "llm",
          model: failedModel,
          round: stats.rounds,
          latencyMs: Date.now() - judgeStarted,
          error: { message: error.message || String(error) },
          llm: summarizeLLM(
            "finalist_judge",
            judgePrompt,
            "",
            Date.now() - judgeStarted,
            0,
            judgeAttempts,
            judgeUsage,
          ),
          metadata: {
            batch: `${batchIndex + 1}_d${attemptDepth}`,
            policyVersion: contract.policyVersion,
            estimatedInputTokens,
            requestedOutputTokens: dynamicMaxTokens,
          },
        });
        // See the equivalent guard in evaluateSingleBatch: a cancelled session must never fall
        // through to the resilient fallback, which would auto-qualify never-evaluated
        // candidates with fabricated scores.
        if (state.abortController.signal.aborted) {
          logEvent(
            `Finalist judge batch ${batchIndex + 1} aborted; discarding ${batch.length} unjudged candidate(s).`,
          );
          return [];
        }
        const isTokenOrSizeError =
          error.isTokenLimit ||
          /413|payload too large|too many tokens|rate_limit_exceeded/i.test(
            error.message || "",
          );
        if (batch.length > 1 && (isTokenOrSizeError || attemptDepth < 2)) {
          logEvent(
            `Finalist judge batch ${batchIndex + 1} failed (${error.message || String(error)}); splitting ${batch.length} candidates.`,
          );
          const mid = Math.ceil(batch.length / 2);
          const left = await evaluateFinalistBatch(
            batch.slice(0, mid),
            batchIndex,
            attemptDepth + 1,
          );
          const right = await evaluateFinalistBatch(
            batch.slice(mid),
            batchIndex,
            attemptDepth + 1,
          );
          return [...left, ...right];
        }
        logEvent(
          `WARN: Finalist judge batch ${batchIndex + 1} failed completely (${error.message || String(error)}); applying fallback resilient qualification to ${batch.length} candidate(s).`,
        );
        return fallbackResilientCandidates(
          batch,
          `judge batch failed: ${error.message || String(error)}`,
        );
      }
    };

    const judgeResults = await runProviderQueue(
      judgeBatches.map((batch, batchIndex) => ({
        id: `${config.sessionId}:finalist:${batchIndex + 1}`,
        priority: judgeBatches.length - batchIndex,
        run: async () => evaluateFinalistBatch(batch, batchIndex),
      })),
      {
        // The upper clamp was 1, which made FINALIST_JUDGE_CONCURRENCY inert. 2 is the
        // recommended maximum in configValidation.ts; default stays 1 unless opted in.
        concurrency: Math.max(
          1,
          Math.min(
            2,
            Number(
              process.env.FINALIST_JUDGE_CONCURRENCY ||
                config.judgeConcurrency ||
                1,
            ),
          ),
        ),
        signal: state.abortController.signal,
      },
    );
    qualifiedLeads.push(...judgeResults.flat());
  }

  stats.rerank.judge = { ...judgeOutcomeTotals };

  // Safety net: if qualifiedLeads falls short of targetLimit, promote acceptedLeads up to the limit
  const qualifiedUrls = new Set<string>(
    qualifiedLeads.map(
      (lead) => lead.contactDetails?.linkedinUrl || lead.sourceUrl || "",
    ),
  );
  let rescuedCount = 0;
  // Default to 1.0: the judge (not the cap) is now responsible for quality.
  // A 0.5 default silently turned every low-yield session into "half the target".
  const maxRescueRatio = Math.min(
    Math.max(Number(process.env.SAFETY_NET_MAX_RESCUE_RATIO ?? 1.0), 0),
    1.0,
  );
  const maxRescuesAllowed = Math.ceil(targetLimit * maxRescueRatio);

  if (
    process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION === "true" &&
    qualifiedLeads.length < targetLimit
  ) {
    const needed = targetLimit - qualifiedLeads.length;
    const rescueCap = Math.min(needed, maxRescuesAllowed);
    logEvent(
      `Safety Net: Finalist Judge qualified ${qualifiedLeads.length}/${targetLimit} leads. Rescuing judge-ranked remaining candidates (cap: ${rescueCap}).`,
    );
    const rescuePool = acceptedLeads
      .map((lead, index) => ({
        lead,
        index,
        url: lead.contactDetails?.linkedinUrl || lead.sourceUrl || "",
      }))
      .filter((entry) => !qualifiedUrls.has(entry.url))
      .filter((entry) => !entry.lead._autoFailed)
      .filter((entry) => checkStrictContradiction(entry.lead, contract) === null)
      // The judge said no on hard requirements; the safety net must not override that.
      .filter((entry) => {
        const insight = judgmentInsight.get(
          candidateIdByLead.get(entry.lead) || `c${entry.index}`,
        );
        return !insight || insight.status !== "hard_fail";
      });
    for (const entry of rescuePool) {
      entry.lead.finalSelectionScore = rankLeadForFinalSelection(entry.lead);
    }
    rescuePool.sort((a, b) => {
      // Judge-graded candidates fill first (highest judged score wins), then
      // deterministic selection rank, then raw score.
      const aInsight = judgmentInsight.get(
        candidateIdByLead.get(a.lead) || `c${a.index}`,
      );
      const bInsight = judgmentInsight.get(
        candidateIdByLead.get(b.lead) || `c${b.index}`,
      );
      const judgeDelta =
        Number(bInsight?.score ?? -1) - Number(aInsight?.score ?? -1);
      if (judgeDelta !== 0) return judgeDelta;
      const rankDelta =
        Number(b.lead.finalSelectionScore || 0) -
        Number(a.lead.finalSelectionScore || 0);
      if (rankDelta !== 0) return rankDelta;
      return effectiveScore(b.lead) - effectiveScore(a.lead);
    });
    for (const entry of rescuePool) {
      if (rescuedCount >= rescueCap || qualifiedLeads.length >= targetLimit)
        break;
      entry.lead.qualification = {
        verdict: "rescued",
        reason: "Safety Net: identity-verified, signal evidence unavailable",
        finalScore: entry.lead.finalSelectionScore,
      };
      entry.lead.whyThisLead =
        "Safety Net: identity verified, buying signal not confirmed";
      const insight = judgmentInsight.get(
        candidateIdByLead.get(entry.lead) || `c${entry.index}`,
      );
      if (insight)
        entry.lead.judgmentInsight = {
          status: insight.status,
          score: insight.score,
          reason: insight.reason,
        };
      entry.lead.isRescued = true;
      qualifiedLeads.push(entry.lead);
      qualifiedUrls.add(entry.url);
      rescuedCount++;
    }

    // Zero-yield safety net: if qualified leads are still 0 but accepted candidates exist,
    // perform best-effort rescue of top-scoring candidates from acceptedLeads so the user
    // never receives an empty result when viable profiles were discovered.
    if (
      process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION === "true" &&
      qualifiedLeads.length === 0 &&
      acceptedLeads.length > 0
    ) {
      const fallbackRescuePool = acceptedLeads
        .map((lead, index) => ({
          lead,
          index,
          url: lead.contactDetails?.linkedinUrl || lead.sourceUrl || "",
        }))
        .filter((entry) => !qualifiedUrls.has(entry.url))
        .filter((entry) => !entry.lead._autoFailed)
        .filter((entry) => checkStrictContradiction(entry.lead, contract) === null)
        .filter((entry) => {
          const insight = judgmentInsight.get(
            candidateIdByLead.get(entry.lead) || `c${entry.index}`,
          );
          return !insight || insight.status !== "hard_fail";
        });

      for (const entry of fallbackRescuePool) {
        entry.lead.finalSelectionScore = rankLeadForFinalSelection(entry.lead);
      }
      fallbackRescuePool.sort((a, b) => {
        const rankDelta =
          Number(b.lead.finalSelectionScore || 0) -
          Number(a.lead.finalSelectionScore || 0);
        if (rankDelta !== 0) return rankDelta;
        return effectiveScore(b.lead) - effectiveScore(a.lead);
      });

      for (const entry of fallbackRescuePool) {
        if (rescuedCount >= targetLimit || qualifiedLeads.length >= targetLimit)
          break;
        entry.lead.qualification = {
          verdict: "rescued",
          reason: "Safety Net: Best-effort delivery for top-scoring candidate from discovery pool",
          finalScore: entry.lead.finalSelectionScore || 5.0,
        };
        entry.lead.whyThisLead =
          "Safety Net: Best-effort delivery for top-scoring candidate from discovery pool";
        entry.lead.isRescued = true;
        qualifiedLeads.push(entry.lead);
        qualifiedUrls.add(entry.url);
        rescuedCount++;
      }
      logEvent(
        `Safety Net: Starvation fallback rescued ${rescuedCount} top-scoring candidate(s) from discovery pool.`,
      );
    }

    logEvent(
      `Safety Net: Promoted ${rescuedCount} candidates to reach target.`,
    );
  }

  checkpointAcceptedLeads(
    qualifiedLeads.length > 0 ? qualifiedLeads : acceptedLeads,
    "post_finalist_judge",
  );

  return { qualifiedLeads };
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
    stats,
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

  // Micro-batch size: 2 candidates per batch for optimal latency on reasoning models
  const microBatchSize = Math.max(
    1,
    Math.min(4, Number(process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE || 2)),
  );
  const judgeConcurrency = Math.max(
    1,
    Math.min(4, Number(process.env.FINALIST_JUDGE_CONCURRENCY || config.judgeConcurrency || 1)),
  );

  const microBatches: FinalistCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += microBatchSize) {
    microBatches.push(candidates.slice(i, i + microBatchSize));
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
        // The 60 floor is deliberate: it keeps never-judged candidates competitive so an
        // upstream LLM failure does not silently drop them (see blueprintBlueprintCoverage
        // "ZERO candidates must be dropped on upstream failures"). The removed `|| 75`
        // invented a score for leads that have none; 0 is honest and the floor still applies.
        // semanticFit/evidenceConfidence/authorityFit below are 0 = "not evaluated" rather
        // than the previous hardcoded 7.5/7.0/7.0, which presented as a real judgment.
        const finalScore = Math.max(
          60,
          Math.round(
            candidate.lead.finalSelectionScore ?? candidate.lead.score ?? 0,
          ),
        );
      const fallbackQualification: Qualification = {
        policyVersion: contract.policyVersion,
        verdict: "qualified_partial",
        qualificationSource: "deterministic",
        finalScore,
        requirements: contract.requirements.map((r) => ({
          requirementId: r.id,
          status: "unknown",
        })),
        reason: `Not LLM-judged (model unavailable): ${reasonMsg}. Treated as unverified.`,
        semanticFit: 0,
        evidenceConfidence: 0,
        authorityFit: 0,
      };
      candidate.lead.qualification = fallbackQualification;
      candidate.lead.whyThisLead = fallbackQualification.reason;
      candidate.lead.finalSelectionScore = finalScore;
      if (candidate.lead.scoreBreakdown) {
        candidate.lead.scoreBreakdown.finalScore = finalScore;
      }
      candidate.lead.scoreOverride = finalScore;
      candidate.lead._qualificationFallback = "fallback_resilient";
      judgmentInsights.set(candidate.candidateId, {
        status: "qualified_partial",
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
        `WARN: Incremental judge batch ${batchIndex + 1} failed completely (${error.message || String(error)}); applying fallback resilient qualification to ${batch.length} candidate(s).`,
      );
      return fallbackResilientCandidates(
        batch,
        `incremental judge batch failed: ${error.message || String(error)}`,
      );
    }
  };

  for (let w = 0; w < waves.length; w++) {
    const waveBatches = waves[w];
    const waveResults: any[][] = [];
    for (let idx = 0; idx < waveBatches.length; idx++) {
      const batchResult = await evaluateSingleBatch(
        waveBatches[idx],
        w * judgeConcurrency + idx,
      );
      waveResults.push(batchResult);
    }
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
