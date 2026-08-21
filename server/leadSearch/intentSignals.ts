import crypto from 'node:crypto';
import { openAIStructured } from '../services/llm.js';
import type { ProspectContract } from './prospectContract.js';

export type CategorizedIntentSignals = {
  tooling: string[];
  hiring: string[];
  pain: string[];
  growth: string[];
};

export type IntentSignalSpec = {
  version: 1;
  universal: string[];
  dynamic: string[];
  categorized?: CategorizedIntentSignals;
  fingerprint: string;
};

export const UNIVERSAL_SIGNALS: string[] = [
  'hiring', 'expanding', 'launched', 'growing', 'automation',
  'operations', 'workflow', 'lead generation', 'conversion'
];

const cleanSignalToken = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

export function parseSnippetFreshnessDays(snippets: string[] | string): number {
  const texts = Array.isArray(snippets) ? snippets : [snippets];
  let minDays: number | null = null;
  for (const raw of texts) {
    const text = String(raw || '').toLowerCase();
    const hoursMatch = text.match(/\b(\d+)\s*(?:hour|hr)s?\s*ago\b/);
    if (hoursMatch) return 0;
    const daysMatch = text.match(/\b(\d+)\s*days?\s*ago\b/);
    if (daysMatch) {
      const d = parseInt(daysMatch[1], 10);
      minDays = minDays === null ? d : Math.min(minDays, d);
      continue;
    }
    const weeksMatch = text.match(/\b(\d+)\s*weeks?\s*ago\b/);
    if (weeksMatch) {
      const d = parseInt(weeksMatch[1], 10) * 7;
      minDays = minDays === null ? d : Math.min(minDays, d);
      continue;
    }
    const monthsMatch = text.match(/\b(\d+)\s*months?\s*ago\b/);
    if (monthsMatch) {
      const d = parseInt(monthsMatch[1], 10) * 30;
      minDays = minDays === null ? d : Math.min(minDays, d);
      continue;
    }
    const yearsMatch = text.match(/\b(\d+)\s*years?\s*ago\b/);
    if (yearsMatch) {
      const d = parseInt(yearsMatch[1], 10) * 365;
      minDays = minDays === null ? d : Math.min(minDays, d);
      continue;
    }
  }
  // When no explicit relative timestamp is present in the snippet, default to 0 days (freshly returned SERP post)
  return minDays !== null ? minDays : 0;
}

export function computeFreshnessMultiplier(ageDays: number): number {
  // Exponential decay with half-life ~35 days; floor at 0.20
  return Number(Math.max(0.20, Math.min(1.0, Math.exp(-0.02 * Math.max(0, ageDays)))).toFixed(2));
}

export function computeSignalFingerprint(dynamicSignals: string[]): string {
  const sortedUnique = Array.from(new Set(dynamicSignals.map(cleanSignalToken).filter(Boolean))).sort();
  if (sortedUnique.length === 0) return 'fallback';
  return crypto.createHash('sha256').update(sortedUnique.join('|')).digest('hex').slice(0, 16);
}

export function normalizeDynamicSignals(rawSignals: unknown): string[] {
  if (!Array.isArray(rawSignals)) return [];
  const universalSet = new Set(UNIVERSAL_SIGNALS.map(s => s.toLowerCase()));
  const cleaned: string[] = [];

  for (const raw of rawSignals) {
    const token = cleanSignalToken(raw);
    if (!token || token.length < 2 || token.length > 50) continue;
    // Cap at max 3 words
    const wordCount = token.split(' ').length;
    if (wordCount > 3) continue;
    // Skip if it's already in universal signals
    if (universalSet.has(token)) continue;
    cleaned.push(token);
  }

  return Array.from(new Set(cleaned)).slice(0, 25);
}

export function buildFallbackIntentSignals(): IntentSignalSpec {
  return {
    version: 1,
    universal: [...UNIVERSAL_SIGNALS],
    dynamic: [],
    categorized: {
      tooling: [],
      hiring: [],
      pain: [],
      growth: []
    },
    fingerprint: 'fallback'
  };
}

const intentSignalsSchema = {
  type: 'OBJECT',
  properties: {
    dynamic_signals: {
      type: 'ARRAY',
      items: { type: 'STRING' }
    },
    categorized: {
      type: 'OBJECT',
      properties: {
        tooling: { type: 'ARRAY', items: { type: 'STRING' } },
        hiring: { type: 'ARRAY', items: { type: 'STRING' } },
        pain: { type: 'ARRAY', items: { type: 'STRING' } },
        growth: { type: 'ARRAY', items: { type: 'STRING' } }
      }
    }
  },
  required: ['dynamic_signals']
};

export async function compileIntentSignals(
  promptQuery: string,
  contract: ProspectContract,
  circuitBreaker?: any
): Promise<IntentSignalSpec> {
  // Fast path: for single-stream identity briefs, skip LLM call and return fallback universal signals
  if (contract.decompositionMode === 'single_stream_identity') {
    return buildFallbackIntentSignals();
  }

  const prompt = `You compile custom buying & intent signal keywords for a B2B search session.

Search Query:
"${promptQuery}"

Targeting Brief:
"${contract.brief}"

Requirements:
${contract.requirements.map(r => `- [${r.importance}/${r.scope}] ${r.description}`).join('\n')}

Task:
Generate 10 to 25 short, highly specific keyword phrases (1-3 words each) that would appear on a target company's public website or careers page to confirm buying intent, hiring activity, or service relevance for THIS specific search query.

Categorize these signals into:
- tooling: specific software, platforms, or tools (e.g. n8n, zapier, make.com, hubspot)
- hiring: job titles, roles, or hiring triggers (e.g. automation specialist, workflow engineer)
- pain: operational problems or bottlenecks (e.g. manual processes, scaling bottleneck)
- growth: company expansion or milestones (e.g. funded, series a, scaling team)

Do NOT include generic terms like "hiring", "expanding", "automation", "crm", "workflow", "growing" (these are already covered by baseline universal rules).
Focus exclusively on query-specific signals.

Return JSON with "dynamic_signals": array of strings and "categorized": object with tooling, hiring, pain, growth arrays.`;

  try {
    const result = await openAIStructured<any>(
      prompt,
      intentSignalsSchema,
      'You are an expert B2B intent analyst compiling custom website buying signals.',
      { maxTokens: 500, temperature: 0, circuitBreaker }
    );

    const dynamic = normalizeDynamicSignals(result?.dynamic_signals);
    const rawCat = result?.categorized || {};
    const categorized: CategorizedIntentSignals = {
      tooling: normalizeDynamicSignals(rawCat.tooling || contract.intentSpec?.toolingKeywords),
      hiring: normalizeDynamicSignals(rawCat.hiring || contract.intentSpec?.hiringSignals),
      pain: normalizeDynamicSignals(rawCat.pain || contract.intentSpec?.painSignals),
      growth: normalizeDynamicSignals(rawCat.growth || contract.intentSpec?.growthSignals)
    };

    const allSignals = Array.from(new Set([
      ...dynamic,
      ...categorized.tooling,
      ...categorized.hiring,
      ...categorized.pain,
      ...categorized.growth
    ])).slice(0, 30);

    const fingerprint = computeSignalFingerprint(allSignals);

    return {
      version: 1,
      universal: [...UNIVERSAL_SIGNALS],
      dynamic: allSignals,
      categorized,
      fingerprint
    };
  } catch (error) {
    console.warn('[intentSignals] compileIntentSignals failed, using fallback:', error instanceof Error ? error.message : String(error));
    return buildFallbackIntentSignals();
  }
}
