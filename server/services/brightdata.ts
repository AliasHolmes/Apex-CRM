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

const brightDataKeyPool = new ApiKeyPool('Bright Data', () => parseApiKeys(
  process.env.BRIGHTDATA_API_TOKENS,
  [process.env.BRIGHTDATA_API_TOKEN, process.env.API_TOKEN]
));

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
    clientHot
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      API_TOKEN: apiToken,
      BRIGHTDATA_API_TOKEN: apiToken,
      BASE_TIMEOUT: timeoutSeconds,
      BRIGHTDATA_BASE_TIMEOUT: timeoutSeconds,
      BASE_MAX_RETRIES: maxRetries
    } as Record<string, string>,
    stderr: 'inherit',
    cwd: process.cwd()
  });

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
  if (isBrightDataFreeTier()) {
    const fallbackLimit = Math.min(
      cleanUrls.length,
      Math.max(1, Math.floor(Number(process.env.BRIGHTDATA_FREE_BATCH_FALLBACK_MAX_URLS) || 5))
    );
    const results = await Promise.all(cleanUrls.slice(0, fallbackLimit).map(async (url) => {
      try {
        const content = await scrapeAsMarkdown(url, timeoutMs);
        return content ? { url, content, sourceProvider: 'brightdata_batch' as const } : null;
      } catch {
        return null;
      }
    }));
    return results.filter((item): item is BrightDataBatchResult => Boolean(item));
  }

  const result = await withBrightDataClient('scrape_batch', async (client) => {
    if (scrapeBatchToolAvailable === null) {
      const tools = await client.listTools();
      scrapeBatchToolAvailable = tools.tools.some(t => t.name === 'scrape_batch');
    }

    if (!scrapeBatchToolAvailable) {
      throw new BrightDataError('scrape_batch tool unavailable in Bright Data MCP', {
        reasonCode: 'provider_config',
        providerDisabled: true
      });
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

    if (candidates) {
      return candidates.map((item: any) => ({
        url: item.url || item.source_url || '',
        content: item.markdown || item.content || item.text || '',
        sourceProvider: 'brightdata_batch' as const
      })).filter((item: BrightDataBatchResult) => item.url && item.content);
    }

    const textResult = textFromToolResult(toolResult);
    if (!textResult) return [];
    try {
      const parsed = JSON.parse(textResult);
      const items = Array.isArray(parsed) ? parsed : (parsed.results || []);
      return items.map((item: any) => ({
        url: item.url || item.source_url || '',
        content: item.markdown || item.content || item.text || '',
        sourceProvider: 'brightdata_batch' as const
      })).filter((item: BrightDataBatchResult) => item.url && item.content);
    } catch {
      return cleanUrls.map(url => ({ url, content: textResult, sourceProvider: 'brightdata_batch' as const }));
    }
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
};

/** Bright Data search_engine accepts a two-letter geo_location value. */
export function normalizeBrightDataGeoLocation(value?: string) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(normalized) ? normalized : '';
}

/**
 * Keep the MCP argument names aligned with @brightdata/mcp's search_engine
 * schema: query, engine, cursor, and geo_location. In particular, `country`
 * and `page` are not valid tool arguments in the installed client.
 */
export function buildBrightDataSearchArguments(query: string, options: BrightDataSearchOptions = {}) {
  const configuredGeo = options.geoLocation || options.country || process.env.BRIGHTDATA_SEARCH_GEO_LOCATION || 'us';
  const geoLocation = normalizeBrightDataGeoLocation(configuredGeo);
  return {
    query,
    engine: 'google' as const,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(geoLocation ? { geo_location: geoLocation } : {})
  };
}

export async function brightDataSearch(query: string, options?: BrightDataSearchOptions): Promise<BrightDataSearchResult[]> {
  const timeoutMs = options?.timeoutMs || baseTimeoutMs();
  const result = await withBrightDataClient('search_engine', async (client) => {
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
        arguments: buildBrightDataSearchArguments(query, options)
      },
      undefined,
      { timeout: timeoutMs }
    ), timeoutMs, 'Bright Data search_engine');

    if ((toolResult as any)?.isError) {
      throw new Error(textFromToolResult(toolResult) || 'Bright Data search_engine returned an error');
    }

    const textResult = textFromToolResult(toolResult);
    if (!textResult) return [];

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

  return result || [];
}
