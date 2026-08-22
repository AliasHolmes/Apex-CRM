import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import path from 'path';
import { ApiKeyPool, parseApiKeys, type ApiKeyFailureKind, type FailureClassification } from './keyRotator.js';
import { brightDataFreeTierCapabilities } from '../leadSearch/freeTier.js';

type BrightDataTransport = 'hosted' | 'local';
export type BrightDataReasonCode =
  | 'none'
  | 'target_transient'
  | 'target_blocked'
  | 'request_invalid'
  | 'transport_transient'
  | 'provider_auth'
  | 'provider_quota'
  | 'provider_config'
  | 'unknown';

export type BrightDataHealth =
  | 'unconfigured'
  | 'idle'
  | 'ready'
  | 'degraded'
  | 'transport_reconnecting'
  | 'provider_disabled';

export class BrightDataError extends Error {
  reasonCode: BrightDataReasonCode;
  retryable: boolean;
  providerDisabled: boolean;
  clearClient: boolean;
  statusCode?: number;

  constructor(message: string, options: {
    reasonCode?: BrightDataReasonCode;
    retryable?: boolean;
    providerDisabled?: boolean;
    clearClient?: boolean;
    statusCode?: number;
  } = {}) {
    super(message);
    this.name = 'BrightDataError';
    this.reasonCode = options.reasonCode || 'unknown';
    this.retryable = Boolean(options.retryable);
    this.providerDisabled = Boolean(options.providerDisabled);
    this.clearClient = Boolean(options.clearClient);
    this.statusCode = options.statusCode;
  }
}

let brightDataClient: Client | null = null;
let brightDataInitPromise: Promise<Client | null> | null = null;
let activeTransport: BrightDataTransport | null = null;
let activeApiToken = '';
let activeApiTokenFingerprint = '';
let disabledReason = '';
let disabledUntil = 0;
let clientGeneration = 0;
let inFlight = 0;
let consecutiveFailures = 0;
let lastError = '';
let lastReasonCode: BrightDataReasonCode = 'none';
let lastRetryable = false;
let healthOverride: BrightDataHealth | null = null;
let cooldownLogMutedUntil = 0;
let scrapeBatchToolAvailable: boolean | null = null;
let searchToolAvailable: boolean | null = null;

export type BatchToolState = {
  documented: boolean;
  detected: boolean | null;
  runtimeVerified: boolean;
  fallbackMode: 'none' | 'single_page_parallel';
  partialSuccesses: number;
  partialFailures: number;
};

let batchToolState: BatchToolState = {
  documented: true,
  detected: null,
  runtimeVerified: false,
  fallbackMode: 'none',
  partialSuccesses: 0,
  partialFailures: 0
};

const brightDataKeyPool = new ApiKeyPool('Bright Data', () => parseApiKeys(
  process.env.BRIGHTDATA_API_TOKENS,
  [process.env.BRIGHTDATA_API_TOKEN, process.env.API_TOKEN]
));

// --- Local MCP child stderr filtering -------------------------------------
// The local @brightdata/mcp server logs every tool call and error to stderr.
// Transient SERP failures (empty/non-JSON bodies, per-query lockouts) are
// retried or fallen back from inside this service, so their raw child-process
// output is dropped instead of surfacing as scary console errors. Everything
// else (real crashes, zone problems, unhandled HTTP errors) still passes
// through. Set BRIGHTDATA_MCP_STDERR_DEBUG=true to bypass the filter.

export type BrightDataMcpStderrFilterState = { suppressingStack: boolean; droppedLines: number };

const MCP_TRANSIENT_ERROR_PATTERN = /\[(?:search_engine|search_engine_batch|scrape_as_markdown|scrape_batch)\] error .*(?:Unexpected non-JSON response from Bright Data|recently failed and cannot be attempted|failed_query_rejected|repeat_query_rejected)/;
const MCP_STACK_FRAME_PATTERN = /^\s+at\s/;

const mcpStderrDebugEnabled = () => String(process.env.BRIGHTDATA_MCP_STDERR_DEBUG || '').trim().toLowerCase() === 'true';

export const createBrightDataMcpStderrFilter = (): BrightDataMcpStderrFilterState => ({
  suppressingStack: false,
  droppedLines: 0
});

/** Decide whether one line of the local MCP server's stderr should be forwarded. */
export function filterBrightDataMcpStderrLine(state: BrightDataMcpStderrFilterState, line: string): boolean {
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
  let pending = '';
  stderr.setEncoding('utf8');
  stderr.on('data', (chunk: string) => {
    pending += chunk;
    let newlineIndex: number;
    while ((newlineIndex = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      if (filterBrightDataMcpStderrLine(filterState, line)) process.stderr.write(line + '\n');
    }
  });
  stderr.on('end', () => {
    if (pending && filterBrightDataMcpStderrLine(filterState, pending)) process.stderr.write(pending + '\n');
    if (filterState.droppedLines > 0) {
      console.error(`[brightdata:mcp] suppressed ${filterState.droppedLines} handled transient SERP error line(s)`);
    }
  });
};

const boundedNumber = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

export const baseTimeoutSeconds = () => boundedNumber(process.env.BASE_TIMEOUT || process.env.BRIGHTDATA_BASE_TIMEOUT, 180, 1, 600);
export const baseMaxRetries = () => boundedNumber(process.env.BASE_MAX_RETRIES, 2, 0, 3);
export const BRIGHTDATA_SCRAPE_BATCH_MAX_URLS = 5;
const baseTimeoutMs = () => baseTimeoutSeconds() * 1000;
const failureCooldownMs = () => Number(process.env.BRIGHTDATA_FAILURE_COOLDOWN_MS || 5_000);

export function normalizeBrightDataUrl(url: string) {
  const value = String(url || '').trim();
  if (!value) {
    throw new BrightDataError('Bright Data URL is empty', { reasonCode: 'request_invalid' });
  }
  try {
    const parsed = new URL(value.startsWith('http://') || value.startsWith('https://') ? value : 'https://' + value);
    if (!parsed.hostname) throw new Error('missing hostname');
    return parsed.toString();
  } catch {
    throw new BrightDataError('Bright Data URL is invalid: ' + value, { reasonCode: 'request_invalid' });
  }
}

const withHardTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new BrightDataError(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`, {
          reasonCode: 'target_transient',
          retryable: true
        })), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const resetToolAvailability = () => {
  scrapeBatchToolAvailable = null;
  searchToolAvailable = null;
  batchToolState = {
    documented: true,
    detected: null,
    runtimeVerified: false,
    fallbackMode: 'none',
    partialSuccesses: 0,
    partialFailures: 0
  };
};

const cooldownMsForFailure = () => {
  const planned = consecutiveFailures <= 1
    ? 30_000
    : consecutiveFailures === 2
      ? 60_000
      : 5 * 60_000;
  return Math.min(planned, failureCooldownMs());
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const statusFromMessage = (message: string) => {
  const match = message.match(/\b(?:HTTP|status)\s*:?\s*(\d{3})\b/i) || message.match(/\b(4\d{2}|5\d{2})\b/);
  return match ? Number(match[1]) : undefined;
};

export function classifyBrightDataError(error: unknown): BrightDataError {
  if (error instanceof BrightDataError) return error;
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const statusCode = statusFromMessage(message);

  if (statusCode === 401 || statusCode === 403 || /unauthorized|forbidden|invalid token|api[_ -]?token|cannot run mcp server without api_token/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'provider_auth', providerDisabled: true, statusCode });
  }
  if (/quota|credit|usage limit|limit exceeded|billing|payment/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'provider_quota', providerDisabled: true, statusCode });
  }
  if (/tool .*unavailable|missing tool|invalid configuration|missing config|zone .*not found|required zone|not configured/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'provider_config', providerDisabled: true, statusCode });
  }
  if (statusCode === 400 || /mcp error -32602|parameter validation failed|request validation failed|must be a valid uri|string\.uri|array must contain at most/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'request_invalid', statusCode });
  }
  if (/connection closed|sse stream disconnected|stdio|process exited|terminated|econnreset|socket hang up|mcp error -32000/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'transport_transient', retryable: true, clearClient: true, statusCode });
  }
  // Official BD docs: "verifying" (challenge page, HTTP 502) and "failed_query_rejected" / "repeat_query_rejected"
  // (HTTP 429) both require a minimum 15-second wait before retrying the same query.
  // Since a 15s per-query delay is unacceptable in the mining pipeline, we classify all of these
  // as non-retryable. The caller's Tavily fallback fires immediately instead of wasting a retry
  // that is guaranteed to lockout (confirmed: any retry < 15s hits failed_query_rejected).
  if (/minimum of \d+\s*seconds?|recently failed and cannot be attempted|cannot be attempted at this time|repeat.{0,20}rejected|failed.{0,20}rejected/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'target_transient', retryable: false, statusCode });
  }
  // Non-JSON SERP response = BD returned a challenge/verification page (HTTP 502 "verifying").
  // Per BD docs: wait >=15s before retrying the same query. Mark non-retryable -> Tavily fallback.
  if (/unexpected non-json response from bright data/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'target_transient', retryable: false, statusCode });
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504 || /timed out|request timed out|fetch failed|empty response|empty body|returned no content/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'target_transient', retryable: true, statusCode });
  }
  if (/captcha|login wall|blocked|privacy checkpoint|sign in to view|authwall/.test(lower)) {
    return new BrightDataError(message, { reasonCode: 'target_blocked', statusCode });
  }
  return new BrightDataError(message, { reasonCode: 'unknown', statusCode });
}

export const isBrightDataRetryableError = (error: unknown) => classifyBrightDataError(error).retryable;
export const isBrightDataProviderDisabledError = (error: unknown) => classifyBrightDataError(error).providerDisabled;
export const isBrightDataTransientTargetError = (error: unknown) => classifyBrightDataError(error).reasonCode === 'target_transient';

export type BrightDataSearchRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  jitterMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  onRetry?: (context: { error: BrightDataError; attempt: number; nextAttempt: number; delayMs: number }) => void | Promise<void>;
};

export async function executeBrightDataSearchWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: BrightDataSearchRetryOptions = {}
): Promise<T> {
  const maxRetries = Math.min(Math.max(Math.floor(Number(options.maxRetries ?? 1)) || 0, 0), 2);
  const baseDelayMs = Math.min(Math.max(Math.floor(Number(options.baseDelayMs ?? 750)) || 0, 0), 10_000);
  const jitterMs = Math.min(Math.max(Math.floor(Number(options.jitterMs ?? 250)) || 0, 0), 2_000);
  const sleep = options.sleep || ((delayMs: number) => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  const random = options.random || Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const classified = classifyBrightDataError(error);
      if (!classified.retryable || attempt > maxRetries) throw classified;

      const retryBaseDelayMs = classified.reasonCode === 'transport_transient'
        ? Math.max(baseDelayMs, 5_000)
        : baseDelayMs;
      const delayMs = retryBaseDelayMs * (2 ** (attempt - 1)) + Math.floor(random() * (jitterMs + 1));
      await options.onRetry?.({ error: classified, attempt, nextAttempt: attempt + 1, delayMs });
      await sleep(delayMs);
    }
  }
}

const EMPTY_BODY_SERP_PATTERN = /unexpected non-json response from bright data/i;

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
  return classified.reasonCode === 'target_transient'
    && EMPTY_BODY_SERP_PATTERN.test(classified.message)
    && !/response snippet/i.test(classified.message);
}

export type BrightDataEmptyBodyRetryOptions = {
  maxRetries?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (context: { error: BrightDataError; attempt: number }) => void | Promise<void>;
};

/**
 * Recovers the empty-200 SERP transient inside the service layer so every
 * consumer (discovery rounds, Phase 5 post intent, company intent) self-heals
 * instead of surfacing a raw non-JSON tool error. Challenge/lockout variants
 * are deliberately not retried here; their fast Tavily fallback stays intact.
 */
export async function executeBrightDataSearchWithEmptyBodyRecovery<T>(
  operation: () => Promise<T>,
  options: BrightDataEmptyBodyRetryOptions = {}
): Promise<T> {
  const envMax = Number(process.env.BRIGHTDATA_SEARCH_EMPTY_BODY_RETRIES);
  const envDelay = Number(process.env.BRIGHTDATA_SEARCH_EMPTY_BODY_RETRY_DELAY_MS);
  const maxRetries = Math.min(Math.max(Math.floor(Number(options.maxRetries ?? (Number.isFinite(envMax) ? envMax : 1))), 0), 2);
  const delayMs = Math.min(Math.max(Math.floor(Number(options.delayMs ?? (Number.isFinite(envDelay) ? envDelay : 1_500))), 0), 15_000);
  const sleep = options.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isEmptyBodySerpTransientError(error)) throw error;
      await options.onRetry?.({ error: classifyBrightDataError(error), attempt: attempt + 1 });
      await sleep(delayMs);
    }
  }
}

const keyFailureKindForBrightData = (classified: BrightDataError): ApiKeyFailureKind => {
  if (classified.reasonCode === 'provider_auth' || classified.reasonCode === 'provider_quota') return 'exhausted';
  if (classified.reasonCode === 'request_invalid' || classified.reasonCode === 'provider_config') return 'request_invalid';
  if (classified.reasonCode === 'transport_transient') return 'transient';
  return 'unknown';
};

const markActiveTokenFailure = (classified: BrightDataError) => {
  if (!activeApiToken) return;
  const kind = keyFailureKindForBrightData(classified);
  if (kind === 'request_invalid' || kind === 'unknown') return;
  const failure: FailureClassification = {
    kind,
    statusCode: classified.statusCode,
    cooldownMs: kind === 'transient' ? 15_000 : undefined,
    message: classified.message
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
    activeApiToken = '';
    activeApiTokenFingerprint = '';
  }
  brightDataInitPromise = null;
  clientGeneration++;
  resetToolAvailability();
  void closeClientQuietly(clientToClose);
  return true;
};

const markProviderFailure = (label: string, message: string, client?: Client | null, classified = classifyBrightDataError(message)) => {
  consecutiveFailures++;
  lastError = message;
  lastReasonCode = classified.reasonCode;
  lastRetryable = classified.retryable;
  disabledReason = `${label}: ${message}`;
  disabledUntil = Date.now() + cooldownMsForFailure();
  healthOverride = classified.providerDisabled ? 'provider_disabled' : 'transport_reconnecting';
  markActiveTokenFailure(classified);
  if (classified.clearClient || classified.providerDisabled) {
    resetToolAvailability();
    clearCurrentClient(client);
  }

  if (Date.now() >= cooldownLogMutedUntil) {
    const seconds = Math.max(1, Math.ceil((disabledUntil - Date.now()) / 1000));
    console.warn(`[brightdata] ${label} failed; cooling down for ${seconds}s: ${message}`);
    cooldownLogMutedUntil = disabledUntil;
  }
};

const markToolFailure = (message: string, classified = classifyBrightDataError(message)) => {
  lastError = message;
  lastReasonCode = classified.reasonCode;
  lastRetryable = classified.retryable;
  if (classified.retryable) healthOverride = 'degraded';
};

const markProviderSuccess = () => {
  consecutiveFailures = 0;
  lastError = '';
  lastReasonCode = 'none';
  lastRetryable = false;
  disabledReason = '';
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
  return (process.env.BRIGHTDATA_PLAN || 'free').trim().toLowerCase() !== 'pro';
}

export function getBrightDataCapabilities() {
  const free = isBrightDataFreeTier();
  return {
    ...(free
      ? brightDataFreeTierCapabilities()
      : {
          provider: 'brightdata' as const,
          plan: 'pro' as const,
          monthlyUnitLimit: Number(process.env.BRIGHTDATA_MONTHLY_REQUEST_BUDGET) || undefined,
          supportedTools: ['search_engine', 'scrape_as_markdown', 'scrape_batch'],
          unavailableTools: [] as string[]
        }),
    configured: isBrightDataConfigured(),
    rapidModeOnly: free
  };
}

export function isBrightDataCoolingDown() {
  return Boolean(disabledUntil && Date.now() < disabledUntil);
}

export function shouldAttemptBrightData() {
  return isBrightDataConfigured() && brightDataKeyPool.hasAvailableKey() && !isBrightDataCoolingDown();
}

export function getBrightDataStatus() {
  const cooldownMsRemaining = Math.max(0, disabledUntil - Date.now());
  const configured = isBrightDataConfigured();
  const keyPool = brightDataKeyPool.getStatus();
  const hasAvailableKey = brightDataKeyPool.hasAvailableKey();
  const coolingDown = isBrightDataCoolingDown();
  const clientHot = Boolean(brightDataClient);
  const health: BrightDataHealth = !configured
    ? 'unconfigured'
    : !hasAvailableKey
      ? 'provider_disabled'
    : coolingDown && healthOverride === 'provider_disabled'
      ? 'provider_disabled'
      : coolingDown
        ? 'transport_reconnecting'
        : healthOverride === 'degraded'
          ? 'degraded'
          : clientHot
            ? 'ready'
            : 'idle';
  return {
    configured,
    ready: clientHot && !coolingDown && hasAvailableKey,
    health,
    transport: activeTransport,
    activeTokenFingerprint: activeApiTokenFingerprint,
    keyPool,
    disabledReason,
    disabledUntil,
    cooldownMsRemaining,
    inFlight,
    consecutiveFailures,
    lastError,
    lastReasonCode,
    retryable: lastRetryable,
    baseTimeoutSeconds: baseTimeoutSeconds(),
    baseMaxRetries: baseMaxRetries(),
    clientHot,
    batchTool: { ...batchToolState }
  };
}

async function connectHostedClient(apiToken: string, generation: number) {
  const client = new Client({ name: 'apex-crm-brightdata', version: '1.0.0' });
  const url = new URL('https://mcp.brightdata.com/mcp');
  url.searchParams.set('token', apiToken);
  const transport = new StreamableHTTPClientTransport(url);
  transport.onerror = (error) => {
    if (generation !== clientGeneration || brightDataClient !== client) {
      void closeClientQuietly(client);
      return;
    }
    markProviderFailure('hosted transport', error.message, client, new BrightDataError(error.message, {
      reasonCode: 'transport_transient',
      retryable: true,
      clearClient: true
    }));
  };
  await withHardTimeout(client.connect(transport, { timeout: baseTimeoutMs() }), baseTimeoutMs(), 'Bright Data hosted MCP connect');
  return client;
}

async function connectLocalClient(apiToken: string, generation: number) {
  const client = new Client({ name: 'apex-crm-brightdata', version: '1.0.0' });
  const serverPath = path.join(process.cwd(), 'node_modules', '@brightdata', 'mcp', 'server.js');
  const timeoutSeconds = String(baseTimeoutSeconds());
  const maxRetries = String(baseMaxRetries());
  const safeEnv = { ...process.env };
  delete (safeEnv as any)['PRO_MODE'];
  delete (safeEnv as any)['GROUPS'];
  delete (safeEnv as any)['TOOLS'];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...safeEnv,
      API_TOKEN: apiToken,
      BRIGHTDATA_API_TOKEN: apiToken,
      BASE_TIMEOUT: timeoutSeconds,
      BRIGHTDATA_BASE_TIMEOUT: timeoutSeconds,
      BASE_MAX_RETRIES: maxRetries
    } as Record<string, string>,
    stderr: mcpStderrDebugEnabled() ? 'inherit' : 'pipe',
    cwd: process.cwd()
  });

  if (transport.stderr) {
    attachFilteredMcpStderr(transport.stderr);
  }

  transport.onerror = (error) => {
    if (generation !== clientGeneration || brightDataClient !== client) {
      void closeClientQuietly(client);
      return;
    }
    markProviderFailure('local transport', error.message, client, new BrightDataError(error.message, {
      reasonCode: 'transport_transient',
      retryable: true,
      clearClient: true
    }));
  };

  await withHardTimeout(client.connect(transport, { timeout: baseTimeoutMs() }), baseTimeoutMs(), 'Bright Data local MCP connect');
  return client;
}

async function initBrightDataClient() {
  if (!isBrightDataConfigured()) {
    disabledReason = 'BRIGHTDATA_API_TOKEN or BRIGHTDATA_API_TOKENS is not configured';
    healthOverride = 'unconfigured';
    return null;
  }
  if (isBrightDataCoolingDown()) return null;

  const mode = (process.env.BRIGHTDATA_MCP_TRANSPORT || 'hosted').toLowerCase();
  const attempts: BrightDataTransport[] = mode === 'local'
    ? ['local']
    : mode === 'auto'
      ? ['hosted', 'local']
      : ['hosted'];

  let lastError: unknown;
  const attemptedTokens = new Set<string>();
  while (attemptedTokens.size < brightDataKeyPool.getStatus().total) {
    const selected = brightDataKeyPool.nextKey(attemptedTokens);
    attemptedTokens.add(selected.key);
    let tokenTransientFailure: BrightDataError | null = null;

    for (const attempt of attempts) {
      const generation = ++clientGeneration;
      try {
        const client = attempt === 'hosted'
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
        console.warn(`[brightdata] ${attempt} transport unavailable for ${selected.label}:`, disabledReason);

        if (classified.reasonCode === 'provider_auth' || classified.reasonCode === 'provider_quota') {
          brightDataKeyPool.markFailure(selected.key, {
            kind: 'exhausted',
            statusCode: classified.statusCode,
            message: classified.message
          });
          tokenTransientFailure = null;
          break;
        }

        if (classified.reasonCode === 'transport_transient') {
          tokenTransientFailure = classified;
        }
      }
    }

    if (tokenTransientFailure) {
      brightDataKeyPool.markFailure(selected.key, {
        kind: 'transient',
        statusCode: tokenTransientFailure.statusCode,
        cooldownMs: 15_000,
        message: tokenTransientFailure.message
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Bright Data initialization failed'));
}

export async function getBrightDataClient() {
  if (brightDataClient && !isBrightDataCoolingDown()) return brightDataClient;
  if (isBrightDataCoolingDown()) return null;
  if (!brightDataInitPromise) {
    brightDataInitPromise = initBrightDataClient().catch((error) => {
      const classified = classifyBrightDataError(error);
      markProviderFailure('initialization', classified.message, undefined, classified);
      return null;
    }).finally(() => {
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
  if (options?.onlyIfUnhealthy && !isBrightDataCoolingDown() && !disabledReason) return false;
  const client = brightDataClient;
  clearCurrentClient(client);
  if (!client) return false;
  await closeClientQuietly(client);
  if (!options?.onlyIfUnhealthy) {
    disabledReason = options?.reason || '';
    disabledUntil = 0;
    healthOverride = null;
  }
  return true;
}

async function withBrightDataClient<T>(
  label: string,
  operation: (client: Client) => Promise<T>,
  options?: { throwOnUnavailable?: boolean; throwOnFailure?: boolean }
): Promise<T | null> {
  const client = await getBrightDataClient();
  if (!client) {
    if (options?.throwOnUnavailable) {
      throw new BrightDataError(disabledReason || 'Bright Data MCP unavailable', classifyBrightDataError(disabledReason || 'Bright Data MCP unavailable'));
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

const textFromToolResult = (result: any) => {
  if (typeof result?.structuredContent?.markdown === 'string') return result.structuredContent.markdown;
  if (typeof result?.structuredContent?.text === 'string') return result.structuredContent.text;
  if (typeof result?.toolResult === 'string') return result.toolResult;
  if (Array.isArray(result?.content)) {
    return result.content
      .map((part: any) => {
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.resource?.text === 'string') return part.resource.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

export async function scrapeAsMarkdown(url: string, timeoutMs = baseTimeoutMs()) {
  const scrapeUrl = normalizeBrightDataUrl(url);

  if (!isBrightDataConfigured() || isBrightDataCoolingDown()) {
    try {
      const response = await fetch(scrapeUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 12000))
      });
      if (response.ok) {
        const html = await response.text();
        const textContent = html
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (textContent.length > 50) return textContent;
      }
    } catch {
      // Fallback fetch failed
    }
  }

  return withBrightDataClient('scrape_as_markdown', async (client) => {
    const result = await withHardTimeout(client.callTool(
      { name: 'scrape_as_markdown', arguments: { url: scrapeUrl } },
      undefined,
      { timeout: timeoutMs }
    ), timeoutMs, 'Bright Data scrape_as_markdown');

    if ((result as any)?.isError) {
      throw new Error(textFromToolResult(result) || 'Bright Data scrape_as_markdown returned an error');
    }

    const markdown = textFromToolResult(result);
    if (!markdown) {
      throw new BrightDataError('Bright Data scrape_as_markdown returned empty body', {
        reasonCode: 'target_transient',
        retryable: true
      });
    }
    return markdown;
  }, { throwOnUnavailable: true, throwOnFailure: true });
}

export type BrightDataBatchResult = {
  url: string;
  content: string;
  sourceProvider: 'brightdata_batch';
};

/**
 * Keeps callers on Bright Data's hard five-URL tool contract without silently
 * dropping the remainder of a larger enrichment set.
 */
export function chunkBrightDataBatchItems<T>(items: T[]): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += BRIGHTDATA_SCRAPE_BATCH_MAX_URLS) {
    batches.push(items.slice(index, index + BRIGHTDATA_SCRAPE_BATCH_MAX_URLS));
  }
  return batches;
}

export async function scrapeBatchAsMarkdown(urls: string[], timeoutMs = baseTimeoutMs()): Promise<BrightDataBatchResult[]> {
  const cleanUrls = Array.from(new Set(urls.map(url => {
    try {
      return normalizeBrightDataUrl(url);
    } catch {
      return '';
    }
  }).filter(Boolean))).slice(0, BRIGHTDATA_SCRAPE_BATCH_MAX_URLS);
  if (cleanUrls.length === 0) return [];

  // `scrape_batch` is not exposed by Bright Data's Rapid/free MCP. Keep the
  // explicit deep-enrichment stage functional without probing an unavailable
  // tool, and keep the fallback intentionally small.
  const result = await withBrightDataClient('scrape_batch', async (client) => {
    if (scrapeBatchToolAvailable === null) {
      const tools = await client.listTools();
      scrapeBatchToolAvailable = tools.tools.some(t => t.name === 'scrape_batch');
      batchToolState.detected = scrapeBatchToolAvailable;
    }

    if (!scrapeBatchToolAvailable) {
      batchToolState.fallbackMode = 'single_page_parallel';
      console.warn('[brightdata:tool_fallback] scrape_batch not in listTools(); falling back to parallel scrape_as_markdown');
      const fallbackResults = await Promise.all(
        cleanUrls.map(async (url) => {
          try {
            const content = await scrapeAsMarkdown(url, timeoutMs);
            return content ? { url, content, sourceProvider: 'brightdata_batch' as const } : null;
          } catch {
            return null;
          }
        })
      );
      return fallbackResults.filter((item): item is BrightDataBatchResult => Boolean(item));
    }

    const toolResult = await withHardTimeout(client.callTool(
      { name: 'scrape_batch', arguments: { urls: cleanUrls } },
      undefined,
      { timeout: timeoutMs }
    ), timeoutMs, 'Bright Data scrape_batch');

    if ((toolResult as any)?.isError) {
      throw new Error(textFromToolResult(toolResult) || 'Bright Data scrape_batch returned an error');
    }

    const structured = (toolResult as any)?.structuredContent;
    const candidates = Array.isArray(structured?.results)
      ? structured.results
      : Array.isArray(structured)
        ? structured
        : null;

    let parsedItems: BrightDataBatchResult[] = [];

    if (candidates) {
      parsedItems = candidates.map((item: any) => ({
        url: item.url || item.source_url || '',
        content: item.markdown || item.content || item.text || '',
        sourceProvider: 'brightdata_batch' as const
      })).filter((item: BrightDataBatchResult) => item.url);
    } else {
      const textResult = textFromToolResult(toolResult);
      if (textResult) {
        try {
          const parsed = JSON.parse(textResult);
          const items = Array.isArray(parsed) ? parsed : (parsed.results || []);
          parsedItems = items.map((item: any) => ({
            url: item.url || item.source_url || '',
            content: item.markdown || item.content || item.text || '',
            sourceProvider: 'brightdata_batch' as const
          })).filter((item: BrightDataBatchResult) => item.url);
        } catch {
          parsedItems = cleanUrls.map(url => ({ url, content: textResult, sourceProvider: 'brightdata_batch' as const }));
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

    const retryUrls = cleanUrls.filter(url => !itemByUrl.get(url)?.content.trim());
    const retries: Promise<BrightDataBatchResult | null>[] = retryUrls.map(url =>
      scrapeAsMarkdown(url, timeoutMs)
        .then(content => content ? { url, content, sourceProvider: 'brightdata_batch' as const } : null)
        .catch(() => null)
    );
    const retryResults = await Promise.all(retries);
    const retryMap = new Map(retryResults.filter((r): r is BrightDataBatchResult => Boolean(r)).map(r => [r.url, r]));

    const finalItems = cleanUrls.map(url => {
      const batchItem = itemByUrl.get(url);
      if (batchItem?.content.trim()) {
        return batchItem;
      }
      return retryMap.get(url) || null;
    }).filter((item): item is BrightDataBatchResult => Boolean(item?.content.trim()));

    const initialSuccessCount = cleanUrls.length - retryUrls.length;
    const initialFailureCount = retryUrls.length;
    const retrySuccessCount = retryResults.filter(Boolean).length;

    batchToolState.partialSuccesses += initialSuccessCount + retrySuccessCount;
    batchToolState.partialFailures += initialFailureCount;

    if (finalItems.length > 0) {
      batchToolState.runtimeVerified = true;
    }

    return finalItems;
  }, { throwOnUnavailable: true, throwOnFailure: true });

  return result || [];
}

export type BrightDataSearchResult = {
  title: string;
  url: string;
  content: string;
  sourceProvider: 'brightdata_search';
};

export type BrightDataSearchOptions = {
  country?: string;
  geoLocation?: string;
  cursor?: string;
  timeoutMs?: number;
  engine?: 'google' | 'bing' | 'yandex';
  allowBingFallback?: boolean;
};

/** Bright Data search_engine accepts a two-letter geo_location value. */
export function normalizeBrightDataGeoLocation(value?: string) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(normalized) ? normalized : '';
}

/**
 * Parses markdown output returned by @brightdata/mcp for non-Google engines (Bing/Yandex).
 * Extracts [Title](url) markdown links and accompanying description text blocks.
 */
export function parseBingMarkdownResults(markdownText: string): BrightDataSearchResult[] {
  if (!markdownText || typeof markdownText !== 'string') return [];
  const results: BrightDataSearchResult[] = [];
  const lines = markdownText.split('\n');
  let currentTitle = '';
  let currentUrl = '';
  let currentSnippetLines: string[] = [];

  const flush = () => {
    if (currentTitle && currentUrl) {
      const content = currentSnippetLines.join(' ').replace(/\s+/g, ' ').trim();
      results.push({
        title: currentTitle,
        url: currentUrl,
        content: content || currentTitle,
        sourceProvider: 'brightdata_search' as const
      });
    }
    currentTitle = '';
    currentUrl = '';
    currentSnippetLines = [];
  };

  const ignoredHosts = /^(?:www\.)?(?:bing\.com|microsoft\.com|msn\.com|live\.com|bingapis\.com|azure\.com|microsoftedge\.com)/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const linkMatch = line.match(/^#{0,6}\s*\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/);
    if (linkMatch) {
      flush();
      const candidateTitle = linkMatch[1].trim();
      const candidateUrl = linkMatch[2].trim();
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
      const candidateUrl = inlineMatch[2].trim();
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
      if (!line.startsWith('![') && !line.startsWith('---') && !line.startsWith('***')) {
        currentSnippetLines.push(line);
      }
    }
  }
  flush();

  return results.filter(r => r.url && r.title);
}

/**
 * Keep the MCP argument names aligned with @brightdata/mcp's search_engine
 * schema: query, engine, cursor, and geo_location. In particular, `country`
 * and `page` are not valid tool arguments in the installed client.
 */
export function buildBrightDataSearchArguments(query: string, options: BrightDataSearchOptions = {}) {
  const configuredGeo = options.geoLocation || options.country || process.env.BRIGHTDATA_SEARCH_GEO_LOCATION || 'us';
  const geoLocation = normalizeBrightDataGeoLocation(configuredGeo);
  const engine = options.engine || 'google';
  return {
    query,
    engine,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(geoLocation ? { geo_location: geoLocation } : {})
  };
}

export async function brightDataSearch(query: string, options?: BrightDataSearchOptions): Promise<BrightDataSearchResult[]> {
  const timeoutMs = options?.timeoutMs || baseTimeoutMs();
  const engine = options?.engine || 'google';
  const allowBingFallback = (options?.allowBingFallback ?? (process.env.BRIGHTDATA_FALLBACK_ENGINE !== 'false')) && engine === 'google';

  const runSearch = async (activeEngine: 'google' | 'bing' | 'yandex'): Promise<BrightDataSearchResult[]> => {
    return withBrightDataClient('search_engine', async (client) => {
      if (searchToolAvailable === null) {
        const tools = await client.listTools();
        searchToolAvailable = tools.tools.some(t => t.name === 'search_engine');
      }

      if (!searchToolAvailable) {
        throw new BrightDataError('search_engine tool unavailable in Bright Data MCP', {
          reasonCode: 'provider_config',
          providerDisabled: true
        });
      }

      const toolResult = await withHardTimeout(client.callTool(
        {
          name: 'search_engine',
          arguments: buildBrightDataSearchArguments(query, { ...options, engine: activeEngine })
        },
        undefined,
        { timeout: timeoutMs }
      ), timeoutMs, `Bright Data search_engine (${activeEngine})`);

      if ((toolResult as any)?.isError) {
        throw new Error(textFromToolResult(toolResult) || `Bright Data search_engine (${activeEngine}) returned an error`);
      }

      const textResult = textFromToolResult(toolResult);
      if (!textResult) return [];

      if (activeEngine === 'bing' || activeEngine === 'yandex') {
        return parseBingMarkdownResults(textResult);
      }

      let parsed: any;
      try {
        parsed = JSON.parse(textResult);
      } catch {
        return [];
      }

      const items = Array.isArray(parsed) ? parsed : (parsed.organic || parsed.results || []);
      return items.map((item: any) => ({
        title: item.title || '',
        url: item.link || item.url || '',
        content: item.snippet || item.description || '',
        sourceProvider: 'brightdata_search' as const
      })).filter((item: BrightDataSearchResult) => item.url && item.title);
    }, { throwOnUnavailable: true, throwOnFailure: true });
  };

  const result = await executeBrightDataSearchWithEmptyBodyRecovery(async () => {
    try {
      return await runSearch(engine);
    } catch (error) {
      const classified = classifyBrightDataError(error);
      if (allowBingFallback && (classified.reasonCode === 'target_transient' || /unexpected non-json response/i.test(classified.message))) {
        try {
          const bingResults = await runSearch('bing');
          if (bingResults && bingResults.length > 0) {
            return bingResults;
          }
        } catch {
          // Bing fallback also failed; proceed to rethrow original classified error for Tavily
        }
      }
      throw error;
    }
  });

  return result || [];
}
