import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let brightDataClient: Client | null = null;
let brightDataInitPromise: Promise<Client | null> | null = null;
let disabledReason = '';
let activeTransport: 'hosted' | 'local' | null = null;
let disabledUntil = 0;

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

export function isBrightDataConfigured() {
  return Boolean(process.env.BRIGHTDATA_API_TOKEN || process.env.API_TOKEN);
}

export function getBrightDataStatus() {
  return {
    configured: isBrightDataConfigured(),
    ready: Boolean(brightDataClient),
    transport: activeTransport,
    disabledReason,
    disabledUntil
  };
}

async function connectHostedClient(apiToken: string) {
  const client = new Client({ name: 'apex-crm-brightdata', version: '1.0.0' });
  const url = new URL('https://mcp.brightdata.com/mcp');
  url.searchParams.set('token', apiToken);
  const transport = new StreamableHTTPClientTransport(url);
  transport.onerror = (error) => {
    disabledReason = error.message;
    console.warn('[brightdata] hosted transport error:', error.message);
    brightDataClient = null;
    brightDataInitPromise = null;
  };
  await withHardTimeout(client.connect(transport, { timeout: baseTimeoutMs() }), baseTimeoutMs(), 'Bright Data hosted MCP connect');
  activeTransport = 'hosted';
  return client;
}

async function connectLocalClient(apiToken: string) {
  const client = new Client({ name: 'apex-crm-brightdata', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: commandForPlatform(),
    args: ['-y', '@brightdata/mcp'],
    env: {
      ...process.env,
      API_TOKEN: apiToken,
      BRIGHTDATA_API_TOKEN: apiToken
    } as Record<string, string>,
    stderr: 'pipe',
    cwd: process.cwd()
  });

  transport.onerror = (error) => {
    disabledReason = error.message;
    console.warn('[brightdata] local transport error:', error.message);
    brightDataClient = null;
    brightDataInitPromise = null;
  };

  await withHardTimeout(client.connect(transport, { timeout: baseTimeoutMs() }), baseTimeoutMs(), 'Bright Data local MCP connect');
  activeTransport = 'local';
  return client;
}

async function initBrightDataClient() {
  if (!isBrightDataConfigured()) {
    disabledReason = 'BRIGHTDATA_API_TOKEN is not configured';
    return null;
  }

  const apiToken = process.env.BRIGHTDATA_API_TOKEN || process.env.API_TOKEN || '';
  const mode = (process.env.BRIGHTDATA_MCP_TRANSPORT || 'hosted').toLowerCase();
  const attempts: Array<'hosted' | 'local'> = mode === 'local'
    ? ['local']
    : mode === 'auto'
      ? ['hosted', 'local']
      : ['hosted'];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const client = attempt === 'hosted'
        ? await connectHostedClient(apiToken)
        : await connectLocalClient(apiToken);
      brightDataClient = client;
      disabledReason = '';
      return client;
    } catch (error) {
      lastError = error;
      disabledReason = error instanceof Error ? error.message : String(error);
      console.warn(`[brightdata] ${attempt} transport unavailable:`, disabledReason);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Bright Data initialization failed'));
}

export async function getBrightDataClient() {
  if (brightDataClient) return brightDataClient;
  if (disabledUntil && Date.now() < disabledUntil) return null;
  if (!brightDataInitPromise) {
    brightDataInitPromise = initBrightDataClient().catch((error) => {
      disabledReason = error instanceof Error ? error.message : String(error);
      disabledUntil = Date.now() + failureCooldownMs();
      console.warn('[brightdata] disabled:', disabledReason);
      return null;
    }).finally(() => {
      brightDataInitPromise = null;
    });
  }
  return brightDataInitPromise;
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
  const client = await getBrightDataClient();
  if (!client) throw new Error(disabledReason || 'Bright Data MCP unavailable');

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
}

export type BrightDataSearchResult = {
  title: string;
  url: string;
  content: string;
  sourceProvider: 'brightdata_search';
};

let searchToolAvailable: boolean | null = null;

export async function brightDataSearch(query: string, options?: {
  country?: string;
  page?: number;
  timeoutMs?: number;
}): Promise<BrightDataSearchResult[]> {
  const client = await getBrightDataClient();
  if (!client) {
    return [];
  }

  // Check tool availability once
  if (searchToolAvailable === null) {
    try {
      const tools = await client.listTools();
      searchToolAvailable = tools.tools.some(t => t.name === 'search_engine');
    } catch (e) {
      searchToolAvailable = false;
    }
  }

  if (!searchToolAvailable) {
    disabledReason = 'search_engine tool unavailable in Bright Data MCP';
    return [];
  }

  const timeoutMs = options?.timeoutMs || baseTimeoutMs();
  
  try {
    const result = await withHardTimeout(client.callTool(
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

    if ((result as any)?.isError) {
      console.warn('[brightdata] search_engine error:', textFromToolResult(result));
      return [];
    }

    const textResult = textFromToolResult(result);
    if (!textResult) return [];

    let parsed: any;
    try {
      parsed = JSON.parse(textResult);
    } catch (e) {
      return [];
    }

    const items = Array.isArray(parsed) ? parsed : (parsed.organic || parsed.results || []);
    return items.map((item: any) => ({
      title: item.title || '',
      url: item.link || item.url || '',
      content: item.snippet || item.description || '',
      sourceProvider: 'brightdata_search' as const
    })).filter((item: BrightDataSearchResult) => item.url && item.title);
  } catch (error) {
    console.warn('[brightdata] search_engine exception:', error instanceof Error ? error.message : String(error));
    return [];
  }
}