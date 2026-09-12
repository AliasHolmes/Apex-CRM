import { runProviderQueue } from "../providerQueue.js";
import {
  reserveProviderUsage,
  recordProviderUsage,
  readExistingIdentityKeys,
} from "../../db.js";
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
  type LLMUsage,
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
import {
  unwrapRedirectUrl,
  canonicalLinkedInIdentity,
  getLinkedInHandle,
  isValidLinkedInHandle,
} from "../../../src/utils/leadDedupe.js";
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
  ablatedRequirementId?: string;
  ablatedTerm?: string;
};

const normalizeDedupeValue = (value?: string) =>
  (value || "").trim().toLowerCase();

export function cleanSnippetNoise(text?: string): string {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9]+;/gi, " ")
    .replace(/\b(?:Cookie\s+Settings|Accept\s+All|Privacy\s+Policy|Terms\s+of\s+Service|Skip\s+to\s+content|All\s+rights\s+reserved)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildCleanEvidence(item: any): string {
  const url = item?.url || "";
  const title = cleanSnippetNoise(item?.title || "Untitled result");
  const rawSnippet = item?.content || item?.raw_content || "";
  const cleaned = cleanSnippetNoise(rawSnippet);
  const snippet = cleaned.length > 500 ? `${cleaned.slice(0, 500)}...` : cleaned;
  return [
    `LINK: ${url}`,
    `TITLE: ${title}`,
    `[TAVILY SNIPPET]`,
    snippet,
  ].filter(Boolean).join("\n");
}

export type ExtractStageInput = {
  round: number;
  candidateItems: any[];
  rerankPoolTarget: number;
  candidateCeiling?: number;
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

  // 0. Stage 2.5: FAST DETERMINISTIC PRE-FILTER GATE (0ms - No LLM)
  const existingCrmKeys = readExistingIdentityKeys();
  const requiresPerson =
    config.contract?.requirements.some((r: any) => r.scope === "person_role") ?? true;

  const preFilteredItems: any[] = [];
  let skippedDuplicates = 0;
  let skippedMissingLinkedIn = 0;

  for (const item of candidateItems) {
    const rawUrl = String(item.url || "").trim();
    const queryRun = item._queryRun as QueryRunStats | undefined;
    const unwrapped = unwrapRedirectUrl(rawUrl);
    const effectiveUrl = unwrapped || rawUrl;
    const normUrl = normalizeDedupeValue(effectiveUrl);

    // a) Check CRM duplicate identities
    const identityKey =
      canonicalLinkedInIdentity(effectiveUrl) ||
      canonicalLinkedInIdentity(rawUrl);
    const handle = getLinkedInHandle(effectiveUrl);
    const handleKey = handle ? `linkedin:${handle}` : "";

    const isDuplicate =
      (identityKey && existingCrmKeys.has(identityKey)) ||
      (handleKey && existingCrmKeys.has(handleKey)) ||
      (normUrl && existingCrmKeys.has(`url:${normUrl}`));

    if (isDuplicate) {
      skippedDuplicates++;
      stats.existingCrmLeadsSkipped = (stats.existingCrmLeadsSkipped || 0) + 1;
      noteRejection("duplicate_existing_lead", queryRun);
      continue;
    }

    // b) Check LinkedIn profile requirement
    const isExplicitLinkedInProfile = Boolean(
      /linkedin\.com\/in\/[^/?#]+/i.test(effectiveUrl) ||
        (handle && isValidLinkedInHandle(handle)),
    );

    // If item is from a signal lane and has no LinkedIn URL, route company signal to signalStore if available
    const isSignalLane = item._queryLane === "signal" || item.lane === "signal";
    if (!isExplicitLinkedInProfile && isSignalLane) {
      if (state.signalStore && typeof (state.signalStore as any).addCompanySignal === "function") {
        const companyHint = item.title?.split(/[-|:]/)[0]?.trim();
        if (companyHint) {
          (state.signalStore as any).addCompanySignal(companyHint, {
            query: item._sourceQuery || "",
            url: effectiveUrl,
            confidence: 0.7,
          });
        }
      }
      skippedMissingLinkedIn++;
      noteRejection("missing_linkedin_profile", queryRun);
      continue;
    }

    // If contract requires person profile, reject items with no LinkedIn URL
    if (requiresPerson && !isExplicitLinkedInProfile) {
      // Check if snippet contains an explicit linkedin.com/in/ URL
      const snippet = String(item.content || item.raw_content || "");
      const snippetLinkedIn = snippet.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9_\u0080-\uffff-]+/i);
      if (snippetLinkedIn?.[0]) {
        const rescuedUrl = snippetLinkedIn[0];
        const rescuedIdentity = canonicalLinkedInIdentity(rescuedUrl);
        const rescuedHandle = getLinkedInHandle(rescuedUrl);
        const rescuedHandleKey = rescuedHandle ? `linkedin:${rescuedHandle}` : "";
        const rescuedNorm = normalizeDedupeValue(rescuedUrl);

        const isRescuedDuplicate = Boolean(
          (rescuedIdentity && existingCrmKeys.has(rescuedIdentity)) ||
          (rescuedHandleKey && existingCrmKeys.has(rescuedHandleKey)) ||
          (rescuedNorm && existingCrmKeys.has(`url:${rescuedNorm}`)),
        );

        if (isRescuedDuplicate) {
          skippedDuplicates++;
          stats.existingCrmLeadsSkipped = (stats.existingCrmLeadsSkipped || 0) + 1;
          noteRejection("duplicate_existing_lead", queryRun);
          continue;
        }

        item.url = rescuedUrl;
      } else {
        skippedMissingLinkedIn++;
        noteRejection("missing_linkedin_profile", queryRun);
        continue;
      }
    }

    preFilteredItems.push(item);
  }

  if (skippedDuplicates > 0 || skippedMissingLinkedIn > 0) {
    logEvent(
      `Round ${round} Pre-Filter Gate: Filtered out ${skippedDuplicates} CRM duplicate(s) and ${skippedMissingLinkedIn} non-LinkedIn profile(s) in 0ms. Retained ${preFilteredItems.length}/${candidateItems.length} candidate(s).`,
    );
  }

  if (preFilteredItems.length === 0) {
    logEvent(
      `Round ${round}: No viable candidates remained after Pre-Filter Gate. Skipping extraction LLM.`,
    );
    return {
      extractedProfiles: [],
      evidenceByUrl,
      consecutiveFailedExtractionRounds: 0,
      brightDataProviderDisabled,
    };
  }

  const activeCandidateItems = preFilteredItems;

  // 1. Thin page evidence upgrades via Bright Data rapid tool or Tavily Extract fallback
  const upgradeTargets = activeCandidateItems.filter((item: any) => {
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
          // Thread cancellation through: without it a cancelled session finishes every
          // remaining batch scrape and pays for results that are then discarded.
          const batchResults = await scrapeBatchAsMarkdown(
            batchUrls,
            undefined,
            state.abortController.signal,
          );
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

  for (const item of activeCandidateItems) {
    const url = item.url || "";
    const normalizedUrl = item._normalizedUrl || normalizeLinkedInUrl(url);
    const username = item._linkedinUsername || extractLinkedInUsername(url);
    const queryRun = item._queryRun as QueryRunStats | undefined;

    const sourceProvider: LeadSourceProvider =
      item.sourceProvider === "brightdata_search" ? "brightdata" : "tavily";
    const evidenceBlock = buildCleanEvidence(item);
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
      ablatedRequirementId: item._ablatedRequirementId || item.ablatedRequirementId,
      ablatedTerm: item._ablatedTerm || item.ablatedTerm,
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
      `--- PROFILE CANDIDATE ---\nSOURCE_PROVIDER: ${sourceProvider}\nLINK: ${normalizedUrl ? `https://${normalizedUrl}` : url}\n${evidenceBlock}\n\n`,
    );
  }

  // 3. Adaptive extraction evidence slicing
  const targetCeiling = Math.max(
    input.candidateCeiling || rerankPoolTarget,
    rerankPoolTarget,
  );
  const neededPoolRemaining = Math.max(
    15,
    targetCeiling - state.acceptedLeads.length,
  );
  const neededEvidenceBlocks = Math.max(
    16,
    Math.ceil(neededPoolRemaining * 1.8),
  );
  if (evidenceBlocks.length > neededEvidenceBlocks) {
    logEvent(
      `Round ${round}: capped extraction evidence to top ${neededEvidenceBlocks}/${evidenceBlocks.length} blocks (pool needed: ${neededPoolRemaining}).`,
    );
    evidenceBlocks = evidenceBlocks.slice(0, neededEvidenceBlocks);
  }

  // 4. Token budget calculation and chunking
  const extractionChunkChars = Math.min(
    Math.max(Number(process.env.LEAD_EXTRACTION_CHUNK_CHARS || 8000), 1800),
    32000,
  );
  const configuredExtractionMaxTokens = Math.min(
    Math.max(Number(process.env.LEAD_EXTRACTION_MAX_TOKENS || 2000), 800),
    6000,
  );
  const providerTokenBudget = Math.min(
    Math.max(Number(process.env.LLM_PROVIDER_TOKEN_BUDGET || 24000), 4000),
    120_000,
  );
  const tokenSafetyMargin = Math.min(
    Math.max(Number(process.env.LLM_TOKEN_SAFETY_MARGIN || 400), 200),
    2000,
  );
  const extractionPromptPrefix = `Extract all distinct individuals and their professional profiles from the source-labeled evidence blocks below.

Rules:
- Extract every person who has a full name and an associated role, title, company, or headline.
- Do not invent data. Use empty strings for missing fields.
- Set contactDetails.linkedinUrl to the candidate's canonical LinkedIn profile URL from LINK or the snippet (e.g. https://linkedin.com/in/username). If LINK is a LinkedIn post or redirect, extract the person's profile URL.
- If LINK is not a LinkedIn URL or is missing, leave contactDetails.linkedinUrl empty.
- Preserve SOURCE_PROVIDER as sourceProvider.
- Score conservatively from 1-10 using only visible evidence.
- Add evidenceReasons as 1 short factual summary of the person's role/company from the snippet.
- Do not filter out individuals or evaluate subjective criteria; extract all visible professional entities faithfully.

Evidence:
`;
  const structuredPromptOverheadTokens =
    estimateTokenCount(extractionPromptPrefix) +
    estimateTokenCount(EXTRACTION_SYSTEM_PROMPT) +
    estimateTokenCount(JSON.stringify(bulkLeadsArraySchema)) +
    500;
  const evidenceTokenBudget = Math.max(
    1500,
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
    let extractionUsage: LLMUsage | undefined;
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
              signal: state.abortController.signal,
              timeoutMs: Math.min(
                120_000,
                Number(process.env.LLM_EXTRACTION_TIMEOUT_MS || 90_000),
              ),
              onProviderAttempt: (attempt) =>
                extractionProviderAttempts.push(attempt),
              onUsage: (usage) => {
                extractionUsage = usage;
              },
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
        const url = lead.contactDetails?.linkedinUrl || lead.sourceUrl || "";
        const username = extractLinkedInUsername(url);
        const normalized = normalizeLinkedInUrl(url);
        if (username) seenCandidateKeys.add(`linkedin:${username}`);
        if (username) seenCandidateKeys.add(username);
        if (normalized) seenCandidateKeys.add(normalized);
      }
      const successfulAttempt = extractionProviderAttempts.find(
        (a) => a.status === "success",
      );
      const resolvedModel =
        extractionUsage?.model ||
        successfulAttempt?.actualModel ||
        successfulAttempt?.model ||
        process.env.OPENAI_MODEL ||
        DEFAULT_PRIMARY_MODEL;
      const latency = Date.now() - extractionStarted;
      const tokens = extractionUsage?.totalTokens;
      logEvent(
        `[LLM 200 OK] ${successfulAttempt?.provider || "LLM"} \u00b7 model: ${resolvedModel} \u00b7 ${latency}ms${tokens ? ` \u00b7 ${tokens.toLocaleString()} tok` : ""} [Extraction Chunk ${chunkIndex}/${chunks.length}: ${extractedLeads.length} leads]`,
      );

      state.debugLogs.push({
        timestamp: new Date().toISOString(),
        type: "llm_request",
        label: `extraction_round_${round}_chunk_${chunkIndex}`,
        model: resolvedModel,
        prompt,
        systemInstruction: EXTRACTION_SYSTEM_PROMPT,
        response: JSON.parse(JSON.stringify(extractedLeads)),
      });
      recordTrace({
        phase: "extraction",
        operation: "llm_extract_chunk",
        status: "success",
        provider: "llm",
        model: resolvedModel,
        round,
        chunk: {
          index: chunkIndex,
          total: chunks.length,
          inputChars: chunk.length,
        },
        latencyMs: latency,
        counts: { extractedProfiles: extractedLeads.length },
        llm: summarizeLLM(
          "extraction",
          prompt,
          extractedLeads,
          latency,
          0,
          extractionProviderAttempts,
          extractionUsage,
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
      const failedAttempt = extractionProviderAttempts[extractionProviderAttempts.length - 1];
      const failedModel = failedAttempt?.actualModel || failedAttempt?.model;
      recordTrace({
        phase: "extraction",
        operation: "llm_extract_chunk",
        status: "error",
        provider: "llm",
        model: failedModel,
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
          extractionUsage,
        ),
        metadata: {
          estimatedStructuredInputTokens,
          outputTokenBudget,
          providerTokenBudget,
        },
      });
      logEvent(
        `[LLM ERROR] Extraction chunk ${chunkIndex}/${chunks.length} failed: ${e.message}`,
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

  // The upper clamp was 1, which made LEAD_EXTRACTION_CONCURRENCY inert. 2 is the recommended
  // maximum in configValidation.ts; default stays 1 unless opted in.
  const extractionConcurrency = Math.min(
    Math.max(
      Number(
        config.extractionConcurrency ||
          process.env.LEAD_EXTRACTION_CONCURRENCY ||
          1,
      ),
      1,
    ),
    2,
  );
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

  const extractedProfiles = extractionResults.flat().map((lead: any) => {
    if (lead?.contactDetails?.linkedinUrl) {
      const unwrapped = unwrapRedirectUrl(lead.contactDetails.linkedinUrl);
      const normalized = normalizeLinkedInUrl(unwrapped);
      if (normalized) {
        lead.contactDetails.linkedinUrl = `https://${normalized}`;
      }
    }
    return lead;
  });
  return {
    extractedProfiles,
    evidenceByUrl,
    consecutiveFailedExtractionRounds,
    brightDataProviderDisabled,
  };
}
