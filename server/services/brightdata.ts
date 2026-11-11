import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "path";
import {
  ApiKeyPool,
  parseApiKeys,
  type ApiKeyFailureKind,
  type FailureClassification,
} from "./keyRotator.js";
import { brightDataFreeTierCapabilities } from "../leadSearch/freeTier.js";
import { boundedNumber } from "../leadSearch/sessionHelpers.js";
import { normalizeLinkedInUrl } from "./linkedinEvidence.js";
import { unwrapRedirectUrl } from "../../src/utils/leadDedupe.js";
import { hasTavilyKey, tavilyExtract } from "./llm.js";
import { isPrivateOrInternalHost } from "./privateHosts.js";
import { abortableSleep } from "./sleepUtils.js";
export { isPrivateOrInternalHost, abortableSleep };

type BrightDataTransport = "hosted" | "local";
export type BrightDataReasonCode =
  | "none"
  | "target_transient"
  | "target_blocked"
  | "request_invalid"
  | "transport_transient"
  | "empty_body_transient"
  | "provider_auth"
  | "provider_quota"
  | "provider_rate_limit"
  | "provider_config"
  | "unknown";

export type BrightDataHealth =
  | "unconfigured"
  | "idle"
  | "ready"
  | "degraded"
  | "transport_reconnecting"
  | "provider_disabled";

export class BrightDataError extends Error {
  reasonCode: BrightDataReasonCode;
  retryable: boolean;
  providerDisabled: boolean;
  clearClient: boolean;
  statusCode?: number;
  /** Applied rate limit (requests/min) parsed from the provider message, when present. */
  rateLimitPerMinute?: number;

  constructor(
    message: string,
    options: {
      reasonCode?: BrightDataReasonCode;
      retryable?: boolean;
      providerDisabled?: boolean;
      clearClient?: boolean;
      statusCode?: number;
      rateLimitPerMinute?: number;
    } = {},
  ) {
    super(message);
    this.name = "BrightDataError";
    this.reasonCode = options.reasonCode || "unknown";
    this.retryable = Boolean(options.retryable);
    this.providerDisabled = Boolean(options.providerDisabled);
    this.clearClient = Boolean(options.clearClient);
    this.statusCode = options.statusCode;
    this.rateLimitPerMinute = options.rateLimitPerMinute;
  }
}

let brightDataClient: Client | null = null;
let brightDataInitPromise: Promise<Client | null> | null = null;
let activeTransport: BrightDataTransport | null = null;
let activeApiToken = "";
let activeApiTokenFingerprint = "";
let disabledReason = "";
let disabledUntil = 0;
let clientGeneration = 0;
let inFlight = 0;
let consecutiveFailures = 0;
let lastError = "";
let lastReasonCode: BrightDataReasonCode = "none";
let lastRetryable = false;
let healthOverride: BrightDataHealth | null = null;
let cooldownLogMutedUntil = 0;
let scrapeBatchToolAvailable: boolean | null = null;
let searchToolAvailable: boolean | null = null;
let searchBatchToolAvailable: boolean | null = null;
let runtimeDiscoveredTools: string[] | null = null;

export type BatchToolState = {
  documented: boolean;
  detected: boolean | null;
  runtimeVerified: boolean;
  fallbackMode: "none" | "single_page_parallel";
  partialSuccesses: number;
  partialFailures: number;
};

let batchToolState: BatchToolState = {
  documented: true,
  detected: null,
  runtimeVerified: false,
  fallbackMode: "none",
  partialSuccesses: 0,
  partialFailures: 0,
};

const brightDataKeyPool = new ApiKeyPool("Bright Data", () =>
  parseApiKeys(process.env.BRIGHTDATA_API_TOKEN, [
    process.env.BRIGHTDATA_API_TOKENS,
    process.env.API_TOKEN,
  ]),
);

// --- Local MCP child stderr filtering -------------------------------------
// The local @brightdata/mcp server logs every tool call and error to stderr.
// Transient SERP failures (empty/non-JSON bodies, per-query lockouts) are
// retried or fallen back from inside this service, so their raw child-process
// output is dropped instead of surfacing as scary console errors. Everything
// else (real crashes, zone problems, unhandled HTTP errors) still passes
// through. Set BRIGHTDATA_MCP_STDERR_DEBUG=true to bypass the filter.

export type BrightDataMcpStderrFilterState = {
  suppressingStack: boolean;
  droppedLines: number;
};

const MCP_TRANSIENT_ERROR_PATTERN =
  /\[(?:search_engine|search_engine_batch|scrape_as_markdown|scrape_batch)\] error .*(?:Unexpected non-JSON response from Bright Data|recently failed and cannot be attempted|failed_query_rejected|repeat_query_rejected|the search engine answer was not json|search failed: google search failed)/i;
const MCP_STACK_FRAME_PATTERN = /^\s+at\s/;

const mcpStderrDebugEnabled = () =>
  String(process.env.BRIGHTDATA_MCP_STDERR_DEBUG || "")
    .trim()
    .toLowerCase() === "true";

export const createBrightDataMcpStderrFilter =
  (): BrightDataMcpStderrFilterState => ({
    suppressingStack: false,
    droppedLines: 0,
  });

/** Decide whether one line of the local MCP server's stderr should be forwarded. */
export function filterBrightDataMcpStderrLine(
  state: BrightDataMcpStderrFilterState,
  line: string,
): boolean {
  if (state.suppressingStack) {
    if (MCP_STACK_FRAME_PATTERN.test(line)) {
      state.droppedLines++;
      return false;
    }
    state.suppressingStack = false;
  }
  if (MCP_TRANSIENT_ERROR_PATTERN.test(line)) {
    // Drop the error line and any stack frames that follow it.
    state.suppressingStack = true;
    state.droppedLines++;
    return false;
  }
  return true;
}

const attachFilteredMcpStderr = (stderr: any) => {
  const filterState = createBrightDataMcpStderrFilter();
  let pending = "";
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string) => {
    pending += chunk;
    let newlineIndex: number;
    while ((newlineIndex = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (filterBrightDataMcpStderrLine(filterState, line))
        process.stderr.write(line + "\n");
    }
  });
  stderr.on("end", () => {
    if (pending && filterBrightDataMcpStderrLine(filterState, pending))
      process.stderr.write(pending + "\n");
    if (filterState.droppedLines > 0) {
      console.error(
        `[brightdata:mcp] suppressed ${filterState.droppedLines} handled transient SERP error line(s)`,
      );
    }
  });
  stderr.on("error", (error: any) => {
    console.warn(
      `[brightdata:mcp] stderr stream error:`,
      error instanceof Error ? error.message : String(error),
    );
  });
};


export const baseTimeoutSeconds = () =>
  boundedNumber(
    process.env.BASE_TIMEOUT || process.env.BRIGHTDATA_BASE_TIMEOUT,
    180,
    1,
    600,
  );
export const baseMaxRetries = () =>
  boundedNumber(process.env.BASE_MAX_RETRIES, 2, 0, 3);
export const BRIGHTDATA_SCRAPE_BATCH_MAX_URLS = boundedNumber(
  process.env.BRIGHTDATA_SCRAPE_BATCH_MAX_URLS,
  5,
  1,
  5,
);
const baseTimeoutMs = () => baseTimeoutSeconds() * 1000;
const failureCooldownMs = () =>
  boundedNumber(process.env.BRIGHTDATA_FAILURE_COOLDOWN_MS, 5_000, 1_000, 300_000);

export function normalizeBrightDataUrl(url: string) {
  const value = String(url || "").trim();
  if (!value) {
    throw new BrightDataError("Bright Data URL is empty", {
      reasonCode: "request_invalid",
    });
  }
  try {
    const parsed = new URL(
      value.startsWith("http://") || value.startsWith("https://")
        ? value
        : "https://" + value,
    );
    if (!parsed.hostname || isPrivateOrInternalHost(parsed.hostname)) {
      throw new BrightDataError(
        "Bright Data URL targets private or internal host: " + value,
        { reasonCode: "request_invalid" },
      );
    }
    return parsed.toString();
  } catch (err: any) {
    if (err instanceof BrightDataError) throw err;
    throw new BrightDataError("Bright Data URL is invalid: " + value, {
      reasonCode: "request_invalid",
    });
  }
}

const withHardTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BrightDataError(
                `${label} timed out after ${Math.round(timeoutMs / 1000)}s`,
                {
                  reasonCode: "target_transient",
                  retryable: true,
                },
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const resetToolAvailability = () => {
  scrapeBatchToolAvailable = null;
  searchToolAvailable = null;
  searchBatchToolAvailable = null;
  runtimeDiscoveredTools = null;
  batchToolState = {
    documented: true,
    detected: null,
    runtimeVerified: false,
    fallbackMode: "none",
    partialSuccesses: 0,
    partialFailures: 0,
  };
};

const cooldownMsForFailure = () => {
  const planned =
    consecutiveFailures <= 1
      ? 30_000
      : consecutiveFailures === 2
        ? 60_000
        : 5 * 60_000;
  return Math.max(planned, failureCooldownMs());
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const statusFromMessage = (message: string, error?: unknown) => {
  if (error && typeof error === "object") {
    const rawStatus = (error as any).status ?? (error as any).statusCode ?? (error as any).code;
    if (typeof rawStatus === "number" && rawStatus >= 400 && rawStatus <= 599) {
      return rawStatus;
    }
  }
  const match =
    message.match(/\b(?:HTTP|status|code)\s*:?\s*(\d{3})\b/i) ||
    message.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : undefined;
};

export function classifyBrightDataError(error: unknown): BrightDataError {
  if (error instanceof BrightDataError) return error;
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const statusCode = statusFromMessage(message, error);

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthorized|forbidden|invalid token|api[_ -]?token|cannot run mcp server without api_token|sign-in failed/.test(
      lower,
    )
  ) {
    return new BrightDataError(message, {
      reasonCode: "provider_auth",
      providerDisabled: true,
      statusCode,
    });
  }
  if (/quota|credit|usage limit|limit exceeded|billing|payment/.test(lower)) {
    return new BrightDataError(message, {
      reasonCode: "provider_quota",
      providerDisabled: true,
      statusCode,
    });
  }
  if (
    /tool .*unavailable|missing tool|invalid configuration|missing config|zone .*not found|required zone|not configured/.test(
      lower,
    )
  ) {
    return new BrightDataError(message, {
      reasonCode: "provider_config",
      providerDisabled: true,
      statusCode,
    });
  }
  if (
    statusCode === 400 ||
    /mcp error -32602|parameter validation failed|request validation failed|must be a valid uri|string\.uri|array must contain at most|invalid argument|was renamed to|unknown argument|scraper input rejected|unrecognized_keys/.test(
      lower,
    )
  ) {
    return new BrightDataError(message, {
      reasonCode: "request_invalid",
      statusCode,
    });
  }
  if (
    /connection closed|sse stream disconnected|stdio|process exited|terminated|econnreset|socket hang up|mcp error -32000|getaddrinfo|enotfound|econnrefused|ehostunreach|enetunreach|network|dns/.test(
      lower,
    )
  ) {
    return new BrightDataError(message, {
      reasonCode: "transport_transient",
      retryable: true,
      clearClient: true,
      statusCode,
    });
  }
  // Official BD docs: "verifying" (challenge page, HTTP 502) and "failed_query_rejected" / "repeat_query_rejected"
  // (HTTP 429) both require a minimum 15-second wait before retrying the same query.
  // Since a 15s per-query delay is unacceptable in the mining pipeline, we classify all of these
  // as non-retryable. The caller's Tavily fallback fires immediately instead of wasting a retry
  // that is guaranteed to lockout (confirmed: any retry < 15s hits failed_query_rejected).
  if (
    /minimum of \d+\s*seconds?|recently failed and cannot be attempted|cannot be attempted at this time|repeat.{0,20}rejected|failed.{0,20}rejected/.test(
      lower,
    )
  ) {
    return new BrightDataError(message, {
      reasonCode: "target_transient",
      retryable: false,
      statusCode,
    });
  }
  // Non-JSON SERP response = BD returned a challenge/verification page (HTTP 502 "verifying").
  // Per BD docs: wait >=15s before retrying the same query. Mark non-retryable -> Tavily fallback.
  if (
    /unexpected non-json response from bright data|search failed: google search failed|the search engine answer was not json|engine error|search failed/.test(
      lower,
    )
  ) {
    return new BrightDataError(message, {
      reasonCode: "target_transient",
      retryable: false,
      statusCode,
    });
  }
  if (
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    /timed out|request timed out|fetch failed|empty response|empty body|returned no content/.test(
      lower,
    )
  ) {
    return new BrightDataError(message, {
      reasonCode: "target_transient",
      retryable: true,
      statusCode,
    });
  }
  if (
    /captcha|login wall|blocked|privacy checkpoint|sign in to view|authwall/.test(
      lower,
    )
  ) {
    return new BrightDataError(message, {
      reasonCode: "target_blocked",
      statusCode,
    });
  }
  if (
    statusCode === 429 ||
    /too many requests|rate limit|rate_limit|your system is sending too many|sending too many of this type|contact your account manager|exceeded the allowed rate limits|reduce requests rate|site rate limited|call limit reached|rate_limit is/.test(
      lower,
    )
  ) {
    // Official BD docs (bucket_rate_limit / account-level 429): the response names the
    // applied limit ("decrease your request rate to <N>/min") and, when throttled
    // per-host (sr_rate_limit), that limit is dynamic. Retrying immediately always fails;
    // the only remedy is backing off for the stated period, which the provider-level
    // cooldown in markProviderFailure provides.
    return new BrightDataError(message, {
      reasonCode: "provider_rate_limit",
      retryable: false,
      statusCode: statusCode || 429,
      rateLimitPerMinute: parseRateLimitPerMinute(message),
    });
  }
  return new BrightDataError(message, { reasonCode: "unknown", statusCode });
}

/**
 * Extracts the applied limit from a rate-limit message, e.g. "decrease your request rate
 * to 120/min" -> 120. Returns undefined when the message carries no numeric limit.
 */
function parseRateLimitPerMinute(message: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)\s*(?:\/|per\s*)\s*(?:min|minute)/i.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export const isBrightDataRetryableError = (error: unknown) =>
  classifyBrightDataError(error).retryable;

export type BrightDataSearchRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  jitterMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  onRetry?: (context: {
    error: BrightDataError;
    attempt: number;
    nextAttempt: number;
    delayMs: number;
  }) => void | Promise<void>;
};

export async function executeBrightDataSearchWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: BrightDataSearchRetryOptions = {},
): Promise<T> {
  const maxRetries = Math.min(
    Math.max(Math.floor(Number(options.maxRetries ?? 1)) || 0, 0),
    2,
  );
  const baseDelayMs = Math.min(
    Math.max(Math.floor(Number(options.baseDelayMs ?? 750)) || 0, 0),
    10_000,
  );
  const jitterMs = Math.min(
    Math.max(Math.floor(Number(options.jitterMs ?? 250)) || 0, 0),
    2_000,
  );
  const sleep =
    options.sleep ||
    ((delayMs: number) => abortableSleep(delayMs, options.signal));
  const random = options.random || Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const classified = classifyBrightDataError(error);
      if (!classified.retryable || attempt > maxRetries) throw classified;

      const retryBaseDelayMs =
        classified.reasonCode === "transport_transient"
          ? Math.max(baseDelayMs, 5_000)
          : baseDelayMs;
      const delayMs =
        retryBaseDelayMs * 2 ** (attempt - 1) +
        Math.floor(random() * (jitterMs + 1));
      await options.onRetry?.({
        error: classified,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs);
    }
  }
}

const EMPTY_BODY_SERP_PATTERN =
  /unexpected non-json response from bright data/i;

/**
 * True when Bright Data answered HTTP 200 but the SERP body was empty or
 * unparseable with no challenge snippet. The vendored @brightdata/mcp server
 * only retries thrown HTTP/network errors (base_request), so an empty 200 body
 * reaches us as "Unexpected non-JSON response..." with no "Response snippet".
 * That is a momentary provider-side hiccup, safe to retry once after a short
 * pause -- unlike challenge/lockout responses, which carry a snippet and
 * enforce a >=15s per-query lockout.
 */
export function isEmptyBodySerpTransientError(error: unknown): boolean {
  const classified = classifyBrightDataError(error);
  return (
    (classified.reasonCode === "target_transient" ||
      classified.reasonCode === "empty_body_transient") &&
    EMPTY_BODY_SERP_PATTERN.test(classified.message) &&
    !/response snippet/i.test(classified.message)
  );
}

export type BrightDataEmptyBodyRetryOptions = {
  maxRetries?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (context: {
    error: BrightDataError;
    attempt: number;
  }) => void | Promise<void>;
};

/**
 * Recovers the empty-200 SERP transient inside the service layer so every
 * consumer (discovery rounds, Phase 5 post intent, company intent) self-heals
 * instead of surfacing a raw non-JSON tool error. Challenge/lockout variants
 * are deliberately not retried here; their fast Tavily fallback stays intact.
 */
export async function executeBrightDataSearchWithEmptyBodyRecovery<T>(
  operation: () => Promise<T>,
  options: BrightDataEmptyBodyRetryOptions = {},
): Promise<T> {
  const envMax = Number(process.env.BRIGHTDATA_SEARCH_EMPTY_BODY_RETRIES);
  const envDelay = Number(
    process.env.BRIGHTDATA_SEARCH_EMPTY_BODY_RETRY_DELAY_MS,
  );
  const maxRetries = Math.min(
    Math.max(
      Math.floor(
        Number(options.maxRetries ?? (Number.isFinite(envMax) ? envMax : 1)),
      ),
      0,
    ),
    2,
  );
  const delayMs = Math.min(
    Math.max(
      Math.floor(
        Number(
          options.delayMs ?? (Number.isFinite(envDelay) ? envDelay : 1_500),
        ),
      ),
      0,
    ),
    15_000,
  );
  const sleep =
    options.sleep ||
    ((ms: number) => abortableSleep(ms, options.signal));

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isEmptyBodySerpTransientError(error))
        throw error;
      await options.onRetry?.({
        error: classifyBrightDataError(error),
        attempt: attempt + 1,
      });
      await sleep(delayMs);
    }
  }
}

const keyFailureKindForBrightData = (
  classified: BrightDataError,
): ApiKeyFailureKind => {
  if (
    classified.reasonCode === "provider_auth" ||
    classified.reasonCode === "provider_quota"
  )
    return "exhausted";
  if (
    classified.reasonCode === "request_invalid" ||
    classified.reasonCode === "provider_config"
  )
    return "request_invalid";
  if (classified.reasonCode === "transport_transient") return "transient";
  return "unknown";
};

const markActiveTokenFailure = (classified: BrightDataError) => {
  if (!activeApiToken) return;
  const kind = keyFailureKindForBrightData(classified);
  if (kind === "request_invalid" || kind === "unknown") return;
  const failure: FailureClassification = {
    kind,
    statusCode: classified.statusCode,
    cooldownMs: kind === "transient" ? 15_000 : undefined,
    message: classified.message,
  };
  brightDataKeyPool.markFailure(activeApiToken, failure);
};

const closeClientQuietly = async (client: Client | null) => {
  if (!client) return;
  try {
    await client.close();
  } catch {
    // The transport may already be closed after an MCP/SSE failure.
  }
};

const clearCurrentClient = (client?: Client | null) => {
  if (client && brightDataClient && brightDataClient !== client) return false;
  const clientToClose = client || brightDataClient;
  if (clientToClose && brightDataClient === clientToClose) {
    brightDataClient = null;
    activeTransport = null;
    activeApiToken = "";
    activeApiTokenFingerprint = "";
  }
  brightDataInitPromise = null;
  clientGeneration++;
  resetToolAvailability();
  void closeClientQuietly(clientToClose);
  return true;
};

const markProviderFailure = (
  label: string,
  message: string,
  client?: Client | null,
  classified = classifyBrightDataError(message),
) => {
  consecutiveFailures++;
  lastError = message;
  lastReasonCode = classified.reasonCode;
  lastRetryable = classified.retryable;
  disabledReason = `${label}: ${message}`;
  disabledUntil = Date.now() + cooldownMsForFailure();
  healthOverride = classified.providerDisabled
    ? "provider_disabled"
    : "transport_reconnecting";
  markActiveTokenFailure(classified);
  if (classified.clearClient || classified.providerDisabled) {
    resetToolAvailability();
    clearCurrentClient(client);
  }

  if (Date.now() >= cooldownLogMutedUntil) {
    const seconds = Math.max(1, Math.ceil((disabledUntil - Date.now()) / 1000));
    const limitHint =
      classified.reasonCode === "provider_rate_limit" && classified.rateLimitPerMinute
        ? ` (applied limit: ${classified.rateLimitPerMinute} req/min - back off, immediate retries always fail)`
        : "";
    console.warn(
      `[brightdata] ${label} failed; cooling down for ${seconds}s: ${message}${limitHint}`,
    );
    cooldownLogMutedUntil = disabledUntil;
  }
};

export const markToolFailure = (
  message: string,
  classified = classifyBrightDataError(message),
) => {
  lastError = message;
  lastReasonCode = classified.reasonCode;
  lastRetryable = classified.retryable;
  if (classified.reasonCode === "provider_rate_limit") {
    const cooldownMs = classified.rateLimitPerMinute
      ? Math.max(15_000, Math.ceil(60_000 / classified.rateLimitPerMinute))
      : cooldownMsForFailure();
    disabledUntil = Math.max(disabledUntil, Date.now() + cooldownMs);
    disabledReason = `rate_limited: ${message}`;
    healthOverride = "degraded";
    markActiveTokenFailure(classified);
    console.warn(`[brightdata] Rate limited; cooling down for ${Math.round(cooldownMs / 1000)}s: ${message}`);
  } else if (classified.retryable) {
    healthOverride = "degraded";
  }
};

const markProviderSuccess = () => {
  consecutiveFailures = 0;
  lastError = "";
  lastReasonCode = "none";
  lastRetryable = false;
  disabledReason = "";
  disabledUntil = 0;
  healthOverride = null;
  if (activeApiToken) brightDataKeyPool.markSuccess(activeApiToken);
};

export function isBrightDataConfigured() {
  return brightDataKeyPool.hasConfiguredKeys();
}

/**
 * Bright Data's Rapid/free MCP surface deliberately exposes only public web
 * search and single-page Markdown scraping.  Default to that safer surface
 * unless a deployment has explicitly opted into a Pro account.
 */
export function isBrightDataFreeTier() {
  return (process.env.BRIGHTDATA_PLAN || "free").trim().toLowerCase() !== "pro";
}

export function isBrightDataPro() {
  return !isBrightDataFreeTier() && isBrightDataConfigured();
}

export const BRIGHTDATA_PRO_SUPPORTED_TOOLS: string[] = [
  // Search & Scraping
  "search_engine",
  "search_engine_batch",
  "scrape_as_markdown",
  "scrape_batch",
  "ask_brightdata_assistant",
  "session_stats",
  // Scraper Discovery & Execution
  "search_scrapers",
  "get_scraper_details",
  "run_scraper",
  "get_scraper_progress",
  "get_scraper_results",
  "refresh_scrapers",
  // Searchable Datasets
  "search_dataset",
  "list_dataset_fields",
  // AI Insights
  "chatgpt_ai_insights",
  "perplexity_ai_insights",
  // Scraping Browser Automation (all 14 tools)
  "scraping_browser_navigate",
  "scraping_browser_go_back",
  "scraping_browser_go_forward",
  "scraping_browser_snapshot",
  "scraping_browser_click_ref",
  "scraping_browser_type_ref",
  "scraping_browser_screenshot",
  "scraping_browser_network_requests",
  "scraping_browser_wait_for_ref",
  "scraping_browser_fill_form",
  "scraping_browser_get_text",
  "scraping_browser_get_html",
  "scraping_browser_scroll",
  "scraping_browser_scroll_to_ref",
];

export function getBrightDataCapabilities() {
  const free = isBrightDataFreeTier();
  const proStaticTools = BRIGHTDATA_PRO_SUPPORTED_TOOLS;
  const activeDiscovered = runtimeDiscoveredTools ? [...runtimeDiscoveredTools] : undefined;
  const effectiveTools = free
    ? brightDataFreeTierCapabilities().supported
    : (activeDiscovered && activeDiscovered.length > 0)
      ? activeDiscovered
      : proStaticTools;

  const unavailableTools = free
    ? []
    : (activeDiscovered && activeDiscovered.length > 0)
      ? proStaticTools.filter((t) => !activeDiscovered.includes(t))
      : [];

  return {
    ...(free
      ? brightDataFreeTierCapabilities()
      : {
          provider: "brightdata" as const,
          plan: "pro" as const,
          monthlyUnitLimit:
            Number(process.env.BRIGHTDATA_MONTHLY_REQUEST_BUDGET) || undefined,
          supportedTools: effectiveTools,
          unavailableTools,
        }),
    discoveredTools: activeDiscovered,
    configured: isBrightDataConfigured(),
    rapidModeOnly: free,
  };
}

export async function discoverBrightDataCapabilities(): Promise<ReturnType<typeof getBrightDataCapabilities>> {
  if (isBrightDataConfigured() && !isBrightDataCoolingDown()) {
    try {
      const client = await getBrightDataClient();
      if (client) {
        const toolsResult = await client.listTools();
        if (toolsResult?.tools) {
          runtimeDiscoveredTools = toolsResult.tools.map((t) => t.name);
        }
      }
    } catch {
      // Best-effort runtime discovery
    }
  }
  return getBrightDataCapabilities();
}

export function isBrightDataCoolingDown() {
  return Boolean(disabledUntil && Date.now() < disabledUntil);
}

export function shouldAttemptBrightData() {
  return (
    isBrightDataConfigured() &&
    brightDataKeyPool.hasAvailableKey() &&
    !isBrightDataCoolingDown()
  );
}

/**
 * Proactive recovery probe: after a cooldown expires, fire one minimal search
 * to discover provider recovery instead of waiting for the next real task to
 * fail again. Never throws; returns true only when the probe succeeded and
 * health was restored. Respects cooldown (returns false without probing).
 */
export async function probeBrightDataRecovery(): Promise<boolean> {
  if (!isBrightDataConfigured()) return false;
  if (isBrightDataCoolingDown()) return false;
  if (!brightDataKeyPool.hasAvailableKey()) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("probe timeout")), 10_000);
  });
  try {
    const results = await Promise.race([
      brightDataSearch("brightdata recovery probe", { timeoutMs: 8_000 }),
      timeoutPromise,
    ]);
    if (Array.isArray(results) && results.length > 0) {
      markProviderSuccess();
      return true;
    }
    return false;
  } catch {
    // Probe failure keeps current degraded state; next cooldown applies.
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getBrightDataStatus() {
  const cooldownMsRemaining = Math.max(0, disabledUntil - Date.now());
  const configured = isBrightDataConfigured();
  const keyPool = brightDataKeyPool.getStatus();
  const hasAvailableKey = brightDataKeyPool.hasAvailableKey();
  const coolingDown = isBrightDataCoolingDown();
  const clientHot = Boolean(brightDataClient);
  const health: BrightDataHealth = !configured
    ? "unconfigured"
    : !hasAvailableKey
      ? "provider_disabled"
      : coolingDown && healthOverride === "provider_disabled"
        ? "provider_disabled"
        : coolingDown
          ? "transport_reconnecting"
          : healthOverride === "degraded"
            ? "degraded"
            : clientHot
              ? "ready"
              : "idle";
  return {
    configured,
    ready: clientHot && !coolingDown && hasAvailableKey,
    health,
    transport: activeTransport,
    activeTokenFingerprint: activeApiTokenFingerprint,
    keyPool,
    disabledReason: disabledReason ? disabledReason.slice(0, 300) : "",
    disabledUntil,
    cooldownMsRemaining,
    inFlight,
    consecutiveFailures,
    lastError: lastError ? lastError.slice(0, 300) : "",
    lastReasonCode,
    retryable: lastRetryable,
    baseTimeoutSeconds: baseTimeoutSeconds(),
    baseMaxRetries: baseMaxRetries(),
    clientHot,
    batchTool: { ...batchToolState },
  };
}

export function getTraceBrightDataStatus() {
  const status = getBrightDataStatus();
  return { ...status, transport: status.transport || undefined };
}

async function connectHostedClient(apiToken: string, generation: number) {
  const client = new Client({ name: "apex-crm-brightdata", version: "1.0.0" });
  const url = new URL("https://mcp.brightdata.com/mcp");
  url.searchParams.set("token", apiToken);
  const transport = new StreamableHTTPClientTransport(url);
  transport.onerror = (error) => {
    if (generation !== clientGeneration || brightDataClient !== client) {
      void closeClientQuietly(client);
      return;
    }
    markProviderFailure(
      "hosted transport",
      error.message,
      client,
      new BrightDataError(error.message, {
        reasonCode: "transport_transient",
        retryable: true,
        clearClient: true,
      }),
    );
  };
  try {
    await withHardTimeout(
      client.connect(transport, { timeout: baseTimeoutMs() }),
      baseTimeoutMs(),
      "Bright Data hosted MCP connect",
    );
    return client;
  } catch (err) {
    void closeClientQuietly(client);
    try {
      await (transport as any).close?.();
    } catch {}
    throw err;
  }
}

async function connectLocalClient(apiToken: string, generation: number) {
  const client = new Client({ name: "apex-crm-brightdata", version: "1.0.0" });
  const serverPath = path.join(
    process.cwd(),
    "node_modules",
    "@brightdata",
    "mcp",
    "server.js",
  );
  const timeoutSeconds = String(baseTimeoutSeconds());
  const maxRetries = String(baseMaxRetries());
  const safeEnv = { ...process.env };
  delete (safeEnv as any)["PRO_MODE"];
  delete (safeEnv as any)["POLLING_TIMEOUT"];

  // MCP safety, server-control, and rate-limit configuration:
  // - CONTENT_GATE: Defaults to "off" in Apex CRM for unattended background mining.
  //   @brightdata/mcp defaults CONTENT_GATE to "on" to prompt for human approval via MCP
  //   elicitation when web content resembles instructions to alter MCP configs. In non-interactive
  //   services, leaving it on causes the server to wait for CONTENT_GATE_TIMEOUT (default 120s)
  //   and silently withhold web data with a refusal. We turn it off for unattended operations,
  //   relying on cryptographic untrusted nonce unwrapping and isolated prompt parsing for safety.
  // - RATE_LIMIT: Enforces MCP server-level rate limits (e.g. "100/1h", "50/30m", "10/1s").
  // - CONTENT_GATE_TIMEOUT: Timeout in seconds for interactive user approval if CONTENT_GATE is on.
  // - BROWSER_FILTERED_SNAPSHOT: If "on", omits free page text from ARIA snapshots, saving tokens.
  // - GROUPS / TOOLS: Allowlist specific tool groups or tools when configured.
  const contentGate =
    process.env.BRIGHTDATA_CONTENT_GATE || process.env.CONTENT_GATE || "off";
  const rateLimit =
    process.env.BRIGHTDATA_RATE_LIMIT || process.env.RATE_LIMIT;
  const contentGateTimeout =
    process.env.BRIGHTDATA_CONTENT_GATE_TIMEOUT || process.env.CONTENT_GATE_TIMEOUT;
  const contentGateProgressMs =
    process.env.BRIGHTDATA_CONTENT_GATE_PROGRESS_MS || process.env.CONTENT_GATE_PROGRESS_MS;
  const browserFilteredSnapshot =
    process.env.BRIGHTDATA_BROWSER_FILTERED_SNAPSHOT || process.env.BROWSER_FILTERED_SNAPSHOT;
  const configuredGroups =
    process.env.BRIGHTDATA_GROUPS || process.env.GROUPS;
  const configuredTools =
    process.env.BRIGHTDATA_TOOLS || process.env.TOOLS;

  if (!configuredGroups) delete (safeEnv as any)["GROUPS"];
  if (!configuredTools) delete (safeEnv as any)["TOOLS"];

  const envOverrides: Record<string, string> = {
    API_TOKEN: apiToken,
    BRIGHTDATA_API_TOKEN: apiToken,
    BASE_TIMEOUT: timeoutSeconds,
    BRIGHTDATA_BASE_TIMEOUT: timeoutSeconds,
    BASE_MAX_RETRIES: maxRetries,
    CONTENT_GATE: contentGate,
    SERP_ZONE: process.env.BRIGHTDATA_SERP_ZONE || "mcp_serp",
    BROWSER_ZONE: process.env.BRIGHTDATA_BROWSER_ZONE || "mcp_browser",
    ...(rateLimit ? { RATE_LIMIT: rateLimit } : {}),
    ...(contentGateTimeout ? { CONTENT_GATE_TIMEOUT: contentGateTimeout } : {}),
    ...(contentGateProgressMs ? { CONTENT_GATE_PROGRESS_MS: contentGateProgressMs } : {}),
    ...(browserFilteredSnapshot ? { BROWSER_FILTERED_SNAPSHOT: browserFilteredSnapshot } : {}),
    ...(configuredGroups ? { GROUPS: configuredGroups } : {}),
    ...(configuredTools ? { TOOLS: configuredTools } : {}),
  };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...safeEnv,
      ...envOverrides,
    } as Record<string, string>,
    stderr: mcpStderrDebugEnabled() ? "inherit" : "pipe",
    cwd: process.cwd(),
  });

  if (transport.stderr) {
    attachFilteredMcpStderr(transport.stderr);
  }

  transport.onerror = (error) => {
    if (generation !== clientGeneration || brightDataClient !== client) {
      void closeClientQuietly(client);
      return;
    }
    markProviderFailure(
      "local transport",
      error.message,
      client,
      new BrightDataError(error.message, {
        reasonCode: "transport_transient",
        retryable: true,
        clearClient: true,
      }),
    );
  };

  try {
    await withHardTimeout(
      client.connect(transport, { timeout: baseTimeoutMs() }),
      baseTimeoutMs(),
      "Bright Data local MCP connect",
    );
    return client;
  } catch (err) {
    void closeClientQuietly(client);
    try {
      await (transport as any).close?.();
    } catch {}
    throw err;
  }
}

async function initBrightDataClient() {
  if (!isBrightDataConfigured()) {
    disabledReason =
      "BRIGHTDATA_API_TOKEN or BRIGHTDATA_API_TOKENS is not configured";
    healthOverride = "unconfigured";
    return null;
  }
  if (isBrightDataCoolingDown()) return null;

  const defaultMode = !isBrightDataFreeTier() ? "local" : "hosted";
  const mode = (process.env.BRIGHTDATA_MCP_TRANSPORT || defaultMode).toLowerCase();
  const attempts: BrightDataTransport[] =
    mode === "local"
      ? ["local"]
      : mode === "auto"
        ? ["hosted", "local"]
        : ["hosted"];

  let lastError: unknown;
  const attemptedTokens = new Set<string>();
  while (attemptedTokens.size < brightDataKeyPool.getStatus().total) {
    const selected = brightDataKeyPool.nextKey(attemptedTokens);
    attemptedTokens.add(selected.key);
    let tokenTransientFailure: BrightDataError | null = null;

    for (const attempt of attempts) {
      const generation = ++clientGeneration;
      try {
        const client =
          attempt === "hosted"
            ? await connectHostedClient(selected.key, generation)
            : await connectLocalClient(selected.key, generation);
        if (generation !== clientGeneration) {
          await closeClientQuietly(client);
          return brightDataClient;
        }
        brightDataClient = client;
        activeTransport = attempt;
        activeApiToken = selected.key;
        activeApiTokenFingerprint = selected.fingerprint;
        markProviderSuccess();
        return client;
      } catch (error) {
        lastError = error;
        const classified = classifyBrightDataError(error);
        disabledReason = classified.message;
        lastError = classified.message;
        lastReasonCode = classified.reasonCode;
        lastRetryable = classified.retryable;
        resetToolAvailability();
        console.warn(
          `[brightdata] ${attempt} transport unavailable for ${selected.label}:`,
          disabledReason,
        );

        if (
          classified.reasonCode === "provider_auth" ||
          classified.reasonCode === "provider_quota"
        ) {
          brightDataKeyPool.markFailure(selected.key, {
            kind: "exhausted",
            statusCode: classified.statusCode,
            message: classified.message,
          });
          tokenTransientFailure = null;
          break;
        }

        if (classified.reasonCode === "transport_transient") {
          tokenTransientFailure = classified;
        }
      }
    }

    if (tokenTransientFailure) {
      brightDataKeyPool.markFailure(selected.key, {
        kind: "transient",
        statusCode: tokenTransientFailure.statusCode,
        cooldownMs: 15_000,
        message: tokenTransientFailure.message,
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || "Bright Data initialization failed"));
}

export async function getBrightDataClient() {
  if (brightDataClient && !isBrightDataCoolingDown()) return brightDataClient;
  if (isBrightDataCoolingDown()) return null;
  if (!brightDataInitPromise) {
    brightDataInitPromise = initBrightDataClient()
      .catch((error) => {
        const classified = classifyBrightDataError(error);
        markProviderFailure(
          "initialization",
          classified.message,
          undefined,
          classified,
        );
        return null;
      })
      .finally(() => {
        brightDataInitPromise = null;
      });
  }
  return brightDataInitPromise;
}

export async function closeBrightDataClient(options?: {
  onlyIfIdle?: boolean;
  onlyIfUnhealthy?: boolean;
  reason?: string;
}) {
  if (options?.onlyIfIdle && inFlight > 0) return false;
  if (options?.onlyIfUnhealthy && !isBrightDataCoolingDown() && !disabledReason)
    return false;
  const client = brightDataClient;
  clearCurrentClient(client);
  if (!client) return false;
  if (!options?.onlyIfUnhealthy) {
    disabledReason = options?.reason || "";
    disabledUntil = 0;
    healthOverride = null;
  }
  return true;
}

async function withBrightDataClient<T>(
  label: string,
  operation: (client: Client) => Promise<T>,
  options?: { throwOnUnavailable?: boolean; throwOnFailure?: boolean },
): Promise<T | null> {
  const client = await getBrightDataClient();
  if (!client) {
    if (options?.throwOnUnavailable) {
      throw new BrightDataError(
        disabledReason || "Bright Data MCP unavailable",
        classifyBrightDataError(
          disabledReason || "Bright Data MCP unavailable",
        ),
      );
    }
    return null;
  }

  inFlight++;
  try {
    const result = await operation(client);
    markProviderSuccess();
    return result;
  } catch (error) {
    const classified = classifyBrightDataError(error);
    if (classified.providerDisabled || classified.clearClient) {
      markProviderFailure(label, classified.message, client, classified);
    } else {
      markToolFailure(classified.message, classified);
    }
    if (options?.throwOnFailure) throw classified;
    return null;
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

/**
 * Unwraps Bright Data v4.6.0 cryptographic untrusted content nonces:
 * SECURITY NOTICE: ...
 * =====UNTRUSTED_<nonce>_BEGIN=====
 * <actual content>
 * =====UNTRUSTED_<nonce>_END=====
 */
export function unwrapBrightDataUntrustedContent(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  const match = raw.match(
    /=====UNTRUSTED_([A-Za-z0-9+/=_-]+)_BEGIN=====\r?\n([\s\S]*?)\r?\n?=====UNTRUSTED_\1_END=====/
  );
  if (match && match[2] !== undefined) {
    return match[2].trim();
  }
  return raw.trim();
}

const textFromToolResult = (result: any) => {
  let text = "";
  if (typeof result?.structuredContent?.markdown === "string")
    text = result.structuredContent.markdown;
  else if (typeof result?.structuredContent?.text === "string")
    text = result.structuredContent.text;
  else if (typeof result?.toolResult === "string")
    text = result.toolResult;
  else if (Array.isArray(result?.content)) {
    text = result.content
      .map((part: any) => {
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.resource?.text === "string") return part.resource.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return unwrapBrightDataUntrustedContent(text);
};

const AUTHWALLED_HOST_PATTERN =
  /(?:(?:[a-z0-9-]+\.)?linkedin\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|tiktok\.com)/i;

export function isAuthwalledUrl(url: string): boolean {
  if (!url) return true;
  return AUTHWALLED_HOST_PATTERN.test(url);
}


async function nativeHttpScrape(
  scrapeUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    if (signal?.aborted) return null;
    let currentUrl = scrapeUrl;
    let redirectCount = 0;
    const maxRedirects = 3;
    const deadlineSignal = AbortSignal.timeout(Math.min(timeoutMs, 12000));
    // Honour caller cancellation alongside the internal deadline, so a cancelled session
    // stops mid-fetch instead of completing paid work nobody will read.
    const fetchSignal = signal
      ? AbortSignal.any([deadlineSignal, signal])
      : deadlineSignal;

    while (redirectCount <= maxRedirects) {
      const parsed = new URL(currentUrl);
      const host = parsed.hostname.toLowerCase().replace(/^www\./i, "");
      if (!host || isPrivateOrInternalHost(host)) {
        return null;
      }
      const response = await fetch(currentUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "manual",
        signal: fetchSignal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return null;
        }
        const nextUrl = new URL(location, currentUrl).toString();
        const nextHost = new URL(nextUrl).hostname
          .toLowerCase()
          .replace(/^www\./i, "");
        if (!nextHost || isPrivateOrInternalHost(nextHost)) {
          return null;
        }
        currentUrl = nextUrl;
        redirectCount++;
        continue;
      }

      if (response.ok) {
        const html = await response.text();
        const jsonLdMatches = Array.from(
          html.matchAll(
            /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
          ),
        )
          .map((m) => m[1].trim())
          .filter(Boolean);
        const metaDesc =
          html.match(
            /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i,
          )?.[1] || "";
        const ogTitle =
          html.match(
            /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i,
          )?.[1] || "";

        const textContent = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
          .replace(/<h[1-6]\b[^>]*>/gi, "\n\n### ")
          .replace(/<\/h[1-6]>/gi, "\n")
          .replace(/<p\b[^>]*>/gi, "\n\n")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/\s+/g, " ")
          .trim();

        const parts = [
          ogTitle ? `# ${ogTitle}` : "",
          metaDesc ? `> ${metaDesc}` : "",
          textContent,
          ...jsonLdMatches.map((j) => `\`\`\`json\n${j}\n\`\`\``),
        ].filter(Boolean);
        const result = parts.join("\n\n");
        if (result.length > 50) return result;
      }
      break;
    }
  } catch {
    // Fallback fetch failed
  }
  return null;
}

async function tavilyExtractFallback(scrapeUrl: string): Promise<string | null> {
  try {
    if (!hasTavilyKey()) return null;
    const extractResults = await tavilyExtract([scrapeUrl], "", {
      extractDepth: "basic",
    });
    const content = extractResults[0]?.rawContent || "";
    if (content.trim().length > 50) {
      return content.trim();
    }
  } catch {
    // Tavily extract fallback failed
  }
  return null;
}

export async function scrapeAsMarkdown(
  url: string,
  timeoutMs = baseTimeoutMs(),
  signal?: AbortSignal,
  format: "markdown" | "html" | "ld_json" | "text" = "markdown",
) {
  const scrapeUrl = normalizeBrightDataUrl(url);
  if (!scrapeUrl) {
    return null;
  }
  // Cancellation is honoured at every await boundary, otherwise a cancelled session keeps
  // spending Bright Data credits on scrapes whose results will be discarded.
  if (signal?.aborted) return null;

  const isAuthwalled = isAuthwalledUrl(scrapeUrl);
  if (isAuthwalled) {
    // Authwalled domains (LinkedIn, X, Facebook, Instagram, TikTok) cannot be scraped via markdown scrapers.
    // Return null immediately without calling Bright Data, native fetch, or Tavily extract.
    return null;
  }

  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) {
    const nativeResult = await nativeHttpScrape(scrapeUrl, timeoutMs, signal);
    if (signal?.aborted) return null;
    if (nativeResult) return nativeResult;
    return await tavilyExtractFallback(scrapeUrl);
  }

  try {
    const result = await withBrightDataClient(
      "scrape_as_markdown",
      async (client) => {
        const toolResult = await withHardTimeout(
          client.callTool(
            { name: "scrape_as_markdown", arguments: { url: scrapeUrl, format } },
            undefined,
            { timeout: timeoutMs },
          ),
          timeoutMs,
          "Bright Data scrape_as_markdown",
        );

        if ((toolResult as any)?.isError) {
          throw new Error(
            textFromToolResult(toolResult) ||
              "Bright Data scrape_as_markdown returned an error",
          );
        }

        const rawText = textFromToolResult(toolResult);
        if (!rawText || !rawText.trim()) {
          throw new BrightDataError(
            "Bright Data scrape_as_markdown returned empty body",
            {
              reasonCode: "target_transient",
              retryable: true,
            },
          );
        }

        let content = rawText;
        try {
          const parsed = JSON.parse(rawText);
          if (parsed && typeof parsed.content === "string") {
            content = parsed.content;
          } else if (parsed && typeof parsed.content === "object" && parsed.content !== null) {
            content = JSON.stringify(parsed.content);
          }
        } catch {}
        return content;
      },
      { throwOnUnavailable: true, throwOnFailure: true },
    );

    if (result && result.trim()) {
      return result;
    }
  } catch (error) {
    console.warn(
      `[brightdata] scrape_as_markdown failed for ${scrapeUrl}: ${error instanceof Error ? error.message : String(error)}. Attempting native/tavily fallback...`,
    );
  }

  // If Bright Data timed out or returned empty body for non-authwalled URL, fall back to native fetch then Tavily
  if (!isAuthwalled) {
    if (signal?.aborted) return null;
    const nativeResult = await nativeHttpScrape(scrapeUrl, timeoutMs, signal);
    if (nativeResult && nativeResult.trim().length > 50) {
      return nativeResult;
    }
    if (signal?.aborted) return null;
    const tavilyResult = await tavilyExtractFallback(scrapeUrl);
    if (tavilyResult && tavilyResult.trim().length > 50) {
      return tavilyResult;
    }
  }

  return null;
}

export interface DatasetFilterLeaf {
  name: string;
  operator: string;
  value: string | number | boolean | Array<string | number | boolean>;
}

export interface DatasetFilterGroup {
  operator: "and" | "or";
  filters: Array<DatasetFilterGroup | DatasetFilterLeaf>;
}

export type DatasetFilter = DatasetFilterGroup | DatasetFilterLeaf;

export interface BrightDataDatasetSearchResult {
  hits: any[];
  total_hits?: number;
  took?: number;
  search_after?: any[];
}

export async function brightDataSearchDataset(
  datasetId: string,
  filter: DatasetFilter,
  size: number = 10,
  sort?: "default" | "random" | Array<Record<string, "asc" | "desc">>,
  searchAfter?: any[],
  timeoutMs: number = 15_000,
): Promise<BrightDataDatasetSearchResult | null> {
  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) return null;
  const clampedSize = Math.min(10, Math.max(1, size || 10));

  return await withBrightDataClient(
    "search_dataset",
    async (client) => {
      const args: Record<string, any> = {
        dataset_id: datasetId,
        filter,
        size: clampedSize,
      };
      if (sort !== undefined) args.sort = sort;
      if (searchAfter !== undefined) args.search_after = searchAfter;

      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "search_dataset", arguments: args },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data search_dataset",
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data search_dataset returned an error",
        );
      }

      const text = textFromToolResult(toolResult);
      if (!text || !text.trim()) return { hits: [] };
      try {
        const parsed = JSON.parse(text);
        return {
          hits: Array.isArray(parsed?.hits) ? parsed.hits : [],
          total_hits: parsed?.total_hits,
          took: parsed?.took,
          search_after: parsed?.search_after,
        };
      } catch (err) {
        console.warn("[brightdata] Failed to parse search_dataset JSON:", err);
        return { hits: [] };
      }
    },
    { throwOnUnavailable: false, throwOnFailure: false },
  );
}

export async function brightDataGetPersonProfile(
  url: string,
  timeoutMs: number = 120_000,
): Promise<any | null> {
  const targetUrl = normalizeBrightDataUrl(url);
  if (!targetUrl || !isBrightDataConfigured() || isBrightDataCoolingDown()) return null;

  const minTimeout = Number(process.env.BRIGHTDATA_MIN_PROFILE_TIMEOUT_MS) || 50_000;
  const effectiveTimeout = Math.max(timeoutMs, minTimeout);

  return await withBrightDataClient(
    "run_scraper",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          {
            name: "run_scraper",
            arguments: {
              dataset_id: "gd_l1viktl72bvl7bjuj0",
              method: "collect_by_url",
              input: [{ url: targetUrl }],
            },
          },
          undefined,
          { timeout: effectiveTimeout },
        ),
        effectiveTimeout,
        "Bright Data run_scraper (gd_l1viktl72bvl7bjuj0)",
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data run_scraper returned an error",
        );
      }

      const text = textFromToolResult(toolResult);
      if (!text || !text.trim()) return null;

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }

      const deadline = Date.now() + effectiveTimeout;
      if (parsed?.status === "running" && parsed?.snapshot_id) {
        while (Date.now() + 2000 < deadline) {
          await abortableSleep(2000);
          try {
            const pollResult = await client.callTool(
              {
                name: "get_scraper_results",
                arguments: { snapshot_id: parsed.snapshot_id },
              },
              undefined,
              { timeout: 10_000 },
            );
            const pollText = textFromToolResult(pollResult);
            if (!pollText) continue;
            const pollParsed = JSON.parse(pollText);
            if (pollParsed?.status === "ready") {
              parsed = pollParsed;
              break;
            }
            if (pollParsed?.status === "failed" || pollParsed?.status === "canceled") {
              parsed = pollParsed;
              break;
            }
          } catch {}
        }
      }

      if (!parsed || parsed.error || parsed.status !== "ready") return null;
      if (!Array.isArray(parsed.data) || parsed.data.length === 0) return null;
      const record = parsed.data[0];
      if (!record || record.error) {
        if (record?.error) {
          console.warn(
            `[brightdata] Scraper returned error record for ${targetUrl}: ${typeof record.error === "object" ? JSON.stringify(record.error) : record.error}`,
          );
        }
        return null;
      }
      return record;
    },
    { throwOnUnavailable: false, throwOnFailure: false },
  );
}

export async function brightDataGetCompanyProfile(
  url: string,
  timeoutMs: number = 120_000,
): Promise<any | null> {
  const targetUrl = normalizeBrightDataUrl(url);
  if (!targetUrl || !isBrightDataConfigured() || isBrightDataCoolingDown()) return null;

  const minTimeout = Number(process.env.BRIGHTDATA_MIN_PROFILE_TIMEOUT_MS) || 50_000;
  const effectiveTimeout = Math.max(timeoutMs, minTimeout);

  return await withBrightDataClient(
    "run_scraper",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          {
            name: "run_scraper",
            arguments: {
              dataset_id: "gd_l1vikfnt1wgvvqz95w",
              method: "collect_by_url",
              input: [{ url: targetUrl }],
            },
          },
          undefined,
          { timeout: effectiveTimeout },
        ),
        effectiveTimeout,
        "Bright Data run_scraper (gd_l1vikfnt1wgvvqz95w)",
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data run_scraper returned an error",
        );
      }

      const text = textFromToolResult(toolResult);
      if (!text || !text.trim()) return null;

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }

      const deadline = Date.now() + effectiveTimeout;
      if (parsed?.status === "running" && parsed?.snapshot_id) {
        while (Date.now() + 2000 < deadline) {
          await abortableSleep(2000);
          try {
            const pollResult = await client.callTool(
              {
                name: "get_scraper_results",
                arguments: { snapshot_id: parsed.snapshot_id },
              },
              undefined,
              { timeout: 10_000 },
            );
            const pollText = textFromToolResult(pollResult);
            if (!pollText) continue;
            const pollParsed = JSON.parse(pollText);
            if (pollParsed?.status === "ready") {
              parsed = pollParsed;
              break;
            }
            if (pollParsed?.status === "failed" || pollParsed?.status === "canceled") {
              parsed = pollParsed;
              break;
            }
          } catch {}
        }
      }

      if (!parsed || parsed.error || parsed.status !== "ready") return null;
      if (!Array.isArray(parsed.data) || parsed.data.length === 0) return null;
      const record = parsed.data[0];
      if (!record || record.error) {
        if (record?.error) {
          console.warn(
            `[brightdata] Scraper returned error record for ${targetUrl}: ${typeof record.error === "object" ? JSON.stringify(record.error) : record.error}`,
          );
        }
        return null;
      }
      return record;
    },
    { throwOnUnavailable: false, throwOnFailure: false },
  );
}

export async function brightDataScrapeAsHtml(
  url: string,
  timeoutMs: number = 60_000,
): Promise<string | null> {
  return scrapeAsMarkdown(url, timeoutMs, undefined, "html");
}

export async function brightDataScrapeAsLdJson(
  url: string,
  timeoutMs: number = 60_000,
): Promise<string | null> {
  return scrapeAsMarkdown(url, timeoutMs, undefined, "ld_json");
}

export async function brightDataScrapeAsText(
  url: string,
  timeoutMs: number = 60_000,
): Promise<string | null> {
  return scrapeAsMarkdown(url, timeoutMs, undefined, "text");
}

export type BrightDataBatchResult = {
  url: string;
  content: string;
  format?: "markdown" | "html" | "ld_json" | "text";
  sourceProvider: "brightdata_batch";
};

/**
 * Keeps callers on Bright Data's hard five-URL tool contract without silently
 * dropping the remainder of a larger enrichment set.
 */
export function chunkBrightDataBatchItems<T>(items: T[]): T[][] {
  const list = Array.isArray(items) ? items : [];
  const batches: T[][] = [];
  for (let i = 0; i < list.length; i += BRIGHTDATA_SCRAPE_BATCH_MAX_URLS) {
    batches.push(list.slice(i, i + BRIGHTDATA_SCRAPE_BATCH_MAX_URLS));
  }
  return batches;
}

export async function scrapeBatchAsMarkdown(
  urls: string[],
  timeoutMs = baseTimeoutMs(),
  signal?: AbortSignal,
  format: "markdown" | "html" | "ld_json" | "text" = "markdown",
): Promise<BrightDataBatchResult[]> {
  if (signal?.aborted) return [];
  const cleanUrls = Array.from(
    new Set(
      urls
        .map((url) => {
          try {
            return normalizeBrightDataUrl(url);
          } catch {
            return "";
          }
        })
        .filter((url) => Boolean(url) && !isAuthwalledUrl(url)),
    ),
  );
  if (cleanUrls.length > BRIGHTDATA_SCRAPE_BATCH_MAX_URLS) {
    console.warn(
      `[brightdata] Scrape batch requested ${cleanUrls.length} URLs; clamping to max batch limit (${BRIGHTDATA_SCRAPE_BATCH_MAX_URLS}).`,
    );
  }
  const batchUrls = cleanUrls.slice(0, BRIGHTDATA_SCRAPE_BATCH_MAX_URLS);
  if (batchUrls.length === 0) return [];

  // `scrape_batch` is not exposed by Bright Data's Rapid/free MCP. Keep the
  // explicit deep-enrichment stage functional without probing an unavailable
  // tool, and keep the fallback intentionally small.
  const result = await withBrightDataClient(
    "scrape_batch",
    async (client) => {
      if (scrapeBatchToolAvailable === null) {
        const tools = await client.listTools();
        if (tools?.tools) {
          runtimeDiscoveredTools = tools.tools.map((t) => t.name);
        }
        scrapeBatchToolAvailable = tools.tools.some(
          (t) => t.name === "scrape_batch",
        );
        batchToolState.detected = scrapeBatchToolAvailable;
      }

      if (!scrapeBatchToolAvailable) {
        batchToolState.fallbackMode = "single_page_parallel";
        console.warn(
          "[brightdata:tool_fallback] scrape_batch not in listTools(); falling back to parallel scrape_as_markdown",
        );
        const fallbackResults: BrightDataBatchResult[] = (
          await Promise.all(
            batchUrls.map(async (url): Promise<BrightDataBatchResult | null> => {
              try {
                // Each scrape checks the signal itself, so a cancelled batch stops issuing
                // further paid calls as soon as cancellation is observed.
                const content = await scrapeAsMarkdown(url, timeoutMs, signal, format);
                return content
                  ? { url, content, format, sourceProvider: "brightdata_batch" as const }
                  : null;
              } catch {
                return null;
              }
            }),
          )
        ).filter((item): item is BrightDataBatchResult => Boolean(item));
        return fallbackResults;
      }

      const batchArgs: Record<string, any> = { urls: batchUrls };
      if (format && format !== "markdown") {
        batchArgs.format = format;
      }

      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scrape_batch", arguments: batchArgs },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scrape_batch",
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scrape_batch returned an error",
        );
      }

      const structured = (toolResult as any)?.structuredContent;
      const candidates = Array.isArray(structured?.results)
        ? structured.results
        : Array.isArray(structured)
          ? structured
          : null;

      let parsedItems: BrightDataBatchResult[] = [];

      if (candidates) {
        parsedItems = candidates
          .map((item: any) => ({
            url: item.url || item.source_url || "",
            content: item.markdown || item.content || item.text || "",
            format: (item.format as any) || format,
            sourceProvider: "brightdata_batch" as const,
          }))
          .filter((item: BrightDataBatchResult) => item.url);
      } else {
        const textResult = textFromToolResult(toolResult);
        if (textResult) {
          try {
            const parsed = JSON.parse(textResult);
            const items = Array.isArray(parsed) ? parsed : parsed.results || [];
            parsedItems = items
              .map((item: any) => ({
                url: item.url || item.source_url || "",
                content: item.markdown || item.content || item.text || "",
                format: (item.format as any) || format,
                sourceProvider: "brightdata_batch" as const,
              }))
              .filter((item: BrightDataBatchResult) => item.url);
          } catch {
            parsedItems = cleanUrls.map((url) => ({
              url,
              content: textResult,
              format,
              sourceProvider: "brightdata_batch" as const,
            }));
          }
        }
      }

      // A provider can omit a URL entirely, rather than returning it with an
      // empty body. Match on canonical request URLs so both cases receive the
      // same single-page recovery attempt.
      const itemByUrl = new Map<string, BrightDataBatchResult>();
      for (const item of parsedItems) {
        try {
          const canonicalUrl = normalizeBrightDataUrl(item.url);
          const existing = itemByUrl.get(canonicalUrl);
          if (!existing || (!existing.content.trim() && item.content.trim())) {
            itemByUrl.set(canonicalUrl, item);
          }
        } catch {
          // Ignore malformed child results; the corresponding requested URL is
          // still retried below if it has no usable batch response.
        }
      }

      const retryUrls = cleanUrls.filter(
        (url) => !itemByUrl.get(url)?.content.trim(),
      );
      const retries: Promise<BrightDataBatchResult | null>[] = retryUrls.map(
        (url) =>
          scrapeAsMarkdown(url, timeoutMs, signal, format)
            .then((content) =>
              content
                ? { url, content, format, sourceProvider: "brightdata_batch" as const }
                : null,
            )
            .catch(() => null),
      );
      const retryResults = await Promise.all(retries);
      const retryMap = new Map(
        retryResults
          .filter((r): r is BrightDataBatchResult => Boolean(r))
          .map((r) => [r.url, r]),
      );

      const finalItems = cleanUrls
        .map((url) => {
          const batchItem = itemByUrl.get(url);
          if (batchItem?.content.trim()) {
            return batchItem;
          }
          return retryMap.get(url) || null;
        })
        .filter((item): item is BrightDataBatchResult =>
          Boolean(item?.content.trim()),
        );

      const initialSuccessCount = cleanUrls.length - retryUrls.length;
      const initialFailureCount = retryUrls.length;
      const retrySuccessCount = retryResults.filter(Boolean).length;

      batchToolState.partialSuccesses +=
        initialSuccessCount + retrySuccessCount;
      batchToolState.partialFailures += initialFailureCount;

      if (finalItems.length > 0) {
        batchToolState.runtimeVerified = true;
      }

      return finalItems;
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );

  return result || [];
}

export type BrightDataSearchResult = {
  title: string;
  url: string;
  content: string;
  sourceProvider: "brightdata_search";
  sourceEngine?: "google" | "bing" | "yandex";
};

export type BrightDataSearchOptions = {
  country?: string;
  geoLocation?: string;
  cursor?: string;
  timeoutMs?: number;
  engine?: "google" | "bing" | "yandex";
  forceEngine?: boolean;
  allowBingFallback?: boolean;
  onEngineAttempt?: (engine: "google" | "bing" | "yandex") => void;
  onBingFallback?: (event: { query: string; resultsCount: number }) => void;
  start?: number;
  page?: number;
  timeRange?: "hour" | "day" | "week" | "month" | "year" | "any";
  /** Cancels in-flight and pending search work; results are discarded on abort. */
  signal?: AbortSignal;
};

const LINKEDIN_PROFILE_URL_PATTERN =
  /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s"'<>)}\]]+/gi;

/** Recover a canonical LinkedIn person URL from provider result metadata. */
export function extractLinkedInProfileUrlFromResult(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const values: string[] = [];
  const collect = (value: unknown, depth: number) => {
    if (depth > 2 || value === null || value === undefined) return;
    if (typeof value === "string") {
      values.push(value);
      if (value.includes("/goto") || value.includes("%2F") || value.includes("url=") || value.includes("q=")) {
        const unwrapped = unwrapRedirectUrl(value);
        if (unwrapped && unwrapped !== value) values.push(unwrapped);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>))
        collect(item, depth + 1);
    }
  };
  collect(result, 0);

  for (const value of values) {
    const candidates = value.match(LINKEDIN_PROFILE_URL_PATTERN) || [];
    for (const candidate of candidates) {
      const normalized = normalizeLinkedInUrl(
        candidate.replace(/[.,;:]+$/, ""),
      );
      if (normalized) return `https://${normalized}`;
    }
  }
  return "";
}

function normalizeBrightDataSearchResult(item: any): BrightDataSearchResult {
  const rawDirect = item?.link || item?.url || item?.source_url || "";
  const directUrl = unwrapRedirectUrl(rawDirect) || rawDirect;
  const profileUrl = extractLinkedInProfileUrlFromResult(item);
  return {
    title: item?.title || "",
    url: profileUrl || directUrl,
    content: item?.snippet || item?.description || item?.content || "",
    sourceProvider: "brightdata_search" as const,
    sourceEngine: item?.sourceEngine,
  };
}

/** Bright Data search_engine accepts a two-letter geo_location value. */
export function normalizeBrightDataGeoLocation(value?: string) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  const countryMap: Record<string, string> = {
    usa: "us",
    "united states": "us",
    us: "us",
    uk: "gb",
    "united kingdom": "gb",
    gb: "gb",
    canada: "ca",
    ca: "ca",
    australia: "au",
    au: "au",
    germany: "de",
    de: "de",
    france: "fr",
    fr: "fr",
    netherlands: "nl",
    nl: "nl",
  };
  if (countryMap[normalized]) return countryMap[normalized];
  return /^[a-z]{2}$/.test(normalized) ? normalized : "";
}

/**
 * Parses markdown output returned by @brightdata/mcp for non-Google engines (Bing/Yandex).
 * Extracts [Title](url) markdown links and accompanying description text blocks.
 */
export function parseBingMarkdownResults(
  markdownText: string,
): BrightDataSearchResult[] {
  if (!markdownText || typeof markdownText !== "string") return [];
  const results: BrightDataSearchResult[] = [];
  const lines = markdownText.split("\n");
  let currentTitle = "";
  let currentUrl = "";
  let currentSnippetLines: string[] = [];

  const flush = () => {
    if (currentTitle && currentUrl) {
      const content = currentSnippetLines.join(" ").replace(/\s+/g, " ").trim();
      results.push({
        title: currentTitle,
        url: currentUrl,
        content: content || currentTitle,
        sourceProvider: "brightdata_search" as const,
        sourceEngine: "bing" as const,
      });
    }
    currentTitle = "";
    currentUrl = "";
    currentSnippetLines = [];
  };

  const ignoredHosts =
    /^(?:www\.)?(?:bing\.com|microsoft\.com|msn\.com|live\.com|bingapis\.com|azure\.com|microsoftedge\.com)/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const linkMatch = line.match(
      /^#{0,6}\s*\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/,
    );
    if (linkMatch) {
      flush();
      const candidateTitle = linkMatch[1].trim();
      const rawUrl = linkMatch[2].trim();
      const candidateUrl = unwrapRedirectUrl(rawUrl) || rawUrl;
      try {
        const parsed = new URL(candidateUrl);
        if (!ignoredHosts.test(parsed.hostname) && candidateTitle.length > 1) {
          currentTitle = candidateTitle;
          currentUrl = candidateUrl;
        }
      } catch {}
      continue;
    }

    const inlineMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/);
    if (inlineMatch && !currentUrl) {
      const candidateTitle = inlineMatch[1].trim();
      const rawUrl = inlineMatch[2].trim();
      const candidateUrl = unwrapRedirectUrl(rawUrl) || rawUrl;
      try {
        const parsed = new URL(candidateUrl);
        if (!ignoredHosts.test(parsed.hostname) && candidateTitle.length > 1) {
          flush();
          currentTitle = candidateTitle;
          currentUrl = candidateUrl;
          continue;
        }
      } catch {}
    }

    if (currentUrl) {
      if (
        !line.startsWith("![") &&
        !line.startsWith("---") &&
        !line.startsWith("***")
      ) {
        currentSnippetLines.push(line);
      }
    }
  }
  flush();

  return results.filter((r) => r.url && r.title);
}

/**
 * FastMCP search argument builder conforming to @brightdata/mcp v4.6.0 search_engine schema:
 * query, engine, country, page, time_range.
 */
export function buildBrightDataSearchArguments(
  query: string,
  options: BrightDataSearchOptions = {},
) {
  const configuredGeo =
    options.country ||
    options.geoLocation ||
    process.env.BRIGHTDATA_SEARCH_GEO_LOCATION ||
    "us";
  const country = normalizeBrightDataGeoLocation(configuredGeo);
  const engine =
    options.engine === "bing"
      ? "bing"
      : options.engine === "yandex"
        ? "yandex"
        : "google";
  const rawPage =
    typeof options.page === "number"
      ? options.page
      : typeof options.start === "number"
        ? Math.floor(options.start / 10)
        : typeof (options as any).cursor === "number"
          ? (options as any).cursor
          : typeof (options as any).cursor === "string" && /^\d+$/.test((options as any).cursor)
            ? parseInt((options as any).cursor, 10)
            : undefined;
  const page =
    typeof rawPage === "number" && !isNaN(rawPage)
      ? Math.max(0, Math.floor(rawPage))
      : undefined;

  let timeRange = options.timeRange;
  if ((engine === "bing" || engine === "yandex") && (timeRange === "hour" || timeRange === "month")) {
    timeRange = "day";
  }

  return {
    query,
    engine,
    ...(country ? { country } : {}),
    ...(typeof page === "number" ? { page } : {}),
    ...(timeRange ? { time_range: timeRange } : {}),
  };
}

let googleSerpChallengeCount = 0;
// Sticky Bing fallback expires by itself after 15 minutes (see isStickyBingActive); a
// successful Google result also clears it. There is deliberately no paid "probe" request.
let stickyBingActiveSince = 0;
const GOOGLE_CHALLENGE_STICKY_THRESHOLD = 2;


export function isStickyBingActive(): boolean {
  if (stickyBingActiveSince > 0) {
    if (Date.now() - stickyBingActiveSince > 15 * 60 * 1000) {
      stickyBingActiveSince = 0;
      return false;
    }
    return true;
  }
  return false;
}

export async function brightDataSearch(
  query: string,
  options?: BrightDataSearchOptions,
): Promise<BrightDataSearchResult[]> {
  // Cancellation is checked before spending anything: a cancelled session must not wait
  // through jitter or pay for SERP calls whose results will be discarded.
  if (options?.signal?.aborted) return [];
  // Configurable search jitter between search calls. Uses abortableSleep rather
  // than a bare setTimeout so the wait ends the moment the session is cancelled.
  const configuredJitter = Number(process.env.BRIGHTDATA_SEARCH_JITTER_MS);
  const jitterMs = Number.isFinite(configuredJitter)
    ? configuredJitter
    : (process.env.BRIGHTDATA_ENABLE_SEARCH_JITTER === "true" ? Math.floor(500 + Math.random() * 700) : 0);
  if (jitterMs > 0) {
    try {
      await abortableSleep(jitterMs, options?.signal);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return [];
      throw error;
    }
  }
  if (options?.signal?.aborted) return [];

  const timeoutMs = options?.timeoutMs || baseTimeoutMs();
  const defaultEngine =
    (process.env.BRIGHTDATA_DEFAULT_SEARCH_ENGINE as "google" | "bing" | "yandex") ||
    "google";
  let engine = options?.engine || defaultEngine;
  if (isStickyBingActive() && engine === "google" && !options?.forceEngine) {
    engine = "bing";
  }

  const allowBingFallback =
    (options?.allowBingFallback ??
      process.env.BRIGHTDATA_FALLBACK_ENGINE !== "false") &&
    engine === "google";

  const runSearch = async (
    activeEngine: "google" | "bing" | "yandex",
  ): Promise<BrightDataSearchResult[]> => {
    options?.onEngineAttempt?.(activeEngine);
    const searchRes = await withBrightDataClient(
      "search_engine",
      async (client) => {
        if (searchToolAvailable === null) {
          const tools = await client.listTools();
          if (tools?.tools) {
            runtimeDiscoveredTools = tools.tools.map((t) => t.name);
          }
          searchToolAvailable = tools.tools.some(
            (t) => t.name === "search_engine",
          );
        }

        if (!searchToolAvailable) {
          throw new BrightDataError(
            "search_engine tool unavailable in Bright Data MCP",
            {
              reasonCode: "provider_config",
              providerDisabled: true,
            },
          );
        }

        const effectiveTimeoutMs =
          activeEngine === "google" && allowBingFallback
            ? Math.min(timeoutMs, Number(process.env.BRIGHTDATA_GOOGLE_CHALLENGE_TIMEOUT_MS || 20_000))
            : timeoutMs;

        const toolResult = await withHardTimeout(
          client.callTool(
            {
              name: "search_engine",
              arguments: buildBrightDataSearchArguments(query, {
                ...options,
                engine: activeEngine,
              }),
            },
            undefined,
            { timeout: effectiveTimeoutMs },
          ),
          effectiveTimeoutMs,
          `Bright Data search_engine (${activeEngine})`,
        );

        if ((toolResult as any)?.isError) {
          throw new Error(
            textFromToolResult(toolResult) ||
              `Bright Data search_engine (${activeEngine}) returned an error`,
          );
        }

        const textResult = textFromToolResult(toolResult);
        if (!textResult) return [];

        let items: any[] = [];
        let parsed: any = null;
        try {
          parsed = JSON.parse(textResult);
          items = Array.isArray(parsed)
            ? parsed
            : parsed?.organic || parsed?.results || [];
        } catch {
          if (activeEngine === "bing" || (activeEngine as string) === "yandex") {
            const mdResults = parseBingMarkdownResults(textResult);
            if (mdResults.length > 0) return mdResults;
          }
          throw new BrightDataError(
            `Unexpected non-JSON response from Bright Data search_engine (${activeEngine}): ${textResult.slice(0, 200)}`,
            { reasonCode: "empty_body_transient", retryable: false },
          );
        }

        return items
          .map((item: any) =>
            normalizeBrightDataSearchResult({
              ...item,
              sourceEngine: activeEngine,
            }),
          )
          .filter((item: BrightDataSearchResult) => item.url && item.title);
      },
      { throwOnUnavailable: true, throwOnFailure: true },
    );
    return searchRes || [];
  };

  const result = await executeBrightDataSearchWithEmptyBodyRecovery(
    async () => {
      try {
        const searchResults = await runSearch(engine);
        if (engine === "google" && searchResults && searchResults.length > 0) {
          if (googleSerpChallengeCount > 0 || isStickyBingActive()) {
            googleSerpChallengeCount = 0;
            stickyBingActiveSince = 0;
          }
        }
        return searchResults;
      } catch (error) {
        const classified = classifyBrightDataError(error);
        const isBotChallenge =
          classified.reasonCode === "target_transient" ||
          classified.reasonCode === "target_blocked" ||
          /unexpected non-json response|captcha|challenge|bot|blocked/i.test(classified.message);

        if (engine === "google" && isBotChallenge) {
          googleSerpChallengeCount++;
          if (googleSerpChallengeCount >= GOOGLE_CHALLENGE_STICKY_THRESHOLD) {
            stickyBingActiveSince = Date.now();
            console.warn(
              `[brightdata] Google SERP bot challenges reached threshold (${googleSerpChallengeCount}). Activated sticky Bing fallback.`,
            );
          }
        }

        if (
          allowBingFallback &&
          isBotChallenge
        ) {
          try {
            console.warn(
              `[brightdata] Google SERP challenge encountered; seamlessly falling back to Bing...`,
            );
            const bingResults = await runSearch("bing");
            if (bingResults && bingResults.length > 0) {
              options?.onBingFallback?.({
                query,
                resultsCount: bingResults.length,
              });
              return bingResults;
            }
          } catch {
            // Bing fallback also failed; proceed to rethrow original classified error for Tavily
          }
        }
        throw error;
      }
    },
  );

  return result || [];
}

export async function brightDataSearchBatch(
  queries: string[],
  options?: BrightDataSearchOptions,
): Promise<Map<string, BrightDataSearchResult[]>> {
  const resultsMap = new Map<string, BrightDataSearchResult[]>();
  if (!queries || queries.length === 0) return resultsMap;
  if (options?.signal?.aborted) return resultsMap;

  // Max 5 queries per batch call
  const cleanQueries = queries.slice(0, 5);
  cleanQueries.forEach((q) => resultsMap.set(q, []));

  const defaultEngine =
    (process.env.BRIGHTDATA_DEFAULT_SEARCH_ENGINE as "google" | "bing") ||
    "google";
  let activeEngine: "google" | "bing" =
    options?.engine === "bing"
      ? "bing"
      : options?.engine === "google"
        ? "google"
        : defaultEngine === "bing"
          ? "bing"
          : "google";

  if (isStickyBingActive() && activeEngine === "google" && !options?.forceEngine) {
    activeEngine = "bing";
  }

  const allowBingFallback =
    (options?.allowBingFallback ??
      process.env.BRIGHTDATA_FALLBACK_ENGINE !== "false") &&
    activeEngine === "google";

  const executeBatch = async (
    engine: "google" | "bing",
  ): Promise<Map<string, BrightDataSearchResult[]>> => {
    options?.onEngineAttempt?.(engine);
    return (
      (await withBrightDataClient(
        "search_engine_batch",
        async (client) => {
          if (searchBatchToolAvailable === null) {
            const tools = await client.listTools();
            if (tools?.tools) {
              runtimeDiscoveredTools = tools.tools.map((t) => t.name);
            }
            searchBatchToolAvailable = tools.tools.some(
              (t) => t.name === "search_engine_batch",
            );
          }

          if (!searchBatchToolAvailable) {
            // Fall back to parallel brightDataSearch
            const singles = await Promise.all(
              cleanQueries.map((q) =>
                brightDataSearch(q, { ...options, engine }).catch(() => []),
              ),
            );
            cleanQueries.forEach((q, idx) => resultsMap.set(q, singles[idx] || []));
            return resultsMap;
          }

          // Each query in queries is a search_schema object
          const batchQueryObjects = cleanQueries.map((q) =>
            buildBrightDataSearchArguments(q, { ...options, engine }),
          );

          const timeoutMs = options?.timeoutMs || baseTimeoutMs();
          const effectiveTimeoutMs =
            engine === "google" && allowBingFallback
              ? Math.min(
                  timeoutMs,
                  Number(
                    process.env.BRIGHTDATA_GOOGLE_CHALLENGE_TIMEOUT_MS || 20_000,
                  ),
                )
              : timeoutMs;

          const toolResult = await withHardTimeout(
            client.callTool(
              {
                name: "search_engine_batch",
                arguments: { queries: batchQueryObjects },
              },
              undefined,
              { timeout: effectiveTimeoutMs },
            ),
            effectiveTimeoutMs,
            `Bright Data search_engine_batch (${engine})`,
          );

          if ((toolResult as any)?.isError) {
            throw new Error(
              textFromToolResult(toolResult) ||
                `Bright Data search_engine_batch (${engine}) returned an error`,
            );
          }

          const textResult = textFromToolResult(toolResult);
          if (!textResult) return resultsMap;

          let parsed: any;
          try {
            parsed = JSON.parse(textResult);
          } catch {
            throw new BrightDataError(
              `Unexpected non-JSON response from Bright Data search_engine_batch (${engine})`,
              { reasonCode: "empty_body_transient", retryable: false },
            );
          }

          const items = Array.isArray(parsed) ? parsed : [];
          items.forEach((entry: any, idx: number) => {
            const queryKey = entry?.query || cleanQueries[idx] || "";
            // Unpack from entry.result.organic
            const organic = entry?.result?.organic || [];
            const normalized = organic
              .map((item: any) =>
                normalizeBrightDataSearchResult({
                  ...item,
                  sourceEngine: entry?.engine || engine,
                }),
              )
              .filter((item: BrightDataSearchResult) => item.url && item.title);
            resultsMap.set(queryKey, normalized);
          });

          return resultsMap;
        },
        { throwOnUnavailable: true, throwOnFailure: true },
      )) || resultsMap
    );
  };

  try {
    const results = await executeBatch(activeEngine);
    if (activeEngine === "google") {
      let totalCount = 0;
      for (const [, items] of results) {
        totalCount += items.length;
      }
      if (totalCount > 0 && (googleSerpChallengeCount > 0 || isStickyBingActive())) {
        googleSerpChallengeCount = 0;
        stickyBingActiveSince = 0;
      }
    }
    return results;
  } catch (error) {
    const classified = classifyBrightDataError(error);
    const isBotChallenge =
      classified.reasonCode === "target_transient" ||
      classified.reasonCode === "target_blocked" ||
      /unexpected non-json response|captcha|challenge|bot|blocked/i.test(
        classified.message,
      );

    if (activeEngine === "google" && isBotChallenge) {
      googleSerpChallengeCount++;
      if (googleSerpChallengeCount >= GOOGLE_CHALLENGE_STICKY_THRESHOLD) {
        stickyBingActiveSince = Date.now();
        console.warn(
          `[brightdata] Google SERP bot challenges reached threshold (${googleSerpChallengeCount}) via batch search. Activated sticky Bing fallback.`,
        );
      }
    }

    if (activeEngine === "google" && isBotChallenge && allowBingFallback) {
      try {
        console.warn(
          "[brightdata] Google SERP batch challenged; falling back to Bing batch...",
        );
        const bingMap = await executeBatch("bing");
        let totalRecovered = 0;
        for (const [, items] of bingMap) {
          totalRecovered += items.length;
        }
        if (totalRecovered > 0) {
          options?.onBingFallback?.({
            query: cleanQueries.join("; "),
            resultsCount: totalRecovered,
          });
        }
        return bingMap;
      } catch {
        // Fall back to empty map so retrieveStage can run Tavily fallback
      }
    }
    return resultsMap;
  }
}

export function resetBrightDataModuleState() {
  clearCurrentClient();
  activeTransport = null;
  activeApiToken = "";
  activeApiTokenFingerprint = "";
  resetToolAvailability();
  runtimeDiscoveredTools = null;
  disabledReason = "";
  disabledUntil = 0;
  healthOverride = null;
  googleSerpChallengeCount = 0;
  stickyBingActiveSince = 0;
  consecutiveFailures = 0;
  lastError = "";
}

export const brightDataScrapeBatch = scrapeBatchAsMarkdown;

// --- Scraper Discovery & Execution Wrappers ---------------------------------

export interface BrightDataScraperCatalogItem {
  dataset_id: string;
  name: string;
  domain?: string;
  collection_methods?: string[];
  [key: string]: any;
}

export interface BrightDataScraperDetails {
  dataset_id: string;
  method: string;
  description?: string;
  input_fields?: Record<string, any>;
  sample_input?: any;
  output_fields?: Record<string, any>;
  [key: string]: any;
}

export async function brightDataSearchScrapers(
  query: string,
  limit: number = 10,
  timeoutMs: number = 30_000,
): Promise<BrightDataScraperCatalogItem[]> {
  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) return [];
  const clampedLimit = Math.min(50, Math.max(1, limit || 10));

  return (
    (await withBrightDataClient(
      "search_scrapers",
      async (client) => {
        const toolResult = await withHardTimeout(
          client.callTool(
            {
              name: "search_scrapers",
              arguments: { query, limit: clampedLimit },
            },
            undefined,
            { timeout: timeoutMs },
          ),
          timeoutMs,
          "Bright Data search_scrapers",
        );

        if ((toolResult as any)?.isError) {
          throw new Error(
            textFromToolResult(toolResult) ||
              "Bright Data search_scrapers returned an error",
          );
        }

        const text = textFromToolResult(toolResult);
        if (!text || !text.trim()) return [];
        try {
          const parsed = JSON.parse(text);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      },
      { throwOnUnavailable: false, throwOnFailure: false },
    )) || []
  );
}

export async function brightDataGetScraperDetails(
  datasetId: string,
  method: string,
  timeoutMs: number = 30_000,
): Promise<BrightDataScraperDetails | null> {
  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) return null;

  return await withBrightDataClient(
    "get_scraper_details",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          {
            name: "get_scraper_details",
            arguments: { dataset_id: datasetId, method },
          },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data get_scraper_details",
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data get_scraper_details returned an error",
        );
      }

      const text = textFromToolResult(toolResult);
      if (!text || !text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    { throwOnUnavailable: false, throwOnFailure: false },
  );
}

export async function brightDataRefreshScrapers(
  timeoutMs: number = 30_000,
): Promise<{ scrapers: number } | null> {
  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) return null;

  return await withBrightDataClient(
    "refresh_scrapers",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "refresh_scrapers", arguments: {} },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data refresh_scrapers",
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data refresh_scrapers returned an error",
        );
      }

      const text = textFromToolResult(toolResult);
      if (!text || !text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    { throwOnUnavailable: false, throwOnFailure: false },
  );
}

export async function brightDataRunScraper(
  datasetId: string,
  method: string,
  input: Array<Record<string, any>>,
  limitPerInput: number = 10,
  timeoutMs: number = 60_000,
): Promise<any | null> {
  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) return null;

  return await withBrightDataClient(
    "run_scraper",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          {
            name: "run_scraper",
            arguments: {
              dataset_id: datasetId,
              method,
              input,
              limit_per_input: limitPerInput,
            },
          },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        `Bright Data run_scraper (${datasetId})`,
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data run_scraper returned an error",
        );
      }

      const text = textFromToolResult(toolResult);
      if (!text || !text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    { throwOnUnavailable: false, throwOnFailure: false },
  );
}

export async function brightDataGetScraperProgress(
  snapshotId: string,
  timeoutMs: number = 30_000,
): Promise<any | null> {
  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) return null;

  return await withBrightDataClient(
    "get_scraper_progress",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          {
            name: "get_scraper_progress",
            arguments: { snapshot_id: snapshotId },
          },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data get_scraper_progress",
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data get_scraper_progress returned an error",
        );
      }

      const text = textFromToolResult(toolResult);
      if (!text || !text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    { throwOnUnavailable: false, throwOnFailure: false },
  );
}

export async function brightDataGetScraperResults(
  snapshotId: string,
  timeoutMs: number = 30_000,
): Promise<any | null> {
  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) return null;

  return await withBrightDataClient(
    "get_scraper_results",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          {
            name: "get_scraper_results",
            arguments: { snapshot_id: snapshotId },
          },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data get_scraper_results",
      );

      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data get_scraper_results returned an error",
        );
      }

      const text = textFromToolResult(toolResult);
      if (!text || !text.trim()) return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    { throwOnUnavailable: false, throwOnFailure: false },
  );
}

// --- Browser Automation Wrappers (All 14 FastMCP Tools) ---------------------

export async function brightDataBrowserNavigate(
  url: string,
  country?: string,
  timeoutMs: number = 120_000,
): Promise<string> {
  const targetUrl = normalizeBrightDataUrl(url);
  const result = await withBrightDataClient(
    "scraping_browser_navigate",
    async (client) => {
      const args: Record<string, any> = { url: targetUrl };
      if (country) args.country = country.toUpperCase();
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_navigate", arguments: args },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_navigate",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_navigate returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserSnapshot(
  filtered?: boolean,
  timeoutMs: number = 30_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_snapshot",
    async (client) => {
      const args: Record<string, any> = {};
      if (filtered !== undefined) args.filtered = filtered;
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_snapshot", arguments: args },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_snapshot",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_snapshot returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserClick(
  ref: string,
  element: string,
  timeoutMs: number = 15_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_click_ref",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_click_ref", arguments: { ref, element } },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_click_ref",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_click_ref returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}
export const brightDataBrowserClickRef = brightDataBrowserClick;

export async function brightDataBrowserType(
  ref: string,
  element: string,
  text: string,
  submit?: boolean,
  timeoutMs: number = 15_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_type_ref",
    async (client) => {
      const args: Record<string, any> = { ref, element, text };
      if (submit !== undefined) args.submit = submit;
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_type_ref", arguments: args },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_type_ref",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_type_ref returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}
export const brightDataBrowserTypeRef = brightDataBrowserType;

export interface BrowserFormField {
  name: string;
  type: "textbox" | "checkbox" | "radio" | "combobox" | "slider";
  ref: string;
  value: string;
}

export async function brightDataBrowserFillForm(
  fields: BrowserFormField[],
  timeoutMs: number = 30_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_fill_form",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_fill_form", arguments: { fields } },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_fill_form",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_fill_form returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserWaitForRef(
  ref: string,
  element: string,
  timeout?: number,
  timeoutMs: number = 35_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_wait_for_ref",
    async (client) => {
      const args: Record<string, any> = { ref, element };
      if (timeout !== undefined) args.timeout = timeout;
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_wait_for_ref", arguments: args },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_wait_for_ref",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_wait_for_ref returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserScroll(
  timeoutMs: number = 15_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_scroll",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_scroll", arguments: {} },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_scroll",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_scroll returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserScrollToRef(
  ref: string,
  element: string,
  timeoutMs: number = 15_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_scroll_to_ref",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_scroll_to_ref", arguments: { ref, element } },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_scroll_to_ref",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_scroll_to_ref returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserGetText(
  timeoutMs: number = 20_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_get_text",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_get_text", arguments: {} },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_get_text",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_get_text returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserGetHtml(
  fullPage: boolean = false,
  timeoutMs: number = 25_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_get_html",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_get_html", arguments: { full_page: fullPage } },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_get_html",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_get_html returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserScreenshot(
  fullPage: boolean = false,
  timeoutMs: number = 30_000,
): Promise<any> {
  return await withBrightDataClient(
    "scraping_browser_screenshot",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_screenshot", arguments: { full_page: fullPage } },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_screenshot",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_screenshot returned an error",
        );
      }
      return toolResult;
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
}

export async function brightDataBrowserNetworkRequests(
  timeoutMs: number = 15_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_network_requests",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_network_requests", arguments: {} },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_network_requests",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_network_requests returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserGoBack(
  timeoutMs: number = 20_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_go_back",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_go_back", arguments: {} },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_go_back",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_go_back returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}

export async function brightDataBrowserGoForward(
  timeoutMs: number = 20_000,
): Promise<string> {
  const result = await withBrightDataClient(
    "scraping_browser_go_forward",
    async (client) => {
      const toolResult = await withHardTimeout(
        client.callTool(
          { name: "scraping_browser_go_forward", arguments: {} },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        "Bright Data scraping_browser_go_forward",
      );
      if ((toolResult as any)?.isError) {
        throw new Error(
          textFromToolResult(toolResult) ||
            "Bright Data scraping_browser_go_forward returned an error",
        );
      }
      return textFromToolResult(toolResult);
    },
    { throwOnUnavailable: true, throwOnFailure: true },
  );
  return result || "";
}
