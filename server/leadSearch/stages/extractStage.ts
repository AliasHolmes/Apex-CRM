import { runProviderQueue } from "../providerQueue.js";
import { reserveProviderUsage, recordProviderUsage } from "../../db.js";
import {
  chunkBrightDataBatchItems,
  scrapeBatchAsMarkdown,
  classifyBrightDataError,
  getBrightDataStatus,
} from "../../services/brightdata.js";
import {
  tavilyExtract,
  hasTavilyKey,
  openAIStructured,
  bulkLeadsArraySchema,
  EXTRACTION_SYSTEM_PROMPT,
  DEFAULT_PRIMARY_MODEL,
  type LLMProviderAttempt,
} from "../../services/llm.js";
import { buildTavilyEvidence } from "../../services/linkedinEvidence.js";
import { inferTavilyEvidenceQuality } from "../evidence.js";
import {
  extractLinkedInUsername,
  normalizeLinkedInUrl,
} from "../../services/linkedinEvidence.js";
import {
  chunkEvidenceBlocksByTokenBudget,
  estimateTokenCount,
  fitOutputTokenBudget,
} from "../llmBudget.js";
import { summarizeLLM } from "../telemetry.js";
import { incrementRejection, type RejectionReason } from "../rejections.js";
import { runWithTransientRetry } from "../sessionHelpers.js";
import type { SessionContext } from "../pipelineTypes.js";
import type { EvidenceQuality, LeadSourceProvider } from "../scoring.js";
import type { QueryRunStats } from "../strategist.js";

export type EvidenceMeta = {
  evidenceBlock: string;
  evidenceQuality: EvidenceQuality;
  sourceProvider: LeadSourceProvider;
  sourceUrl: string;
  sourceQuery: string;
  sourceRound: number;
  queryRun?: QueryRunStats;
  sourceProviders?: string[];
  sourceCount?: number;
  lanes?: string[];
  corroborated?: boolean;
};

const normalizeDedupeValue = (value?: string) =>
  (value || "").trim().toLowerCase();

export type ExtractStageInput = {
  round: number;
  candidateItems: any[];
  rerankPoolTarget: number;
  brightDataReady: boolean;
  brightDataProviderDisabled: boolean;
  tavilyCapabilities: any;
  brightDataCapabilities: any;
  consecutiveFailedExtractionRounds: number;
  failedExtractionRoundsBeforeStop: number;
  evidenceByUrl?: Map<string, EvidenceMeta>;
  stats: any;
};

export type ExtractStageOutput = {
  extractedProfiles: any[];
  evidenceByUrl: Map<string, EvidenceMeta>;
  consecutiveFailedExtractionRounds: number;
  brightDataProviderDisabled: boolean;
  stopReason?: string;
};

export async function executeExtractStage(
  ctx: SessionContext,
  input: ExtractStageInput,
): Promise<ExtractStageOutput> {
  const {
    round,
    candidateItems,
    rerankPoolTarget,
    brightDataReady,
    tavilyCapabilities,
    brightDataCapabilities,
    failedExtractionRoundsBeforeStop,
    stats,
  } = input;

  let brightDataProviderDisabled = input.brightDataProviderDisabled;
  let consecutiveFailedExtractionRounds =
    input.consecutiveFailedExtractionRounds;
  const { config, state, logEvent, recordTrace } = ctx;
  const { freeTierBudget, seenCandidateKeys, llmCircuitBreaker } = state;
  const { creditReservationEnabled } = config;
  const evidenceByUrl = input.evidenceByUrl || new Map<string, EvidenceMeta>();

  const getTraceBrightDataStatus = () => {
    const status = getBrightDataStatus();
    return { ...status, transport: status.transport || undefined };
  };

  const noteRejection = (reason: RejectionReason, queryRun?: QueryRunStats) => {
    incrementRejection(stats.rejectionReasons, reason);
    if (queryRun) incrementRejection(queryRun.rejectionReasons, reason);
  };

  // 1. Thin page evidence upgrades via Bright Data rapid tool or Tavily Extract fallback
  const upgradeTargets = candidateItems.filter((item: any) => {
    const url = String(item.url || "");
    return (
      url &&
      !/linkedin\.com\/in\//i.test(url) &&
      String(item.content || item.raw_content || "").length < 420
    );
  });
  const maxUpgradeUrls = Math.min(
    upgradeTargets.length,
    Math.max(
      1,
      Math.floor(Number(process.env.BRIGHTDATA_EVIDENCE_UPGRADE_MAX_URLS) || 8),
    ),
  );
  let remainingForTavilyExtract = upgradeTargets.slice(0, maxUpgradeUrls);

  if (
    remainingForTavilyExtract.length > 0 &&
    brightDataReady &&
    !brightDataProviderDisabled
  ) {
    const bdUpgradeStarted = Date.now();
    const targets = remainingForTavilyExtract.slice();
    const upgradeUrls = targets
      .map((item: any) => String(item.url || ""))
      .filter(Boolean);
    remainingForTavilyExtract = [];
    let upgraded = 0;
    let batchRequests = 0;
    let attemptedUpgradeTargets = 0;
    try {
      freeTierBudget.reserveBrightDataScrape(upgradeUrls.length);
      if (!creditReservationEnabled)
        recordProviderUsage("brightdata", upgradeUrls.length);
      for (const batchTargets of chunkBrightDataBatchItems(targets)) {
        if (brightDataProviderDisabled) break;
        attemptedUpgradeTargets += batchTargets.length;
        batchRequests++;
        try {
          const batchUrls = batchTargets
            .map((item: any) => String(item.url || ""))
            .filter(Boolean);
          const batchResults = await scrapeBatchAsMarkdown(batchUrls);
          const contentByUrl = new Map(
            batchResults.map((r) => [normalizeDedupeValue(r.url), r.content]),
          );
          for (const item of batchTargets) {
            const markdown = contentByUrl.get(
              normalizeDedupeValue(String(item.url || "")),
            );
            if (markdown && markdown.trim().length > 80) {
              item.raw_content = [item.raw_content, markdown]
                .filter(Boolean)
                .join("\n");
              item.content = [item.content, markdown.slice(0, 1800)]
                .filter(Boolean)
                .join("\n");
              upgraded++;
              stats.scout.brightDataEvidenceUpgrades =
                (stats.scout.brightDataEvidenceUpgrades || 0) + 1;
            } else {
              remainingForTavilyExtract.push(item);
            }
          }
        } catch (error: any) {
          const classified = classifyBrightDataError(error);
          if (classified.providerDisabled) {
            brightDataProviderDisabled = true;
            state.brightDataStats.providerDisabled++;
          }
          remainingForTavilyExtract.push(...batchTargets);
        }
      }
      if (attemptedUpgradeTargets < targets.length) {
        remainingForTavilyExtract.push(
          ...targets.slice(attemptedUpgradeTargets),
        );
      }
    } catch (error: any) {
      const classified = classifyBrightDataError(error);
      if (classified.providerDisabled) {
        brightDataProviderDisabled = true;
        state.brightDataStats.providerDisabled++;
      }
      remainingForTavilyExtract.push(...targets);
    }
    recordTrace({
      phase: "search",
      operation: "brightdata_batch_evidence_upgrade",
      status: upgraded > 0 ? "success" : "skipped",
      provider: "brightdata",
      round,
      latencyMs: Date.now() - bdUpgradeStarted,
      counts: {
        requestedUrls: upgradeUrls.length,
        batchRequests,
        upgradedUrls: upgraded,
        fallbackToTavily: remainingForTavilyExtract.length,
      },
      brightData: getTraceBrightDataStatus(),
    });
    if (upgraded > 0)
      logEvent(
        `Round ${round}: Bright Data batch-upgraded evidence for ${upgraded}/${upgradeUrls.length} thin pages.`,
      );
  }

  const acceptedUpgradeCount = freeTierBudget.reserveTavilyExtract(
    remainingForTavilyExtract.length,
  );
  if (acceptedUpgradeCount > 0 && hasTavilyKey()) {
    const upgradeUrls = remainingForTavilyExtract
      .slice(0, acceptedUpgradeCount)
      .map((item: any) => String(item.url));
    const upgradeCredits = Math.ceil(upgradeUrls.length / 5);
    if (creditReservationEnabled) {
      const monthlyReservation = reserveProviderUsage(
        "tavily",
        upgradeCredits,
        tavilyCapabilities.monthlyLimit,
      );
      if (!monthlyReservation.allowed) {
        logEvent(
          `Round ${round}: skipped Tavily extract after local monthly reservation.`,
        );
      } else {
        try {
          const extractedPages = await tavilyExtract(
            upgradeUrls,
            config.promptQuery,
            {
              extractDepth: "basic",
              chunksPerSource: 1,
              signal: state.abortController.signal,
            },
          );
          const contentByUrl = new Map(
            extractedPages.map((page) => [
              normalizeDedupeValue(page.url),
              page.rawContent,
            ]),
          );
          for (const item of remainingForTavilyExtract.slice(
            0,
            acceptedUpgradeCount,
          )) {
            const extracted = contentByUrl.get(normalizeDedupeValue(item.url));
            if (extracted) {
              item.raw_content = [item.raw_content, extracted]
                .filter(Boolean)
                .join("\n");
              item.content = [item.content, extracted.slice(0, 1800)]
                .filter(Boolean)
                .join("\n");
            }
          }
          stats.scout.lightweightEvidenceUpgrades += extractedPages.length;
          recordTrace({
            phase: "search",
            operation: "tavily_lightweight_extract",
            status: "success",
            provider: "tavily",
            round,
            counts: {
              requestedUrls: upgradeUrls.length,
              extractedUrls: extractedPages.length,
            },
            tavily: { searchDepth: "basic" },
          });
        } catch (error: any) {
          logEvent(
            `WARN: Lightweight Tavily evidence extraction failed: ${error.message || String(error)}`,
          );
          recordTrace({
            phase: "search",
            operation: "tavily_lightweight_extract",
            status: "error",
            provider: "tavily",
            round,
            error: { message: error.message || String(error) },
          });
        }
      }
    } else {
      recordProviderUsage("tavily", upgradeCredits);
      try {
        const extractedPages = await tavilyExtract(
          upgradeUrls,
          config.promptQuery,
          {
            extractDepth: "basic",
            chunksPerSource: 1,
            signal: state.abortController.signal,
          },
        );
        const contentByUrl = new Map(
          extractedPages.map((page) => [
            normalizeDedupeValue(page.url),
            page.rawContent,
          ]),
        );
        for (const item of remainingForTavilyExtract.slice(
          0,
          acceptedUpgradeCount,
        )) {
          const extracted = contentByUrl.get(normalizeDedupeValue(item.url));
          if (extracted) {
            item.raw_content = [item.raw_content, extracted]
              .filter(Boolean)
              .join("\n");
            item.content = [item.content, extracted.slice(0, 1800)]
              .filter(Boolean)
              .join("\n");
          }
        }
        stats.scout.lightweightEvidenceUpgrades += extractedPages.length;
        recordTrace({
          phase: "search",
          operation: "tavily_lightweight_extract",
          status: "success",
          provider: "tavily",
          round,
          counts: {
            requestedUrls: upgradeUrls.length,
            extractedUrls: extractedPages.length,
          },
          tavily: { searchDepth: "basic" },
        });
      } catch (error: any) {
        logEvent(
          `WARN: Lightweight Tavily evidence extraction failed: ${error.message || String(error)}`,
        );
        recordTrace({
          phase: "search",
          operation: "tavily_lightweight_extract",
          status: "error",
          provider: "tavily",
          round,
          error: { message: error.message || String(error) },
        });
      }
    }
  }

  // 2. Format evidence blocks
  let evidenceBlocks: string[] = [];

  for (const item of candidateItems) {
    if (state.acceptedLeads.length >= rerankPoolTarget) break;
    const url = item.url || "";
    const normalizedUrl = item._normalizedUrl || normalizeLinkedInUrl(url);
    const username = item._linkedinUsername || extractLinkedInUsername(url);
    const queryRun = item._queryRun as QueryRunStats | undefined;

    const sourceProvider: LeadSourceProvider =
      item.sourceProvider === "brightdata_search" ? "brightdata" : "tavily";
    const evidenceBlock = buildTavilyEvidence(item);
    const evidenceQuality = inferTavilyEvidenceQuality(item);

    const evidenceMeta: EvidenceMeta = {
      evidenceBlock,
      evidenceQuality,
      sourceProvider,
      sourceUrl: url,
      sourceQuery: item._sourceQuery || "",
      sourceRound: item._sourceRound || round,
      queryRun,
      sourceProviders: Array.isArray(item._sourceProviders)
        ? item._sourceProviders
        : [sourceProvider],
      sourceCount: Number(item._sourceCount || 1),
      lanes: Array.isArray(item._lanes)
        ? item._lanes
        : [item._queryLane || "person"],
      corroborated: Boolean(item._corroborated),
    };
    const primaryKey = normalizedUrl || normalizeDedupeValue(url);
    if (primaryKey) evidenceByUrl.set(primaryKey, evidenceMeta);
    if (url && url !== primaryKey) evidenceByUrl.set(url, evidenceMeta);
    if (username) {
      evidenceByUrl.set(`linkedin:${username}`, evidenceMeta);
      evidenceByUrl.set(`linkedin.com/in/${username}`, evidenceMeta);
    }
    if (queryRun) queryRun.evidenceBlocks++;
    evidenceBlocks.push(
      `--- PROFILE CANDIDATE ---\nSOURCE_PROVIDER: ${sourceProvider}\nLINK: ${url}\n${evidenceBlock}\n\n`,
    );
  }

  // 3. Adaptive extraction evidence slicing
  const neededPoolRemaining = Math.max(
    1,
    rerankPoolTarget - state.acceptedLeads.length,
  );
  const neededEvidenceBlocks = Math.max(
    12,
    Math.ceil(neededPoolRemaining * 1.5),
  );
  if (evidenceBlocks.length > neededEvidenceBlocks) {
    logEvent(
      `Round ${round}: capped extraction evidence to top ${neededEvidenceBlocks}/${evidenceBlocks.length} blocks (pool needed: ${neededPoolRemaining}).`,
    );
    evidenceBlocks = evidenceBlocks.slice(0, neededEvidenceBlocks);
  }

  // 4. Token budget calculation and chunking
  const extractionChunkChars = Math.min(
    Math.max(Number(process.env.LEAD_EXTRACTION_CHUNK_CHARS || 3200), 1800),
    9000,
  );
  const configuredExtractionMaxTokens = Math.min(
    Math.max(Number(process.env.LEAD_EXTRACTION_MAX_TOKENS || 3000), 800),
    6000,
  );
  const providerTokenBudget = Math.min(
    Math.max(Number(process.env.LLM_PROVIDER_TOKEN_BUDGET || 7200), 4000),
    120_000,
  );
  const tokenSafetyMargin = Math.min(
    Math.max(Number(process.env.LLM_TOKEN_SAFETY_MARGIN || 400), 200),
    2000,
  );
  const extractionPromptPrefix = `Extract distinct, qualified B2B prospects from the source-labeled evidence below.\n\nRules:\n- Include only people with at least a full name and a title, company, or headline.\n- Do not invent data. Use empty strings for missing fields.\n- Set contactDetails.linkedinUrl ONLY to the exact LINK value from the same source block. Never copy external website URLs found in text snippets.\n- If LINK is not a linkedin.com/in/ URL or is missing, leave contactDetails.linkedinUrl empty.\n- Preserve SOURCE_PROVIDER as sourceProvider.\n- Score conservatively from 1-10 using only visible evidence.\n- Add evidenceReasons as 1-3 short reasons the prospect matches the user query.\n\nUser search criteria:\n${config.promptQuery}\n\nEvidence:\n`;
  const structuredPromptOverheadTokens =
    estimateTokenCount(extractionPromptPrefix) +
    estimateTokenCount(EXTRACTION_SYSTEM_PROMPT) +
    estimateTokenCount(JSON.stringify(bulkLeadsArraySchema)) +
    500;
  const evidenceTokenBudget = Math.max(
    400,
    Math.min(
      Math.floor(extractionChunkChars / 4),
      providerTokenBudget -
        configuredExtractionMaxTokens -
        tokenSafetyMargin -
        structuredPromptOverheadTokens,
    ),
  );
  const chunks = chunkEvidenceBlocksByTokenBudget(
    evidenceBlocks,
    evidenceTokenBudget,
  );
  logEvent(
    `Round ${round}: extracting ${chunks.length} token-budgeted evidence batches (max evidence tokens: ${evidenceTokenBudget}).`,
  );
  recordTrace({
    phase: "extraction",
    operation: "chunk_evidence",
    status: "info",
    provider: "system",
    round,
    counts: { chunks: chunks.length, evidenceBlocks: evidenceBlocks.length },
    metadata: {
      evidenceTokenBudget,
      providerTokenBudget,
      configuredMaxOutputTokens: configuredExtractionMaxTokens,
    },
  });

  let extractionFailuresThisRound = 0;
  const extractionTasks = chunks.map((chunk, idx) => async () => {
    const chunkIndex = idx + 1;
    const extractionStarted = Date.now();
    const prompt = `${extractionPromptPrefix}${chunk}`;
    const extractionProviderAttempts: LLMProviderAttempt[] = [];
    const estimatedStructuredInputTokens =
      estimateTokenCount(prompt) +
      estimateTokenCount(EXTRACTION_SYSTEM_PROMPT) +
      estimateTokenCount(JSON.stringify(bulkLeadsArraySchema)) +
      500;
    const outputTokenBudget = fitOutputTokenBudget({
      configuredMaxTokens: configuredExtractionMaxTokens,
      estimatedInputTokens: estimatedStructuredInputTokens,
      totalTokenBudget: providerTokenBudget,
      safetyTokens: tokenSafetyMargin,
      minimumOutputTokens: 800,
    });
    try {
      const chunkRetryMax = Math.min(
        Math.max(Number(process.env.LEAD_EXTRACTION_CHUNK_RETRIES ?? 1), 0),
        2,
      );
      const extracted = await runWithTransientRetry(
        () =>
          openAIStructured<any[]>(
            prompt,
            bulkLeadsArraySchema,
            EXTRACTION_SYSTEM_PROMPT,
            {
              maxTokens: outputTokenBudget,
              temperature: 0.0,
              circuitBreaker: llmCircuitBreaker,
              onProviderAttempt: (attempt) =>
                extractionProviderAttempts.push(attempt),
            },
          ),
        {
          attempts: chunkRetryMax + 1,
          baseDelayMs: 1500,
          signal: state.abortController.signal,
          onRetry: (nextAttempt, delayMs, error) => {
            logEvent(
              `Round ${round}, chunk ${chunkIndex}: transient LLM error (${error instanceof Error ? error.message : String(error)}); retry ${nextAttempt} in ${delayMs}ms.`,
            );
            recordTrace({
              phase: "extraction",
              operation: "llm_extract_chunk_retry",
              status: "info",
              provider: "llm",
              round,
              chunk: {
                index: chunkIndex,
                total: chunks.length,
                inputChars: chunk.length,
              },
              metadata: { nextAttempt, delayMs },
            });
          },
        },
      );
      const extractedLeads = Array.isArray(extracted) ? extracted : [];
      for (const lead of extractedLeads) {
        const u =
          extractLinkedInUsername(
            lead.contactDetails?.linkedinUrl || lead.sourceUrl || "",
          ) ||
          normalizeLinkedInUrl(
            lead.contactDetails?.linkedinUrl || lead.sourceUrl || "",
          );
        if (u) seenCandidateKeys.add(u);
      }
      const chunkLinkMatches = chunk.matchAll(/LINK:\s*([^\s\n]+)/g);
      for (const match of chunkLinkMatches) {
        const url = match[1];
        const u = extractLinkedInUsername(url) || normalizeLinkedInUrl(url);
        if (u) seenCandidateKeys.add(u);
      }
      state.debugLogs.push({
        timestamp: new Date().toISOString(),
        type: "llm_request",
        label: `extraction_round_${round}_chunk_${chunkIndex}`,
        model: process.env.OPENAI_MODEL || DEFAULT_PRIMARY_MODEL,
        prompt,
        systemInstruction: EXTRACTION_SYSTEM_PROMPT,
        response: extractedLeads,
      });
      logEvent(
        `Round ${round}, chunk ${chunkIndex}/${chunks.length}: extracted ${extractedLeads.length} profiles.`,
      );
      recordTrace({
        phase: "extraction",
        operation: "llm_extract_chunk",
        status: "success",
        provider: "llm",
        round,
        chunk: {
          index: chunkIndex,
          total: chunks.length,
          inputChars: chunk.length,
        },
        latencyMs: Date.now() - extractionStarted,
        counts: { extractedProfiles: extractedLeads.length },
        llm: summarizeLLM(
          "extraction",
          prompt,
          extractedLeads,
          Date.now() - extractionStarted,
          0,
          extractionProviderAttempts,
        ),
        metadata: {
          estimatedStructuredInputTokens,
          outputTokenBudget,
          providerTokenBudget,
        },
      });
      if (extractedLeads.length === 0) {
        noteRejection("llm_extraction_empty");
      }
      return extractedLeads;
    } catch (e: any) {
      extractionFailuresThisRound++;
      recordTrace({
        phase: "extraction",
        operation: "llm_extract_chunk",
        status: "error",
        provider: "llm",
        round,
        chunk: {
          index: chunkIndex,
          total: chunks.length,
          inputChars: chunk.length,
        },
        latencyMs: Date.now() - extractionStarted,
        error: { message: e.message || String(e) },
        llm: summarizeLLM(
          "extraction",
          prompt,
          "",
          Date.now() - extractionStarted,
          0,
          extractionProviderAttempts,
        ),
        metadata: {
          estimatedStructuredInputTokens,
          outputTokenBudget,
          providerTokenBudget,
        },
      });
      logEvent(
        `WARN: Extraction chunk ${chunkIndex}/${chunks.length} failed: ${e.message}`,
      );
      state.debugLogs.push({
        timestamp: new Date().toISOString(),
        type: "llm_error",
        label: `extraction_round_${round}_chunk_${chunkIndex}`,
        prompt,
        error: e.message,
      });
      return [];
    }
  });

  const extractionConcurrency = config.extractionConcurrency || 1;
  const extractionResults = await runProviderQueue(
    extractionTasks.map((run, index) => ({
      id: `${config.sessionId}:extraction:r${round}:chunk${index + 1}`,
      priority: extractionTasks.length - index,
      run,
    })),
    {
      concurrency: extractionConcurrency,
      signal: state.abortController.signal,
    },
  );

  if (chunks.length > 0 && extractionFailuresThisRound === chunks.length) {
    consecutiveFailedExtractionRounds++;
  } else {
    consecutiveFailedExtractionRounds = 0;
  }

  if (consecutiveFailedExtractionRounds >= failedExtractionRoundsBeforeStop) {
    logEvent(
      `Stopping after ${consecutiveFailedExtractionRounds} consecutive rounds where every LLM extraction batch failed.`,
    );
    recordTrace({
      phase: "extraction",
      operation: "llm_circuit_breaker_stop",
      status: "error",
      provider: "system",
      round,
      error: {
        message: `All LLM providers failed for ${consecutiveFailedExtractionRounds} consecutive extraction rounds.`,
      },
    });
    return {
      extractedProfiles: [],
      evidenceByUrl,
      consecutiveFailedExtractionRounds,
      brightDataProviderDisabled,
      stopReason: "llm_unavailable",
    };
  }

  const extractedProfiles = extractionResults.flat();
  return {
    extractedProfiles,
    evidenceByUrl,
    consecutiveFailedExtractionRounds,
    brightDataProviderDisabled,
  };
}
