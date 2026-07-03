import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type BrightDataTransport = 'hosted' | 'local';

let brightDataClient: Client | null = null;
let brightDataInitPromise: Promise<Client | null> | null = null;
let activeTransport: BrightDataTransport | null = null;
let disabledReason = '';
let disabledUntil = 0;
let clientGeneration = 0;
let inFlight = 0;
let consecutiveFailures = 0;
let lastError = '';
let cooldownLogMutedUntil = 0;
let scrapeBatchToolAvailable: boolean | null = null;
let searchToolAvailable: boolean | null = null;

const commandForPlatform = () => process.platform === 'win32' ? 'npx.cmd' : 'npx';
const baseTimeoutMs = () => Number(process.env.BRIGHTDATA_BASE_TIMEOUT || 15) * 1000;
const failureCooldownMs = () => Number(process.env.BRIGHTDATA_FAILURE_COOLDOWN_MS || 10 * 60 * 1000);

const withHardTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
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
  }
  brightDataInitPromise = null;
  clientGeneration++;
  resetToolAvailability();
  void closeClientQuietly(clientToClose);
  return true;
};

const markProviderFailure = (label: string, message: string, client?: Client | null) => {
  consecutiveFailures++;
  lastError = message;
  disabledReason = `${label}: ${message}`;
  disabledUntil = Date.now() + cooldownMsForFailure();
  resetToolAvailability();
  clearCurrentClient(client);

  if (Date.now() >= cooldownLogMutedUntil) {
    const seconds = Math.max(1, Math.ceil((disabledUntil - Date.now()) / 1000));
    console.warn(`[brightdata] ${label} failed; cooling down for ${seconds}s: ${message}`);
    cooldownLogMutedUntil = disabledUntil;
  }
};

const markProviderSuccess = () => {
  consecutiveFailures = 0;
  lastError = '';
  disabledReason = '';
  disabledUntil = 0;
};

export function isBrightDataConfigured() {
  return Boolean(process.env.BRIGHTDATA_API_TOKEN || process.env.API_TOKEN);
}

export function isBrightDataCoolingDown() {
  return Boolean(disabledUntil && Date.now() < disabledUntil);
}

export function shouldAttemptBrightData() {
  return isBrightDataConfigured() && !isBrightDataCoolingDown();
}

export function getBrightDataStatus() {
  const cooldownMsRemaining = Math.max(0, disabledUntil - Date.now());
  return {
    configured: isBrightDataConfigured(),
    ready: Boolean(brightDataClient) && !isBrightDataCoolingDown(),
    transport: activeTransport,
    disabledReason,
    disabledUntil,
    cooldownMsRemaining,
    inFlight,
    consecutiveFailures,
    lastError
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
    markProviderFailure('hosted transport', error.message, client);
  };
  await withHardTimeout(client.connect(transport, { timeout: baseTimeoutMs() }), baseTimeoutMs(), 'Bright Data hosted MCP connect');
  return client;
}

async function connectLocalClient(apiToken: string, generation: number) {
  const client = new Client({ name: 'apex-crm-brightdata', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: commandForPlatform(),
    args: ['-y', '@brightdata/mcp'],
    env: {
      ...process.env,
      API_TOKEN: apiToken,
      BRIGHTDATA_API_TOKEN: apiToken
    } as Record<string, string>,
    stderr: 'inherit',
    cwd: process.cwd()
  });

  transport.onerror = (error) => {
    if (generation !== clientGeneration || brightDataClient !== client) {
      void closeClientQuietly(client);
      return;
    }
    markProviderFailure('local transport', error.message, client);
  };

  await withHardTimeout(client.connect(transport, { timeout: baseTimeoutMs() }), baseTimeoutMs(), 'Bright Data local MCP connect');
  return client;
}

async function initBrightDataClient() {
  if (!isBrightDataConfigured()) {
    disabledReason = 'BRIGHTDATA_API_TOKEN is not configured';
    return null;
  }
  if (isBrightDataCoolingDown()) return null;

  const apiToken = process.env.BRIGHTDATA_API_TOKEN || process.env.API_TOKEN || '';
  const mode = (process.env.BRIGHTDATA_MCP_TRANSPORT || 'hosted').toLowerCase();
  const attempts: BrightDataTransport[] = mode === 'local'
    ? ['local']
    : mode === 'auto'
      ? ['hosted', 'local']
      : ['hosted'];

  let lastError: unknown;
  for (const attempt of attempts) {
    const generation = ++clientGeneration;
    try {
      const client = attempt === 'hosted'
        ? await connectHostedClient(apiToken, generation)
        : await connectLocalClient(apiToken, generation);
      if (generation !== clientGeneration) {
        await closeClientQuietly(client);
        return brightDataClient;
      }
      brightDataClient = client;
      activeTransport = attempt;
      markProviderSuccess();
      return client;
    } catch (error) {
      lastError = error;
      disabledReason = errorMessage(error);
      resetToolAvailability();
      console.warn(`[brightdata] ${attempt} transport unavailable:`, disabledReason);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Bright Data initialization failed'));
}

export async function getBrightDataClient() {
  if (brightDataClient && !isBrightDataCoolingDown()) return brightDataClient;
  if (isBrightDataCoolingDown()) return null;
  if (!brightDataInitPromise) {
    brightDataInitPromise = initBrightDataClient().catch((error) => {
      markProviderFailure('initialization', errorMessage(error));
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
      throw new Error(disabledReason || 'Bright Data MCP unavailable');
    }
    return null;
  }

  inFlight++;
  try {
    const result = await operation(client);
    markProviderSuccess();
    return result;
  } catch (error) {
    const message = errorMessage(error);
    markProviderFailure(label, message, client);
    if (options?.throwOnFailure) throw new Error(message);
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
  return withBrightDataClient('scrape_as_markdown', async (client) => {
    const result = await withHardTimeout(client.callTool(
      { name: 'scrape_as_markdown', arguments: { url } },
      undefined,
      { timeout: timeoutMs }
    ), timeoutMs, 'Bright Data scrape_as_markdown');

    if ((result as any)?.isError) {
      throw new Error(textFromToolResult(result) || 'Bright Data scrape_as_markdown returned an error');
    }

    const markdown = textFromToolResult(result);
    return markdown || null;
  }, { throwOnUnavailable: true, throwOnFailure: true });
}

export type BrightDataBatchResult = {
  url: string;
  content: string;
  sourceProvider: 'brightdata_batch';
};

export async function scrapeBatchAsMarkdown(urls: string[], timeoutMs = baseTimeoutMs()): Promise<BrightDataBatchResult[]> {
  const cleanUrls = Array.from(new Set(urls.filter(Boolean))).slice(0, 10);
  if (cleanUrls.length === 0) return [];

  const result = await withBrightDataClient('scrape_batch', async (client) => {
    if (scrapeBatchToolAvailable === null) {
      const tools = await client.listTools();
      scrapeBatchToolAvailable = tools.tools.some(t => t.name === 'scrape_batch');
    }

    if (!scrapeBatchToolAvailable) {
      disabledReason = 'scrape_batch tool unavailable in Bright Data MCP';
      return [];
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
  });

  return result || [];
}

export type BrightDataSearchResult = {
  title: string;
  url: string;
  content: string;
  sourceProvider: 'brightdata_search';
};

export async function brightDataSearch(query: string, options?: {
  country?: string;
  page?: number;
  timeoutMs?: number;
}): Promise<BrightDataSearchResult[]> {
  const timeoutMs = options?.timeoutMs || baseTimeoutMs();
  const result = await withBrightDataClient('search_engine', async (client) => {
    if (searchToolAvailable === null) {
      const tools = await client.listTools();
      searchToolAvailable = tools.tools.some(t => t.name === 'search_engine');
    }

    if (!searchToolAvailable) {
      disabledReason = 'search_engine tool unavailable in Bright Data MCP';
      return [];
    }

    const toolResult = await withHardTimeout(client.callTool(
      {
        name: 'search_engine',
        arguments: {
          query,
          country: options?.country || 'us',
          page: options?.page || 1
        }
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
  });

  return result || [];
}