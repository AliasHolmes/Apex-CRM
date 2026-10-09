/**
 * Boot-time engine configuration sanity checks. Non-fatal: each issue is a
 * console warning so misconfiguration surfaces at startup instead of as
 * mysterious mid-run behavior.
 */
export function validateEngineConfig(): string[] {
  const warnings: string[] = [];
  const num = (name: string): number | undefined => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : NaN;
  };

  const timeoutMs = num("LEAD_SEARCH_TIMEOUT_MS");
  if (timeoutMs === 0) {
    warnings.push(
      "LEAD_SEARCH_TIMEOUT_MS=0 disables the discovery safety timeout; synchronous sessions may run indefinitely.",
    );
  } else if (
    timeoutMs !== undefined &&
    (Number.isNaN(timeoutMs) || timeoutMs < 0)
  ) {
    warnings.push(
      "LEAD_SEARCH_TIMEOUT_MS is not a valid non-negative number; falling back to the 15-minute default.",
    );
  }

  for (const [name, max, customMsg] of [
    ["TAVILY_SEARCH_CONCURRENCY", 8, undefined],
    ["BRIGHTDATA_SEARCH_CONCURRENCY", 8, "BRIGHTDATA_SEARCH_CONCURRENCY exceeds the recommended maximum of 8; the SERP API documents no hard cap for funded accounts, but dynamic per-host auto-throttling (sr_rate_limit) raises 429 risk."],
    ["BRIGHTDATA_PROFILE_CONCURRENCY", 4, "BRIGHTDATA_PROFILE_CONCURRENCY exceeds the recommended maximum of 4; the MCP person-profile tool is single-URL, so higher concurrency mostly raises per-query lockout risk."],
    ["LEAD_EXTRACTION_CONCURRENCY", 8, undefined],
    ["FINALIST_JUDGE_CONCURRENCY", 8, undefined],
    ["LINKEDIN_POST_INTENT_CONCURRENCY", 8, undefined],
    [
      "ATRIA_CONCURRENT_SLOTS",
      10,
      "ATRIA_CONCURRENT_SLOTS exceeds the stress-tested envelope of 8-10; vLLM GPU KV-cache contention may degrade generation speed. See docs/adr/0011-atria-primary-with-byesu-second-priority.md.",
    ],
    [
      "BYESU_CONCURRENT_SLOTS",
      16,
      "BYESU_CONCURRENT_SLOTS exceeds the recommended maximum of 16; the stress test sustained 50+, but under the second-priority policy Byesu serves overflow, fast-tier planning, and Atria outage windows.",
    ],
    ["LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK", 5, "LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK exceeds recommended micro-chunk size of 2-3; large chunks increase latency and timeout risk."],
    ["FINALIST_JUDGE_MICRO_BATCH_SIZE", 5, "FINALIST_JUDGE_MICRO_BATCH_SIZE exceeds recommended micro-batch size of 2-3; large batches diminish rolling pool early-stopping gains."],
  ] as const) {
    const value = num(name);
    if (value !== undefined && !Number.isNaN(value) && value > max) {
      warnings.push(
        customMsg || `${name}=${value} exceeds the recommended maximum of ${max}; provider rate limits may trigger.`,
      );
    }
  }

  const minScore = num("LEAD_SEARCH_MIN_SCORE");
  if (
    minScore !== undefined &&
    !Number.isNaN(minScore) &&
    (minScore < 1 || minScore > 10)
  ) {
    warnings.push(
      `LEAD_SEARCH_MIN_SCORE=${minScore} is outside the valid 1-10 range and will be clamped.`,
    );
  }

  const batchRaw = process.env.BRIGHTDATA_SCRAPE_BATCH_MAX_URLS;
  if (batchRaw !== undefined && batchRaw !== "") {
    const requested = Number(batchRaw);
    if (!Number.isFinite(requested) || requested < 1 || requested > 20) {
      warnings.push(
        `BRIGHTDATA_SCRAPE_BATCH_MAX_URLS="${batchRaw}" will be clamped to the 1-20 range.`,
      );
    }
  }

  if (
    String(process.env.PROVIDER_CREDIT_RESERVATION || "")
      .trim()
      .toLowerCase() === "true" &&
    !process.env.TAVILY_MONTHLY_CREDIT_BUDGET &&
    !process.env.BRIGHTDATA_MONTHLY_REQUEST_BUDGET
  ) {
    warnings.push(
      "PROVIDER_CREDIT_RESERVATION=true but no TAVILY_MONTHLY_CREDIT_BUDGET/BRIGHTDATA_MONTHLY_REQUEST_BUDGET configured; monthly caps are inactive.",
    );
  }

  return warnings;
}
