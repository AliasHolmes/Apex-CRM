export const Type = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  INTEGER: 'INTEGER',
  BOOLEAN: 'BOOLEAN',
  ARRAY: 'ARRAY',
  OBJECT: 'OBJECT',
};

// -----------------------------------------------------------------------------
// OpenAI Compatible REST API Helpers (OPENAI_API_KEY)
// -----------------------------------------------------------------------------

const gatewayMode = process.env.LLM_GATEWAY_MODE || 'direct';

const defaultBase = gatewayMode === 'litellm'
  ? (process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1')
  : (process.env.OPENAI_BASE || 'https://api.byesu.com/v1');

const defaultModel = gatewayMode === 'litellm'
  ? (process.env.LITELLM_MODEL || 'apex-primary')
  : (process.env.OPENAI_MODEL || 'gpt-5.5');

const OPENAI_BASE = defaultBase;
const OPENAI_MODEL = defaultModel;

export function getAPIKey(): string {
  const gatewayMode = process.env.LLM_GATEWAY_MODE || 'direct';
  if (gatewayMode === 'litellm') {
    return process.env.LITELLM_MASTER_KEY || '';
  }
  return process.env.OPENAI_API_KEY || process.env.BYESU_API_KEY || '';
}

/**
 * Wraps fetch with a hard AbortController timeout and automatic retry on 5xx/network errors.
 * Prevents indefinite hangs when the LLM proxy is slow or overloaded.
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
export async function tavilySearch(
  query: string,
  includeDomains?: string[]
): Promise<{ text: string; sources: { title: string; uri: string }[], items: any[] }> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY is not set in environment.');

  const maxResults = Math.min(Math.max(Number(process.env.TAVILY_MAX_RESULTS || 10), 1), 20);
  const includeRawContent = process.env.TAVILY_INCLUDE_RAW_CONTENT !== 'false';
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      search_depth: process.env.TAVILY_SEARCH_DEPTH || 'basic',
      max_results: maxResults,
      include_answer: false,
      include_raw_content: includeRawContent,
      include_usage: true,
      ...(includeDomains ? { include_domains: includeDomains } : {})
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tavily search error ${res.status}: ${err}`);
  }

  const data = await res.json();
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

/**
 * Calls OpenAI compatible API for pure text generation.
 */
export async function openAIText(prompt: string, systemInstruction?: string): Promise<{ text: string }> {
  const apiKey = getAPIKey();
  if (!apiKey) throw new Error('No OpenAI compatible API key available.');

  const messages = [];
  if (systemInstruction) {
    messages.push({ role: 'system', content: (systemInstruction as any).toWellFormed ? (systemInstruction as any).toWellFormed() : systemInstruction });
  }
  messages.push({ role: 'user', content: (prompt as any).toWellFormed ? (prompt as any).toWellFormed() : prompt });

  const res = await fetchWithRetry(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.1,
      max_tokens: 4000
    })
  });

  if (!res.ok) {
    let err = await res.text();
    if (err.length > 500) {
      err = err.slice(0, 500) + '... [truncated]';
    }
    throw new Error(`OpenAI text generation error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';

  return { text };
}

function cleanJSONString(str: string): string {
  let cleaned = str.trim();
  // Remove markdown code block wrappers
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    if (lines[0].startsWith('```')) {
      lines.shift();
    }
    if (lines[lines.length - 1] === '```') {
      lines.pop();
    }
    cleaned = lines.join('\n').trim();
  }
  // Extract content between first [ or { and last ] or }
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIdx = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }

  if (startIdx !== -1) {
    const lastBrace = cleaned.lastIndexOf('}');
    const lastBracket = cleaned.lastIndexOf(']');
    const endIdx = Math.max(lastBrace, lastBracket);
    if (endIdx !== -1 && endIdx > startIdx) {
      cleaned = cleaned.slice(startIdx, endIdx + 1);
    }
  }
  return cleaned;
}

/**
 * Calls OpenAI compatible API with a request for a strict JSON response.
 * Used as step 2 to convert raw searched text into clean structured data.
 */
export async function openAIStructured<T>(prompt: string, schema: any, systemInstruction?: string): Promise<T> {
  const apiKey = getAPIKey();
  if (!apiKey) throw new Error('No OpenAI compatible API key available.');

  let sysPrompt = systemInstruction || '';
  sysPrompt += `\n\nYou MUST respond ONLY in valid JSON. The JSON must exactly match this schema:\n${JSON.stringify(normalizeSchema(schema), null, 2)}`;

  const messages = [
    { role: 'system', content: (sysPrompt as any).toWellFormed ? (sysPrompt as any).toWellFormed() : sysPrompt },
    { role: 'user', content: (prompt as any).toWellFormed ? (prompt as any).toWellFormed() : prompt }
  ];

  const jsonMode = process.env.LLM_JSON_MODE || 'auto';
  const useJsonMode = jsonMode === 'on' || jsonMode === 'auto';

  const body: any = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0.1,
    max_tokens: 4000,
  };
  if (useJsonMode) {
    body.response_format = { type: "json_object" };
  }

  let res = await fetchWithRetry(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let err = await res.text();
    const isJsonValidationError = 
      res.status === 400 || 
      res.status === 422 || 
      err.includes('json_validate_failed') || 
      err.includes('Failed to validate JSON') || 
      err.includes('json_validate');

    if (jsonMode === 'auto' && isJsonValidationError) {
      console.warn(`[llm] Structured output call failed (JSON validation error). Retrying without response_format due to LLM_JSON_MODE=auto...`);
      delete body.response_format;
      res = await fetchWithRetry(`${OPENAI_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        let retryErr = await res.text();
        if (retryErr.length > 500) {
          retryErr = retryErr.slice(0, 500) + '... [truncated]';
        }
        throw new Error(`OpenAI structured call error ${res.status}: ${retryErr}`);
      }
    } else {
      if (err.length > 500) {
        err = err.slice(0, 500) + '... [truncated]';
      }
      throw new Error(`OpenAI structured call error ${res.status}: ${err}`);
    }
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';

  try {
    return JSON.parse(cleanJSONString(text)) as T;
  } catch {
    throw new Error(`Failed to parse OpenAI JSON response: ${text.slice(0, 300)}`);
  }
}

/** Returns true when a real OpenAI API key is available. */
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
    seniorityLevel: { type: Type.STRING, description: "C-Suite / VP / Director / Manager / IC / Founder" },
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
        },
        required: ["query"],
      }
    }
  },
  required: ["queries"]
};

// -----------------------------------------------------------------------------
// Lean per-task system prompts - scoped to what each call actually needs.
// Sending the full APEX_SYSTEM_PROMPT (~530 tokens) to every call wastes tokens
// on irrelevant rules (e.g. outreach golden rules during query generation).
// -----------------------------------------------------------------------------

/** Minimal prompt for Step 1 - query generation only. */
export const STRATEGIST_SYSTEM_PROMPT = `You are an expert B2B sales search strategist. Your sole task is to produce precise, targeted search query plan objects that surface LinkedIn profiles matching the user's lead criteria. Output only valid JSON.`;

/** Focused prompt for Step 3 - bulk extraction only. No outreach or scoring formula needed. */
export const EXTRACTION_SYSTEM_PROMPT = `You are a CRM data extraction engine. Extract structured lead records from raw search result text and return valid JSON matching the schema exactly.
Rules: Never invent data. Use empty strings for missing fields. Score fitScore/intentScore/timingScore 1-10 based only on signals visible in the provided text.`;

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
    seniorityLevel: { type: Type.STRING, description: "C-Suite / VP / Director / Manager / IC / Founder" },
    companySizeEst: { type: Type.STRING, description: "1-10 / 11-50 / 51-200 / 201-500 / 500+ / UNKNOWN" },
    location: { type: Type.STRING, description: "City, State or Country" },
    industry: { type: Type.STRING, description: "Industry category (e.g. Software, Finance, Healthcare)" },
    summary: { type: Type.STRING, description: "2-sentence professional summary" },
    contactDetails: {
      type: Type.OBJECT,
      properties: {
        email: { type: Type.STRING, description: "Email if found, or INFERRED pattern" },
        linkedinUrl: { type: Type.STRING, description: "Full LinkedIn profile URL" },
        website: { type: Type.STRING, description: "Company or personal website" },
      },
    },
    fitScore: { type: Type.NUMBER, description: "ICP match 1-10" },
    intentScore: { type: Type.NUMBER, description: "Buying signals 1-10" },
    timingScore: { type: Type.NUMBER, description: "Recent role change or trigger 1-10" },
    sourceProvider: { type: Type.STRING, description: "tavily or brightdata, copied from SOURCE_PROVIDER when present" },
    evidenceReasons: { type: Type.ARRAY, items: { type: Type.STRING }, description: "1-3 short evidence-backed reasons this prospect matches the user query" },
    evidence: { type: Type.OBJECT, description: "Server-populated evidence object. Leave empty if not present in evidence." },
    scoreBreakdown: { type: Type.OBJECT, description: "Server-populated score object. Leave empty if not present in evidence." },
  },
  required: ["fullName"],
};

export const bulkLeadsArraySchema = {
  type: Type.ARRAY,
  items: bulkSingleProfileSchema,
};
