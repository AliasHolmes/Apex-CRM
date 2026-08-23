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

  for (const [name, max] of [
    ["TAVILY_SEARCH_CONCURRENCY", 8],
    ["BRIGHTDATA_SEARCH_CONCURRENCY", 8],
    ["BRIGHTDATA_PROFILE_CONCURRENCY", 8],
    ["LEAD_EXTRACTION_CONCURRENCY", 4],
    ["FINALIST_JUDGE_CONCURRENCY", 8],
    ["LINKEDIN_POST_INTENT_CONCURRENCY", 8],
  ] as const) {
    const value = num(name);
    if (value !== undefined && !Number.isNaN(value) && value > max) {
      warnings.push(
        `${name}=${value} exceeds the recommended maximum of ${max}; provider rate limits may trigger.`,
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
    !process.env.TAVILY_MONTHLY_LIMIT &&
    !process.env.BRIGHTDATA_MONTHLY_LIMIT
  ) {
    warnings.push(
      "PROVIDER_CREDIT_RESERVATION=true but no TAVILY_MONTHLY_LIMIT/BRIGHTDATA_MONTHLY_LIMIT configured; monthly caps are inactive.",
    );
  }

  return warnings;
}
