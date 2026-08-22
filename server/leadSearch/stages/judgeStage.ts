import {
  finalistCandidateFromLead,
  partitionCandidatesByStrictEvidence,
  buildFinalistJudgePrompt,
  validateFinalistJudgments,
  finalistJudgeSchema,
  FINALIST_JUDGE_SYSTEM_PROMPT,
  type FinalistCandidate
} from '../finalistJudge.js';
import {
  openAIStructured,
  type LLMProviderAttempt,
  type LLMUsage
} from '../../services/llm.js';
import { estimateTokenCount } from '../llmBudget.js';
import { summarizeLLM } from '../telemetry.js';
import { runProviderQueue } from '../providerQueue.js';
import { rankLeadForFinalSelection } from '../scoring.js';
import { normalizeLinkedInUrl } from '../../services/linkedinEvidence.js';
import type { SessionContext } from '../pipelineTypes.js';
import type { ProspectContract } from '../prospectContract.js';
import type { EvidenceMeta } from './extractStage.js';

const normalizeDedupeValue = (value?: string) => (value || '').trim().toLowerCase();

export type JudgeStageInput = {
  contract: ProspectContract;
  evidenceByUrl: Map<string, EvidenceMeta>;
  stats: any;
  checkpointAcceptedLeads: (leads: any[], stageLabel: string) => void;
};

export type JudgeStageOutput = {
  qualifiedLeads: any[];
};

export async function executeJudgeStage(
  ctx: SessionContext,
  input: JudgeStageInput
): Promise<JudgeStageOutput> {
  const { contract, evidenceByUrl, stats, checkpointAcceptedLeads } = input;
  const { config, state, logEvent, recordTrace } = ctx;
  const { acceptedLeads, qualifiedLeads, llmCircuitBreaker, debugLogs } = state;
  const { targetLimit } = config;

  if (acceptedLeads.length === 0) {
    throw new Error('Could not extract any new qualified profiles from search results. Try more specific criteria.');
  }

  stats.rerank = stats.rerank || {};
  stats.rerank.poolSize = acceptedLeads.length;

  const fallbackEvidenceForLead = (lead: any): EvidenceMeta => {
    const sourceUrl = lead.contactDetails?.linkedinUrl || '';
    const evidenceBlock = [
      sourceUrl ? `LINK: ${sourceUrl}` : '',
      lead.headline ? `HEADLINE: ${lead.headline}` : '',
      lead.summary ? `SUMMARY: ${lead.summary}` : '',
      Array.isArray(lead.evidenceReasons) ? lead.evidenceReasons.join('\n') : ''
    ].filter(Boolean).join('\n');
    return {
      evidenceBlock,
      evidenceQuality: 'weak',
      sourceProvider: lead.sourceProvider === 'brightdata_search' ? 'brightdata' : (lead.sourceProvider === 'brightdata' ? 'brightdata' : 'tavily'),
      sourceUrl,
      sourceQuery: config.promptQuery,
      sourceRound: stats.rounds || 1,
      sourceProviders: [lead.sourceProvider || 'tavily'],
      sourceCount: 1,
      lanes: [lead.discoveryLane || 'person'],
      corroborated: false
    };
  };

  const getEvidenceForLead = (lead: any): EvidenceMeta => {
    const linkedinUrl = lead?.contactDetails?.linkedinUrl || '';
    const fallbackUrl = lead?.sourceUrl || '';
    const candidateKeys = [
      normalizeLinkedInUrl(linkedinUrl),
      normalizeDedupeValue(linkedinUrl),
      linkedinUrl,
      normalizeLinkedInUrl(fallbackUrl),
      normalizeDedupeValue(fallbackUrl),
      fallbackUrl
    ].filter(Boolean);

    for (const key of candidateKeys) {
      const found = evidenceByUrl.get(key);
      if (found) return found;
    }
    return fallbackEvidenceForLead(lead);
  };

  const effectiveScore = (lead: any) => {
    const score = Number(lead.scoreBreakdown?.finalScore || 0);
    if (score > 0) return score;
    const fit = Number(lead.fitScore || 0);
    const composite = Number(lead.compositeScore || 0);
    return Math.max(fit, composite);
  };

  const finalistCandidates: FinalistCandidate[] = acceptedLeads.map((lead, index) => {
    const evidence = getEvidenceForLead(lead);
    return finalistCandidateFromLead(`c${index}`, lead, evidence?.evidenceBlock, contract);
  });

  const { autoQualified, needsJudge } = partitionCandidatesByStrictEvidence(finalistCandidates, contract);
  const maxBatchSize = Math.max(1, Math.min(18, Number(process.env.FINALIST_JUDGE_BATCH_SIZE || 6)));
  const providerTokenBudget = Math.max(4_000, Number(process.env.LLM_PROVIDER_TOKEN_BUDGET || 7_200));
  const maxBatchInputTokens = Math.min(4_200, Math.max(1_600, providerTokenBudget - 3_000));
  const judgeBatches: FinalistCandidate[][] = [];
  let currentBatch: FinalistCandidate[] = [];

  for (const candidate of needsJudge) {
    const proposedBatch = [...currentBatch, candidate];
    const proposedInputTokens = estimateTokenCount(buildFinalistJudgePrompt(contract, proposedBatch));

    if (currentBatch.length >= maxBatchSize || (currentBatch.length > 0 && proposedInputTokens > maxBatchInputTokens)) {
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
  qualifiedLeads.push(...autoQualified.map(({ candidate, qualification }) => {
    candidate.lead.qualification = qualification;
    candidate.lead.whyThisLead = qualification.reason;
    candidate.lead.finalSelectionScore = qualification.finalScore;
    return candidate.lead;
  }));
  logEvent(`Finalist Judge: ${autoQualified.length} strict direct-profile qualifications; ${needsJudge.length} candidates need semantic review.`);

  if (judgeBatches.length) {
    logEvent(`Running evidence-validated Finalist Judge on ${needsJudge.length} candidates in ${judgeBatches.length} prompt-aware batch(es), up to ${maxBatchInputTokens} input tokens each.`);

    const evaluateFinalistBatch = async (batch: FinalistCandidate[], batchIndex: number, attemptDepth = 0): Promise<any[]> => {
      const judgeStarted = Date.now();
      const judgeAttempts: LLMProviderAttempt[] = [];
      let judgeUsage: LLMUsage | undefined;
      const judgePrompt = buildFinalistJudgePrompt(contract, batch);
      const dynamicMaxTokens = Math.min(5_000, Math.max(900, batch.length * 500));
      const estimatedInputTokens = estimateTokenCount(judgePrompt);
      try {
        const judgmentResult = await openAIStructured<any>(judgePrompt, finalistJudgeSchema, FINALIST_JUDGE_SYSTEM_PROMPT, {
          maxTokens: dynamicMaxTokens,
          temperature: 0,
          retryOnParseFailure: false,
          timeoutMs: Number(process.env.LLM_FINALIST_TIMEOUT_MS || 90_000),
          circuitBreaker: llmCircuitBreaker,
          onProviderAttempt: attempt => judgeAttempts.push(attempt),
          onUsage: usage => { judgeUsage = usage; }
        });
        const validation = validateFinalistJudgments(judgmentResult, contract, batch);
        const minimumValid = Math.ceil(batch.length * 0.60);
        if (validation.validJudgmentCount < minimumValid) {
          recordTrace({
            phase: 'candidate_processing', operation: 'finalist_judge', status: 'error', provider: 'llm', round: stats.rounds,
            latencyMs: Date.now() - judgeStarted,
            counts: { batchSize: batch.length, validJudgments: validation.validJudgmentCount, minimumValid },
            error: { message: 'Finalist judge response omitted too many candidates.' },
            llm: summarizeLLM('finalist_judge', judgePrompt, judgmentResult, Date.now() - judgeStarted, 0, judgeAttempts, judgeUsage),
            metadata: { batch: `${batchIndex + 1}_d${attemptDepth}`, policyVersion: contract.policyVersion, estimatedInputTokens, requestedOutputTokens: dynamicMaxTokens }
          });
          if (batch.length > 1 && attemptDepth < 3) {
            logEvent(`Finalist judge batch ${batchIndex + 1} omitted judgments; splitting ${batch.length} candidates.`);
            const mid = Math.ceil(batch.length / 2);
            const left = await evaluateFinalistBatch(batch.slice(0, mid), batchIndex, attemptDepth + 1);
            const right = await evaluateFinalistBatch(batch.slice(mid), batchIndex, attemptDepth + 1);
            return [...left, ...right];
          }
          return [] as any[];
        }
        const batchQualified = batch.flatMap(candidate => {
          const qualification = validation.qualifications.get(candidate.candidateId);
          if (!qualification) return [];
          candidate.lead.qualification = qualification;
          candidate.lead.whyThisLead = qualification.reason;
          candidate.lead.finalSelectionScore = qualification.finalScore;
          if (candidate.lead.scoreBreakdown) candidate.lead.scoreBreakdown.finalScore = qualification.finalScore;
          candidate.lead.scoreOverride = qualification.finalScore;
          return [candidate.lead];
        });
        debugLogs.push({
          timestamp: new Date().toISOString(), type: 'llm_response', label: `finalist_judge_batch_${batchIndex + 1}_d${attemptDepth}`,
          response: JSON.parse(JSON.stringify(judgmentResult))
        });
        recordTrace({
          phase: 'candidate_processing', operation: 'finalist_judge', status: 'success', provider: 'llm', round: stats.rounds,
          latencyMs: Date.now() - judgeStarted,
          counts: { batchSize: batch.length, validJudgments: validation.validJudgmentCount, qualified: batchQualified.length },
          llm: summarizeLLM('finalist_judge', judgePrompt, judgmentResult, Date.now() - judgeStarted, 0, judgeAttempts, judgeUsage),
          metadata: { batch: `${batchIndex + 1}_d${attemptDepth}`, policyVersion: contract.policyVersion, estimatedInputTokens, requestedOutputTokens: dynamicMaxTokens }
        });
        return batchQualified;
      } catch (error: any) {
        recordTrace({
          phase: 'candidate_processing', operation: 'finalist_judge', status: 'error', provider: 'llm', round: stats.rounds,
          latencyMs: Date.now() - judgeStarted, error: { message: error.message || String(error) },
          llm: summarizeLLM('finalist_judge', judgePrompt, '', Date.now() - judgeStarted, 0, judgeAttempts, judgeUsage),
          metadata: { batch: `${batchIndex + 1}_d${attemptDepth}`, policyVersion: contract.policyVersion, estimatedInputTokens, requestedOutputTokens: dynamicMaxTokens }
        });
        const isTokenOrSizeError = error.isTokenLimit || /413|payload too large|too many tokens|rate_limit_exceeded/i.test(error.message || '');
        if (batch.length > 1 && (isTokenOrSizeError || attemptDepth < 2)) {
          logEvent(`Finalist judge batch ${batchIndex + 1} failed (${error.message || String(error)}); splitting ${batch.length} candidates.`);
          const mid = Math.ceil(batch.length / 2);
          const left = await evaluateFinalistBatch(batch.slice(0, mid), batchIndex, attemptDepth + 1);
          const right = await evaluateFinalistBatch(batch.slice(mid), batchIndex, attemptDepth + 1);
          return [...left, ...right];
        }
        logEvent(`WARN: Finalist judge batch ${batchIndex + 1} failed completely: ${error.message || String(error)}.`);
        return [] as any[];
      }
    };

    const judgeResults = await runProviderQueue(
      judgeBatches.map((batch, batchIndex) => ({
        id: `${config.sessionId}:finalist:${batchIndex + 1}`,
        priority: judgeBatches.length - batchIndex,
        run: async () => evaluateFinalistBatch(batch, batchIndex)
      })),
      {
        concurrency: config.judgeConcurrency || 2,
        signal: state.abortController.signal
      }
    );
    qualifiedLeads.push(...judgeResults.flat());
  }

  // Safety net: if qualifiedLeads falls short of targetLimit, promote acceptedLeads up to the limit
  const qualifiedUrls = new Set<string>(qualifiedLeads.map(lead => lead.contactDetails?.linkedinUrl || lead.sourceUrl || ''));
  let rescuedCount = 0;
  const maxRescueRatio = Math.min(Math.max(Number(process.env.SAFETY_NET_MAX_RESCUE_RATIO ?? 0.5), 0), 1.0);
  const maxRescuesAllowed = Math.ceil(targetLimit * maxRescueRatio);

  if (qualifiedLeads.length < targetLimit) {
    const needed = targetLimit - qualifiedLeads.length;
    const rescueCap = Math.min(needed, maxRescuesAllowed);
    logEvent(`Safety Net: Finalist Judge qualified ${qualifiedLeads.length}/${targetLimit} leads. Rescuing top remaining accepted candidates (cap: ${rescueCap}).`);
    acceptedLeads.forEach(lead => {
      lead.finalSelectionScore = rankLeadForFinalSelection(lead);
    });
    acceptedLeads.sort((a, b) => {
      const rankDelta = Number(b.finalSelectionScore || 0) - Number(a.finalSelectionScore || 0);
      return rankDelta !== 0 ? rankDelta : effectiveScore(b) - effectiveScore(a);
    });
    for (const lead of acceptedLeads) {
      if (rescuedCount >= rescueCap || qualifiedLeads.length >= targetLimit) break;
      const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl || '';
      if (!qualifiedUrls.has(url)) {
        lead.qualification = { verdict: 'rescued', reason: 'Safety Net: identity-verified, signal evidence unavailable', finalScore: lead.finalSelectionScore };
        lead.whyThisLead = 'Safety Net: identity verified, buying signal not confirmed';
        lead.isRescued = true;
        qualifiedLeads.push(lead);
        qualifiedUrls.add(url);
        rescuedCount++;
      }
    }
    logEvent(`Safety Net: Promoted ${rescuedCount} candidates to reach target.`);
  }

  checkpointAcceptedLeads(qualifiedLeads.length > 0 ? qualifiedLeads : acceptedLeads, 'post_finalist_judge');

  return { qualifiedLeads };
}
