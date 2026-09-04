import {
  finalistCandidateFromLead,
  partitionCandidatesByStrictEvidence,
  buildFinalistJudgePrompt,
  validateFinalistJudgments,
  finalistJudgeSchema,
  FINALIST_JUDGE_SYSTEM_PROMPT,
  type FinalistCandidate,
  type FinalistOutcomeStatus,
} from "../finalistJudge.js";
import {
  openAIStructured,
  type LLMProviderAttempt,
  type LLMUsage,
} from "../../services/llm.js";
import { estimateTokenCount } from "../llmBudget.js";
import { summarizeLLM } from "../telemetry.js";
import { runProviderQueue } from "../providerQueue.js";
import { rankLeadForFinalSelection } from "../scoring.js";
import { normalizeLinkedInUrl } from "../../services/linkedinEvidence.js";
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
  const effectivePoolCap = rerankPoolTarget || Math.ceil(targetLimit * 1.35);
  const candidatePoolCap = Math.max(
    targetLimit,
    Math.min(60, Math.max(effectivePoolCap, 24)),
  );
  const prioritizedNeedsJudge = needsJudge.length > candidatePoolCap
    ? [...needsJudge].sort((a, b) => (effectiveScore(b.lead) || 0) - (effectiveScore(a.lead) || 0)).slice(0, candidatePoolCap)
    : needsJudge;

  const maxBatchSize = Math.max(
    1,
    Math.min(18, Number(process.env.FINALIST_JUDGE_BATCH_SIZE || 8)),
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

  for (const candidate of prioritizedNeedsJudge) {
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

    const evaluateFinalistBatch = async (
      batch: FinalistCandidate[],
      batchIndex: number,
      attemptDepth = 0,
    ): Promise<any[]> => {
      const judgeStarted = Date.now();
      const judgeAttempts: LLMProviderAttempt[] = [];
      let judgeUsage: LLMUsage | undefined;
      const judgePrompt = buildFinalistJudgePrompt(contract, batch);
      const dynamicMaxTokens = Math.min(
        5_000,
        Math.max(900, batch.length * 500),
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
            timeoutMs: Math.max(
              180_000,
              Number(
                process.env.LLM_FINALIST_TIMEOUT_MS ||
                  process.env.LLM_TIMEOUT_MS ||
                  180_000,
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
          if (batch.length > 1 && attemptDepth < 3) {
            logEvent(
              `Finalist judge batch ${batchIndex + 1} omitted judgments; splitting ${batch.length} candidates.`,
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
          judgeOutcomeTotals.qualified += validation.counts.qualified;
          judgeOutcomeTotals.hardFail += validation.counts.hardFail;
          judgeOutcomeTotals.unknown += validation.counts.unknown;
          judgeOutcomeTotals.unjudged += validation.counts.unjudged;
          return [] as any[];
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
        for (const candidate of batch) {
          const queryRun =
            leadQueryRuns?.get?.(candidate.lead) ||
            leadQueryRuns?.get?.(candidate);
          if (queryRun) {
            const jm = rawJudgments.find(
              (j: any) =>
                String(j?.candidateId || "").trim() === candidate.candidateId,
            );
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
        debugLogs.push({
          timestamp: new Date().toISOString(),
          type: "llm_response",
          label: `finalist_judge_batch_${batchIndex + 1}_d${attemptDepth}`,
          response: JSON.parse(JSON.stringify(judgmentResult)),
        });
        recordTrace({
          phase: "candidate_processing",
          operation: "finalist_judge",
          status: "success",
          provider: "llm",
          round: stats.rounds,
          latencyMs: Date.now() - judgeStarted,
          counts: {
            batchSize: batch.length,
            validJudgments: validation.validJudgmentCount,
            qualified: batchQualified.length,
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
        return batchQualified;
      } catch (error: any) {
        recordTrace({
          phase: "candidate_processing",
          operation: "finalist_judge",
          status: "error",
          provider: "llm",
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
          `WARN: Finalist judge batch ${batchIndex + 1} failed completely: ${error.message || String(error)}.`,
        );
        return [] as any[];
      }
    };

    const judgeResults = await runProviderQueue(
      judgeBatches.map((batch, batchIndex) => ({
        id: `${config.sessionId}:finalist:${batchIndex + 1}`,
        priority: judgeBatches.length - batchIndex,
        run: async () => evaluateFinalistBatch(batch, batchIndex),
      })),
      {
        concurrency: config.judgeConcurrency || 2,
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

  if (qualifiedLeads.length < targetLimit) {
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
    if (qualifiedLeads.length === 0 && acceptedLeads.length > 0) {
      const fallbackRescuePool = acceptedLeads
        .map((lead, index) => ({
          lead,
          index,
          url: lead.contactDetails?.linkedinUrl || lead.sourceUrl || "",
        }))
        .filter((entry) => !qualifiedUrls.has(entry.url))
        .filter((entry) => !entry.lead._autoFailed)
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

  // Micro-batch size: 3-4 candidates per batch for optimal token amortization and zero omission
  const microBatchSize = Math.max(
    2,
    Math.min(4, Number(process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE || 3)),
  );
  const judgeConcurrency = Math.max(
    1,
    Math.min(3, config.judgeConcurrency || 2),
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

  const evaluateSingleBatch = async (
    batch: FinalistCandidate[],
    batchIndex: number,
    depth = 0,
  ): Promise<any[]> => {
    const judgeStarted = Date.now();
    const judgeAttempts: LLMProviderAttempt[] = [];
    let judgeUsage: LLMUsage | undefined;
    const judgePrompt = buildFinalistJudgePrompt(contract, batch);
    const dynamicMaxTokens = Math.min(
      2_500,
      Math.max(600, batch.length * 450),
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
          timeoutMs: Math.max(
            180_000,
            Number(
              process.env.LLM_FINALIST_TIMEOUT_MS ||
                process.env.LLM_TIMEOUT_MS ||
                180_000,
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
        judgmentInsights.set(judgedId, {
          status: outcome.status,
          score:
            outcome.qualification?.finalScore ??
            (outcome.status === "hard_fail" ? -100 : -1),
          reason: outcome.reason,
        });
      }

      // Candidate omission check: retry split if too many omitted
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

      const batchQualified = batch.flatMap((candidate) => {
        const qualification = validation.qualifications.get(
          candidate.candidateId,
        );
        if (!qualification) return [];
        candidate.lead.qualification = qualification;
        candidate.lead.whyThisLead = qualification.reason;
        candidate.lead.finalSelectionScore = qualification.finalScore;
        if (candidate.lead.scoreBreakdown) {
          candidate.lead.scoreBreakdown.finalScore = qualification.finalScore;
        }
        candidate.lead.scoreOverride = qualification.finalScore;
        return [candidate.lead];
      });

      // Attribute failures back to queryRun
      const rawJudgments = Array.isArray(judgmentResult?.judgments)
        ? judgmentResult.judgments
        : [];
      for (const candidate of batch) {
        const queryRun =
          leadQueryRuns?.get?.(candidate.lead) ||
          leadQueryRuns?.get?.(candidate);
        if (queryRun) {
          const jm = rawJudgments.find(
            (j: any) =>
              String(j?.candidateId || "").trim() === candidate.candidateId,
          );
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

      recordTrace({
        phase: "candidate_processing",
        operation: "incremental_finalist_judge",
        status: "success",
        provider: "llm",
        round,
        latencyMs: Date.now() - judgeStarted,
        counts: {
          batchSize: batch.length,
          validJudgments: validation.validJudgmentCount,
          qualified: batchQualified.length,
        },
        llm: summarizeLLM(
          "incremental_finalist_judge",
          judgePrompt,
          judgmentResult,
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

      return batchQualified;
    } catch (error: any) {
      logEvent(
        `WARN: Incremental judge batch ${batchIndex + 1} failed: ${error.message || String(error)}`,
      );
      recordTrace({
        phase: "candidate_processing",
        operation: "incremental_finalist_judge",
        status: "error",
        provider: "llm",
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
      return [];
    }
  };

  for (let w = 0; w < waves.length; w++) {
    const waveBatches = waves[w];
    const waveResults = await Promise.all(
      waveBatches.map((batch, idx) =>
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
