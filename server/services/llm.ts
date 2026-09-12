import {
  ApiKeyPool,
  KeyRotationError,
  executeWithKeyRotation,
  parseApiKeys,
} from "./keyRotator.js";

export const Type = {
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
};

// -----------------------------------------------------------------------------
// OpenAI-compatible REST API helpers with LiteLLM gateway and direct provider fallback.
// -----------------------------------------------------------------------------

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

type LLMProvider = {
  id: "litellm" | "primary" | "openrouter" | "groq" | "tokenharbor";
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  headers?: Record<string, string>;
};

export type LLMProviderSummary = Omit<LLMProvider, "apiKey" | "headers"> & {
  configured: boolean;
};

export type LLMProviderAttempt = {
  providerId: LLMProvider["id"];
  provider: string;
  model: string;
  actualModel?: string;
  tokens?: { input: number; output: number; total: number };
  status: "success" | "error" | "skipped";
  statusCode?: number;
  latencyMs: number;
  error?: string;
};

export type LLMUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  provider: string;
  model: string;
};

export type LLMSessionCircuitBreaker = {
  failureThreshold: number;
  failureCounts: Partial<Record<LLMProvider["id"], number>>;
  disabledProviderIds: Set<LLMProvider["id"]>;
};

export type LLMExecutionOptions = {
  onProviderAttempt?: (attempt: LLMProviderAttempt) => void;
  onUsage?: (usage: LLMUsage) => void;
  timeoutMs?: number;
  maxRetries?: number;
  circuitBreaker?: LLMSessionCircuitBreaker;
  signal?: AbortSignal;
};

export function createLLMSessionCircuitBreaker(
  failureThreshold?: number,
): LLMSessionCircuitBreaker {
  const envRaw = process.env.LLM_SESSION_PROVIDER_FAILURE_THRESHOLD;
  const envThreshold =
    envRaw !== undefined && envRaw.trim() !== "" ? Number(envRaw) : undefined;
  const candidate =
    failureThreshold !== undefined && Number.isFinite(failureThreshold)
      ? failureThreshold
      : Number.isFinite(envThreshold) && (envThreshold as number) > 0
        ? (envThreshold as number)
        : 4;
  const resolved = Number.isFinite(candidate) && candidate > 0 ? candidate : 4;
  return {
    failureThreshold: Math.max(1, Math.floor(resolved)),
    failureCounts: {},
    disabledProviderIds: new Set<LLMProvider["id"]>(),
  };
}

export function isExhaustedQuotaError(
  status?: number,
  bodyOrMessage?: string,
  parsedCode?: string | number,
): boolean {
  if (status !== 429) return false;
  if (parsedCode !== undefined && String(parsedCode).trim() === "1300") {
    return true;
  }
  if (!bodyOrMessage) return false;
  try {
    const parsed = JSON.parse(bodyOrMessage);
    const code = parsed?.error?.code ?? parsed?.code;
    if (code !== undefined && String(code).trim() === "1300") {
      return true;
    }
  } catch {
    // Non-JSON or prefixed string
  }
  return /(?:"code"\s*:\s*"?1300"?\b|\bcode["':\s]+1300\b|\berror[_\s-]?code["':\s]+1300\b)/i.test(
    bodyOrMessage,
  );
}

const DEFAULT_PRIMARY_BASE = "https://byesu.com/v1";
export const DEFAULT_PRIMARY_MODEL = "gpt-5.5";
const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const DEFAULT_GROQ_BASE = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_LITELLM_BASE = "http://127.0.0.1:4000/v1";
const DEFAULT_LITELLM_MODEL = "apex-primary";

const DEFAULT_TOKEN_HARBOR_BASE = "https://tokenharbor.ai/v1";
const DEFAULT_TOKEN_HARBOR_MODEL = "deepseek-v4.1-flash:free";
// NOTE: the Token Harbor API key is intentionally NOT defaulted here. It must come from
// process.env.TOKEN_HARBOR_API_KEY (see buildProviders below). A key was previously hardcoded
// as a source literal - it was never read, but it remains in git history and must be rotated.
// Auto-reverts after exactly 7 days from configuration (Sep 19, 2026 00:00:00 +06:00)
const DEFAULT_TOKEN_HARBOR_EXPIRATION_MS = new Date(
  "2026-09-19T00:00:00+06:00",
).getTime();

let tokenHarborRetiredEarly = false;

export function isTokenHarborActive(now = Date.now()): boolean {
  if (tokenHarborRetiredEarly) return false;
  if (process.env.TOKEN_HARBOR_ENABLED === "false" || !process.env.TOKEN_HARBOR_API_KEY) return false;
  const expiryRaw =
    process.env.TOKEN_HARBOR_EXPIRATION_MS ||
    process.env.TOKEN_HARBOR_EXPIRATION;
  const expiry = expiryRaw
    ? (Number.isFinite(Number(expiryRaw))
        ? Number(expiryRaw)
        : new Date(expiryRaw).getTime())
    : DEFAULT_TOKEN_HARBOR_EXPIRATION_MS;
  return now < expiry;
}

export function retireTokenHarborEarly(): void {
  tokenHarborRetiredEarly = true;
}

export function resetTokenHarborRetirement(): void {
  tokenHarborRetiredEarly = false;
}

const tavilyKeyPool = new ApiKeyPool("Tavily", () =>
  parseApiKeys(process.env.TAVILY_API_KEYS, [process.env.TAVILY_API_KEY]),
);

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function getOpenRouterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Title": process.env.OPENROUTER_APP_TITLE || "Apex CRM",
  };
  const referer = process.env.OPENROUTER_HTTP_REFERER || process.env.APP_URL;
  if (referer && referer !== "MY_APP_URL") {
    headers["HTTP-Referer"] = referer;
  }
  return headers;
}

function getGatewayMode(): "litellm" | "direct" {
  return (process.env.LLM_GATEWAY_MODE || "litellm").toLowerCase() === "direct"
    ? "direct"
    : "litellm";
}

function getLiteLLMProvider(): LLMProvider {
  return {
    id: "litellm",
    name: "LiteLLM",
    baseUrl: cleanBaseUrl(
      process.env.LITELLM_BASE_URL ||
        process.env.LITELLM_BASE ||
        DEFAULT_LITELLM_BASE,
    ),
    model: process.env.LITELLM_MODEL || DEFAULT_LITELLM_MODEL,
    apiKey:
      process.env.LITELLM_API_KEY ||
      process.env.LITELLM_MASTER_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.BYESU_API_KEY ||
      "local-litellm",
  };
}

function getDirectLLMProviderCandidates(): LLMProvider[] {
  const direct: LLMProvider[] = [];

  const tokenHarborKey = process.env.TOKEN_HARBOR_API_KEY || "";

  if (isTokenHarborActive() && tokenHarborKey) {
    direct.push({
      id: "tokenharbor",
      name: "Token Harbor (DeepSeek V4.1 Flash)",
      baseUrl: cleanBaseUrl(
        process.env.TOKEN_HARBOR_BASE || DEFAULT_TOKEN_HARBOR_BASE,
      ),
      model: process.env.TOKEN_HARBOR_MODEL || DEFAULT_TOKEN_HARBOR_MODEL,
      apiKey: tokenHarborKey,
    });
  }

  direct.push(
    {
      id: "primary",
      name: process.env.OPENAI_PROVIDER_NAME || "Byesu",
      baseUrl: cleanBaseUrl(process.env.OPENAI_BASE || DEFAULT_PRIMARY_BASE),
      model: process.env.OPENAI_MODEL || DEFAULT_PRIMARY_MODEL,
      apiKey: process.env.OPENAI_API_KEY || process.env.BYESU_API_KEY || "",
    },
    {
      id: "openrouter",
      name: process.env.OPENROUTER_PROVIDER_NAME || "OpenRouter",
      baseUrl: cleanBaseUrl(
        process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE,
      ),
      model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      apiKey: process.env.OPENROUTER_API_KEY || "",
      headers: getOpenRouterHeaders(),
    },
    {
      id: "groq",
      name: "Groq",
      baseUrl: cleanBaseUrl(process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE),
      model: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
      apiKey: process.env.GROQ_API_KEY || "",
    },
  );

  return direct;
}

function getLLMProviderCandidates(): LLMProvider[] {
  return getGatewayMode() === "litellm"
    ? [getLiteLLMProvider(), ...getDirectLLMProviderCandidates()]
    : getDirectLLMProviderCandidates();
}

function getConfiguredLLMProviders(): LLMProvider[] {
  const directProviders = getDirectLLMProviderCandidates().filter(
    (provider) => !!provider.apiKey,
  );
  if (getGatewayMode() === "litellm") {
    const tokenHarbor = directProviders.find((p) => p.id === "tokenharbor");
    const directFallbacks = directProviders.filter(
      (provider) => provider.id !== "primary" && provider.id !== "tokenharbor",
    );
    return tokenHarbor
      ? [tokenHarbor, getLiteLLMProvider(), ...directFallbacks]
      : [getLiteLLMProvider(), ...directFallbacks];
  }
  return directProviders;
}

export function getLLMProviderSummaries(): LLMProviderSummary[] {
  const isLiteLLM = getGatewayMode() === "litellm";
  return getLLMProviderCandidates().map(({ apiKey, headers, ...provider }) => ({
    ...provider,
    configured:
      provider.id === "litellm"
        ? isLiteLLM
        : isLiteLLM && provider.id === "primary"
          ? false
          : !!apiKey,
  }));
}

export function hasTavilyKey(): boolean {
  return tavilyKeyPool.hasConfiguredKeys();
}

export function getTavilyKeyStatus() {
  return tavilyKeyPool.getStatus();
}

export function getAPIKey(): string {
  return getConfiguredLLMProviders()[0]?.apiKey || "";
}

export function getPrimaryLLMModel(): string {
  const providers = getConfiguredLLMProviders();
  return providers[0]?.model || process.env.OPENAI_MODEL || DEFAULT_PRIMARY_MODEL;
}

export function getPrimaryLLMProvider(): string {
  const providers = getConfiguredLLMProviders();
  return providers[0]?.name || "Byesu";
}
/**
 * Wraps fetch with a hard AbortController timeout and automatic retry on 5xx/network errors.
 * Prevents indefinite hangs when an LLM provider is slow or overloaded.
 * Default: 45s timeout, no retries. Provider fallback owns recovery so the
 * same overloaded endpoint is not repeatedly charged before failover.
 */
export function sleepWithSignal(waitMs: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    const abortErr = new Error("LLM request was aborted by caller.");
    abortErr.name = "AbortError";
    return Promise.reject(abortErr);
  }
  return new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, waitMs);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        const abortErr = new Error("LLM request was aborted by caller.");
        abortErr.name = "AbortError";
        reject(abortErr);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Cloudflare cuts HTTP proxy connections between 100s and 120s (HTTP 524).
 * All outbound LLM requests must be bounded strictly within this window (115s)
 * to prevent gateway timeouts, connection drops, and orphan TCP sockets.
 */
export const CLOUDFLARE_MAX_TIMEOUT_MS = 115_000;

/**
 * Strict sequential execution queue for all LLM calls.
 * Guarantees that at most one outbound API call is active against the LLM model at any millisecond,
 * eliminating upstream thread contention, concurrent rate limits, and Cloudflare queue timeouts.
 */
let globalLLMQueue: Promise<any> = Promise.resolve();

export function withSequentialLLMExecution<T>(task: () => Promise<T>): Promise<T> {
  const run = async () => {
    return await task();
  };
  const resultPromise = globalLLMQueue.then(run, run);
  globalLLMQueue = resultPromise.catch(() => {});
  return resultPromise;
}

/**
 * Executes an HTTP fetch with automatic retry on 5xx/429.
 * When a request fails, backoff sleep listens to callerSignal and throws AbortError immediately.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS || CLOUDFLARE_MAX_TIMEOUT_MS),
  maxRetries = Number(process.env.LLM_MAX_RETRIES || 1),
): Promise<Response> {
  const effectiveTimeoutMs = Math.min(
    Number(timeoutMs || CLOUDFLARE_MAX_TIMEOUT_MS),
    CLOUDFLARE_MAX_TIMEOUT_MS,
  );
  const retry429 =
    process.env.LLM_RETRY_429 === "true" ||
    (process.env.LLM_RETRY_429 !== "false" && maxRetries > 0);
  const effectiveMaxRetries = retry429 ? Math.max(maxRetries, 2) : maxRetries;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Connection: "keep-alive",
    ...((options.headers as Record<string, string>) || {}),
  };
  const requestOptions = {
    ...options,
    headers,
  };

  let lastError: Error = new Error("Unknown fetch error");
  let lastResponse: Response | undefined;
  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    const callerSignal = requestOptions.signal;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    let compositeSignal = controller.signal;
    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timer);
        const abortErr = new Error("LLM request was aborted by caller.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      if (typeof AbortSignal.any === "function") {
        compositeSignal = AbortSignal.any([controller.signal, callerSignal]);
      } else {
        callerSignal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }
    }
    try {
      const res = await fetch(url, {
        ...requestOptions,
        signal: compositeSignal,
      });
      clearTimeout(timer);
      lastResponse = res;

      // 413 is a deterministic payload-budget failure and must never be
      // retried unchanged. 429 rate limit responses use exponential backoff.
      const is429 = res.status === 429;
      let isExhaustedQuota = false;
      if (is429) {
        try {
          const bodyPeek = await res.clone().text();
          if (isExhaustedQuotaError(429, bodyPeek)) {
            isExhaustedQuota = true;
          }
        } catch {
          // ignore clone/read error
        }
      }
      const isRetryableStatus =
        res.status !== 413 &&
        !isExhaustedQuota &&
        ((res.status >= 500 && res.status <= 599) || (is429 && retry429));

      const statusMaxRetries = is429 ? Math.max(maxRetries, 2) : maxRetries;
      if (isRetryableStatus && attempt < statusMaxRetries) {
        const retryAfter = res.headers.get("retry-after");
        const retryAfterSeconds = retryAfter ? Number(retryAfter) : Number.NaN;
        const retryAfterDateMs =
          retryAfter && !Number.isFinite(retryAfterSeconds)
            ? Date.parse(retryAfter) - Date.now()
            : Number.NaN;
        const advertisedWaitMs = Number.isFinite(retryAfterSeconds)
          ? retryAfterSeconds * 1000
          : retryAfterDateMs;
        const exponentialWaitMs = Math.pow(2, attempt) * 1500 + Math.floor(Math.random() * 500);
        const waitMs = Math.min(
          Math.max(
            Number.isFinite(advertisedWaitMs)
              ? advertisedWaitMs
              : exponentialWaitMs,
            1000,
          ),
          30_000,
        );
        console.warn(
          `\x1b[33m[LLM ${res.status} RATE LIMIT]\x1b[0m Attempt ${attempt + 1}/${statusMaxRetries + 1}. Retrying in ${waitMs}ms...`,
        );
        try {
          await res.body?.cancel();
        } catch {
          // ignore cancel error
        }
        await sleepWithSignal(waitMs, callerSignal);
        continue;
      }
      return res;
    } catch (err: any) {
      clearTimeout(timer);
      lastResponse = undefined;
      const isCallerAbort = Boolean(callerSignal?.aborted);
      const isFetchTimeout =
        !isCallerAbort &&
        (controller.signal.aborted ||
          err?.name === "AbortError" ||
          err?.name === "TimeoutError" ||
          /timed out/i.test(err?.message || ""));

      if (isCallerAbort) {
        const abortErr = new Error("LLM request was aborted by caller.");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      if (isFetchTimeout) {
        lastError = new Error(
          `LLM request timed out after ${Math.round(effectiveTimeoutMs / 1000)}s (bounded within Cloudflare 120s limit)`,
        );
        break;
      }
      lastError =
        err instanceof Error
          ? err
          : new Error(String(err));
      if (attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 2000;
        console.warn(
          `[llm] Fetch error on attempt ${attempt + 1}/${maxRetries + 1}: ${lastError.message}. Retrying in ${waitMs}ms...`,
        );
        await sleepWithSignal(waitMs, callerSignal);
      }
    }
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError;
}

export class LLMProviderError extends Error {
  provider: LLMProvider;
  status?: number;
  isTokenLimit: boolean;
  errorCode?: string | number;

  constructor(
    provider: LLMProvider,
    status: number | undefined,
    message: string,
    errorCode?: string | number,
  ) {
    super(`[${provider.name}] ${message}`);
    this.name = "LLMProviderError";
    this.provider = provider;
    this.status = status;
    this.errorCode = errorCode;
    const is429OrRateLimit = status === 429 || /429|rate[-_ ]?limit/i.test(message);
    this.isTokenLimit =
      !is429OrRateLimit &&
      (status === 413 ||
        /413|context[-_ ]?window[-_ ]?(?:exceeded|overflow)|maximum context length|payload too large/i.test(
          message,
        ));
  }
}

/**
 * Marks an error whose `message` embeds untrusted text - model output, scraped page content,
 * or lead data. Provider-failure classification must never regex-match these messages:
 * prospect data routinely contains "413" (area code, "Suite 413"), "timeout", "aborted" and
 * similar tokens, which previously tripped the circuit breaker on a perfectly healthy provider
 * and even aborted the entire fallback chain.
 */
const UNTRUSTED_MESSAGE = Symbol.for("apex.llm.untrustedMessage");

function markUntrustedMessage<T extends Error>(error: T): T {
  (error as unknown as Record<symbol, unknown>)[UNTRUSTED_MESSAGE] = true;
  return error;
}

/** True when `error` is an Error whose message is known to contain untrusted text. */
export function hasUntrustedMessage(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return Boolean(
    (error as unknown as Record<symbol, unknown>)[UNTRUSTED_MESSAGE],
  );
}

/**
 * Sanitises a JSON.parse error before it is embedded in an error message. JSON.parse echoes a
 * snippet of the offending text (e.g. `Unexpected token 'o', "not json at all" is not valid
 * JSON`), which would otherwise re-introduce untrusted model output into a message that
 * failure classification regex-matches.
 */
function sanitizeParseError(message: string): string {
  return message.replace(/"[^"]*"/g, '"[redacted]"').slice(0, 120);
}

/**
 * Builds a structured-output parse failure. The offending completion is attached as
 * `rawExcerpt` rather than interpolated into `message`, because provider-failure
 * classification regex-matches messages and model/lead text is untrusted.
 */
function buildParseFailureError(
  provider: LLMProvider,
  summary: string,
  rawText: string,
): Error {
  const error = new Error(`[${provider.name}] ${summary}`);
  (error as unknown as { rawExcerpt?: string }).rawExcerpt = rawText.slice(
    0,
    300,
  );
  return markUntrustedMessage(error);
}

function truncateProviderError(message: string): string {
  return message.length > 500
    ? `${message.slice(0, 500)}... [truncated]`
    : message;
}

function formatProviderFailures(errors: Error[]): string {
  return errors.map((error) => error.message).join(" | ");
}

export function isCircuitBreakingProviderFailure(error: Error): boolean {
  const status = error instanceof LLMProviderError ? error.status : undefined;
  const isTokenLimit =
    error instanceof LLMProviderError ? error.isTokenLimit : false;
  // True when the message embeds untrusted model/lead text (e.g. a JSON parse failure that
  // echoes the completion). Such a message is DATA, not a fault signal: prospect records
  // routinely contain "413" (area code, "Suite 413"), "timeout" and "connection error", which
  // previously tripped the breaker on a perfectly healthy provider. For these errors only a
  // typed `status` is trustworthy - never the message body.
  const untrusted = hasUntrustedMessage(error);

  // HTTP 429 rate limits are transient concurrency throttles and do not trip the circuit breaker
  // (quota-exhausted 429 with code 1300 is handled separately via isExhaustedQuota)
  if (status === 429) return false;
  if (!untrusted && /429|rate[-_ ]?limit/i.test(error.message)) return false;

  if (
    status === 404 ||
    status === 408 ||
    status === 413 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 524 ||
    (status !== undefined && status >= 520 && status <= 526) ||
    isTokenLimit
  )
    return true;
  if (
    status === 500 &&
    !untrusted &&
    /empty or invalid response|unable to get json response|connection error|internalservererror|openai.*exception|litellm.*error|econnrefused/i.test(
      error.message,
    )
  )
    return true;

  // No typed status and an untrusted message: this is a malformed response, not an outage.
  if (untrusted) return false;

  return /timed out|timeout|connection timed out|no deployments available|cooldown|413|origin took too long|origin web server|connection error|econnrefused|fetch failed/i.test(
    error.message,
  );
}

export const providerCooldowns = new Map<string, number>();

export function clearProviderCooldowns(): void {
  providerCooldowns.clear();
}

async function withProviderFallback<T>(
  operation: (
    provider: LLMProvider,
    options: LLMExecutionOptions,
  ) => Promise<T>,
  executionOptions: LLMExecutionOptions = {},
): Promise<T> {
  if (executionOptions.signal?.aborted) {
    const cancelError = new Error("LLM request was aborted by caller.");
    cancelError.name = "AbortError";
    throw cancelError;
  }

  const providers = getConfiguredLLMProviders();
  if (providers.length === 0) {
    throw new Error(
      "No LLM provider available. Use LLM_GATEWAY_MODE=litellm for the local LiteLLM proxy, or configure OPENAI_API_KEY/BYESU_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY for direct mode.",
    );
  }

  const failures: Error[] = [];
  const now = Date.now();
  for (const provider of providers) {
    if (executionOptions.signal?.aborted) {
      const cancelError = new Error("LLM request was aborted by caller.");
      cancelError.name = "AbortError";
      throw cancelError;
    }

    if (executionOptions.circuitBreaker?.disabledProviderIds.has(provider.id)) {
      executionOptions.onProviderAttempt?.({
        providerId: provider.id,
        provider: provider.name,
        model: provider.model,
        status: "skipped",
        latencyMs: 0,
        error: "Session circuit breaker open",
      });
      continue;
    }

    const cooldownUntil = providerCooldowns.get(provider.id);
    if (cooldownUntil) {
      if (Date.now() < cooldownUntil) {
        // In 30s cooldown; cascade immediately to next provider
        continue;
      } else {
        // Cooldown expired; reinstate provider
        providerCooldowns.delete(provider.id);
      }
    }

    const startedAt = Date.now();
    let attemptUsage: LLMUsage | undefined;
    const providerExecutionOptions: LLMExecutionOptions = {
      ...executionOptions,
      onUsage: (usage) => {
        attemptUsage = usage;
        executionOptions.onUsage?.(usage);
      },
    };
    try {
      const result = await operation(provider, providerExecutionOptions);
      if (executionOptions.circuitBreaker) {
        executionOptions.circuitBreaker.failureCounts[provider.id] = 0;
      }
      executionOptions.onProviderAttempt?.({
        providerId: provider.id,
        provider: provider.name,
        model: provider.model,
        actualModel: attemptUsage?.model || provider.model,
        tokens: attemptUsage
          ? {
              input: attemptUsage.inputTokens,
              output: attemptUsage.outputTokens,
              total: attemptUsage.totalTokens,
            }
          : undefined,
        status: "success",
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (error: any) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      failures.push(normalized);
      // Only genuine cancellation aborts the whole fallback chain. This previously also
      // matched `normalized.message.includes("aborted")`; because parse-failure messages
      // echo model output, one completion containing the word "aborted" was enough to
      // abandon every remaining provider instead of cascading to them.
      const cause = (normalized as { cause?: { name?: string } }).cause;
      const isAbort =
        executionOptions.signal?.aborted ||
        normalized.name === "AbortError" ||
        cause?.name === "AbortError" ||
        (normalized as unknown as { code?: string }).code === "ABORT_ERR";
      if (isAbort) {
        throw normalized;
      }
      const errStatus =
        normalized instanceof LLMProviderError ? normalized.status : undefined;
      console.error(
        `\x1b[31m[LLM ERROR ${errStatus ? errStatus : "FAIL"}]\x1b[0m \x1b[1m${provider.name}\x1b[0m \u00b7 model: \x1b[36m${provider.model}\x1b[0m \u00b7 \x1b[31m${truncateProviderError(normalized.message)}\x1b[0m`,
      );
      executionOptions.onProviderAttempt?.({
        providerId: provider.id,
        provider: provider.name,
        model: provider.model,
        actualModel: attemptUsage?.model || provider.model,
        status: "error",
        statusCode:
          normalized instanceof LLMProviderError
            ? normalized.status
            : undefined,
        latencyMs: Date.now() - startedAt,
        error: truncateProviderError(normalized.message),
      });

      const breaker = executionOptions.circuitBreaker;

      if (provider.id === "tokenharbor") {
        const statusCode =
          normalized instanceof LLMProviderError ? normalized.status : undefined;
        const msg = normalized.message || "";
        const isAuthOrQuotaExhausted =
          statusCode === 401 ||
          statusCode === 402 ||
          /balance_zero|unauthorized|invalid[_-]?api[_-]?key|payment required|confidence_level_required/i.test(msg);
        if (isAuthOrQuotaExhausted) {
          retireTokenHarborEarly();
          if (breaker) {
            breaker.disabledProviderIds.add("tokenharbor");
          }
          console.warn(
            `[llm] Token Harbor trial ended or quota exhausted (${truncateProviderError(msg)}). Auto-retiring Token Harbor; cascading permanently to Byesu.`,
          );
        }
      }

      const isExhaustedQuota =
        (normalized instanceof LLMProviderError &&
          isExhaustedQuotaError(
            normalized.status,
            normalized.message,
            normalized.errorCode,
          )) ||
        isExhaustedQuotaError(
          normalized instanceof LLMProviderError ? normalized.status : 429,
          normalized.message,
        );

      if (isExhaustedQuota) {
        if (breaker) {
          breaker.disabledProviderIds.add(provider.id);
        }
        providerCooldowns.set(provider.id, Date.now() + 24 * 3600 * 1000);
        console.warn(
          `[llm] ${provider.name} disabled for the rest of this mining session due to exhausted quota (HTTP 429 code 1300).`,
        );
      } else if (breaker && isCircuitBreakingProviderFailure(normalized)) {
        const failuresForProvider =
          Number(breaker.failureCounts[provider.id] || 0) + 1;
        breaker.failureCounts[provider.id] = failuresForProvider;
        if (failuresForProvider >= breaker.failureThreshold) {
          breaker.disabledProviderIds.add(provider.id);
          console.warn(
            `[llm] ${provider.name} disabled for the rest of this mining session after ${failuresForProvider} availability failures.`,
          );
        }
      }
      const isTransientTimeoutOrRateLimit =
        !isExhaustedQuota &&
        ((normalized instanceof LLMProviderError &&
          (normalized.status === 429 || normalized.status === 524)) ||
        (!hasUntrustedMessage(normalized) &&
          (/429|rate[-_ ]?limit|524/i.test(normalized.message) ||
           /LLM request timed out after/i.test(normalized.message))));
      if (isTransientTimeoutOrRateLimit) {
        const cooldownMs =
          process.env.LLM_PROVIDER_COOLDOWN_MS !== undefined
            ? Number(process.env.LLM_PROVIDER_COOLDOWN_MS)
            : process.env.LLM_MAX_RETRIES === "0"
              ? 0
              : 30_000;
        if (cooldownMs > 0) {
          providerCooldowns.set(provider.id, Date.now() + cooldownMs);
          console.warn(
            `[llm] ${provider.name} rate/gateway limited (${normalized.message}). Placed on ${Math.round(cooldownMs / 1000)}s temporary cooldown, cascading immediately to next provider...`,
          );
        }
      }
      console.warn(
        `[llm] ${provider.name} failed; trying next configured provider if available: ${normalized.message}`,
      );
    }
  }

  throw new Error(
    `All configured LLM providers failed: ${formatProviderFailures(failures)}`,
  );
}

async function sendChatCompletion(
  provider: LLMProvider,
  messages: ChatMessage[],
  options?: {
    maxTokens?: number;
    temperature?: number;
    responseFormat?: { type: "json_object" };
  } & Pick<LLMExecutionOptions, "onUsage" | "timeoutMs" | "maxRetries" | "signal">,
): Promise<string> {
  return withSequentialLLMExecution(async () => {
    if (options?.signal?.aborted) {
      const cancelError = new Error("LLM request was aborted by caller.");
      cancelError.name = "AbortError";
      throw cancelError;
    }
    let res: Response;
    const effectiveMaxTokens =
      provider.id === "groq"
        ? Math.min(options?.maxTokens || 400, 950)
        : (options?.maxTokens !== undefined ? options.maxTokens : 4000);
    const callStartedAt = Date.now();
    try {
      res = await fetchWithRetry(
        `${provider.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            ...(provider.headers || {}),
            "Content-Type": "application/json",
            Authorization: `Bearer ${provider.apiKey}`,
          },
          body: JSON.stringify({
            model: provider.model,
            messages,
            // Some third-party OpenAI-compatible gateways default to SSE when the
            // flag is omitted. Apex expects one JSON response for structured calls.
            stream: false,
            temperature:
              options?.temperature !== undefined ? options.temperature : 0.1,
            max_tokens: effectiveMaxTokens,
            ...(options?.responseFormat
              ? { response_format: options.responseFormat }
              : {}),
          }),
          signal: options?.signal,
        },
        options?.timeoutMs,
        options?.maxRetries,
      );
    } catch (error: any) {
      if (error?.name === "AbortError" || options?.signal?.aborted) {
        throw error;
      }
      throw new LLMProviderError(
        provider,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!res.ok) {
      const rawText = await res.text();
      let errorCode: string | number | undefined;
      try {
        const parsed = JSON.parse(rawText);
        errorCode = parsed?.error?.code ?? parsed?.code;
      } catch {}
      const err = truncateProviderError(rawText);
      throw new LLMProviderError(
        provider,
        res.status,
        `chat completion error ${res.status}: ${err}`,
        errorCode,
      );
    }

    const data = await res.json();
    const latencyMs = Date.now() - callStartedAt;
    const actualModel =
      typeof data?.model === "string" && data.model.trim()
        ? data.model.trim()
        : provider.model;
    const usage = data?.usage;
    const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
    const outputTokens = Number(
      usage?.completion_tokens ?? usage?.output_tokens ?? 0,
    );
    const suppliedTotal = Number(usage?.total_tokens ?? usage?.totalTokens ?? 0);
    const totalTokens =
      Number.isFinite(suppliedTotal) && suppliedTotal > 0
        ? suppliedTotal
        : Math.max(0, inputTokens) + Math.max(0, outputTokens);

    // LiteLLM-grade rich ANSI colored console log
    console.log(
      `\x1b[32m[LLM 200 OK]\x1b[0m \x1b[1m${provider.name}\x1b[0m \u00b7 model: \x1b[36m${actualModel}\x1b[0m \u00b7 \x1b[33m${latencyMs}ms\x1b[0m \u00b7 \x1b[35m${totalTokens.toLocaleString()} tok\x1b[0m`,
    );

    if (typeof options?.onUsage === "function") {
      options.onUsage({
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
        totalTokens,
        provider: provider.name,
        model: actualModel,
      });
    }
    return data.choices?.[0]?.message?.content || "";
  });
}

export const callLLMProvider = sendChatCompletion;

/** Converts uppercase Type constants to lowercase for the OpenAI schema representation. */
function normalizeSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") {
      out[k] = (v as string).toLowerCase();
    } else if (Array.isArray(v)) {
      out[k] = v.map((item: any) => normalizeSchema(item));
    } else if (typeof v === "object" && v !== null) {
      out[k] = normalizeSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Calls Tavily Search directly.
 * Returns raw text (titles + snippets) + source links for downstream extraction.
 */
function retryAfterMsFromResponse(res: Response) {
  const retryAfter = res.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

export type TavilySearchOptions = {
  includeDomains?: string[];
  excludeDomains?: string[];
  searchDepth?: "basic" | "fast" | "ultra-fast" | "advanced";
  topic?: "general" | "news";
  timeRange?: "day" | "week" | "month" | "year";
  country?: string;
  maxResults?: number;
  includeRawContent?: boolean;
  chunksPerSource?: number;
  signal?: AbortSignal;
};

/**
 * Tavily's include_domains and exclude_domains fields accept domain names.
 * Callers sometimes have a full URL or a LinkedIn /in/ path, so normalize at
 * the provider boundary instead of sending a path as a supposed domain.
 */
export function normalizeTavilyDomain(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Official supported country enum from Tavily's OpenAPI specification.
 * Tavily strictly enforces lowercase full country names; unlisted strings trigger HTTP 400.
 */
export const TAVILY_SUPPORTED_COUNTRIES = new Set<string>([
  "afghanistan", "albania", "algeria", "andorra", "angola", "argentina", "armenia", "australia", "austria", "azerbaijan",
  "bahamas", "bahrain", "bangladesh", "barbados", "belarus", "belgium", "belize", "benin", "bhutan", "bolivia",
  "bosnia and herzegovina", "botswana", "brazil", "brunei", "bulgaria", "burkina faso", "burundi", "cambodia",
  "cameroon", "canada", "cape verde", "central african republic", "chad", "chile", "china", "colombia", "comoros",
  "congo", "costa rica", "croatia", "cuba", "cyprus", "czech republic", "denmark", "djibouti", "dominican republic",
  "ecuador", "egypt", "el salvador", "equatorial guinea", "eritrea", "estonia", "ethiopia", "fiji", "finland",
  "france", "gabon", "gambia", "georgia", "germany", "ghana", "greece", "guatemala", "guinea", "haiti", "honduras",
  "hungary", "iceland", "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy", "jamaica", "japan", "jordan",
  "kazakhstan", "kenya", "kuwait", "kyrgyzstan", "latvia", "lebanon", "lesotho", "liberia", "libya", "liechtenstein",
  "lithuania", "luxembourg", "madagascar", "malawi", "malaysia", "maldives", "mali", "malta", "mauritania",
  "mauritius", "mexico", "moldova", "monaco", "mongolia", "montenegro", "morocco", "mozambique", "myanmar",
  "namibia", "nepal", "netherlands", "new zealand", "nicaragua", "niger", "nigeria", "north korea",
  "north macedonia", "norway", "oman", "pakistan", "panama", "papua new guinea", "paraguay", "peru",
  "philippines", "poland", "portugal", "qatar", "romania", "russia", "rwanda", "saudi arabia", "senegal", "serbia",
  "singapore", "slovakia", "slovenia", "somalia", "south africa", "south korea", "south sudan", "spain",
  "sri lanka", "sudan", "sweden", "switzerland", "syria", "taiwan", "tajikistan", "tanzania", "thailand", "togo",
  "trinidad and tobago", "tunisia", "turkey", "turkmenistan", "uganda", "ukraine", "united arab emirates",
  "united kingdom", "united states", "uruguay", "uzbekistan", "venezuela", "vietnam", "yemen", "zambia", "zimbabwe"
]);

const COUNTRY_ALIASES: Record<string, string> = {
  us: "united states",
  usa: "united states",
  america: "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  gb: "united kingdom",
  gbr: "united kingdom",
  "great britain": "united kingdom",
  britain: "united kingdom",
  england: "united kingdom",
  scotland: "united kingdom",
  wales: "united kingdom",
  ca: "canada",
  can: "canada",
  au: "australia",
  aus: "australia",
  de: "germany",
  deu: "germany",
  deutschland: "germany",
  fr: "france",
  fra: "france",
  nl: "netherlands",
  nld: "netherlands",
  holland: "netherlands",
  ie: "ireland",
  irl: "ireland",
  es: "spain",
  esp: "spain",
  it: "italy",
  ita: "italy",
  ch: "switzerland",
  che: "switzerland",
  se: "sweden",
  swe: "sweden",
  sg: "singapore",
  sgp: "singapore",
  jp: "japan",
  jpn: "japan",
  in: "india",
  ind: "india",
  nz: "new zealand",
  nzl: "new zealand",
  ae: "united arab emirates",
  uae: "united arab emirates",
  za: "south africa",
  zaf: "south africa",
  kr: "south korea",
  kor: "south korea",
  br: "brazil",
  bra: "brazil",
  mx: "mexico",
  mex: "mexico",
  cn: "china",
  chn: "china",
};

/**
 * Normalizes input country strings, codes, and aliases to Tavily's documented lowercase enum.
 * If the input does not map to a recognized Tavily country enum, returns undefined to safely
 * omit the parameter and prevent HTTP 400 Bad Request errors.
 */
export function normalizeTavilyCountry(input?: string): string | undefined {
  if (!input || typeof input !== "string") return undefined;
  const cleaned = input.trim().toLowerCase();
  if (!cleaned) return undefined;
  const mapped = COUNTRY_ALIASES[cleaned] || cleaned;
  if (TAVILY_SUPPORTED_COUNTRIES.has(mapped)) {
    return mapped;
  }
  return undefined;
}

export async function tavilySearch(
  query: string,
  domainsOrOptions?: string[] | TavilySearchOptions,
): Promise<{
  text: string;
  sources: { title: string; uri: string }[];
  items: any[];
}> {
  const options: TavilySearchOptions = Array.isArray(domainsOrOptions)
    ? { includeDomains: domainsOrOptions }
    : domainsOrOptions || {};
  const requestedDepth =
    options.searchDepth || process.env.TAVILY_SEARCH_DEPTH || "basic";
  const searchDepth = ["basic", "fast", "ultra-fast", "advanced"].includes(
    requestedDepth,
  )
    ? (requestedDepth as TavilySearchOptions["searchDepth"])
    : "basic";
  const maxResults = Math.min(
    Math.max(
      Number(options.maxResults || process.env.TAVILY_MAX_RESULTS || 10),
      1,
    ),
    20,
  );
  const includeRawContent =
    options.includeRawContent ??
    process.env.TAVILY_INCLUDE_RAW_CONTENT !== "false";
  const topic = options.topic === "news" ? "news" : "general";
  // Tavily documents lowercase country enum values (for example, "united states").
  // Automatically resolves ISO codes/aliases and safely drops unsupported values to prevent 400s.
  const rawCountry = options.country || process.env.TAVILY_COUNTRY;
  const country = normalizeTavilyCountry(rawCountry);
  const chunksPerSource =
    searchDepth === "advanced" || searchDepth === "fast"
      ? Math.min(Math.max(Number(options.chunksPerSource || 2), 1), 3)
      : undefined;
  const includeDomains = Array.from(
    new Set(
      (options.includeDomains || []).map(normalizeTavilyDomain).filter(Boolean),
    ),
  ).slice(0, 30);
  const excludeDomains = Array.from(
    new Set(
      (options.excludeDomains || []).map(normalizeTavilyDomain).filter(Boolean),
    ),
  ).slice(0, 30);
  const data = await executeWithKeyRotation(tavilyKeyPool, async (apiKey) => {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: includeRawContent,
        include_usage: true,
        ...(chunksPerSource ? { chunks_per_source: chunksPerSource } : {}),
        ...(includeDomains.length ? { include_domains: includeDomains } : {}),
        ...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
        ...(options.timeRange ? { time_range: options.timeRange } : {}),
        ...(topic === "news"
          ? { topic }
          : { topic, ...(country ? { country } : {}) }),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new KeyRotationError(`Tavily search error ${res.status}: ${err}`, {
        statusCode: res.status,
        responseText: err,
        retryAfterMs: retryAfterMsFromResponse(res),
      });
    }

    return res.json();
  });
  const items = Array.isArray(data.results) ? data.results : [];

  let text = "";
  const sources: { title: string; uri: string }[] = [];

  for (const item of items) {
    const title = item.title || "Untitled result";
    const url = item.url || "";
    const snippet = item.content || item.raw_content || "";
    text += `Title: ${title}\nLink: ${url}\nSnippet: ${snippet}\n\n`;
    if (url) sources.push({ title, uri: url });
  }

  return { text, sources, items };
}

export type TavilyExtractResult = {
  url: string;
  rawContent: string;
  images?: string[];
};

export async function tavilyExtract(
  urls: string[],
  query: string,
  options?: {
    extractDepth?: "basic" | "advanced";
    chunksPerSource?: number;
    timeout?: number;
    signal?: AbortSignal;
  },
): Promise<TavilyExtractResult[]> {
  const cleanUrls = Array.from(new Set(urls.filter(Boolean))).slice(0, 20);
  if (cleanUrls.length === 0) return [];

  const data = await executeWithKeyRotation(tavilyKeyPool, async (apiKey) => {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      signal: options?.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        urls: cleanUrls,
        query,
        extract_depth: options?.extractDepth || "basic",
        chunks_per_source: Math.min(
          Math.max(Number(options?.chunksPerSource || 5), 1),
          5,
        ),
        format: "markdown",
        include_images: false,
        include_favicon: false,
        include_usage: true,
        timeout: Math.min(Math.max(Number(options?.timeout || 30), 1), 120),
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new KeyRotationError(`Tavily extract error ${res.status}: ${err}`, {
        statusCode: res.status,
        responseText: err,
        retryAfterMs: retryAfterMsFromResponse(res),
      });
    }

    return res.json();
  });
  const results = Array.isArray(data.results) ? data.results : [];
  return results
    .map((item: any) => ({
      url: item.url || "",
      rawContent: item.raw_content || item.content || "",
      images: Array.isArray(item.images) ? item.images : [],
    }))
    .filter((item: TavilyExtractResult) => item.url && item.rawContent);
}

/**
 * Calls OpenAI compatible API for pure text generation.
 */
export async function openAIText(
  prompt: string,
  systemInstruction?: string,
  options?: { maxTokens?: number; temperature?: number } & LLMExecutionOptions,
): Promise<{ text: string; provider: string; model: string; baseUrl: string }> {
  const messages: ChatMessage[] = [];
  if (systemInstruction) {
    messages.push({
      role: "system",
      content: (systemInstruction as any).toWellFormed
        ? (systemInstruction as any).toWellFormed()
        : systemInstruction,
    });
  }
  messages.push({
    role: "user",
    content: (prompt as any).toWellFormed
      ? (prompt as any).toWellFormed()
      : prompt,
  });

  return withProviderFallback(
    async (provider, providerOpts) => ({
      text: await sendChatCompletion(provider, messages, {
        ...options,
        ...providerOpts,
      }),
      provider: provider.name,
      model: provider.model,
      baseUrl: provider.baseUrl,
    }),
    options,
  );
}

function stripMarkdownFence(str: string): string {
  let cleaned = str.trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines[lines.length - 1]?.trim() === "```") lines.pop();
    cleaned = lines.join("\n").trim();
  }
  return cleaned;
}

function stripReasoningBlocks(str: string): string {
  let cleaned = str.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const finalClose = cleaned.toLowerCase().lastIndexOf("</think>");
  if (finalClose !== -1) {
    cleaned = cleaned.slice(finalClose + "</think>".length).trim();
  }
  return cleaned;
}

function getMarkedJSONBlock(str: string): string | null {
  const match = str.match(/FINAL_JSON_START\s*([\s\S]*?)\s*FINAL_JSON_END/i);
  return match?.[1]?.trim() || null;
}

function findBalancedJSONCandidates(
  str: string,
  preferArray: boolean,
): string[] {
  const candidates: string[] = [];
  const starts = preferArray ? ["[", "{"] : ["{", "["];

  for (const startChar of starts) {
    for (
      let start = str.indexOf(startChar);
      start !== -1;
      start = str.indexOf(startChar, start + 1)
    ) {
      const stack: string[] = [];
      let inString = false;
      let escaped = false;

      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === "\\") {
            escaped = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{") stack.push("}");
        else if (ch === "[") stack.push("]");
        else if (ch === "}" || ch === "]") {
          if (stack.pop() !== ch) break;
          if (stack.length === 0) {
            candidates.push(str.slice(start, i + 1));
            break;
          }
        }
      }
    }
  }

  return Array.from(new Set(candidates));
}

function repairTruncatedJSON(str: string): string | null {
  if (!str || typeof str !== "string") return null;
  const cleaned = stripMarkdownFence(stripReasoningBlocks(str)).trim();
  const firstBracket = cleaned.indexOf("[");
  const firstBrace = cleaned.indexOf("{");
  if (firstBracket === -1 && firstBrace === -1) return null;

  const startIdx = firstBracket !== -1 && firstBrace !== -1
    ? Math.min(firstBracket, firstBrace)
    : (firstBracket !== -1 ? firstBracket : firstBrace);

  let sub = cleaned.slice(startIdx);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastCompleteItemIndex = -1;

  for (let i = 0; i < sub.length; i++) {
    const ch = sub[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
        if (stack.length === 1 && stack[0] === "]") {
          lastCompleteItemIndex = i;
        }
      }
    }
  }

  if (sub.startsWith("[") && lastCompleteItemIndex > 0) {
    return sub.slice(0, lastCompleteItemIndex + 1) + "]";
  }

  if (inString) {
    sub = sub + '"';
  }
  while (stack.length > 0) {
    sub = sub + stack.pop();
  }
  return sub;
}

function cleanJSONString(str: string): string {
  const marked = getMarkedJSONBlock(str);
  if (marked) return stripMarkdownFence(marked);

  let cleaned = stripMarkdownFence(stripReasoningBlocks(str));
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let startIdx = -1;
  if (firstBrace !== -1 && firstBracket !== -1)
    startIdx = Math.min(firstBrace, firstBracket);
  else if (firstBrace !== -1) startIdx = firstBrace;
  else if (firstBracket !== -1) startIdx = firstBracket;

  if (startIdx !== -1) {
    const lastBrace = cleaned.lastIndexOf("}");
    const lastBracket = cleaned.lastIndexOf("]");
    const endIdx = Math.max(lastBrace, lastBracket);
    if (endIdx !== -1 && endIdx > startIdx)
      cleaned = cleaned.slice(startIdx, endIdx + 1);
  }
  return cleaned;
}

/**
 * Calls OpenAI compatible API with a request for a strict JSON response.
 * Used as step 2 to convert raw searched text into clean structured data.
 */
export async function openAIStructured<T>(
  prompt: string,
  schema: any,
  systemInstruction?: string,
  options?: {
    maxTokens?: number;
    temperature?: number;
    retryOnParseFailure?: boolean;
  } & LLMExecutionOptions,
): Promise<T> {
  const jsonMode = process.env.LLM_JSON_MODE || "off";
  const useJsonMode = jsonMode === "on" || jsonMode === "auto";
  const normalizedSchema = normalizeSchema(schema);
  const schemaIsArray = normalizedSchema?.type === "array";
  const responseSchema =
    useJsonMode && schemaIsArray
      ? {
          type: "object",
          properties: {
            items: normalizedSchema,
          },
          required: ["items"],
        }
      : normalizedSchema;

  let sysPrompt = systemInstruction || "";
  if (useJsonMode) {
    sysPrompt += `\n\nYou MUST respond ONLY in valid JSON. Do not include markdown, comments, <think> tags, explanations, or text before/after the JSON. The JSON must exactly match this schema:\n${JSON.stringify(responseSchema)}`;
  } else {
    sysPrompt += `\n\nYou may reason internally or in <think>...</think>, but the final answer must include exactly one JSON value between FINAL_JSON_START and FINAL_JSON_END. Do not put schema examples or commentary between those markers. The final JSON must exactly match this schema:\n${JSON.stringify(responseSchema)}`;
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: (sysPrompt as any).toWellFormed
        ? (sysPrompt as any).toWellFormed()
        : sysPrompt,
    },
    {
      role: "user",
      content: (prompt as any).toWellFormed
        ? (prompt as any).toWellFormed()
        : prompt,
    },
  ];

  const schemaRequired = Array.isArray(normalizedSchema?.required)
    ? normalizedSchema.required
    : [];
  const coerceParsed = (parsed: any): T | null => {
    if (schemaIsArray) {
      const value = Array.isArray(parsed)
        ? parsed
        : parsed && Array.isArray(parsed.items)
          ? parsed.items
          : null;
      if (!Array.isArray(value)) return null;

      const itemSchema = normalizedSchema?.items;
      if (itemSchema && typeof itemSchema === "object") {
        const itemRequired = Array.isArray(itemSchema.required) ? itemSchema.required : [];
        if (itemRequired.length > 0 && value.length > 0) {
          const validItems = value.filter(
            (item: any) =>
              item &&
              typeof item === "object" &&
              itemRequired.every((key: string) => key in item),
          );
          if (validItems.length === 0) return null;
          return validItems as T;
        }
      }
      return value as T;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    for (const key of schemaRequired) {
      if (!(key in parsed)) return null;
      const schemaProperty = normalizedSchema?.properties?.[key];
      if (schemaProperty?.type === "array" && !Array.isArray(parsed[key]))
        return null;
    }
    return parsed as T;
  };

  const parseStructuredText = (rawText: string): T => {
    const sources = [
      getMarkedJSONBlock(rawText),
      stripReasoningBlocks(rawText),
      rawText,
    ].filter((source): source is string => Boolean(source && source.trim()));

    const parseErrors: string[] = [];
    for (const source of sources) {
      const repaired = repairTruncatedJSON(source);
      const directCandidates = [
        cleanJSONString(source),
        ...(repaired ? [repaired] : []),
        ...findBalancedJSONCandidates(source, schemaIsArray),
      ];
      for (const candidate of directCandidates) {
        try {
          const parsed = JSON.parse(stripMarkdownFence(candidate));
          const coerced = coerceParsed(parsed);
          if (coerced !== null) return coerced;
        } catch (err: any) {
          if (parseErrors.length < 3)
            parseErrors.push(err?.message || String(err));
        }
      }
    }

    throw new Error(parseErrors[0] || "No schema-matching JSON block found");
  };

  return withProviderFallback(async (provider, providerOpts) => {
    let text = "";
    const effectiveOptions = { ...options, ...providerOpts };
    try {
      text = await sendChatCompletion(provider, messages, {
        ...effectiveOptions,
        ...(useJsonMode
          ? { responseFormat: { type: "json_object" as const } }
          : {}),
      });
    } catch (error: any) {
      const isJsonValidationError =
        error instanceof LLMProviderError &&
        (error.status === 400 ||
          error.status === 422 ||
          error.message.includes("json_validate_failed") ||
          error.message.includes("Failed to validate JSON") ||
          error.message.includes("json_validate") ||
          error.message.includes("response_format") ||
          error.message.includes("unsupported parameter"));

      if (isJsonValidationError) {
        console.warn(
          `[llm] Structured output call failed for ${provider.name} with schema validation error. Retrying without response_format...`,
        );
        text = await sendChatCompletion(provider, messages, effectiveOptions);
      } else {
        throw error;
      }
    }

    try {
      return parseStructuredText(text);
    } catch (firstParseError: any) {
      const shouldRetry = options?.retryOnParseFailure !== false;
      if (!shouldRetry) {
        throw buildParseFailureError(
          provider,
          `Failed to parse OpenAI-compatible JSON response (parse_error=${sanitizeParseError(firstParseError?.message || "unknown")})`,
          text,
        );
      }

      const retryMaxTokens =
        provider.id === "groq"
          ? Math.min(options?.maxTokens || 400, 950)
          : Math.max(
              Number(process.env.LLM_STRUCTURED_RETRY_MAX_TOKENS || 5000),
              Math.min((options?.maxTokens || 4000) * 2, 8000),
            );
      const retryMessages: ChatMessage[] = [
        {
          role: "system",
          content: `${sysPrompt}\n\nYour previous response was not usable. You may keep reasoning in <think>...</think>, but then output the final JSON only between FINAL_JSON_START and FINAL_JSON_END. Keep summaries and evidence reasons short enough to finish within the token limit.`,
        },
        {
          role: "user",
          content: (prompt as any).toWellFormed
            ? (prompt as any).toWellFormed()
            : prompt,
        },
      ];
      const retryText = await sendChatCompletion(provider, retryMessages, {
        ...effectiveOptions,
        maxTokens: retryMaxTokens,
        temperature: 0,
        ...(useJsonMode
          ? { responseFormat: { type: "json_object" as const } }
          : {}),
      });

      try {
        return parseStructuredText(retryText);
      } catch {
        throw buildParseFailureError(
          provider,
          `Failed to parse OpenAI-compatible JSON response after retry (first_parse_error=${sanitizeParseError(firstParseError?.message || "unknown")})`,
          retryText,
        );
      }
    }
  }, options);
}
/** Returns true when at least one LLM provider API key is available. */
export function hasOpenAIKey(): boolean {
  return !!getAPIKey();
}

// -----------------------------------------------------------------------------
// Type Schemas for OpenAI Structure Responses
// -----------------------------------------------------------------------------

export type RawExtractedCandidate = {
  fullName: string;
  currentTitle?: string;
  currentCompany?: string;
  location?: string;
  headline?: string;
  seniorityLevel?: string;
  contactDetails?: {
    linkedinUrl?: string;
    email?: string;
    phone?: string;
    website?: string;
  };
  experiences?: Array<{ title: string; company: string; duration?: string }>;
  summary?: string;
  extractionConfidence: number; // 1-10
};

export const singleProfileSchema = {
  type: Type.OBJECT,
  properties: {
    fullName: {
      type: Type.STRING,
      description: "Person's first name and last name",
    },
    headline: {
      type: Type.STRING,
      description: "Professional headline or current summary statement",
    },
    currentCompany: {
      type: Type.STRING,
      description: "Name of current employer company",
    },
    currentTitle: { type: Type.STRING, description: "Current role/title" },
    seniorityLevel: {
      type: Type.STRING,
      description:
        "Buying authority classification: C-Suite / Founder-Owner / VP / Head / Director / Manager / IC / Assistant / Student / Unknown. Do not classify Assistant to CEO as C-Suite, student club founder as Founder-Owner, or Product Owner as Owner.",
    },
    companySizeEst: {
      type: Type.STRING,
      description: "1-10 / 11-50 / 51-200 / 201-500 / 500+ / UNKNOWN",
    },
    location: { type: Type.STRING, description: "City, State or Country" },
    summary: {
      type: Type.STRING,
      description: "A high-quality 2-3 sentence professional summary",
    },
    industry: {
      type: Type.STRING,
      description:
        "The industry category (e.g. Software, Finance, Healthcare, Real Estate)",
    },
    contactDetails: {
      type: Type.OBJECT,
      properties: {
        email: {
          type: Type.STRING,
          description:
            "Email if found, or INFERRED email pattern based on company data (e.g. jsmith@company.com). Label appropriately.",
        },
        phone: {
          type: Type.STRING,
          description: "Mobile or office contact phone number if found",
        },
        linkedinUrl: {
          type: Type.STRING,
          description: "Complete LinkedIn profile URL",
        },
        twitter: {
          type: Type.STRING,
          description: "Twitter/X handle if found",
        },
        website: {
          type: Type.STRING,
          description: "Company or personal portfolio website",
        },
      },
    },
    experiences: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Role title" },
          company: { type: Type.STRING, description: "Company name" },
          duration: {
            type: Type.STRING,
            description: "E.g., 2021 - Present or Jan 2020 - Dec 2022",
          },
          location: { type: Type.STRING, description: "Role location" },
          description: {
            type: Type.STRING,
            description: "Summary of main tasks/impact",
          },
        },
        required: ["title", "company"],
      },
    },
    education: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          school: {
            type: Type.STRING,
            description: "University or institution name",
          },
          degree: { type: Type.STRING, description: "B.S., M.S., Ph.D, etc." },
          fieldOfStudy: { type: Type.STRING, description: "Major study" },
          duration: { type: Type.STRING, description: "E.g., 2016 - 2020" },
        },
        required: ["school"],
      },
    },
    skills: { type: Type.ARRAY, items: { type: Type.STRING } },
    yearsInRole: {
      type: Type.STRING,
      description: "Calculated if dates available",
    },
    careerSignals: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3 bullet points - notable transitions, promotions",
    },
    techStackHints: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Tools/software mentioned",
    },
    painIndicators: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Quoted phrases or inferred needs",
    },
    enrichmentGaps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "List all MISSING fields that block outreach",
    },
    extractionConfidence: {
      type: Type.NUMBER,
      description:
        "How certain the LLM is that the extraction is accurate based directly on source evidence (1-10).",
    },
  },
  required: ["fullName", "extractionConfidence"],
};

export const APEX_SYSTEM_PROMPT = `
# SYSTEM PROMPT - LinkedIn CRM & Outreach Intelligence Platform
# Version 2.0 - Comprehensive Edition

## ROLE & IDENTITY

You are **Apex**, an elite B2B Sales Intelligence Engine embedded inside a LinkedIn CRM & Outreach Platform. You operate at the intersection of data enrichment, pipeline management, and precision outreach. You process raw lead signals and convert them into actionable, high-conversion sales assets.

Your core responsibilities span five operational domains:
1. **Lead Ingestion & Structural Parsing**
2. **AI Enrichment Pipeline**
3. **CRM Pipeline Management**
4. **Campaign Analytics & Scoring**
5. **Outreach Sequence Studio**

You are not a general assistant. Every output you produce must be structured, data-grounded, and immediately actionable. No filler, no generalities.

## DOMAIN 1 - LEAD INGESTION & STRUCTURAL PARSING

### Extraction Protocol
When given any raw input, extract and return a **structured schema** responding directly to the required properties (Full Name, Primary Title, Seniority Level, Company, Company Size Est., Industry, Location, LinkedIn URL, Email, Phone, Years in Role, Career Signals, Tech Stack Hints, Pain Indicators, ICP Match Score, Enrichment Gaps).

### ICP Match Scoring Logic
Score 1-10 based on these weighted factors:
- Title/seniority match to buyer persona: 35%
- Industry vertical match: 25%
- Company size fit: 20%
- Tech stack signal relevance: 10%
- Geographic relevance: 10%

## DOMAIN 2 - AI ENRICHMENT PIPELINE

### Auto-Enrichment Triggers
For each MISSING field, generate a prioritized enrichment task.

### Enrichment Inference Engine
When enrichment data is not available but contextual signals exist, infer intelligently:
**Email Pattern Inference:** Based on company name, generate the 3 most likely email formats. Label these as INFERRED - NOT VERIFIED.
**Company Enrichment:** Infer likely revenue band, tech stack category, funding stage, hiring velocity signal.
**Buying Signals Detection:** Scan input text for trigger phrases (Growth, Pain, Active buyer, Urgency).

### Enrichment Confidence Score
For every enriched field, append a confidence tag: [CONFIRMED], [INFERRED-HIGH], [INFERRED-LOW], [MISSING]

## DOMAIN 5 - OUTREACH SEQUENCE STUDIO

### The Golden Rules of Outreach
1. **No I-first openers.** Never begin a message with "I" - opens with their name, an observation, or a pattern interrupt.
2. **Specificity over flattery.** Reference something real.
3. **One CTA per message.** Never ask two questions. Never stack asks.
4. **Respect character limits.** LinkedIn Connection = 300 chars hard limit. Cold Email = target <150 words.
5. **No spam words.** Flag and refuse to use: "guaranteed," "synergy," "leverage," "disruptive," "game-changing," "revolutionary," "pick your brain," "hop on a quick call," "circle back."
6. **Always personalize with at least one lead-specific reference.**

### Sequence Architecture
For every lead, generate a **3-step sequence** across the selected channel:
STEP 1 - FIRST TOUCH: Pattern interrupt + one credible claim + soft CTA
STEP 2 - VALUE DEMONSTRATION: Deliver proof before asking again
STEP 3 - THE BUMP: Surface the thread, close or clear

### Rejection Criteria (refuse and explain)
Refuse to generate outreach copy that:
- Is longer than the channel limit
- Contains >2 spam trigger words
- Has no lead-specific personalization
- Uses manipulative pressure tactics
*End of System Prompt - Apex LinkedIn CRM Intelligence Platform v2.0*
`;

export const leadsArraySchema = {
  type: Type.ARRAY,
  items: singleProfileSchema,
};

export const searchQueriesSchema = {
  type: Type.OBJECT,
  properties: {
    queries: {
      type: Type.ARRAY,
      description:
        "Array of targeted query plan objects. Legacy string entries are tolerated by server normalization.",
      items: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description:
              "Plain search phrase. Do not include LinkedIn or site:.",
          },
          family: {
            type: Type.STRING,
            description:
              "persona_title | industry_vertical | pain_signal | growth_signal | tooling_signal | local_market | company_type",
          },
          intent: {
            type: Type.STRING,
            description:
              "find_decision_makers | find_buying_signal | expand_surface_area | recover_from_low_yield | reduce_duplicates",
          },
          expectedSignal: {
            type: Type.STRING,
            description:
              "Short reason this query should surface relevant prospects",
          },
          priority: {
            type: Type.NUMBER,
            description: "Lower numbers run first",
          },
          lane: { type: Type.STRING, description: "person | account | signal" },
          providerPreference: {
            type: Type.STRING,
            description: "tavily | brightdata | corroborate",
          },
          searchDepth: {
            type: Type.STRING,
            description:
              "basic | fast | ultra-fast | advanced. Prefer basic; advanced only for one high-value signal task.",
          },
          topic: { type: Type.STRING, description: "general | news" },
          timeRange: {
            type: Type.STRING,
            description: "week | month | year when recency is relevant",
          },
          country: {
            type: Type.STRING,
            description: "Country name only when explicit geography matters",
          },
        },
        required: ["query"],
      },
    },
  },
  required: ["queries"],
};

export const searchSpecSchema = {
  type: Type.OBJECT,
  properties: {
    mode: {
      type: Type.STRING,
      description:
        "person_first | account_first | signal_first | local_business",
    },
    person: {
      type: Type.OBJECT,
      properties: {
        includeTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
        excludeTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
        seniorities: { type: Type.ARRAY, items: { type: Type.STRING } },
        locations: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    company: {
      type: Type.OBJECT,
      properties: {
        industries: { type: Type.ARRAY, items: { type: Type.STRING } },
        keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
        locations: { type: Type.ARRAY, items: { type: Type.STRING } },
        employeeRange: {
          type: Type.OBJECT,
          properties: {
            min: { type: Type.NUMBER },
            max: { type: Type.NUMBER },
          },
        },
      },
    },
    signals: {
      type: Type.OBJECT,
      properties: {
        include: { type: Type.ARRAY, items: { type: Type.STRING } },
        recencyDays: { type: Type.NUMBER },
      },
    },
    exclusions: {
      type: Type.OBJECT,
      properties: {
        companies: { type: Type.ARRAY, items: { type: Type.STRING } },
        domains: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    maxPerCompany: { type: Type.NUMBER },
  },
};

// -----------------------------------------------------------------------------
// Lean per-task system prompts - scoped to what each call actually needs.
// Sending the full APEX_SYSTEM_PROMPT (~530 tokens) to every call wastes tokens
// on irrelevant rules (e.g. outreach golden rules during query generation).
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Lean per-task system prompts - scoped to what each call actually needs.
// Sending the full APEX_SYSTEM_PROMPT (~530 tokens) to every call wastes tokens
// on irrelevant rules (e.g. outreach golden rules during query generation).
// -----------------------------------------------------------------------------

/** Minimal prompt for Step 1 - query generation only. */
export const STRATEGIST_SYSTEM_PROMPT = `You are an expert B2B sales search strategist. Your sole task is to produce concise, targeted search query plan objects that surface LinkedIn profiles matching the user's lead criteria. Always use clean natural language keyword phrases (3 to 6 words) without raw boolean operator words (AND/OR/NOT) or site: operators. Balanced double quotes around multi-word roles or niches (e.g. "AI agency") and hyphenated negative exclusions (e.g. -platform) are permitted. Output only valid JSON.`;

/** Focused prompt for Step 3 - initial scouting only. Deep enrichment and email
 * discovery deliberately happen after manual selection. */
export const EXTRACTION_SYSTEM_PROMPT = `You are a B2B prospect scouting extraction engine. Extract only facts directly supported by source evidence and return valid JSON matching the schema exactly.
Rules: Never invent data. Use empty strings for missing fields. Do not score or judge relevance. Do not infer or generate email addresses. Do not invent employment history, company size, funding, intent, or timing. Classify seniorityLevel by actual buying authority, not substring matching: Assistant to CEO is Assistant, student club founder is Student/IC, Product Owner is not Company Owner, and CRO/CIO/Head of Engineering/VP of Sales are executive authority. Keep summaries under 140 characters and evidence reasons under 90 characters. If current employment is unclear from the evidence, set extractionConfidence below 6. If reasoning is visible, keep it outside the final JSON markers.`;

// -----------------------------------------------------------------------------
// Trimmed schema for bulk extraction.
// Drops high-token optional fields (careerSignals, experiences, education,
// techStackHints, painIndicators) that are better enriched individually on
// committed leads. Cuts schema token cost from ~800 to ~300 tokens (~40% saving).
// -----------------------------------------------------------------------------

export const bulkSingleProfileSchema = {
  type: Type.OBJECT,
  properties: {
    fullName: { type: Type.STRING, description: "Full name" },
    headline: { type: Type.STRING, description: "Professional headline" },
    currentCompany: { type: Type.STRING, description: "Current company" },
    currentTitle: { type: Type.STRING, description: "Current role/title" },
    seniorityLevel: {
      type: Type.STRING,
      description:
        "C-Suite, Founder-Owner, VP, Director, Manager, or IC",
    },
    companySizeEst: {
      type: Type.STRING,
      description: "Company size if stated, else UNKNOWN",
    },
    location: { type: Type.STRING, description: "City, State, or Country" },
    industry: {
      type: Type.STRING,
      description: "Industry category",
    },
    contactDetails: {
      type: Type.OBJECT,
      properties: {
        linkedinUrl: {
          type: Type.STRING,
          description: "LinkedIn URL from source LINK",
        },
        website: {
          type: Type.STRING,
          description: "Company website",
        },
      },
    },
    sourceProvider: {
      type: Type.STRING,
      description: "tavily or brightdata",
    },
    evidenceReasons: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "1 short evidence reason",
    },
    extractionConfidence: {
      type: Type.NUMBER,
      description: "Confidence 1-10",
    },
  },
  required: ["fullName", "extractionConfidence"],
};

export const bulkLeadsArraySchema = {
  type: Type.ARRAY,
  items: bulkSingleProfileSchema,
};
