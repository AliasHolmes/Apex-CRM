import { runProviderQueue } from "../providerQueue.js";
import { reserveProviderUsage, recordProviderUsage } from "../../db.js";
import {
  shouldRunTavilyForTask,
  shouldRunBrightDataForTask,
  type BrightDataSearchMode,
} from "../discoveryRouting.js";
import { toLinkedInSearchQuery, toDatasetFilter } from "../strategist.js";
import {
  classifyBrightDataError,
  executeBrightDataSearchWithRetry,
  getBrightDataStatus,
  isBrightDataPro,
  brightDataSearchDataset,
  type BrightDataSearchResult,
  type BrightDataSearchOptions,
} from "../../services/brightdata.js";
import { hasTavilyKey } from "../../services/llm.js";
import { incrementCounter } from "../sessionHelpers.js";
import type { SessionContext } from "../pipelineTypes.js";
import type { ExecutableQueryPlan } from "./planStage.js";
import type { QueryRunStats } from "../strategist.js";
import { ablateQueryTask, createAblationTracker } from "../constraintAblation.js";

export type RetrieveStageInput = {
  round: number;
  roundPlans: ExecutableQueryPlan[];
  queryRuns: QueryRunStats[];
  discoveryProviderMode: any;
  brightDataSearchMode: BrightDataSearchMode | string;
  brightDataReady: boolean;
  brightDataProviderDisabled: boolean;
  brightDataTransportRetryAfter: number;
  brightDataSearchRetryMax: number;
  brightDataSearchRetryBaseDelayMs: number;
  tavilyCapabilities: any;
  brightDataCapabilities: any;
  stats: any;
};

export type RetrieveStageOutput = {
  roundItems: { item: any; resultIndex: number }[];
  usingBrightDataSearch: boolean;
  brightDataProviderDisabled: boolean;
  brightDataTransportRetryAfter: number;
};

export async function executeRetrieveStage(
  ctx: SessionContext,
  input: RetrieveStageInput,
): Promise<RetrieveStageOutput> {
  const {
    round,
    roundPlans,
    queryRuns,
    discoveryProviderMode,
    brightDataSearchMode,
    brightDataReady,
    brightDataSearchRetryMax,
    brightDataSearchRetryBaseDelayMs,
    tavilyCapabilities,
    brightDataCapabilities,
    stats,
  } = input;

  let brightDataProviderDisabled = input.brightDataProviderDisabled;
  let brightDataTransportRetryAfter = input.brightDataTransportRetryAfter;
  const { config, state, ports, logEvent, recordTrace } = ctx;
  const { freeTierBudget } = state;
  const { creditReservationEnabled } = config;

  const getTraceBrightDataStatus = () => {
    const status = getBrightDataStatus();
    return { ...status, transport: status.transport || undefined };
  };

  const tavilyResultsByIndex = new Map<
    number,
    { text: string; sources: any[]; items: any[] }
  >();
  const roundItems: { item: any; resultIndex: number }[] = [];
  let usingBrightDataSearch = false;
  const ablationTracker = createAblationTracker(2);

  const duplicateCollisionRate =
    (stats.rawCandidates || 0) > 0
      ? ((stats.rejectionReasons?.duplicate_existing_lead || 0) +
          (stats.rejectionReasons?.duplicate_person || 0) +
          (stats.existingCrmLeadsSkipped || 0)) /
        stats.rawCandidates
      : 0;
  const isHighDuplication =
    duplicateCollisionRate >= 0.2 ||
    (stats.rejectionReasons?.duplicate_existing_lead || 0) >= 3 ||
    (stats.existingCrmLeadsSkipped || 0) >= 3;
  const dynamicTavilyMaxResults =
    round > 1 || isHighDuplication
      ? 20
      : Math.min(
          Math.max(Number(process.env.TAVILY_MAX_RESULTS || 10), 1),
          20,
        );

  const executeTavilyLane = async (
    plans: { plan: (typeof roundPlans)[0]; index: number }[],
  ) => {
    if (plans.length === 0) return;

    recordTrace({
      phase: "search",
      operation: "tavily_round_search",
      status: "started",
      provider: "tavily",
      round,
      counts: { queries: plans.length, plannedQueries: roundPlans.length },
      tavily: {
        searchDepth: "task-specific",
        maxResults: dynamicTavilyMaxResults,
        includeDomains: Array.from(
          new Set(
            plans.flatMap(({ plan }) => plan.item.tavily.includeDomains || []),
          ),
        ),
      },
      metadata: { discoveryProviderMode, dynamicMaxResults: dynamicTavilyMaxResults, isHighDuplication },
    });
    logEvent(
      `Round ${round}: executing ${plans.length}/${roundPlans.length} Tavily queries (mode=${discoveryProviderMode}, maxResults=${dynamicTavilyMaxResults}).`,
    );

    await runProviderQueue(
      plans.map(({ plan, index }) => ({
        id: `${config.sessionId}:tavily:r${round}:q${index + 1}`,
        priority: 1_000 - plan.item.priority,
        run: async (signal?: AbortSignal) => {
          const searchStarted = Date.now();
          try {
            const tavilyOptions = plan.item.tavily;
            const estimatedCredits =
              tavilyOptions.searchDepth === "advanced" ? 2 : 1;
            if (
              !freeTierBudget.reserveTavilySearch(tavilyOptions.searchDepth)
            ) {
              logEvent(
                `Round ${round}: skipped Tavily task after local session reservation (PROVIDER_CREDIT_RESERVATION=true).`,
              );
              tavilyResultsByIndex.set(index, {
                text: "",
                sources: [],
                items: [],
              });
              return;
            }
            if (creditReservationEnabled) {
              const monthlyReservation = reserveProviderUsage(
                "tavily",
                estimatedCredits,
                tavilyCapabilities.monthlyLimit,
              );
              if (!monthlyReservation.allowed) {
                logEvent(
                  `Round ${round}: skipped Tavily task after local monthly reservation (PROVIDER_CREDIT_RESERVATION=true).`,
                );
                tavilyResultsByIndex.set(index, {
                  text: "",
                  sources: [],
                  items: [],
                });
                return;
              }
            } else {
              recordProviderUsage("tavily", estimatedCredits);
            }
            queryRuns[index].providerUnits += estimatedCredits;
            const res = await ports.tavilySearch(plan.executableQuery, {
              ...tavilyOptions,
              maxResults: dynamicTavilyMaxResults,
              signal: signal || state.abortController.signal,
            });
            let resultsCount = res.items?.length || 0;

            // Hierarchical Algorithmic Constraint Ablation:
            // If the query hit a zero-SERP cliff (resultsCount <= 1), dynamically relax the lowest-priority
            // constraint term (Tier 4 first, then 3, then 2, never Tier 1 identity anchor).
            if (
              resultsCount <= 1 &&
              config.contract &&
              ablationTracker.attemptsCount < ablationTracker.maxAblatedPerRound &&
              !ablationTracker.ablatedTasks.has(plan.executableQuery) &&
              plan.item.lane !== "signal"
            ) {
              const ablated = ablateQueryTask(
                plan.executableQuery,
                config.contract,
                plan.item.coveredRequirementIds,
              );
              if (ablated) {
                ablationTracker.attemptsCount++;
                ablationTracker.ablatedTasks.add(plan.executableQuery);
                logEvent(
                  `[Constraint Ablation] Round ${round}: Query "${plan.executableQuery}" yielded ${resultsCount} result(s). Relaxed to "${ablated.ablatedQuery}" (deferred Tier ${ablated.tier} [${ablated.ablatedRequirementId}]: "${ablated.ablatedTerm}").`,
                );
                recordTrace({
                  phase: "search",
                  operation: "constraint_ablation_relaxation",
                  status: "started",
                  provider: "tavily",
                  round,
                  query: ablated.ablatedQuery,
                  metadata: {
                    originalQuery: plan.executableQuery,
                    ablatedRequirementId: ablated.ablatedRequirementId,
                    ablatedTerm: ablated.ablatedTerm,
                    tier: ablated.tier,
                  },
                });

                try {
                  const ablatedRes = await ports.tavilySearch(ablated.ablatedQuery, {
                    ...tavilyOptions,
                    signal: signal || state.abortController.signal,
                  });
                  const ablatedCount = ablatedRes.items?.length || 0;
                  if (ablatedCount > 0) {
                    stats.ablationRescues = (stats.ablationRescues || 0) + ablatedCount;
                    for (const it of ablatedRes.items) {
                      it.ablatedRequirementId = ablated.ablatedRequirementId;
                      it.ablatedTerm = ablated.ablatedTerm;
                    }
                    const existingUrls = new Set((res.items || []).map((it: any) => it.url));
                    const newItems = ablatedRes.items.filter((it: any) => !existingUrls.has(it.url));
                    res.items = [...(res.items || []), ...newItems];
                    resultsCount = res.items.length;
                    if (ablatedRes.text) {
                      res.text = (res.text ? res.text + "\n\n" : "") + ablatedRes.text;
                    }
                    if (ablatedRes.sources) {
                      res.sources = [...(res.sources || []), ...ablatedRes.sources];
                    }
                    logEvent(
                      `[Constraint Ablation] Rescued ${newItems.length} candidate(s) via ablated query "${ablated.ablatedQuery}".`,
                    );
                  }
                } catch (ablationErr: any) {
                  logEvent(
                    `[Constraint Ablation] Ablated query attempt failed: ${ablationErr.message}`,
                  );
                }
              }
            }

            recordTrace({
              phase: "search",
              operation: "tavily_search",
              status: "success",
              provider: "tavily",
              round,
              query: plan.executableQuery,
              latencyMs: Date.now() - searchStarted,
              counts: { rawCandidates: resultsCount },
              tavily: {
                searchDepth: tavilyOptions.searchDepth,
                maxResults: tavilyOptions.maxResults,
                includeDomains: tavilyOptions.includeDomains,
              },
            });
            state.debugLogs.push({
              timestamp: new Date().toISOString(),
              type: "tavily_search",
              query: plan.executableQuery,
              resultsCount,
              results: res.items?.map((item: any) => ({
                title: item.title,
                url: item.url,
                snippet: item.content || item.raw_content,
              })),
            });
            tavilyResultsByIndex.set(index, res);
          } catch (e: any) {
            recordTrace({
              phase: "search",
              operation: "tavily_search",
              status: "error",
              provider: "tavily",
              round,
              query: plan.executableQuery,
              latencyMs: Date.now() - searchStarted,
              error: { message: e.message || String(e) },
            });
            logEvent(
              `WARN: Tavily Search failed for query "${plan.executableQuery}": ${e.message}`,
            );
            state.debugLogs.push({
              timestamp: new Date().toISOString(),
              type: "tavily_error",
              query: plan.executableQuery,
              error: e.message,
            });
            tavilyResultsByIndex.set(index, {
              text: "",
              sources: [],
              items: [],
            });
          } finally {
            queryRuns[index].searchLatencyMs += Date.now() - searchStarted;
          }
        },
      })),
      {
        concurrency: Number(process.env.TAVILY_SEARCH_CONCURRENCY || 3),
        intervalCap: Number(process.env.TAVILY_SEARCH_INTERVAL_CAP || 0),
        intervalMs: Number(process.env.TAVILY_SEARCH_INTERVAL_MS || 1_000),
        signal: state.abortController.signal,
      },
    );
  };

  const executeBrightDataLane = async (
    plans: { plan: (typeof roundPlans)[0]; index: number }[],
    waveLabel: string,
  ) => {
    if (plans.length === 0) return;

    usingBrightDataSearch = true;
    stats.sourceProvider =
      stats.sourceProvider === "tavily" && roundItems.length === 0
        ? "brightdata_search"
        : "mixed";
    logEvent(
      `Round ${round}: executing ${plans.length} Bright Data searches (${waveLabel}, mode: ${brightDataSearchMode}).`,
    );

    const bdResults = await runProviderQueue(
      plans.map(({ plan, index }) => ({
        id: `${config.sessionId}:brightdata:r${round}:q${index + 1}`,
        priority: 1_000 - plan.item.priority,
        run: async () => {
          const bdSearchStarted = Date.now();
          let physicalAttempts = 0;
          let recovered = false;

          if (
            brightDataProviderDisabled ||
            (brightDataTransportRetryAfter &&
              Date.now() < brightDataTransportRetryAfter)
          ) {
            state.brightDataStats.skipped++;
            const skipReason = brightDataProviderDisabled
              ? "provider_disabled"
              : "transport_cooldown";
            logEvent(
              `Round ${round}: skipped Bright Data search due to ${skipReason} (${Math.max(0, Math.ceil((brightDataTransportRetryAfter - Date.now()) / 1000))}s remaining).`,
            );
            recordTrace({
              phase: "search",
              operation: "brightdata_search",
              status: "skipped",
              provider: "brightdata",
              round,
              query: plan.executableQuery,
              metadata: {
                reason: skipReason,
                cooldownRemainingMs: Math.max(0, brightDataTransportRetryAfter - Date.now()),
              },
            });
            return { index, results: [] as any[], fallbackProvider: undefined };
          }

          try {
            const results = await executeBrightDataSearchWithRetry(
              async (attempt) => {
                const attemptStarted = Date.now();
                if (!freeTierBudget.reserveBrightDataSearch()) {
                  state.brightDataStats.skipped++;
                  logEvent(
                    `Round ${round}: skipped Bright Data search attempt ${attempt} after local session reservation (PROVIDER_CREDIT_RESERVATION=true).`,
                  );
                  recordTrace({
                    phase: "search",
                    operation: "brightdata_search",
                    status: "skipped",
                    provider: "brightdata",
                    round,
                    query: plan.executableQuery,
                    metadata: {
                      attempt,
                      maxAttempts: brightDataSearchRetryMax + 1,
                      reason: "session_credit_reservation",
                    },
                  });
                  return [] as BrightDataSearchResult[];
                }
                if (creditReservationEnabled) {
                  const monthlyReservation = reserveProviderUsage(
                    "brightdata",
                    1,
                    brightDataCapabilities.monthlyLimit,
                  );
                  if (!monthlyReservation.allowed) {
                    state.brightDataStats.skipped++;
                    logEvent(
                      `Round ${round}: skipped Bright Data search attempt ${attempt} after local monthly reservation (PROVIDER_CREDIT_RESERVATION=true).`,
                    );
                    recordTrace({
                      phase: "search",
                      operation: "brightdata_search",
                      status: "skipped",
                      provider: "brightdata",
                      round,
                      query: plan.executableQuery,
                      metadata: {
                        attempt,
                        maxAttempts: brightDataSearchRetryMax + 1,
                        reason: "monthly_credit_reservation",
                      },
                    });
                    return [] as BrightDataSearchResult[];
                  }
                } else {
                  recordProviderUsage("brightdata", 1);
                }

                physicalAttempts++;
                queryRuns[index].providerUnits += 1;
                const linkedInQuery = toLinkedInSearchQuery(plan.item);
                const shouldFetchPage2 = duplicateCollisionRate > 0.3;
                const bdSearchOptions: BrightDataSearchOptions = {
                  ...(shouldFetchPage2 ? { start: 10 } : {}),
                  // Without this, a cancelled session keeps issuing paid SERP calls (and
                  // waiting through the 500-1200ms jitter) for results nobody will read.
                  signal: state.abortController.signal,
                };
                try {
                  const attemptResults = await ports.brightDataSearch(
                    linkedInQuery || plan.executableQuery,
                    bdSearchOptions,
                    `round_${round}`,
                  );
                  if (attempt > 1) recovered = true;
                  const isBing = attemptResults.some(
                    (r) => r.sourceEngine === "bing",
                  );
                  recordTrace({
                    phase: "search",
                    operation: "brightdata_search",
                    status: "success",
                    provider: "brightdata",
                    round,
                    query: plan.executableQuery,
                    latencyMs: Date.now() - attemptStarted,
                    counts: { rawCandidates: attemptResults.length },
                    brightData: getTraceBrightDataStatus(),
                    metadata: {
                      attempt,
                      maxAttempts: brightDataSearchRetryMax + 1,
                      recovered: attempt > 1,
                      engine: isBing ? "bing" : "google",
                    },
                  });
                  return attemptResults;
                } catch (error: any) {
                  const classified = classifyBrightDataError(error);
                  const willRetry =
                    classified.retryable && attempt <= brightDataSearchRetryMax;
                  incrementCounter(
                    state.brightDataStats.failureReasons,
                    classified.reasonCode,
                  );
                  if (classified.reasonCode === "target_transient")
                    state.brightDataStats.transientFailures++;
                  if (classified.reasonCode === "transport_transient") {
                    state.brightDataStats.transportFailures++;
                    state.brightDataStats.processRestarts++;
                    brightDataTransportRetryAfter = Date.now() + 15_000;
                  }
                  if (classified.providerDisabled) {
                    state.brightDataStats.providerDisabled++;
                    brightDataProviderDisabled = true;
                  }
                  recordTrace({
                    phase: "search",
                    operation: "brightdata_search",
                    status: willRetry ? "info" : "error",
                    provider: "brightdata",
                    round,
                    query: plan.executableQuery,
                    latencyMs: Date.now() - attemptStarted,
                    error: {
                      message:
                        classified.reasonCode + ": " + classified.message,
                    },
                    brightData: getTraceBrightDataStatus(),
                    metadata: {
                      attempt,
                      maxAttempts: brightDataSearchRetryMax + 1,
                      retrying: willRetry,
                    },
                  });
                  throw classified;
                }
              },
              {
                maxRetries: brightDataSearchRetryMax,
                baseDelayMs: brightDataSearchRetryBaseDelayMs,
                onRetry: ({ error, nextAttempt, delayMs }) => {
                  state.brightDataStats.searchRetries++;
                  logEvent(
                    `Round ${round}: Bright Data ${error.reasonCode}; retrying search attempt ${nextAttempt}/${brightDataSearchRetryMax + 1} after ${delayMs}ms.`,
                  );
                },
              },
            );

            if (recovered) state.brightDataStats.searchRecovered++;
            return { index, results, fallbackProvider: undefined };
          } catch (error: any) {
            const classified = classifyBrightDataError(error);
            stats.brightDataFailures++;
            state.brightDataStats.failed++;
            logEvent(
              `[Search Fallback] Bright Data search challenged or unavailable (${classified.reasonCode}) after ${physicalAttempts} attempt(s); gracefully using fallback.`,
            );

            if (hasTavilyKey()) {
              try {
                const fallbackStarted = Date.now();
                logEvent(
                  `Round ${round}: falling back to Tavily for query "${plan.executableQuery}".`,
                );
                const tavilyOptions = plan.item.tavily;
                const res = await ports.tavilySearch(plan.executableQuery, {
                  ...tavilyOptions,
                  signal: state.abortController.signal,
                });
                const fallbackItems = (res.items || [])
                  .map((item: any) => ({
                    title: String(item.title || ""),
                    url: String(item.url || ""),
                    content: String(
                      item.content || item.raw_content || item.snippet || "",
                    ),
                    sourceProvider: "tavily" as const,
                  }))
                  .filter((item: any) => item.url && item.title);

                recordTrace({
                  phase: "search",
                  operation: "tavily_search",
                  status: "success",
                  provider: "tavily",
                  round,
                  query: plan.executableQuery,
                  latencyMs: Date.now() - fallbackStarted,
                  counts: { rawCandidates: fallbackItems.length },
                  metadata: {
                    fallbackFrom: "brightdata",
                    originalReason: classified.reasonCode,
                  },
                });

                return {
                  index,
                  results: fallbackItems,
                  fallbackProvider: "tavily",
                };
              } catch (fallbackError: any) {
                logEvent(
                  `WARN: Tavily fallback search also failed for query "${plan.executableQuery}": ${fallbackError.message || String(fallbackError)}`,
                );
              }
            }

            return { index, results: [] as any[], fallbackProvider: undefined };
          } finally {
            queryRuns[index].searchLatencyMs += Date.now() - bdSearchStarted;
          }
        },
      })),
      {
        concurrency: Number(process.env.BRIGHTDATA_SEARCH_CONCURRENCY || 2),
        intervalCap: Number(process.env.BRIGHTDATA_SEARCH_INTERVAL_CAP || 0),
        intervalMs: Number(process.env.BRIGHTDATA_SEARCH_INTERVAL_MS || 1_000),
        signal: state.abortController.signal,
      },
    );

    for (const result of bdResults) {
      if (!result) continue;
      const { index, results } = result;
      for (const res of results) {
        roundItems.push({
          item: {
            title: res.title,
            url: res.url,
            content: res.snippet || res.description || res.content || "",
            sourceProvider:
              result.fallbackProvider === "tavily" ||
              res.sourceProvider === "tavily"
                ? "tavily"
                : "brightdata",
          },
          resultIndex: index,
        });
      }
    }
  };

  const executeBrightDataDatasetLane = async (
    plans: { plan: (typeof roundPlans)[0]; index: number }[],
  ) => {
    if (plans.length === 0 || !isBrightDataPro()) return;

    for (const { plan, index } of plans) {
      const locationRequirement = config.contract?.requirements?.find(
        (r) => r.category === "location",
      );
      const fallbackCountry = locationRequirement?.values?.[0];
      const filter = toDatasetFilter(plan.item, fallbackCountry);
      if (!filter) continue;

      const startedAt = Date.now();
      logEvent(
        `Round ${round}: executing Bright Data Pro dataset search (gd_l1viktl72bvl7bjuj0)...`,
      );
      recordTrace({
        phase: "search",
        operation: "brightdata_dataset_search",
        status: "started",
        provider: "brightdata",
        round,
        query: plan.executableQuery,
        metadata: { filter: JSON.stringify(filter) },
      });

      try {
        const datasetResult = await brightDataSearchDataset(
          "gd_l1viktl72bvl7bjuj0",
          filter,
          10,
          undefined,
          state.datasetSearchAfter,
        );

        if (datasetResult?.search_after) {
          state.datasetSearchAfter = datasetResult.search_after;
        }

        const hits = datasetResult?.hits || [];
        if (hits.length > 0) {
          recordProviderUsage("brightdata", hits.length);
          state.brightDataStats.succeeded += hits.length;
          usingBrightDataSearch = true;

          for (const hit of hits) {
            if (!hit?.url) continue;
            roundItems.push({
              item: {
                title: `${hit.position || "Professional"} at ${hit.current_company_name || (typeof hit.current_company === "object" ? hit.current_company?.name : "") || "Company"}`,
                url: hit.url,
                content: JSON.stringify(hit),
                sourceProvider: "brightdata_dataset",
                raw: {
                  ...hit,
                  sourceProvider: "brightdata_dataset",
                },
              },
              resultIndex: index,
            });
          }

          logEvent(
            `Round ${round}: Bright Data dataset discovery found ${hits.length} structured dossiers in ${Date.now() - startedAt}ms.`,
          );
          recordTrace({
            phase: "search",
            operation: "brightdata_dataset_search",
            status: "success",
            provider: "brightdata",
            round,
            query: plan.executableQuery,
            counts: { candidates: hits.length },
            metadata: {
              latencyMs: Date.now() - startedAt,
              took: datasetResult?.took,
              totalHits: datasetResult?.total_hits,
            },
          });
        } else {
          logEvent(
            `Round ${round}: Bright Data dataset search returned 0 hits in ${Date.now() - startedAt}ms.`,
          );
          recordTrace({
            phase: "search",
            operation: "brightdata_dataset_search",
            status: "completed",
            provider: "brightdata",
            round,
            query: plan.executableQuery,
            counts: { candidates: 0 },
            metadata: { latencyMs: Date.now() - startedAt },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logEvent(
          `Round ${round}: Bright Data dataset search failed: ${msg}`,
        );
        recordTrace({
          phase: "search",
          operation: "brightdata_dataset_search",
          status: "failed",
          provider: "brightdata",
          round,
          query: plan.executableQuery,
          metadata: { error: msg },
        });
      }
    }
  };

  const bdSearchMode = brightDataSearchMode as BrightDataSearchMode;
  const canAttemptBD =
    brightDataReady &&
    !brightDataProviderDisabled &&
    brightDataSearchMode !== "off";

  // Wave 1: Tavily plans + Unconditional Bright Data plans
  const tavilyPlans = roundPlans
    .map((plan, index) => ({ plan, index }))
    .filter(({ plan }) =>
      shouldRunTavilyForTask(plan.item, discoveryProviderMode, hasTavilyKey()),
    );

  const unconditionalBdPlans = canAttemptBD
    ? roundPlans
        .map((plan, index) => ({ plan, index }))
        .filter(({ plan }) =>
          shouldRunBrightDataForTask(
            plan.item,
            discoveryProviderMode,
            bdSearchMode,
            {
              brightDataReady: true,
              tavilyResultCount: 999, // large count ensures only unconditional tasks run in Wave 1
            },
          ),
        )
    : [];

  const datasetPlans =
    isBrightDataPro() && canAttemptBD
      ? roundPlans
          .map((plan, index) => ({ plan, index }))
          .filter(({ plan }) => !plan.item.lane || plan.item.lane === "person")
          .slice(0, 1)
      : [];

  // Run Wave 1 (Tavily || Unconditional Bright Data || Bright Data Dataset) concurrently in parallel
  await Promise.all([
    executeTavilyLane(tavilyPlans),
    executeBrightDataLane(unconditionalBdPlans, "Wave 1 parallel"),
    executeBrightDataDatasetLane(datasetPlans),
  ]);

  // Aggregate Tavily items into roundItems
  let tavilyResultCount = 0;
  for (const [resultIndex, result] of tavilyResultsByIndex.entries()) {
    const items = Array.isArray(result.items) ? result.items : [];
    for (const item of items) {
      item.sourceProvider = "tavily";
      roundItems.push({ item, resultIndex });
      tavilyResultCount++;
    }
  }

  // Wave 2: Conditional supplemental Bright Data plans (tasks triggered only if Tavily underdelivers)
  if (canAttemptBD) {
    const executedBdIndices = new Set(unconditionalBdPlans.map((p) => p.index));
    const conditionalBdPlans = roundPlans
      .map((plan, index) => ({ plan, index }))
      .filter(
        ({ plan, index }) =>
          !executedBdIndices.has(index) &&
          shouldRunBrightDataForTask(
            plan.item,
            discoveryProviderMode,
            bdSearchMode,
            {
              brightDataReady: true,
              tavilyResultCount,
            },
          ),
      );

    if (conditionalBdPlans.length > 0) {
      await executeBrightDataLane(conditionalBdPlans, "Wave 2 supplemental");
    }
  }

  return {
    roundItems,
    usingBrightDataSearch,
    brightDataProviderDisabled,
    brightDataTransportRetryAfter,
  };
}
