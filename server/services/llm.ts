import { ApiKeyPool, KeyRotationError, executeWithKeyRotation, parseApiKeys } from './keyRotator.js';

export const Type = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  INTEGER: 'INTEGER',
  BOOLEAN: 'BOOLEAN',
  ARRAY: 'ARRAY',
  OBJECT: 'OBJECT',
};

// -----------------------------------------------------------------------------
// OpenAI-compatible REST API helpers with LiteLLM gateway and direct provider fallback.
// -----------------------------------------------------------------------------

type ChatMessage = {
  role: 'system' | 'user';
  content: string;
};

type LLMProvider = {
  id: 'litellm' | 'primary' | 'openrouter' | 'groq';
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  headers?: Record<string, string>;
};

export type LLMProviderSummary = Omit<LLMProvider, 'apiKey' | 'headers'> & {
  configured: boolean;
};

const DEFAULT_PRIMARY_BASE = 'https://byesu.com/v1';
const DEFAULT_PRIMARY_MODEL = 'gpt-5.5';
const DEFAULT_OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'poolside/laguna-m.1:free';
const DEFAULT_GROQ_BASE = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_MODEL = 'qwen/qwen3.6-27b';
const DEFAULT_LITELLM_BASE = 'http://127.0.0.1:4000/v1';
const DEFAULT_LITELLM_MODEL = 'apex-primary';

const tavilyKeyPool = new ApiKeyPool('Tavily', () => parseApiKeys(
  process.env.TAVILY_API_KEYS,
  [process.env.TAVILY_API_KEY]
));

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function getOpenRouterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Title': process.env.OPENROUTER_APP_TITLE || 'Apex CRM',
  };
  const referer = process.env.OPENROUTER_HTTP_REFERER || process.env.APP_URL;
  if (referer && referer !== 'MY_APP_URL') {
    headers['HTTP-Referer'] = referer;
  }
  return headers;
}

function getGatewayMode(): 'litellm' | 'direct' {
  return (process.env.LLM_GATEWAY_MODE || 'litellm').toLowerCase() === 'direct' ? 'direct' : 'litellm';
}

function getLiteLLMProvider(): LLMProvider {
  return {
    id: 'litellm',
    name: 'LiteLLM',
    baseUrl: cleanBaseUrl(process.env.LITELLM_BASE_URL || process.env.LITELLM_BASE || DEFAULT_LITELLM_BASE),
    model: process.env.LITELLM_MODEL || DEFAULT_LITELLM_MODEL,
    apiKey: process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || process.env.OPENAI_API_KEY || process.env.BYESU_API_KEY || 'local-litellm',
  };
}

function getDirectLLMProviderCandidates(): LLMProvider[] {
  return [
    {
      id: 'primary',
      name: process.env.OPENAI_PROVIDER_NAME || 'Byesu',
      baseUrl: cleanBaseUrl(process.env.OPENAI_BASE || DEFAULT_PRIMARY_BASE),
      model: process.env.OPENAI_MODEL || DEFAULT_PRIMARY_MODEL,
      apiKey: process.env.OPENAI_API_KEY || process.env.BYESU_API_KEY || '',
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: cleanBaseUrl(process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE),
      model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      apiKey: process.env.OPENROUTER_API_KEY || '',
      headers: getOpenRouterHeaders(),
    },
    {
      id: 'groq',
      name: 'Groq',
      baseUrl: cleanBaseUrl(process.env.GROQ_BASE_URL || DEFAULT_GROQ_BASE),
      model: process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL,
      apiKey: process.env.GROQ_API_KEY || '',
    },
  ];
}

function getLLMProviderCandidates(): LLMProvider[] {
  return getGatewayMode() === 'litellm'
    ? [getLiteLLMProvider(), ...getDirectLLMProviderCandidates()]
    : getDirectLLMProviderCandidates();
}

function getConfiguredLLMProviders(): LLMProvider[] {
  const directProviders = getDirectLLMProviderCandidates().filter(provider => !!provider.apiKey);
  if (getGatewayMode() === 'litellm') {
    const directFallbacks = directProviders.filter(provider => provider.id !== 'primary');
    return [getLiteLLMProvider(), ...directFallbacks];
  }
  return directProviders;
}

export function getLLMProviderSummaries(): LLMProviderSummary[] {
  return getLLMProviderCandidates().map(({ apiKey, headers, ...provider }) => ({
    ...provider,
    configured: provider.id === 'litellm' ? getGatewayMode() === 'litellm' : !!apiKey,
  }));
}

export function hasTavilyKey(): boolean {
  return tavilyKeyPool.hasConfiguredKeys();
}

export function getTavilyKeyStatus() {
  return tavilyKeyPool.getStatus();
}

export function getAPIKey(): string {
  return getConfiguredLLMProviders()[0]?.apiKey || '';
}
/**
 * Wraps fetch with a hard AbortController timeout and automatic retry on 5xx/network errors.
 * Prevents indefinite hangs when an LLM provider is slow or overloaded.
 * Default: 45s timeout, 1 retry (waits 2s then 4s between attempts).
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 45000),
  maxRetries = Number(process.env.LLM_MAX_RETRIES || 1)
): Promise<Response> {
  const retry429 = process.env.LLM_RETRY_429 === 'true';
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(options.headers as Record<string, string> || {})
  };
  const requestOptions = {
    ...options,
    headers
  };

  let lastError: Error = new Error('Unknown fetch error');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...requestOptions, signal: controller.signal });
      clearTimeout(timer);
      
      const isRetryableStatus = 
        (res.status >= 500 && res.status <= 599) || 
        (res.status === 429 && retry429);

      if (isRetryableStatus && attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 2000; // 2s, then 4s
        console.warn(`[llm] HTTP ${res.status} on attempt ${attempt + 1}/${maxRetries + 1}. Retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      return res;
    } catch (err: any) {
      clearTimeout(timer);
      lastError = err?.name === 'AbortError'
        ? new Error(`LLM request timed out after ${timeoutMs / 1000}s`)
        : (err instanceof Error ? err : new Error(String(err)));
      if (attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 2000;
        console.warn(`[llm] Fetch error on attempt ${attempt + 1}/${maxRetries + 1}: ${lastError.message}. Retrying in ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  throw lastError;
}

class LLMProviderError extends Error {
  provider: LLMProvider;
  status?: number;

  constructor(provider: LLMProvider, status: number | undefined, message: string) {
    super(`[${provider.name}] ${message}`);
    this.name = 'LLMProviderError';
    this.provider = provider;
    this.status = status;
  }
}

function truncateProviderError(message: string): string {
  return message.length > 500 ? `${message.slice(0, 500)}... [truncated]` : message;
}

function formatProviderFailures(errors: Error[]): string {
  return errors.map(error => error.message).join(' | ');
}

async function withProviderFallback<T>(
  operation: (provider: LLMProvider) => Promise<T>
): Promise<T> {
  const providers = getConfiguredLLMProviders();
  if (providers.length === 0) {
    throw new Error('No LLM provider available. Use LLM_GATEWAY_MODE=litellm for the local LiteLLM proxy, or configure OPENAI_API_KEY/BYESU_API_KEY, OPENROUTER_API_KEY, or GROQ_API_KEY for direct mode.');
  }

  const failures: Error[] = [];
  for (const provider of providers) {
    try {
      return await operation(provider);
    } catch (error: any) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      failures.push(normalized);
      console.warn(`[llm] ${provider.name} failed; trying next configured provider if available: ${normalized.message}`);
    }
  }

  throw new Error(`All configured LLM providers failed: ${formatProviderFailures(failures)}`);
}

async function sendChatCompletion(
  provider: LLMProvider,
  messages: ChatMessage[],
  options?: { maxTokens?: number; temperature?: number; responseFormat?: { type: 'json_object' } }
): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithRetry(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...(provider.headers || {}),
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: options?.temperature !== undefined ? options.temperature : 0.1,
        max_tokens: options?.maxTokens !== undefined ? options.maxTokens : 4000,
        ...(options?.responseFormat ? { response_format: options.responseFormat } : {}),
      })
    });
  } catch (error: any) {
    throw new LLMProviderError(
      provider,
      undefined,
      error instanceof Error ? error.message : String(error)
    );
  }

  if (!res.ok) {
    const err = truncateProviderError(await res.text());
    throw new LLMProviderError(provider, res.status, `chat completion error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}


/** Converts uppercase Type constants to lowercase for the OpenAI schema representation. */
function normalizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'type' && typeof v === 'string') {
      out[k] = (v as string).toLowerCase();
    } else if (Array.isArray(v)) {
      out[k] = v.map((item: any) => normalizeSchema(item));
    } else if (typeof v === 'object' && v !== null) {
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
  const retryAfter = res.headers.get('retry-after');
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

export type TavilySearchOptions = {
  includeDomains?: string[];
  excludeDomains?: string[];
  searchDepth?: 'basic' | 'fast' | 'ultra-fast' | 'advanced';
  topic?: 'general' | 'news';
  timeRange?: 'day' | 'week' | 'month' | 'year';
  country?: string;
  maxResults?: number;
  includeRawContent?: boolean;
  chunksPerSource?: number;
};

/**
 * Tavily's include_domains and exclude_domains fields accept domain names.
 * Callers sometimes have a full URL or a LinkedIn /in/ path, so normalize at
 * the provider boundary instead of sending a path as a supposed domain.
 */
export function normalizeTavilyDomain(value: string) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export async function tavilySearch(
  query: string,
  domainsOrOptions?: string[] | TavilySearchOptions
): Promise<{ text: string; sources: { title: string; uri: string }[], items: any[] }> {
  const options: TavilySearchOptions = Array.isArray(domainsOrOptions)
    ? { includeDomains: domainsOrOptions }
    : (domainsOrOptions || {});
  const requestedDepth = options.searchDepth || process.env.TAVILY_SEARCH_DEPTH || 'basic';
  const searchDepth = ['basic', 'fast', 'ultra-fast', 'advanced'].includes(requestedDepth)
    ? requestedDepth as TavilySearchOptions['searchDepth']
    : 'basic';
  const maxResults = Math.min(Math.max(Number(options.maxResults || process.env.TAVILY_MAX_RESULTS || 10), 1), 20);
  const includeRawContent = options.includeRawContent ?? process.env.TAVILY_INCLUDE_RAW_CONTENT !== 'false';
  const topic = options.topic === 'news' ? 'news' : 'general';
  // Tavily documents lowercase country enum values (for example, "united states").
  const country = options.country?.trim().toLowerCase();
  const chunksPerSource = searchDepth === 'advanced' || searchDepth === 'fast'
    ? Math.min(Math.max(Number(options.chunksPerSource || 2), 1), 3)
    : undefined;
  const includeDomains = Array.from(new Set((options.includeDomains || [])
    .map(normalizeTavilyDomain)
    .filter(Boolean))).slice(0, 30);
  const excludeDomains = Array.from(new Set((options.excludeDomains || [])
    .map(normalizeTavilyDomain)
    .filter(Boolean))).slice(0, 30);
  const data = await executeWithKeyRotation(tavilyKeyPool, async (apiKey) => {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
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
        ...(topic === 'news' ? { topic } : { topic, ...(country ? { country } : {}) })
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new KeyRotationError(`Tavily search error ${res.status}: ${err}`, {
        statusCode: res.status,
        responseText: err,
        retryAfterMs: retryAfterMsFromResponse(res)
      });
    }

    return res.json();
  });
  const items = Array.isArray(data.results) ? data.results : [];

  let text = '';
  const sources: { title: string; uri: string }[] = [];

  for (const item of items) {
    const title = item.title || 'Untitled result';
    const url = item.url || '';
    const snippet = item.content || item.raw_content || '';
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
    extractDepth?: 'basic' | 'advanced';
    chunksPerSource?: number;
    timeout?: number;
  }
): Promise<TavilyExtractResult[]> {
  const cleanUrls = Array.from(new Set(urls.filter(Boolean))).slice(0, 20);
  if (cleanUrls.length === 0) return [];

  const data = await executeWithKeyRotation(tavilyKeyPool, async (apiKey) => {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        urls: cleanUrls,
        query,
        extract_depth: options?.extractDepth || 'basic',
        chunks_per_source: Math.min(Math.max(Number(options?.chunksPerSource || 5), 1), 5),
        format: 'markdown',
        include_images: false,
        include_favicon: false,
        include_usage: true,
        timeout: Math.min(Math.max(Number(options?.timeout || 30), 1), 120)
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new KeyRotationError(`Tavily extract error ${res.status}: ${err}`, {
        statusCode: res.status,
        responseText: err,
        retryAfterMs: retryAfterMsFromResponse(res)
      });
    }

    return res.json();
  });
  const results = Array.isArray(data.results) ? data.results : [];
  return results.map((item: any) => ({
    url: item.url || '',
    rawContent: item.raw_content || item.content || '',
    images: Array.isArray(item.images) ? item.images : []
  })).filter((item: TavilyExtractResult) => item.url && item.rawContent);
}

/**
 * Calls OpenAI compatible API for pure text generation.
 */
export async function openAIText(
  prompt: string,
  systemInstruction?: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<{ text: string; provider: string; model: string; baseUrl: string }> {
  const messages: ChatMessage[] = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: (systemInstruction as any).toWellFormed ? (systemInstruction as any).toWellFormed() : systemInstruction });
  }
  messages.push({ role: 'user', content: (prompt as any).toWellFormed ? (prompt as any).toWellFormed() : prompt });

  return withProviderFallback(async (provider) => ({
    text: await sendChatCompletion(provider, messages, options),
    provider: provider.name,
    model: provider.model,
    baseUrl: provider.baseUrl,
  }));
}

function stripMarkdownFence(str: string): string {
  let cleaned = str.trim();
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    if (lines[0].startsWith('```')) lines.shift();
    if (lines[lines.length - 1]?.trim() === '```') lines.pop();
    cleaned = lines.join('\n').trim();
  }
  return cleaned;
}

function stripReasoningBlocks(str: string): string {
  let cleaned = str.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const finalClose = cleaned.toLowerCase().lastIndexOf('</think>');
  if (finalClose !== -1) {
    cleaned = cleaned.slice(finalClose + '</think>'.length).trim();
  }
  return cleaned;
}

function getMarkedJSONBlock(str: string): string | null {
  const match = str.match(/FINAL_JSON_START\s*([\s\S]*?)\s*FINAL_JSON_END/i);
  return match?.[1]?.trim() || null;
}

function findBalancedJSONCandidates(str: string, preferArray: boolean): string[] {
  const candidates: string[] = [];
  const starts = preferArray ? ['[', '{'] : ['{', '['];

  for (const startChar of starts) {
    for (let start = str.indexOf(startChar); start !== -1; start = str.indexOf(startChar, start + 1)) {
      const stack: string[] = [];
      let inString = false;
      let escaped = false;

      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === '\\') {
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
        if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') {
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

function cleanJSONString(str: string): string {
  const marked = getMarkedJSONBlock(str);
  if (marked) return stripMarkdownFence(marked);

  let cleaned = stripMarkdownFence(stripReasoningBlocks(str));
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIdx = -1;
  if (firstBrace !== -1 && firstBracket !== -1) startIdx = Math.min(firstBrace, firstBracket);
  else if (firstBrace !== -1) startIdx = firstBrace;
  else if (firstBracket !== -1) startIdx = firstBracket;

  if (startIdx !== -1) {
    const lastBrace = cleaned.lastIndexOf('}');
    const lastBracket = cleaned.lastIndexOf(']');
    const endIdx = Math.max(lastBrace, lastBracket);
    if (endIdx !== -1 && endIdx > startIdx) cleaned = cleaned.slice(startIdx, endIdx + 1);
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
  options?: { maxTokens?: number; temperature?: number; retryOnParseFailure?: boolean }
): Promise<T> {
  const jsonMode = process.env.LLM_JSON_MODE || 'off';
  const useJsonMode = jsonMode === 'on' || jsonMode === 'auto';
  const normalizedSchema = normalizeSchema(schema);
  const schemaIsArray = normalizedSchema?.type === 'array';
  const responseSchema = useJsonMode && schemaIsArray
    ? {
        type: 'object',
        properties: {
          items: normalizedSchema
        },
        required: ['items']
      }
    : normalizedSchema;

  let sysPrompt = systemInstruction || '';
  if (useJsonMode) {
    sysPrompt += `\n\nYou MUST respond ONLY in valid JSON. Do not include markdown, comments, <think> tags, explanations, or text before/after the JSON. The JSON must exactly match this schema:\n${JSON.stringify(responseSchema, null, 2)}`;
  } else {
    sysPrompt += `\n\nYou may reason internally or in <think>...</think>, but the final answer must include exactly one JSON value between FINAL_JSON_START and FINAL_JSON_END. Do not put schema examples or commentary between those markers. The final JSON must exactly match this schema:\n${JSON.stringify(responseSchema, null, 2)}`;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: (sysPrompt as any).toWellFormed ? (sysPrompt as any).toWellFormed() : sysPrompt },
    { role: 'user', content: (prompt as any).toWellFormed ? (prompt as any).toWellFormed() : prompt }
  ];

  const schemaRequired = Array.isArray(normalizedSchema?.required) ? normalizedSchema.required : [];
  const coerceParsed = (parsed: any): T | null => {
    if (schemaIsArray) {
      const value = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
      if (!Array.isArray(value)) return null;
      if (value.length > 0 && !value.some((item: any) => item && typeof item === 'object' && (
        typeof item.fullName === 'string' ||
        typeof item.headline === 'string' ||
        typeof item.currentTitle === 'string' ||
        typeof item.currentCompany === 'string' ||
        item.contactDetails
      ))) return null;
      return value as T;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    for (const key of schemaRequired) {
      if (!(key in parsed)) return null;
      const schemaProperty = normalizedSchema?.properties?.[key];
      if (schemaProperty?.type === 'array' && !Array.isArray(parsed[key])) return null;
    }
    return parsed as T;
  };

  const parseStructuredText = (rawText: string): T => {
    const sources = [
      getMarkedJSONBlock(rawText),
      stripReasoningBlocks(rawText),
      rawText
    ].filter((source): source is string => Boolean(source && source.trim()));

    const parseErrors: string[] = [];
    for (const source of sources) {
      const directCandidates = [cleanJSONString(source), ...findBalancedJSONCandidates(source, schemaIsArray)];
      for (const candidate of directCandidates) {
        try {
          const parsed = JSON.parse(stripMarkdownFence(candidate));
          const coerced = coerceParsed(parsed);
          if (coerced !== null) return coerced;
        } catch (err: any) {
          if (parseErrors.length < 3) parseErrors.push(err?.message || String(err));
        }
      }
    }

    throw new Error(parseErrors[0] || 'No schema-matching JSON block found');
  };

  return withProviderFallback(async (provider) => {
    let text = '';
    try {
      text = await sendChatCompletion(provider, messages, {
        ...options,
        ...(useJsonMode ? { responseFormat: { type: 'json_object' as const } } : {}),
      });
    } catch (error: any) {
      const isJsonValidationError =
        error instanceof LLMProviderError &&
        (error.status === 400 ||
        error.status === 422 ||
        error.message.includes('json_validate_failed') ||
        error.message.includes('Failed to validate JSON') ||
        error.message.includes('json_validate') ||
        error.message.includes('response_format'));

      if (jsonMode === 'auto' && isJsonValidationError) {
        console.warn(`[llm] Structured output call failed for ${provider.name}. Retrying without response_format due to LLM_JSON_MODE=auto...`);
        text = await sendChatCompletion(provider, messages, options);
      } else {
        throw error;
      }
    }

    try {
      return parseStructuredText(text);
    } catch (firstParseError: any) {
      const shouldRetry = options?.retryOnParseFailure !== false;
      if (!shouldRetry) {
        throw new Error(`[${provider.name}] Failed to parse OpenAI-compatible JSON response (parse_error=${firstParseError?.message || 'unknown'}): ${text.slice(0, 300)}`);
      }

      const retryMaxTokens = Math.max(
        Number(process.env.LLM_STRUCTURED_RETRY_MAX_TOKENS || 5000),
        Math.min((options?.maxTokens || 4000) * 2, 8000)
      );
      const retryMessages: ChatMessage[] = [
        {
          role: 'system',
          content: `${sysPrompt}\n\nYour previous response was not usable. You may keep reasoning in <think>...</think>, but then output the final JSON only between FINAL_JSON_START and FINAL_JSON_END. Keep summaries and evidence reasons short enough to finish within the token limit.`
        },
        {
          role: 'user',
          content: (prompt as any).toWellFormed ? (prompt as any).toWellFormed() : prompt
        }
      ];
      const retryText = await sendChatCompletion(provider, retryMessages, {
        ...options,
        maxTokens: retryMaxTokens,
        temperature: 0,
        ...(useJsonMode ? { responseFormat: { type: 'json_object' as const } } : {}),
      });

      try {
        return parseStructuredText(retryText);
      } catch {
        throw new Error(`[${provider.name}] Failed to parse OpenAI-compatible JSON response after retry (first_parse_error=${firstParseError?.message || 'unknown'}): ${retryText.slice(0, 300)}`);
      }
    }
  });
}
/** Returns true when at least one LLM provider API key is available. */
export function hasOpenAIKey(): boolean {
  return !!getAPIKey();
}

// -----------------------------------------------------------------------------
// Type Schemas for OpenAI Structure Responses
// -----------------------------------------------------------------------------

export const singleProfileSchema = {
  type: Type.OBJECT,
  properties: {
    fullName: { type: Type.STRING, description: "Person's first name and last name" },
    headline: { type: Type.STRING, description: "Professional headline or current summary statement" },
    currentCompany: { type: Type.STRING, description: "Name of current employer company" },
    currentTitle: { type: Type.STRING, description: "Current role/title" },
    seniorityLevel: { type: Type.STRING, description: "Buying authority classification: C-Suite / Founder-Owner / VP / Head / Director / Manager / IC / Assistant / Student / Unknown. Do not classify Assistant to CEO as C-Suite, student club founder as Founder-Owner, or Product Owner as Owner." },
    companySizeEst: { type: Type.STRING, description: "1-10 / 11-50 / 51-200 / 201-500 / 500+ / UNKNOWN" },
    location: { type: Type.STRING, description: "City, State or Country" },
    summary: { type: Type.STRING, description: "A high-quality 2-3 sentence professional summary" },
    industry: { type: Type.STRING, description: "The industry category (e.g. Software, Finance, Healthcare, Real Estate)" },
    contactDetails: {
      type: Type.OBJECT,
      properties: {
        email: { type: Type.STRING, description: "Email if found, or INFERRED email pattern based on company data (e.g. jsmith@company.com). Label appropriately." },
        phone: { type: Type.STRING, description: "Mobile or office contact phone number if found" },
        linkedinUrl: { type: Type.STRING, description: "Complete LinkedIn profile URL" },
        twitter: { type: Type.STRING, description: "Twitter/X handle if found" },
        website: { type: Type.STRING, description: "Company or personal portfolio website" },
      },
    },
    experiences: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Role title" },
          company: { type: Type.STRING, description: "Company name" },
          duration: { type: Type.STRING, description: "E.g., 2021 - Present or Jan 2020 - Dec 2022" },
          location: { type: Type.STRING, description: "Role location" },
          description: { type: Type.STRING, description: "Summary of main tasks/impact" },
        },
        required: ["title", "company"],
      },
    },
    education: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          school: { type: Type.STRING, description: "University or institution name" },
          degree: { type: Type.STRING, description: "B.S., M.S., Ph.D, etc." },
          fieldOfStudy: { type: Type.STRING, description: "Major study" },
          duration: { type: Type.STRING, description: "E.g., 2016 - 2020" },
        },
        required: ["school"],
      },
    },
    skills: { type: Type.ARRAY, items: { type: Type.STRING } },
    yearsInRole: { type: Type.STRING, description: "Calculated if dates available" },
    careerSignals: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3 bullet points - notable transitions, promotions" },
    techStackHints: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Tools/software mentioned" },
    painIndicators: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Quoted phrases or inferred needs" },
    enrichmentGaps: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List all MISSING fields that block outreach" },
    icpScoreReasoning: { type: Type.STRING, description: "1-10 rating rationale" },
    fitScore: { type: Type.NUMBER, description: "ICP match based on title, industry, company size (out of 10)" },
    intentScore: { type: Type.NUMBER, description: "Buying signals (out of 10)" },
    timingScore: { type: Type.NUMBER, description: "Recent role change, funding event (out of 10)" },
  },
  required: ["fullName"],
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
      description: "Array of targeted query plan objects. Legacy string entries are tolerated by server normalization.",
      items: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: "Plain search phrase. Do not include LinkedIn or site:." },
          family: { type: Type.STRING, description: "persona_title | industry_vertical | pain_signal | growth_signal | tooling_signal | local_market | company_type" },
          intent: { type: Type.STRING, description: "find_decision_makers | find_buying_signal | expand_surface_area | recover_from_low_yield | reduce_duplicates" },
          expectedSignal: { type: Type.STRING, description: "Short reason this query should surface relevant prospects" },
          priority: { type: Type.NUMBER, description: "Lower numbers run first" },
          lane: { type: Type.STRING, description: "person | account | signal" },
          providerPreference: { type: Type.STRING, description: "tavily | brightdata | corroborate" },
          searchDepth: { type: Type.STRING, description: "basic | fast | ultra-fast | advanced. Prefer basic; advanced only for one high-value signal task." },
          topic: { type: Type.STRING, description: "general | news" },
          timeRange: { type: Type.STRING, description: "week | month | year when recency is relevant" },
          country: { type: Type.STRING, description: "Country name only when explicit geography matters" },
        },
        required: ["query"],
      }
    }
  },
  required: ["queries"]
};

export const searchSpecSchema = {
  type: Type.OBJECT,
  properties: {
    mode: { type: Type.STRING, description: 'person_first | account_first | signal_first | local_business' },
    person: {
      type: Type.OBJECT,
      properties: {
        includeTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
        excludeTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
        seniorities: { type: Type.ARRAY, items: { type: Type.STRING } },
        locations: { type: Type.ARRAY, items: { type: Type.STRING } }
      }
    },
    company: {
      type: Type.OBJECT,
      properties: {
        industries: { type: Type.ARRAY, items: { type: Type.STRING } },
        keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
        locations: { type: Type.ARRAY, items: { type: Type.STRING } },
        employeeRange: { type: Type.OBJECT, properties: { min: { type: Type.NUMBER }, max: { type: Type.NUMBER } } }
      }
    },
    signals: { type: Type.OBJECT, properties: { include: { type: Type.ARRAY, items: { type: Type.STRING } }, recencyDays: { type: Type.NUMBER } } },
    exclusions: { type: Type.OBJECT, properties: { companies: { type: Type.ARRAY, items: { type: Type.STRING } }, domains: { type: Type.ARRAY, items: { type: Type.STRING } } } },
    maxPerCompany: { type: Type.NUMBER }
  }
};

// -----------------------------------------------------------------------------
// Lean per-task system prompts - scoped to what each call actually needs.
// Sending the full APEX_SYSTEM_PROMPT (~530 tokens) to every call wastes tokens
// on irrelevant rules (e.g. outreach golden rules during query generation).
// -----------------------------------------------------------------------------

/** Minimal prompt for Step 1 - query generation only. */
export const STRATEGIST_SYSTEM_PROMPT = `You are an expert B2B sales search strategist. Your sole task is to produce precise, targeted search query plan objects that surface LinkedIn profiles matching the user's lead criteria. Output only valid JSON.`;

/** Focused prompt for Step 3 - initial scouting only. Deep enrichment and email
 * discovery deliberately happen after manual selection. */
export const EXTRACTION_SYSTEM_PROMPT = `You are a B2B prospect scouting extraction engine. Extract only facts directly supported by source evidence and return valid JSON matching the schema exactly.
Rules: Never invent data. Use empty strings for missing fields. Do not infer or generate email addresses. Do not invent employment history, company size, funding, intent, or timing. Classify seniorityLevel by actual buying authority, not substring matching: Assistant to CEO is Assistant, student club founder is Student/IC, Product Owner is not Company Owner, and CRO/CIO/Head of Engineering/VP of Sales are executive authority. Keep summaries under 140 characters and evidence reasons under 90 characters. If reasoning is visible, keep it outside the final JSON markers.`;

// -----------------------------------------------------------------------------
// Trimmed schema for bulk extraction.
// Drops high-token optional fields (careerSignals, experiences, education,
// techStackHints, painIndicators) that are better enriched individually on
// committed leads. Cuts schema token cost from ~800 to ~300 tokens (~40% saving).
// -----------------------------------------------------------------------------

export const bulkSingleProfileSchema = {
  type: Type.OBJECT,
  properties: {
    fullName: { type: Type.STRING, description: "Person's full name" },
    headline: { type: Type.STRING, description: "Professional headline" },
    currentCompany: { type: Type.STRING, description: "Current employer" },
    currentTitle: { type: Type.STRING, description: "Current role/title" },
    seniorityLevel: { type: Type.STRING, description: "Buying authority classification: C-Suite / Founder-Owner / VP / Head / Director / Manager / IC / Assistant / Student / Unknown. Do not classify Assistant to CEO as C-Suite, student club founder as Founder-Owner, or Product Owner as Owner." },
    companySizeEst: { type: Type.STRING, description: "Company size only when the source explicitly provides it; otherwise UNKNOWN" },
    location: { type: Type.STRING, description: "City, State or Country" },
    industry: { type: Type.STRING, description: "Industry category (e.g. Software, Finance, Healthcare)" },
    summary: { type: Type.STRING, description: "2-sentence professional summary" },
    contactDetails: {
      type: Type.OBJECT,
      properties: {
        linkedinUrl: { type: Type.STRING, description: "Full public professional profile URL when supplied by source LINK" },
        website: { type: Type.STRING, description: "Company or personal website" },
      },
    },
    fitScore: { type: Type.NUMBER, description: "Conservative 1-10 match based only on explicit title, company, industry, and location evidence" },
    intentScore: { type: Type.NUMBER, description: "1-10 only when a specific public signal is visible; otherwise use 5" },
    timingScore: { type: Type.NUMBER, description: "1-10 only when a dated public trigger is visible; otherwise use 5" },
    sourceProvider: { type: Type.STRING, description: "tavily or brightdata, copied from SOURCE_PROVIDER when present" },
    evidenceReasons: { type: Type.ARRAY, items: { type: Type.STRING }, description: "1-3 short evidence-backed reasons this prospect matches the user query" },
  },
  required: ["fullName"],
};

export const bulkLeadsArraySchema = {
  type: Type.ARRAY,
  items: bulkSingleProfileSchema,
};
