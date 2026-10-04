import crypto from "crypto";
import {
  ApiKeyPool,
  KeyRotationError,
  executeWithKeyRotation,
  parseApiKeys,
} from "./keyRotator.js";
import { sendDirectLangfuseTrace } from "./langfuse.js";
import { getLlmCacheEntry, upsertLlmCacheEntry } from "../db.js";

export const Type = {
  STRING: "STRING",
  NUMBER: "NUMBER",
  INTEGER: "INTEGER",
  BOOLEAN: "BOOLEAN",
  ARRAY: "ARRAY",
  OBJECT: "OBJECT",
};

// -----------------------------------------------------------------------------
// OpenAI-compatible REST API helpers with direct provider fallback chain.
// -----------------------------------------------------------------------------

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

type LLMProvider = {
  id: "primary" | "openrouter" | "groq" | "tokenharbor" | "atria";
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
  queueWaitMs?: number;
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
  /**
   * Providers this breaker disabled because process-wide health marked them OUT. These
   * entries are released when health reaches half-open, so a tripped provider is re-tested
   * within the same session. Manually disabled providers are never released automatically.
   */
  healthDisabledProviderIds?: Set<LLMProvider["id"]>;
};

export type LLMRoutingTier = "fast" | "reasoning" | "balanced";

export type LLMExecutionOptions = {
  onProviderAttempt?: (attempt: LLMProviderAttempt) => void;
  onUsage?: (usage: LLMUsage) => void;
  timeoutMs?: number;
  maxRetries?: number;
  circuitBreaker?: LLMSessionCircuitBreaker;
  signal?: AbortSignal;
  reasoningEffort?: "low" | "medium" | "high";
  routingTier?: LLMRoutingTier;
  metadata?: Record<string, any>;
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
    healthDisabledProviderIds: new Set<LLMProvider["id"]>(),
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

// Atria is a self-hosted vLLM deployment (see docs/adr/0007-industry-agnostic-pipeline-and-dual-provider-concurrency.md).
// It is a REASONING model: reasoning_content is emitted and billed before any visible
// content, so a small max_tokens yields content:null with finish_reason:"length".
// Registered only when ATRIA_API_KEY is set. When registered it is the first provider of the
// primary pair (Atria + Byesu, one request each, in parallel); Groq and OpenRouter/Mistral
// form the failsafe tier.
const DEFAULT_ATRIA_BASE = "https://api.atria-asi.ai/v1";
const DEFAULT_ATRIA_MODEL = "Atria-Dawn-Preview";

// Token Harbor is retired from the provider chain (see isTokenHarborActive); this default
// expiry (Oct 19, 2026 00:00:00 +06:00) only gates the legacy active check.
const DEFAULT_TOKEN_HARBOR_EXPIRATION_MS = new Date(
  "2026-10-19T00:00:00+06:00",
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

function getOpenRouterHeaders(baseUrl?: string): Record<string, string> {
  if (baseUrl && !baseUrl.includes("openrouter.ai")) {
    return {};
  }
  const headers: Record<string, string> = {
    "X-Title": process.env.OPENROUTER_APP_TITLE || "Apex CRM",
  };
  const referer = process.env.OPENROUTER_HTTP_REFERER || process.env.APP_URL;
  if (referer && referer !== "MY_APP_URL") {
    headers["HTTP-Referer"] = referer;
  }
  return headers;
}

export function isAtriaConfigured(): boolean {
  return Boolean(process.env.ATRIA_API_KEY);
}

export function isAtriaPrimary(): boolean {
  const providers = getConfiguredLLMProviders();
  return providers[0]?.id === "atria";
}

/** Returns the Atria provider when ATRIA_API_KEY is set, otherwise null (disabled). */
function getAtriaProvider(): LLMProvider | null {
  const apiKey = process.env.ATRIA_API_KEY || "";
  if (!apiKey) return null;
  return {
    id: "atria",
    name: process.env.ATRIA_PROVIDER_NAME || "Atria",
    baseUrl: cleanBaseUrl(process.env.ATRIA_BASE || DEFAULT_ATRIA_BASE),
    model: process.env.ATRIA_MODEL || DEFAULT_ATRIA_MODEL,
    apiKey,
  };
}

function getDirectLLMProviderCandidates(): LLMProvider[] {
  const direct: LLMProvider[] = [];

  // Tier 1: Primary Pair (Atria Primary, Byesu Secondary)
  const atria = getAtriaProvider();
  if (atria) direct.push(atria);

  direct.push({
    id: "primary",
    name: process.env.OPENAI_PROVIDER_NAME || "Byesu",
    baseUrl: cleanBaseUrl(process.env.OPENAI_BASE || DEFAULT_PRIMARY_BASE),
    model: process.env.OPENAI_MODEL || DEFAULT_PRIMARY_MODEL,
    apiKey: process.env.OPENAI_API_KEY || process.env.BYESU_API_KEY || "",
  });

  // Tier 2: Failsafe Pair (Groq Failsafe 1, OpenRouter/Mistral Failsafe 2)
  direct.push({
    id: "groq",
    name: "Groq",
    baseUrl: cleanBaseUrl(process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE),
    model: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
    apiKey: process.env.GROQ_API_KEY || "",
  });

  const openRouterBase = cleanBaseUrl(
    process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE,
  );
  direct.push({
    id: "openrouter",
    name: process.env.OPENROUTER_PROVIDER_NAME || "OpenRouter",
    baseUrl: openRouterBase,
    model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
    apiKey: process.env.OPENROUTER_API_KEY || "",
    headers: getOpenRouterHeaders(openRouterBase),
  });

  return direct;
}

function getLLMProviderCandidates(): LLMProvider[] {
  return getDirectLLMProviderCandidates();
}

function getConfiguredLLMProviders(): LLMProvider[] {
  return getDirectLLMProviderCandidates().filter(
    (provider) => !!provider.apiKey,
  );
}

const GROQ_MAX_OUTPUT_TOKENS = Number(
  process.env.GROQ_MAX_OUTPUT_TOKENS || 950,
);
const REASONING_MODEL_REGEX = /\b(gpt-5|gpt-6|o[134]|deepseek-r1|reasoning)\b/i;

const TASK_REASONING_EFFORT: Record<string, "low" | "medium" | "high"> = {
  strategist: "medium",
  extraction: "low",
  intent_signals: "low",
  company_attribution: "low",
  judge: "medium",
  contract: "medium",
  post_intent: "low",
  enrich: "low",
};

let atriaRejectsReasoningEffort = false;

export function resetAtriaReasoningEffortRefusal(): void {
  atriaRejectsReasoningEffort = false;
}

export function isReasoningProvider(provider: { id: string; model: string }): boolean {
  return provider.id === "atria" || REASONING_MODEL_REGEX.test(provider.model);
}

export function parseFastProviderIds(raw?: string): string[] {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Reorders within tiers only: Primary tier (Atria, Byesu) remains primary,
 * Failsafe tier (Groq, OpenRouter) remains failsafe.
 */
export function orderProvidersForTier<T extends { id: string }>(
  providers: T[],
  tier: LLMRoutingTier | undefined,
  fastProviderIds: string[],
): T[] {
  if (tier !== "fast" || fastProviderIds.length === 0) return providers;
  // LLM_FAST_PROVIDER_IDS may reorder providers inside a tier, never promote a failsafe
  // provider ahead of the primary pair.
  const tierRank = (provider: T) => (provider.id === "atria" || provider.id === "primary" ? 0 : 1);
  const rank = (provider: T) => {
    const index = fastProviderIds.indexOf(provider.id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort(
      (a, b) =>
        tierRank(a.provider) - tierRank(b.provider) ||
        rank(a.provider) - rank(b.provider) ||
        a.index - b.index,
    )
    .map(({ provider }) => provider);
}

export function describeLLMRoute(tier?: LLMRoutingTier): {
  providerId: string | null;
  reasoning: boolean;
  outputTokenCap: number;
} {
  const ordered = orderProvidersForTier(
    getConfiguredLLMProviders(),
    tier,
    parseFastProviderIds(process.env.LLM_FAST_PROVIDER_IDS),
  );
  // Health-aware: when Atria and Byesu are both out the failsafe serves the call, so callers
  // that size batches from this (e.g. Groq's 950-token cap) must see the failsafe provider.
  const first = ordered.find((p) => !isProviderOut(p.id)) ?? ordered[0];
  if (!first) return { providerId: null, reasoning: false, outputTokenCap: Number.POSITIVE_INFINITY };
  return {
    providerId: first.id,
    reasoning: isReasoningProvider(first),
    outputTokenCap: first.id === "groq" ? GROQ_MAX_OUTPUT_TOKENS : Number.POSITIVE_INFINITY,
  };
}

export function getLLMProviderSummaries(): LLMProviderSummary[] {
  return getLLMProviderCandidates().map(({ apiKey, headers, ...provider }) => ({
    ...provider,
    configured: !!apiKey,
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

export const CLOUDFLARE_MAX_TIMEOUT_MS = 115_000;

/**
 * Atria (api.atria-asi.ai) is a self-hosted vLLM deployment behind an Aliyun ALB
 * (Singapore ap-southeast-1), NOT behind Cloudflare (endpoint probe of 2026-09-16; see ADR-0007).
 * The 115s CLOUDFLARE_MAX_TIMEOUT_MS therefore does not apply to Atria traffic.
 * Timeout scales dynamically with prompt weight and reasoning budget up to this safety ceiling.
 */
export const ATRIA_MAX_TIMEOUT_MS = 600_000;

/**
 * Legacy global single-slot queue. Provider calls bypass it (sendChatCompletion always passes
 * a providerId); concurrency is the per-provider slots in withProviderFallback (Atria 1 +
 * Byesu 1, in parallel). runWithLlmStageLane is a passthrough kept for API compatibility.
 */
export type LLMStageLane = 'strategist' | 'extraction' | 'judge' | 'general';

export function runWithLlmStageLane<T>(_lane: LLMStageLane, fn: () => Promise<T>): Promise<T> {
  return fn();
}

let activeLlmSlots = 0;
const llmWaitQueue: Array<{
  run: () => void;
  onAbort: () => void;
  refreshTimer?: () => void;
}> = [];

function resolveDynamicQueueTimeoutMs(): number {
  const configured = Number(process.env.LLM_QUEUE_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0 && configured < 5_000) {
    return configured;
  }
  const providerCeiling = isAtriaConfigured()
    ? (Number(process.env.ATRIA_MAX_TIMEOUT_MS) > 0
        ? Number(process.env.ATRIA_MAX_TIMEOUT_MS)
        : ATRIA_MAX_TIMEOUT_MS)
    : CLOUDFLARE_MAX_TIMEOUT_MS;
  return Math.max(
    Number.isFinite(configured) && configured > 0 ? configured : 60_000,
    providerCeiling + 15_000,
  );
}

function pumpLlmQueue() {
  while (activeLlmSlots < 1 && llmWaitQueue.length > 0) {
    const next = llmWaitQueue.shift();
    if (next) {
      activeLlmSlots++;
      next.run();
    }
  }
  for (const waiter of llmWaitQueue) {
    waiter.refreshTimer?.();
  }
}

export function withSequentialLLMExecution<T>(
  task: () => Promise<T>,
  signal?: AbortSignal | null,
  _laneOverride?: LLMStageLane,
  providerId?: string,
): Promise<T> {
  if (signal?.aborted) {
    const abortErr = new Error("LLM request was aborted by caller.");
    abortErr.name = "AbortError";
    return Promise.reject(abortErr);
  }
  // When provider-level concurrency is active, execute directly since withProviderFallback
  // already guarantees per-provider isolation and capacity bounds.
  if (providerId) {
    return task();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let waitEntry: { run: () => void; onAbort: () => void; refreshTimer?: () => void } | null = null;
    let queueTimer: NodeJS.Timeout | null = null;

    const armQueueTimer = () => {
      if (settled) return;
      if (queueTimer) clearTimeout(queueTimer);
      const queueTimeoutMs = resolveDynamicQueueTimeoutMs();
      queueTimer = setTimeout(() => {
        if (settled) return;
        handleAbort("LLM request timed out waiting in execution queue.");
      }, queueTimeoutMs);
    };
    armQueueTimer();

    const cleanupAbort = () => {
      if (queueTimer) {
        clearTimeout(queueTimer);
        queueTimer = null;
      }
      if (signal && waitEntry?.onAbort) {
        signal.removeEventListener("abort", waitEntry.onAbort);
      }
    };

    const handleAbort = (reason?: unknown) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      const idx = llmWaitQueue.findIndex((entry) => entry === waitEntry);
      if (idx !== -1) {
        llmWaitQueue.splice(idx, 1);
      }
      const msg = typeof reason === "string" ? reason : "LLM request was aborted by caller.";
      const abortErr = new Error(msg);
      abortErr.name = msg.includes("timed out") ? "TimeoutError" : "AbortError";
      reject(abortErr);
    };

    const executeTask = async () => {
      cleanupAbort();
      if (settled || signal?.aborted) {
        activeLlmSlots = Math.max(0, activeLlmSlots - 1);
        pumpLlmQueue();
        if (!settled) {
          settled = true;
          const abortErr = new Error("LLM request was aborted by caller.");
          abortErr.name = "AbortError";
          reject(abortErr);
        }
        return;
      }

      try {
        const result = await task();
        settled = true;
        resolve(result);
      } catch (err) {
        settled = true;
        reject(err);
      } finally {
        activeLlmSlots = Math.max(0, activeLlmSlots - 1);
        pumpLlmQueue();
      }
    };

    waitEntry = {
      run: executeTask,
      onAbort: handleAbort,
      refreshTimer: armQueueTimer,
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    if (activeLlmSlots < 1) {
      activeLlmSlots++;
      executeTask();
    } else {
      llmWaitQueue.push(waitEntry);
    }
  });
}

/**
 * Executes an HTTP fetch with automatic retry on 5xx/429.
 * When a request fails, backoff sleep listens to callerSignal and throws AbortError immediately.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS || CLOUDFLARE_MAX_TIMEOUT_MS),
  maxRetries?: number,
  isAtria = false,
  providerId?: string,
): Promise<Response> {
  const atriaConfiguredBase = process.env.ATRIA_BASE
    ? cleanBaseUrl(process.env.ATRIA_BASE)
    : "";
  const isAtriaUrl =
    isAtria ||
    /(^|[/.])atria-asi\.ai(?=[/:]|$)/i.test(url) ||
    (atriaConfiguredBase ? url.startsWith(atriaConfiguredBase) : false);

  // Precedence: explicit per-call value, then LLM_MAX_RETRIES, then 1. An empty env var is
  // "unset" (Number("") would otherwise silently become 0 and disable retries).
  const envRetriesRaw = process.env.LLM_MAX_RETRIES;
  const envRetries =
    envRetriesRaw !== undefined && envRetriesRaw.trim() !== ""
      ? Number(envRetriesRaw)
      : Number.NaN;
  const rawRetries =
    typeof maxRetries === "number" && Number.isFinite(maxRetries) && maxRetries >= 0
      ? maxRetries
      : envRetries;
  const effectiveMaxRetries =
    Number.isFinite(rawRetries) && rawRetries >= 0 ? Math.floor(rawRetries) : 1;

  const rawTimeout = Number(timeoutMs || process.env.LLM_TIMEOUT_MS || CLOUDFLARE_MAX_TIMEOUT_MS);
  const maxAtriaCeiling =
    Number(process.env.ATRIA_MAX_TIMEOUT_MS) > 0
      ? Number(process.env.ATRIA_MAX_TIMEOUT_MS)
      : ATRIA_MAX_TIMEOUT_MS;
  const effectiveTimeoutMs = isAtriaUrl
    ? Math.min(
        Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : maxAtriaCeiling,
        maxAtriaCeiling,
      )
    : Math.min(
        Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : CLOUDFLARE_MAX_TIMEOUT_MS,
        CLOUDFLARE_MAX_TIMEOUT_MS,
      );
  const retry429 =
    process.env.LLM_RETRY_429 !== "false" && effectiveMaxRetries > 0;

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
    if (callerSignal?.aborted) {
      const abortErr = new Error("LLM request was aborted by caller.");
      abortErr.name = "AbortError";
      throw abortErr;
    }

    let controller: AbortController | undefined;
    let timer: NodeJS.Timeout | undefined;

    try {
      const res = await withSequentialLLMExecution(async () => {
        controller = new AbortController();
        timer = setTimeout(() => controller?.abort(), effectiveTimeoutMs);
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
            callerSignal.addEventListener("abort", () => controller?.abort(), {
              once: true,
            });
          }
        }
        return await fetch(url, {
          ...requestOptions,
          signal: compositeSignal,
        });
      }, callerSignal, undefined, providerId);

      if (timer) clearTimeout(timer);
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

      const statusMaxRetries = effectiveMaxRetries;
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
      if (timer) clearTimeout(timer);
      lastResponse = undefined;
      const isCallerAbort = Boolean(callerSignal?.aborted);
      const isFetchTimeout =
        !isCallerAbort &&
        ((controller && controller.signal.aborted) ||
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
          `LLM request timed out after ${Math.round(effectiveTimeoutMs / 1000)}s${isAtriaUrl ? " (adaptive reasoning timeout)" : " (bounded within Cloudflare 120s limit)"}`,
        );
        break;
      }
      lastError =
        err instanceof Error
          ? err
          : new Error(String(err));
      if (attempt < effectiveMaxRetries) {
        const waitMs = Math.pow(2, attempt) * 2000;
        console.warn(
          `[llm] Fetch error on attempt ${attempt + 1}/${effectiveMaxRetries + 1}: ${lastError.message}. Retrying in ${waitMs}ms...`,
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

// --- Provider-Affinity Concurrency & Parallel Execution ---
// User requirement: Atria (primary) and Byesu (secondary) run concurrently with 1 request each.
// Atria is prioritized whenever idle.

export function getProviderConcurrencyLimit(providerId: string): number {
  if (providerId === "atria") {
    const configured = Number(process.env.ATRIA_CONCURRENT_SLOTS);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1;
  }
  if (providerId === "primary") {
    const configured = Number(process.env.BYESU_CONCURRENT_SLOTS);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 1;
  }
  return 1;
}

export const providerActiveSlots = new Map<string, number>();

export function getProviderActiveSlots(providerId: string): number {
  return providerActiveSlots.get(providerId) || 0;
}

export function isProviderSlotFree(providerId: string): boolean {
  return getProviderActiveSlots(providerId) < getProviderConcurrencyLimit(providerId);
}

export function acquireProviderSlot(providerId: string): void {
  const current = providerActiveSlots.get(providerId) || 0;
  providerActiveSlots.set(providerId, current + 1);
}

export function releaseProviderSlot(providerId: string): void {
  const current = providerActiveSlots.get(providerId) || 0;
  providerActiveSlots.set(providerId, Math.max(0, current - 1));
  pumpProviderSlotWaitQueue();
}

type ProviderSlotWaiter = {
  getCandidates: () => LLMProvider[];
  resolve: (provider: LLMProvider) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal | null;
  isInteractive?: boolean;
  enqueuedAt: number;
  cleanup?: () => void;
  /** True when the waiter can never be served (e.g. every candidate went OUT). */
  isAbandoned?: () => boolean;
};

const providerSlotWaitQueue: ProviderSlotWaiter[] = [];
let isPumpingSlots = false;

export function pumpProviderSlotWaitQueue(): void {
  if (isPumpingSlots) return;
  isPumpingSlots = true;
  try {
    for (let i = 0; i < providerSlotWaitQueue.length; i++) {
      const waiter = providerSlotWaitQueue[i];
      if (waiter.signal?.aborted) continue;
      if (waiter.isAbandoned?.()) {
        providerSlotWaitQueue.splice(i, 1);
        i--;
        const abandonedErr = new Error("Every provider this call was waiting for is out.");
        abandonedErr.name = "ProviderSlotAbandonedError";
        waiter.reject(abandonedErr);
        continue;
      }
      const candidates = waiter.getCandidates();
      const available = candidates.find(
        (p) => getProviderActiveSlots(p.id) < getProviderConcurrencyLimit(p.id),
      );
      if (available) {
        providerSlotWaitQueue.splice(i, 1);
        i--;
        waiter.cleanup?.();
        acquireProviderSlot(available.id);
        waiter.resolve(available);
      }
    }
  } finally {
    isPumpingSlots = false;
  }
}

export function waitForProviderSlot(
  getCandidates: () => LLMProvider[],
  signal?: AbortSignal | null,
  timeoutMs = resolveDynamicQueueTimeoutMs(),
  isInteractive = false,
  isAbandoned?: () => boolean,
): Promise<LLMProvider> {
  return new Promise<LLMProvider>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    const enqueuedAt = Date.now();

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const idx = providerSlotWaitQueue.findIndex((w) => w === waiter);
      if (idx !== -1) providerSlotWaitQueue.splice(idx, 1);
      const abortErr = new Error("LLM request was aborted by caller.");
      abortErr.name = "AbortError";
      reject(abortErr);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const idx = providerSlotWaitQueue.findIndex((w) => w === waiter);
      if (idx !== -1) providerSlotWaitQueue.splice(idx, 1);
      const timeoutErr = new Error("LLM request timed out waiting for provider concurrency slot.");
      timeoutErr.name = "TimeoutError";
      reject(timeoutErr);
    }, timeoutMs);

    const waiter: ProviderSlotWaiter = {
      getCandidates,
      resolve: (p) => {
        if (settled) {
          releaseProviderSlot(p.id);
          return;
        }
        settled = true;
        cleanup();
        resolve(p);
      },
      reject: (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
      signal,
      isInteractive,
      enqueuedAt,
      cleanup,
      isAbandoned,
    };

    if (isInteractive) {
      const insertIdx = providerSlotWaitQueue.findIndex((w) => !w.isInteractive);
      if (insertIdx === -1) {
        providerSlotWaitQueue.push(waiter);
      } else {
        providerSlotWaitQueue.splice(insertIdx, 0, waiter);
      }
    } else {
      providerSlotWaitQueue.push(waiter);
    }
  });
}

export type ProviderHealthStatus = "healthy" | "cooling_down" | "out" | "half_open";

export type ProviderHealthRecord = {
  status: ProviderHealthStatus;
  consecutiveFatalFailures: number;
  outUntil?: number;
  cooldownUntil?: number;
  outReason?: string;
  halfOpenActive?: boolean;
};

export const providerHealthState = new Map<string, ProviderHealthRecord>();

export function getProviderHealth(providerId: string): ProviderHealthRecord {
  let record = providerHealthState.get(providerId);
  if (!record) {
    record = {
      status: "healthy",
      consecutiveFatalFailures: 0,
    };
    providerHealthState.set(providerId, record);
  }
  const now = Date.now();
  if (record.status === "out" && record.outUntil && now >= record.outUntil) {
    record.status = "half_open";
    record.halfOpenActive = false;
  } else if (record.status === "cooling_down" && record.cooldownUntil && now >= record.cooldownUntil) {
    record.status = "healthy";
    record.cooldownUntil = undefined;
  }
  return record;
}

/** Breaker entries that process-wide health added, so they can be released on recovery. */
function markBreakerDisabledByHealth(
  breaker: LLMSessionCircuitBreaker | undefined,
  providerId: string,
): void {
  if (!breaker) return;
  const pid = providerId as LLMProvider["id"];
  breaker.disabledProviderIds.add(pid);
  if (!breaker.healthDisabledProviderIds) breaker.healthDisabledProviderIds = new Set();
  breaker.healthDisabledProviderIds.add(pid);
}

/**
 * Re-admits a provider this breaker disabled because health marked it OUT, once that OUT
 * window has ended (half-open). Without this a tripped provider stayed disabled for the
 * rest of the session, since only a successful attempt cleared it and none was ever made.
 */
function releaseRecoveredBreakerEntry(
  providerId: string,
  breaker: LLMSessionCircuitBreaker | undefined,
): void {
  const pid = providerId as LLMProvider["id"];
  if (!breaker?.healthDisabledProviderIds?.has(pid)) return;
  if (getProviderHealth(providerId).status === "out") return;
  breaker.healthDisabledProviderIds.delete(pid);
  breaker.disabledProviderIds.delete(pid);
  breaker.failureCounts[pid] = 0;
}

/**
 * OUT means unusable: quota exhausted, auth failure, repeated fatal failures, or a manually
 * opened session breaker. A provider that is merely busy or cooling down is NOT out.
 */
export function isProviderOut(providerId: string, breaker?: LLMSessionCircuitBreaker): boolean {
  releaseRecoveredBreakerEntry(providerId, breaker);
  if (breaker?.disabledProviderIds?.has(providerId as any)) return true;
  return getProviderHealth(providerId).status === "out";
}

/** Briefly backing off after a rate limit, timeout, or transient 5xx. Not an outage. */
export function isProviderCoolingDown(providerId: string): boolean {
  const until = providerCooldowns.get(providerId);
  return Boolean(until && Date.now() < until);
}

export function getProviderHealthSummaries(): Record<
  string,
  { status: ProviderHealthStatus; consecutiveFatalFailures: number; outReason?: string }
> {
  const summaries: Record<string, any> = {};
  for (const p of getDirectLLMProviderCandidates()) {
    const h = getProviderHealth(p.id);
    summaries[p.id] = {
      status: h.status,
      consecutiveFatalFailures: h.consecutiveFatalFailures,
      outReason: h.outReason,
    };
  }
  return summaries;
}

export function recordProviderSuccess(providerId: string, breaker?: LLMSessionCircuitBreaker): void {
  const record = getProviderHealth(providerId);
  record.status = "healthy";
  record.consecutiveFatalFailures = 0;
  record.outUntil = undefined;
  record.cooldownUntil = undefined;
  record.outReason = undefined;
  record.halfOpenActive = false;
  providerCooldowns.delete(providerId);
  if (breaker) {
    const pid = providerId as LLMProvider["id"];
    breaker.disabledProviderIds.delete(pid);
    breaker.healthDisabledProviderIds?.delete(pid);
    const prev = Number(breaker.failureCounts[pid] || 0);
    breaker.failureCounts[pid] = Math.max(0, prev - 1);
  }
}

function resolveAuthOutMs(): number {
  const configured = Number(process.env.LLM_AUTH_OUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 60_000;
}

function resolveQuotaOutMs(): number {
  const configured = Number(process.env.LLM_QUOTA_OUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60 * 60_000;
}

function startProviderCooldown(providerId: string, cooldownMs: number): void {
  if (!(cooldownMs > 0)) return;
  const record = getProviderHealth(providerId);
  // An OUT or half-open provider keeps that state; a cooldown never shortens an outage.
  if (record.status === "out" || record.status === "half_open") return;
  record.status = "cooling_down";
  record.cooldownUntil = Date.now() + cooldownMs;
  providerCooldowns.set(providerId, record.cooldownUntil);
  // Wake queued calls the moment the cooldown ends instead of at the next slot release.
  const timer = setTimeout(() => pumpProviderSlotWaitQueue(), cooldownMs + 5);
  if (typeof timer.unref === "function") timer.unref();
}

export function recordProviderFailure(providerId: string, error: Error, breaker?: LLMSessionCircuitBreaker): void {
  const record = getProviderHealth(providerId);
  // Any finished attempt ends a half-open probe; the outcome below decides the next state.
  record.halfOpenActive = false;
  const status = error instanceof LLMProviderError ? error.status : undefined;
  const untrusted = hasUntrustedMessage(error);
  const isAuth = status === 401 || status === 403;
  const isQuota = isExhaustedQuotaError(
    status,
    error.message,
    error instanceof LLMProviderError ? error.errorCode : undefined,
  );

  if (isAuth || isQuota) {
    // Bounded: once the window ends the provider is re-tested with a single half-open probe,
    // so a rotated key or refilled quota is picked up without a restart.
    record.status = "out";
    record.outUntil = Date.now() + (isAuth ? resolveAuthOutMs() : resolveQuotaOutMs());
    record.outReason = isAuth ? "Authentication failure" : "Quota exhausted (429 code 1300)";
    record.halfOpenActive = false;
    markBreakerDisabledByHealth(breaker, providerId);
    console.warn(`[llm] ${providerId} marked OUT: ${record.outReason}.`);
    return;
  }

  const isFullRequestTimeout = !untrusted && /timed out after/i.test(error.message);
  const configuredCooldown =
    process.env.LLM_PROVIDER_COOLDOWN_MS !== undefined &&
    process.env.LLM_PROVIDER_COOLDOWN_MS.trim() !== ""
      ? Number(process.env.LLM_PROVIDER_COOLDOWN_MS)
      : undefined;
  const cooldownMs =
    configuredCooldown !== undefined && Number.isFinite(configuredCooldown)
      ? configuredCooldown
      : isFullRequestTimeout
        ? 5_000
        : 15_000;

  if (isCircuitBreakingProviderFailure(error)) {
    const pid = providerId as LLMProvider["id"];
    if (breaker) breaker.failureCounts[pid] = (breaker.failureCounts[pid] || 0) + 1;
    record.consecutiveFatalFailures++;
    const threshold = breaker?.failureThreshold || 3;
    if (record.status === "half_open" || record.consecutiveFatalFailures >= threshold) {
      const wasProbe = record.status === "half_open";
      record.status = "out";
      record.outUntil = Date.now() + 60_000;
      record.outReason = wasProbe
        ? `Half-open re-test failed: ${truncateProviderError(error.message)}`
        : `${record.consecutiveFatalFailures} consecutive fatal failures`;
      record.halfOpenActive = false;
      providerCooldowns.delete(providerId);
      markBreakerDisabledByHealth(breaker, providerId);
      console.warn(`[llm] ${providerId} marked OUT for 60s (${record.outReason}).`);
      return;
    }
    startProviderCooldown(providerId, cooldownMs);
    return;
  }

  // Rate limits and transient upstream errors back off briefly. Bad answers (unparseable
  // output, schema/validation errors) are quality failures, not availability failures: they
  // neither start a cooldown nor count toward OUT.
  const isRateLimited =
    status === 429 || (!untrusted && /429|rate[-_ ]?limit/i.test(error.message));
  const isTransientUpstream =
    (status !== undefined && status >= 500) ||
    (!untrusted && /fetch failed|econnreset|econnrefused|socket hang up|network/i.test(error.message));
  if (isRateLimited || isTransientUpstream || isFullRequestTimeout) {
    startProviderCooldown(providerId, cooldownMs);
  }
}

export function clearProviderCooldowns(): void {
  providerCooldowns.clear();
  for (const health of providerHealthState.values()) {
    if (health.status === "cooling_down") {
      health.status = "healthy";
      health.cooldownUntil = undefined;
    }
  }
  pumpProviderSlotWaitQueue();
}

class ProviderOutageError extends Error {
  readonly isNonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = "ProviderOutageError";
  }
}

/** How long background work waits for Atria/Byesu to recover when no failsafe is available. */
function resolvePrimaryRecoveryMaxWaitMs(): number {
  const configured = Number(process.env.LLM_PRIMARY_RECOVERY_MAX_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 10 * 60_000;
}

type AttemptResult<T> = { ok: true; val: T } | { ok: false; err: Error; isTimeout: boolean };

async function withProviderFallback<T>(
  operation: (
    provider: LLMProvider,
    options: LLMExecutionOptions,
  ) => Promise<T>,
  executionOptions: LLMExecutionOptions = {},
  outagePauseStartedAt?: number,
): Promise<T> {
  if (executionOptions.signal?.aborted) {
    const cancelError = new Error("LLM request was aborted by caller.");
    cancelError.name = "AbortError";
    throw cancelError;
  }

  const allConfigured = getConfiguredLLMProviders();
  if (allConfigured.length === 0) {
    throw new Error(
      "No LLM provider available. Configure ATRIA_API_KEY, OPENAI_API_KEY/BYESU_API_KEY, GROQ_API_KEY, or OPENROUTER_API_KEY in .env.",
    );
  }

  const breaker = executionOptions.circuitBreaker;
  const fastIds = parseFastProviderIds(process.env.LLM_FAST_PROVIDER_IDS);
  const primaryTier = orderProvidersForTier(
    allConfigured.filter((p) => p.id === "atria" || p.id === "primary"),
    executionOptions.routingTier,
    fastIds,
  );
  const failsafeTier = orderProvidersForTier(
    allConfigured.filter((p) => p.id === "groq" || p.id === "openrouter"),
    executionOptions.routingTier,
    fastIds,
  );

  const isBackgroundSession = Boolean(executionOptions.metadata?.sessionId);
  const isInteractive = Boolean(
    executionOptions.metadata?.isInteractive ||
    executionOptions.metadata?.priority === "high",
  );
  // Health probes report status; they must not move provider health or reach the failsafe.
  const isHealthProbe = Boolean(executionOptions.metadata?.healthProbe);

  // The budget must fit one full Atria attempt plus one full Byesu attempt, so it never
  // blocks the partner fallback. It only bounds the extra in-pair retry and the failsafe.
  const atriaCeilingMs =
    Number(process.env.ATRIA_MAX_TIMEOUT_MS) > 0
      ? Number(process.env.ATRIA_MAX_TIMEOUT_MS)
      : ATRIA_MAX_TIMEOUT_MS;
  const overallCallBudgetMs = atriaCeilingMs + CLOUDFLARE_MAX_TIMEOUT_MS + 30_000;
  // Queue time is not execution time, so slot waits are excluded from the budget.
  const budgetClockStartedAt = Date.now();
  let queueWaitTotalMs = 0;
  const budgetExceeded = () =>
    Date.now() - budgetClockStartedAt - queueWaitTotalMs > overallCallBudgetMs;
  const budgetError = () => {
    const err = new Error(
      `LLM call exceeded overall time budget of ${Math.round(overallCallBudgetMs / 1000)}s.`,
    );
    err.name = "TimeoutError";
    (err as any).isNonRetryable = true;
    (err as any).isFatalTimeout = true;
    return err;
  };

  const executeAttempt = async (provider: LLMProvider, queueWaitMs = 0): Promise<AttemptResult<T>> => {
    const attemptStartedAt = Date.now();
    let attemptUsage: LLMUsage | undefined;
    const opts: LLMExecutionOptions = {
      ...executionOptions,
      onUsage: (usage) => {
        attemptUsage = usage;
        executionOptions.onUsage?.(usage);
      },
    };

    const health = getProviderHealth(provider.id);
    if (health.status === "half_open" && !isHealthProbe) health.halfOpenActive = true;

    try {
      const val = await operation(provider, opts);
      recordProviderSuccess(provider.id, breaker);
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
        latencyMs: Date.now() - attemptStartedAt,
        queueWaitMs,
      });
      return { ok: true, val };
    } catch (error: any) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const cause = (normalized as { cause?: { name?: string } }).cause;
      const isAbort =
        executionOptions.signal?.aborted ||
        normalized.name === "AbortError" ||
        cause?.name === "AbortError" ||
        (normalized as unknown as { code?: string }).code === "ABORT_ERR";
      if (isAbort) {
        throw normalized;
      }

      const errStatus = normalized instanceof LLMProviderError ? normalized.status : undefined;
      const isTimeout =
        !hasUntrustedMessage(normalized) &&
        (/timed?\s*out|timeout/i.test(normalized.message) || errStatus === 524 || errStatus === 408);

      console.error(
        `\x1b[31m[LLM ERROR ${errStatus ? errStatus : "FAIL"}]\x1b[0m \x1b[1m${provider.name}\x1b[0m - model: \x1b[36m${provider.model}\x1b[0m - \x1b[31m${truncateProviderError(normalized.message)}\x1b[0m`,
      );

      executionOptions.onProviderAttempt?.({
        providerId: provider.id,
        provider: provider.name,
        model: provider.model,
        actualModel: attemptUsage?.model || provider.model,
        status: "error",
        statusCode: errStatus,
        latencyMs: Date.now() - attemptStartedAt,
        queueWaitMs,
        error: truncateProviderError(normalized.message),
      });

      if (!isHealthProbe) recordProviderFailure(provider.id, normalized, breaker);
      return { ok: false, err: normalized, isTimeout };
    }
  };

  /**
   * Takes a slot on the first candidate that is free and not cooling down. A busy or
   * cooling-down candidate is waited for, never skipped in favor of a lower tier. If every
   * candidate is merely cooling down (and none is busy), the cooldowns are cleared so the
   * call is not starved.
   */
  const acquireSlot = async (
    candidates: LLMProvider[],
  ): Promise<{ provider: LLMProvider; queueWaitMs: number } | null> => {
    const immediate = candidates.find(
      (p) => isProviderSlotFree(p.id) && !isProviderCoolingDown(p.id),
    );
    if (immediate) {
      acquireProviderSlot(immediate.id);
      return { provider: immediate, queueWaitMs: 0 };
    }
    const freeButCooling = candidates.filter((p) => isProviderSlotFree(p.id));
    if (freeButCooling.length > 0 && candidates.every((p) => isProviderCoolingDown(p.id))) {
      for (const p of freeButCooling) {
        providerCooldowns.delete(p.id);
        const h = getProviderHealth(p.id);
        if (h.status === "cooling_down") {
          h.status = "healthy";
          h.cooldownUntil = undefined;
        }
      }
      acquireProviderSlot(freeButCooling[0].id);
      return { provider: freeButCooling[0], queueWaitMs: 0 };
    }
    // A health probe reports a busy provider as busy; it never queues behind real work.
    if (isHealthProbe) return null;
    const ids = new Set(candidates.map((p) => p.id));
    const queueWaitStart = Date.now();
    try {
      const provider = await waitForProviderSlot(
        () =>
          allConfigured.filter(
            (p) => ids.has(p.id) && !isProviderOut(p.id, breaker) && !isProviderCoolingDown(p.id),
          ),
        executionOptions.signal,
        resolveDynamicQueueTimeoutMs(),
        isInteractive,
        () => candidates.every((p) => isProviderOut(p.id, breaker)),
      );
      const queueWaitMs = Date.now() - queueWaitStart;
      queueWaitTotalMs += queueWaitMs;
      return { provider, queueWaitMs };
    } catch (error: any) {
      if (executionOptions.signal?.aborted || error?.name === "AbortError") throw error;
      console.warn(`[llm] Gave up waiting for a provider slot: ${error?.message || error}`);
      return null;
    }
  };

  const runOn = async (candidates: LLMProvider[]): Promise<{ provider: LLMProvider; result: AttemptResult<T> } | null> => {
    const slot = await acquireSlot(candidates);
    if (!slot) return null;
    try {
      return { provider: slot.provider, result: await executeAttempt(slot.provider, slot.queueWaitMs) };
    } finally {
      releaseProviderSlot(slot.provider.id);
    }
  };

  let lastPrimaryError: Error | undefined;

  // 1. PRIMARY PAIR (Atria first, Byesu in parallel). Busy partners are waited for.
  const eligiblePrimaries = primaryTier.filter((p) => !isProviderOut(p.id, breaker));
  if (eligiblePrimaries.length > 0) {
    const first = await runOn(eligiblePrimaries);
    if (first?.result.ok) return first.result.val;
    if (first && !first.result.ok) lastPrimaryError = first.result.err;

    const partners = primaryTier.filter(
      (p) => p.id !== first?.provider.id && !isProviderOut(p.id, breaker),
    );
    let second: Awaited<ReturnType<typeof runOn>> = null;
    if (first && partners.length > 0) {
      second = await runOn(partners);
      if (second?.result.ok) return second.result.val;
      if (second && !second.result.ok) lastPrimaryError = second.result.err;
    }

    const firstTimedOut = Boolean(first && !first.result.ok && first.result.isTimeout);
    const secondTimedOut = Boolean(second && !second.result.ok && second.result.isTimeout);
    if (first && second && firstTimedOut && secondTimedOut) {
      const bothTimeoutErr = new Error(
        `Both primary providers timed out (${(first.result as any).err.message} | ${(second.result as any).err.message}).`,
      );
      bothTimeoutErr.name = "TimeoutError";
      (bothTimeoutErr as any).isNonRetryable = true;
      (bothTimeoutErr as any).isFatalTimeout = true;
      throw bothTimeoutErr;
    }

    // One in-pair retry after BOTH primaries failed this call, sent to a provider that did not
    // just time out. Errors that would fail identically (413, auth, bad request) are not retried.
    const isRepeatable = (r: AttemptResult<T> | undefined) => {
      if (!r || r.ok) return false;
      const e = r.err as Error & { isNonRetryable?: boolean; isTokenLimit?: boolean };
      if (e.isNonRetryable || e.isTokenLimit) return false;
      const st = e instanceof LLMProviderError ? e.status : undefined;
      return !(st !== undefined && [400, 401, 403, 404, 413, 422].includes(st));
    };
    const retryPool = primaryTier.filter((p) => {
      if (isProviderOut(p.id, breaker)) return false;
      if (first && p.id === first.provider.id && firstTimedOut) return false;
      if (second && p.id === second.provider.id && secondTimedOut) return false;
      return true;
    });
    const retryWorthwhile =
      Boolean(first && second) && (isRepeatable(first?.result) || isRepeatable(second?.result));
    if (retryWorthwhile && retryPool.length > 0 && !budgetExceeded()) {
      console.warn(`[llm] Primary attempt(s) failed; one in-pair retry on ${retryPool.map((p) => p.name).join(" or ")}...`);
      await sleepWithSignal(1_500, executionOptions.signal);
      const retry = await runOn(retryPool);
      if (retry?.result.ok) return retry.result.val;
      if (retry && !retry.result.ok) lastPrimaryError = retry.result.err;
    }
  }

  // 2. FAILSAFE GATE: Groq/Mistral only when BOTH primaries are out (policy). A busy,
  // cooling-down, or once-failed primary never escalates; the failure returns to the stage.
  const allPrimariesOut =
    primaryTier.length > 0 && primaryTier.every((p) => isProviderOut(p.id, breaker));

  if (primaryTier.length > 0 && !allPrimariesOut) {
    throw lastPrimaryError ?? new Error("Primary LLM providers are busy or unavailable for this call.");
  }

  if (allPrimariesOut && isHealthProbe) {
    throw new Error("Primary providers (Atria, Byesu) are both out.");
  }

  const failsafeEligible = failsafeTier.filter((p) => !isProviderOut(p.id, breaker));

  if (allPrimariesOut && failsafeEligible.length === 0) {
    const outMessage =
      "Primary providers (Atria, Byesu) are out and no failsafe provider is available.";
    // Background session work waits (bounded) for a primary to come back for re-testing.
    if (isBackgroundSession && !isInteractive) {
      const waitStartedAt = outagePauseStartedAt ?? Date.now();
      const maxWaitMs = resolvePrimaryRecoveryMaxWaitMs();
      const waitedMs = Date.now() - waitStartedAt;
      if (waitedMs >= maxWaitMs) {
        throw new ProviderOutageError(
          `${outMessage} Gave up after waiting ${Math.round(waitedMs / 1000)}s for recovery.`,
        );
      }
      const earliestRetest = Math.min(
        ...primaryTier.map((p) => getProviderHealth(p.id).outUntil || Date.now() + 60_000),
      );
      const waitMs = Math.max(
        1,
        Math.min(60_000, Math.max(1_000, earliestRetest - Date.now()), maxWaitMs - waitedMs),
      );
      console.warn(
        `[llm] ${outMessage} Waiting ${Math.round(waitMs / 1000)}s before re-testing the primaries.`,
      );
      await sleepWithSignal(waitMs, executionOptions.signal);
      return withProviderFallback(operation, executionOptions, waitStartedAt);
    }
    throw new ProviderOutageError(outMessage);
  }

  // 3. FAILSAFE TIER (Groq, then OpenRouter/Mistral): used by every caller, but only when the
  // primary pair is out, or when no primary provider is configured at all.
  if (failsafeEligible.length === 0) {
    throw lastPrimaryError ?? new Error("All configured LLM providers failed or are unavailable.");
  }

  if (allPrimariesOut) {
    console.warn(`[llm] Atria and Byesu are both out. Failsafe activated.`);
    void sendDirectLangfuseTrace({
      stage: "failsafe_activation",
      status: "error",
      model: "system",
      provider: "system",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: 0,
      errorMessage: "llm_failsafe_activated",
      messages: [{ role: "system", content: "llm_failsafe_activated" }],
    });
  }

  const failsafeFailures: Error[] = lastPrimaryError ? [lastPrimaryError] : [];
  for (const failsafeProvider of failsafeEligible) {
    if (budgetExceeded()) {
      failsafeFailures.push(budgetError());
      break;
    }
    const attempt = await runOn([failsafeProvider]);
    if (attempt?.result.ok) return attempt.result.val;
    if (attempt && !attempt.result.ok) failsafeFailures.push(attempt.result.err);
  }

  const failureErr = new Error(
    `All configured LLM providers failed: ${formatProviderFailures(failsafeFailures)}`,
  );
  if (failsafeFailures.length > 0) {
    const lastErr = failsafeFailures[failsafeFailures.length - 1];
    (failureErr as any).cause = lastErr;
    if (lastErr instanceof LLMProviderError && lastErr.status) {
      (failureErr as any).status = lastErr.status;
    }
  }
  throw failureErr;
}

export function computeAtriaDynamicMaxTokens(
  requestedMaxTokens: number | undefined,
  messages: ChatMessage[],
  metadata?: Record<string, any>,
): number {
  // If caller explicitly requested a tiny budget (<= 50 tokens, e.g. for testing truncation errors),
  // honor it directly without inflating.
  if (
    requestedMaxTokens !== undefined &&
    requestedMaxTokens > 0 &&
    requestedMaxTokens <= 50
  ) {
    return requestedMaxTokens;
  }

  const baseRequested =
    requestedMaxTokens !== undefined && requestedMaxTokens > 0
      ? requestedMaxTokens
      : 4000;

  // Calculate total prompt characters and user payload density dynamically without locking to a stage type
  const safeMessages = Array.isArray(messages) ? messages : [];
  const messageChars = safeMessages.reduce(
    (acc, m) =>
      acc + (typeof m?.content === "string" ? m.content.length : 0),
    0,
  );
  const userText = safeMessages
    .filter((m) => m?.role !== "system")
    .map((m) => (typeof m?.content === "string" ? m.content : ""))
    .join("\n");

  const chunkChars = Number(metadata?.chunkSize || 0);
  const promptSize = Number(metadata?.promptSize || 0);
  const effectiveInputChars = Math.max(messageChars, chunkChars, promptSize);
  const estimatedInputTokens = Math.ceil(effectiveInputChars / 3.5);

  // Dynamically measure entity/block density in the payload
  const explicitItems = Math.max(
    0,
    Number(
      metadata?.candidateCount ||
        metadata?.itemCount ||
        metadata?.blockCount ||
        0,
    ),
  );
  const detectedItems = (
    userText.match(
      /(?:^|\n)(?:---\s*PROFILE CANDIDATE\s*---|SOURCE_BLOCK|CANDIDATE\b|###\s*Candidate|\[\d+\])/gi,
    ) || []
  ).length;
  const itemCount = explicitItems > 0 ? explicitItems : detectedItems;

  // Scale visible output budget dynamically to handle whatever volume the engine sends
  const dynamicOutputBudget = Math.max(
    baseRequested,
    itemCount * 250,
    Math.round(estimatedInputTokens * 0.6),
  );

  const isJudgeLike =
    /judge|finalist|verdict|disqualif/i.test(String(metadata?.stage || "")) ||
    /\b(verdict|disqualif|evaluate these candidates)\b/i.test(userText);

  // Scale reasoning headroom continuously with input volume and item density without static ceilings
  const reasoningHeadroom = Math.max(
    isJudgeLike ? 3500 : 3000,
    Math.round(effectiveInputChars * 0.8) + itemCount * 250,
  );

  // Combined token budget for Atria (reasoning_content + visible content)
  const flexibleBudget = dynamicOutputBudget + reasoningHeadroom;

  // Allow explicit env override if provided, otherwise allow flexible budget without static ceiling
  const envOverride = Number(process.env.ATRIA_MAX_TOKENS || 0);
  if (envOverride > 0) {
    return Math.max(flexibleBudget, envOverride);
  }

  return Math.max(4000, flexibleBudget);
}

export function computeAtriaDynamicTimeoutMs(
  effectiveMaxTokens: number,
  messages: ChatMessage[],
  requestedTimeoutMs?: number,
  metadata?: Record<string, any>,
): number {
  if (
    requestedTimeoutMs !== undefined &&
    requestedTimeoutMs > 0 &&
    requestedTimeoutMs < 1000
  ) {
    return requestedTimeoutMs;
  }

  const safeMessages = Array.isArray(messages) ? messages : [];
  const promptChars = safeMessages.reduce(
    (acc, m) =>
      acc + (typeof m?.content === "string" ? m.content.length : 0),
    0,
  );
  const chunkChars = Number(metadata?.chunkSize || 0);
  const promptSize = Number(metadata?.promptSize || 0);
  const effectiveChars = Math.max(promptChars, chunkChars, promptSize);
  const estimatedInputTokens = Math.ceil(effectiveChars / 3.5);

  // Scale timeout dynamically with prefill tokens + reasoning/output token budget
  // Calibrated to Atria vLLM throughput (~35-45 tok/s + queue/prefill overhead + reasoning pauses)
  const workloadTimeoutMs =
    60_000 +
    Math.round(estimatedInputTokens * 12) +
    Math.round(Math.max(0, effectiveMaxTokens) * 15);

  const minAtriaTimeout = Math.max(
    120_000,
    Number(process.env.ATRIA_MIN_TIMEOUT_MS || 0),
    requestedTimeoutMs || 0,
  );
  const maxAtriaTimeout =
    Number(process.env.ATRIA_MAX_TIMEOUT_MS) > 0
      ? Number(process.env.ATRIA_MAX_TIMEOUT_MS)
      : ATRIA_MAX_TIMEOUT_MS;

  return Math.min(maxAtriaTimeout, Math.max(minAtriaTimeout, workloadTimeoutMs));
}

export function computeByesuDynamicTimeoutMs(
  effectiveMaxTokens: number,
  messages: ChatMessage[],
  requestedTimeoutMs?: number,
  metadata?: Record<string, any>,
): number {
  if (
    requestedTimeoutMs !== undefined &&
    requestedTimeoutMs > 0 &&
    requestedTimeoutMs < 1000
  ) {
    return requestedTimeoutMs;
  }

  const safeMessages = Array.isArray(messages) ? messages : [];
  const promptChars = safeMessages.reduce(
    (acc, m) =>
      acc + (typeof m?.content === "string" ? m.content.length : 0),
    0,
  );
  const chunkChars = Number(metadata?.chunkSize || 0);
  const promptSize = Number(metadata?.promptSize || 0);
  const effectiveChars = Math.max(promptChars, chunkChars, promptSize);
  const estimatedInputTokens = Math.ceil(effectiveChars / 3.5);

  // Scale timeout dynamically for Byesu GPT-5/GPT-6 models so multi-candidate
  // batches do not prematurely abort at 30s/35s when falling back from Atria.
  const workloadTimeoutMs =
    45_000 +
    Math.round(estimatedInputTokens * 6) +
    Math.round(Math.max(0, effectiveMaxTokens) * 6);

  const minByesuTimeout = Math.max(
    75_000,
    Number(process.env.BYESU_MIN_TIMEOUT_MS || 0),
    requestedTimeoutMs || 0,
  );

  return Math.min(
    CLOUDFLARE_MAX_TIMEOUT_MS,
    Math.max(minByesuTimeout, workloadTimeoutMs),
  );
}

async function sendChatCompletion(
  provider: LLMProvider,
  messages: ChatMessage[],
  options?: {
    maxTokens?: number;
    temperature?: number;
    responseFormat?: { type: "json_object" };
  } & Pick<LLMExecutionOptions, "onUsage" | "timeoutMs" | "maxRetries" | "signal" | "reasoningEffort" | "metadata">,
): Promise<string> {
  if (options?.signal?.aborted) {
    const cancelError = new Error("LLM request was aborted by caller.");
    cancelError.name = "AbortError";
    throw cancelError;
  }
  let res: Response;
  const isAtriaTarget = provider.id === "atria";
  const isByesuTarget = provider.id === "primary";
  const effectiveMaxTokens =
    provider.id === "groq"
      ? Math.min(options?.maxTokens || 400, GROQ_MAX_OUTPUT_TOKENS)
      : isAtriaTarget
        ? computeAtriaDynamicMaxTokens(
            options?.maxTokens,
            messages,
            options?.metadata,
          )
        : (options?.maxTokens !== undefined ? options.maxTokens : 4000);

  // Health probes are status checks: they honor the caller timeout exactly (no Atria/Byesu
  // workload floor) and never retry, so a probe cannot hold a provider slot for minutes.
  const isHealthProbe = Boolean(options?.metadata?.healthProbe);
  const probeTimeoutMs =
    isHealthProbe && Number(options?.timeoutMs) > 0 ? Number(options?.timeoutMs) : undefined;
  const maxRetriesForCall = isHealthProbe ? 0 : options?.maxRetries;
  let timeoutForCall = options?.timeoutMs;
  if (probeTimeoutMs !== undefined) {
    timeoutForCall = probeTimeoutMs;
  } else if (isAtriaTarget) {
    timeoutForCall = computeAtriaDynamicTimeoutMs(
      effectiveMaxTokens,
      messages,
      options?.timeoutMs,
      options?.metadata,
    );
  } else if (isByesuTarget) {
    timeoutForCall = computeByesuDynamicTimeoutMs(
      effectiveMaxTokens,
      messages,
      options?.timeoutMs,
      options?.metadata,
    );
  }

  const sessionHeaders: Record<string, string> = {};
  if (options?.metadata?.sessionId) {
    sessionHeaders["x-langfuse-trace-id"] = String(options.metadata.sessionId);
    sessionHeaders["x-langfuse-tags"] = "apex-crm,mining-session";
  }
  const isReasoningCapable = REASONING_MODEL_REGEX.test(provider.model);
  const isFailsafe = provider.id === "groq" || provider.id === "openrouter";
  const stage = String(options?.metadata?.stage || "").toLowerCase();
  const stageEffort = stage && TASK_REASONING_EFFORT[stage] ? TASK_REASONING_EFFORT[stage] : undefined;
  const effectiveReasoningEffort =
    options?.reasoningEffort ?? stageEffort ?? (options?.responseFormat ? "low" : undefined);
  const shouldSendReasoningEffort =
    !isFailsafe &&
    Boolean(effectiveReasoningEffort) &&
    (isAtriaTarget ? !atriaRejectsReasoningEffort : isReasoningCapable);

  const callStartedAt = Date.now();
  try {
    res = await fetchWithRetry(
      `${provider.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...(provider.headers || {}),
          ...sessionHeaders,
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
          ...(shouldSendReasoningEffort
            ? { reasoning_effort: effectiveReasoningEffort }
            : {}),
        }),
        signal: options?.signal,
      },
      timeoutForCall,
      maxRetriesForCall,
      isAtriaTarget,
      provider.id,
    );
  } catch (error: any) {
    if (error?.name === "AbortError" || options?.signal?.aborted) {
      throw error;
    }
    void sendDirectLangfuseTrace({
      sessionId: options?.metadata?.sessionId ? String(options.metadata.sessionId) : undefined,
      stage: options?.metadata?.stage ? String(options.metadata.stage) : undefined,
      round: typeof options?.metadata?.round === "number" ? options.metadata.round : undefined,
      model: provider.model,
      provider: provider.name,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs: Date.now() - callStartedAt,
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      messages,
    });
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

    // Lazy detection: if Atria rejects reasoning_effort with HTTP 400, cache the refusal and retry once without it
    if (
      isAtriaTarget &&
      res.status === 400 &&
      shouldSendReasoningEffort &&
      /reasoning_effort|reasoning effort/i.test(rawText)
    ) {
      console.warn(
        `[llm] Atria rejected reasoning_effort. Caching refusal and retrying without reasoning_effort...`,
      );
      atriaRejectsReasoningEffort = true;
      try {
        res = await fetchWithRetry(
          `${provider.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              ...(provider.headers || {}),
              ...sessionHeaders,
              "Content-Type": "application/json",
              Authorization: `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({
              model: provider.model,
              messages,
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
          timeoutForCall,
          maxRetriesForCall,
          isAtriaTarget,
          provider.id,
        );
      } catch (retryError: any) {
        if (retryError?.name === "AbortError" || options?.signal?.aborted) {
          throw retryError;
        }
        void sendDirectLangfuseTrace({
          sessionId: options?.metadata?.sessionId ? String(options.metadata.sessionId) : undefined,
          stage: options?.metadata?.stage ? String(options.metadata.stage) : undefined,
          round: typeof options?.metadata?.round === "number" ? options.metadata.round : undefined,
          model: provider.model,
          provider: provider.name,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          latencyMs: Date.now() - callStartedAt,
          status: "error",
          errorMessage: retryError instanceof Error ? retryError.message : String(retryError),
          messages,
        });
        throw new LLMProviderError(
          provider,
          undefined,
          retryError instanceof Error ? retryError.message : String(retryError),
        );
      }
    }

    if (!res.ok) {
      const errText = res.bodyUsed ? rawText : await res.text();
      try {
        const parsed = JSON.parse(errText);
        errorCode = parsed?.error?.code ?? parsed?.code;
      } catch {}
      const err = truncateProviderError(errText);
      void sendDirectLangfuseTrace({
        sessionId: options?.metadata?.sessionId ? String(options.metadata.sessionId) : undefined,
        stage: options?.metadata?.stage ? String(options.metadata.stage) : undefined,
        round: typeof options?.metadata?.round === "number" ? options.metadata.round : undefined,
        model: provider.model,
        provider: provider.name,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        latencyMs: Date.now() - callStartedAt,
        status: "error",
        errorMessage: err,
        messages,
      });
      throw new LLMProviderError(
        provider,
        res.status,
        `chat completion error ${res.status}: ${err}`,
        errorCode,
      );
    }
  }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const finishReason =
      typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : undefined;
    const content =
      typeof choice?.message?.content === "string" ? choice.message.content : "";

    // A reasoning model (e.g. Atria-Dawn-Preview) emits and bills `reasoning_content`
    // BEFORE any visible content. When max_tokens runs out during reasoning the gateway
    // still answers HTTP 200, but with content:null and finish_reason:"length". Collapsing
    // that to "" lets downstream stages record a zero-yield round with no error anywhere.
    // Surface it as a provider failure so the chain cascades and the cause is visible.
    //
    // Deliberately does NOT set isTokenLimit and does not match the token-limit regexes in
    // LLMProviderError: this is a budget-sizing fault, not a context-window rejection, and
    // must not disable an otherwise healthy provider for the rest of the session.
    if (finishReason === "length" && content === "") {
      const reasoningChars =
        typeof choice?.message?.reasoning_content === "string"
          ? choice.message.reasoning_content.length
          : 0;
      throw new LLMProviderError(
        provider,
        res.status,
        `chat completion truncated: finish_reason "length" produced no visible content` +
          (reasoningChars > 0
            ? ` (reasoning_content consumed the entire budget: ${reasoningChars} chars)`
            : "") +
          `. Raise max_tokens.`,
      );
    }

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

    // Rich ANSI colored console log
    console.log(
      `\x1b[32m[LLM 200 OK]\x1b[0m \x1b[1m${provider.name}\x1b[0m \u00b7 model: \x1b[36m${actualModel}\x1b[0m \u00b7 \x1b[33m${latencyMs}ms\x1b[0m \u00b7 \x1b[35m${totalTokens.toLocaleString()} tok\x1b[0m`,
    );

    sendDirectLangfuseTrace({
      sessionId: options?.metadata?.sessionId ? String(options.metadata.sessionId) : undefined,
      stage: options?.metadata?.stage ? String(options.metadata.stage) : undefined,
      round: typeof options?.metadata?.round === "number" ? options.metadata.round : undefined,
      model: actualModel,
      provider: provider.name,
      inputTokens,
      outputTokens,
      totalTokens,
      latencyMs,
      status: "success",
      messages,
      output: content,
    });

    if (typeof options?.onUsage === "function") {
      options.onUsage({
        inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
        outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
        totalTokens,
        provider: provider.name,
        model: actualModel,
      });
    }
    return content;
}
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
function normalizeTavilyDomain(value: string) {
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
    (process.env.TAVILY_INCLUDE_RAW_CONTENT === "true");
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    const signal = options.signal
      ? (typeof (AbortSignal as any).any === "function"
          ? (AbortSignal as any).any([options.signal, controller.signal])
          : controller.signal)
      : controller.signal;
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal,
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
          include_usage: false,
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
    } finally {
      clearTimeout(timeoutId);
    }
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
    const controller = new AbortController();
    const timeoutSeconds = Math.min(Math.max(Number(options?.timeout || 30), 1), 120);
    const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    const signal = options?.signal
      ? (typeof (AbortSignal as any).any === "function"
          ? (AbortSignal as any).any([options.signal, controller.signal])
          : controller.signal)
      : controller.signal;
    try {
      const res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        signal,
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
          include_usage: false,
          timeout: timeoutSeconds,
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
    } finally {
      clearTimeout(timeoutId);
    }
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
  // Depth of the first array opened (1 for a bare array, 2 for a {"items":[...]} wrapper).
  // A complete element of that array ends whenever the stack returns to this depth.
  let itemArrayDepth = -1;
  let closersAtLastItem = "";

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
      if (itemArrayDepth === -1 && stack.length <= 2) itemArrayDepth = stack.length;
    } else if (ch === "}" || ch === "]") {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
        if (stack.length === itemArrayDepth && stack[stack.length - 1] === "]") {
          lastCompleteItemIndex = i;
          closersAtLastItem = [...stack].reverse().join("");
        }
      }
    }
  }

  // Only salvage when the text was cut off inside that array (the array is still open).
  const truncatedInsideItems =
    itemArrayDepth > 0 && stack.length >= itemArrayDepth && stack[itemArrayDepth - 1] === "]";
  const truncated = truncatedInsideItems;
  if (lastCompleteItemIndex > 0 && (sub.startsWith("[") || truncated)) {
    console.warn(
      `[repairTruncatedJSON] Truncated JSON array repaired to last complete element (index: ${lastCompleteItemIndex}).`,
    );
    return sub.slice(0, lastCompleteItemIndex + 1) + closersAtLastItem;
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
  const jsonMode = process.env.LLM_JSON_MODE || "auto";
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

  const cacheEnabled = process.env.LLM_COMPLETION_CACHE !== "false";
  // Base content is provider-agnostic; the per-provider hash is derived inside
  // the fallback operation so a Byesu response is never reused for Groq/Atria.
  const cacheBaseContent = cacheEnabled
    ? [
        sysPrompt,
        prompt,
        JSON.stringify(normalizedSchema || {}),
        options?.temperature ?? 0,
        options?.maxTokens ?? 0,
        useJsonMode ? "json" : "text",
      ].join("::")
    : "";
  const buildPromptHash = (providerName: string, providerModel: string, maxTokens?: number) => {
    const fullContent = [cacheBaseContent, providerName, providerModel, maxTokens ?? 0].join("::");
    return crypto.createHash("sha256").update(fullContent).digest("hex");
  };

  return withProviderFallback(async (provider, providerOpts) => {
    let text = "";
    const effectiveOptions: any = { ...options, ...providerOpts };
    let promptHash: string | undefined;
    let liveUsage: LLMUsage | undefined;
    const cacheWrappedOptions: any = {
      ...effectiveOptions,
      onUsage: (usage: LLMUsage) => {
        liveUsage = usage;
        (effectiveOptions as any).onUsage?.(usage);
      },
    };
    if (cacheEnabled) {
      try {
        promptHash = buildPromptHash(provider.name, provider.model, effectiveOptions.maxTokens);
        const cached = getLlmCacheEntry(promptHash);
        if (cached?.response) {
          try {
            const parsed = parseStructuredText(cached.response);
            if (parsed !== null) {
              if (cached.usage) effectiveOptions.onUsage?.(cached.usage as LLMUsage);
              return parsed;
            }
          } catch {
            // Cached response invalid for current schema, proceed to fresh generation
          }
        }
      } catch {
        // Non-fatal cache lookup failure
      }
    }
    try {
      text = await sendChatCompletion(provider, messages, {
        ...cacheWrappedOptions,
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
        text = await sendChatCompletion(provider, messages, cacheWrappedOptions);
      } else {
        throw error;
      }
    }

    try {
      const parsed = parseStructuredText(text);
      if (cacheEnabled && promptHash) {
        const ttlHours = options?.metadata?.stage === "strategist" ? 6 : 24;
        upsertLlmCacheEntry(
          promptHash,
          provider.name,
          provider.model,
          text,
          liveUsage
            ? {
                input_tokens: liveUsage.inputTokens,
                output_tokens: liveUsage.outputTokens,
                total_tokens: liveUsage.totalTokens,
                provider: liveUsage.provider,
                model: liveUsage.model,
              }
            : undefined,
          ttlHours,
        );
      }
      return parsed;
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
          ? Math.min(options?.maxTokens || 400, GROQ_MAX_OUTPUT_TOKENS)
          : provider.id === "atria"
            ? Math.max(
                Number(process.env.LLM_STRUCTURED_RETRY_MAX_TOKENS || 5000),
                (options?.maxTokens || 4000) * 2,
              )
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
      let retryUsage: LLMUsage | undefined;
      const retryText = await sendChatCompletion(provider, retryMessages, {
        ...cacheWrappedOptions,
        maxTokens: retryMaxTokens,
        temperature: 0,
        onUsage: (usage: LLMUsage) => {
          retryUsage = usage;
          liveUsage = usage;
          (effectiveOptions as any).onUsage?.(usage);
        },
        ...(useJsonMode
          ? { responseFormat: { type: "json_object" as const } }
          : {}),
      });

      try {
        const parsedRetry = parseStructuredText(retryText);
        if (cacheEnabled && promptHash) {
          const ttlHours = options?.metadata?.stage === "strategist" ? 6 : 24;
          const usageToStore = retryUsage ?? liveUsage;
          upsertLlmCacheEntry(
            promptHash,
            provider.name,
            provider.model,
            retryText,
            usageToStore
              ? {
                  input_tokens: usageToStore.inputTokens,
                  output_tokens: usageToStore.outputTokens,
                  total_tokens: usageToStore.totalTokens,
                  provider: usageToStore.provider,
                  model: usageToStore.model,
                }
              : undefined,
            ttlHours,
          );
        }
        return parsedRetry;
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

Your core responsibilities span three operational domains:
1. **Lead Ingestion & Structural Parsing**
2. **AI Enrichment Pipeline**
3. **Outreach Sequence Studio**

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

## DOMAIN 3 - OUTREACH SEQUENCE STUDIO

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
export const STRATEGIST_SYSTEM_PROMPT = `You are an expert B2B sales search strategist. Your sole task is to produce concise, targeted search query plan objects that surface LinkedIn profiles matching the user's lead criteria. Always use clean natural language keyword phrases (3 to 6 words) without raw boolean operator words (AND/OR/NOT) or site: operators. Balanced double quotes around multi-word roles or niches (e.g. "freight forwarder") and hyphenated negative exclusions (e.g. -platform) are permitted. Output only valid JSON.`;

/** Focused prompt for Step 3 - initial scouting only. Deep enrichment and email
 * discovery deliberately happen after manual selection. */
export const EXTRACTION_SYSTEM_PROMPT = `You are a B2B prospect scouting extraction engine. Extract candidates with verified identity/profile and exclude anonymous background mentions or passing citations. Only extract an individual if they have an identifiable professional profile/identity mentioned as the subject of the snippet. Extract only facts directly supported by source evidence and return valid JSON matching the schema exactly.
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
      description: "1 concise evidence reason under 60 chars",
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
