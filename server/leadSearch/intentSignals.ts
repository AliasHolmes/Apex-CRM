import crypto from 'node:crypto';
import { openAIStructured } from '../services/llm.js';
import type { ProspectContract } from './prospectContract.js';

export type IntentSignalSpec = {
  version: 1;
  universal: string[];
  dynamic: string[];
  fingerprint: string;
};

export const UNIVERSAL_SIGNALS: string[] = [
  'hiring', 'expanding', 'launched', 'opening', 'growing', 'locations',
  'booking', 'scheduling', 'automation', 'crm', 'intake', 'patient acquisition',
  'lead generation', 'operations', 'workflow', 'follow-up', 'no-show', 'conversion'
];

const cleanSignalToken = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

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
    fingerprint: 'fallback'
  };
}

const intentSignalsSchema = {
  type: 'OBJECT',
  properties: {
    dynamic_signals: {
      type: 'ARRAY',
      items: { type: 'STRING' }
    }
  },
  required: ['dynamic_signals']
};

export async function compileIntentSignals(
  promptQuery: string,
  contract: ProspectContract,
  circuitBreaker?: any
): Promise<IntentSignalSpec> {
  const prompt = `You compile custom buying & intent signal keywords for a B2B search session.

Search Query:
"${promptQuery}"

Targeting Brief:
"${contract.brief}"

Requirements:
${contract.requirements.map(r => `- [${r.importance}/${r.scope}] ${r.description}`).join('\n')}

Task:
Generate 10 to 25 short, highly specific keyword phrases (1-3 words each) that would appear on a target company's public website or careers page to confirm buying intent, hiring activity, or service relevance for THIS specific search query.

Do NOT include generic terms like "hiring", "expanding", "automation", "crm", "workflow", "growing" (these are already covered by baseline universal rules).
Focus exclusively on query-specific signals (e.g. for AI agency white label: "white label", "fulfillment partner", "delivery partner", "subcontract", "open positions", "partner program").

Return JSON with "dynamic_signals": array of strings.`;

  try {
    const result = await openAIStructured<any>(
      prompt,
      intentSignalsSchema,
      'You are an expert B2B intent analyst compiling custom website buying signals.',
      { maxTokens: 400, temperature: 0, circuitBreaker }
    );

    const dynamic = normalizeDynamicSignals(result?.dynamic_signals);
    const fingerprint = computeSignalFingerprint(dynamic);

    return {
      version: 1,
      universal: [...UNIVERSAL_SIGNALS],
      dynamic,
      fingerprint
    };
  } catch (error) {
    return buildFallbackIntentSignals();
  }
}
