import crypto from 'node:crypto';

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

/** G11: neutral age for undated snippets (multiplier ~0.41, never 1.0). */
export const UNKNOWN_AGE_DAYS = 45;

export function parseSnippetFreshnessDays(snippets: string[] | string): number {
  const texts = Array.isArray(snippets) ? snippets : [snippets];
  let minDays: number | null = null;
  for (const raw of texts) {
    const text = String(raw || '').toLowerCase();
    const hoursMatch = text.match(/\b(\d+)\s*(?:h|hours?|hrs?)\s*ago\b/);
    if (hoursMatch) return 0;
    const daysMatch = text.match(/\b(\d+)\s*(?:d|days?)\s*ago\b/);
    if (daysMatch) {
      const d = parseInt(daysMatch[1], 10);
      minDays = minDays === null ? d : Math.min(minDays, d);
      continue;
    }
    const weeksMatch = text.match(/\b(\d+)\s*(?:w|weeks?|wks?)\s*ago\b/);
    if (weeksMatch) {
      const d = parseInt(weeksMatch[1], 10) * 7;
      minDays = minDays === null ? d : Math.min(minDays, d);
      continue;
    }
    const monthsMatch = text.match(/\b(\d+)\s*(?:m|months?|mos?)\s*ago\b/);
    if (monthsMatch) {
      const d = parseInt(monthsMatch[1], 10) * 30;
      minDays = minDays === null ? d : Math.min(minDays, d);
      continue;
    }
    const yearsMatch = text.match(/\b(\d+)\s*(?:y|years?|yrs?)\s*ago\b/);
    if (yearsMatch) {
      const d = parseInt(yearsMatch[1], 10) * 365;
      minDays = minDays === null ? d : Math.min(minDays, d);
      continue;
    }
  }
  // G11: unknown age is neutral, never "best". 45 days yields ~0.41 via
  // exp(-0.02*45) instead of 1.0 for undated snippets.
  return minDays !== null ? minDays : UNKNOWN_AGE_DAYS;
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


