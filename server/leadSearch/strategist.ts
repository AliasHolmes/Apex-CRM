import type { QueryFamily, QueryIntent, SearchQueryPlanItem } from './searchSpec.js';
export type { QueryFamily, QueryIntent, SearchQueryPlanItem };

export type QueryRunStats = {
  round: number;
  query: string;
  family?: string;
  intent?: string;
  rawCandidates: number;
  uniqueCandidates: number;
  evidenceBlocks: number;
  extractedLeads: number;
  acceptedLeads: number;
  rejectionReasons: Record<string, number>;
  lane?: string;
  providerPreference?: string;
  tavilySearchDepth?: string;
  corroboratedCandidates?: number;
  searchLatencyMs: number;
  providerUnits: number;
  qualifiedFinalists: number;
  rescuedFinalists: number;
  returnedFinalists: number;
  requirementFailCounts?: Record<string, number>;
};

export type ProviderRunStats = {
  configured: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cacheHits: number;
  rejectionReasons: Record<string, number>;
};

export function sanitizeQueryText(query: string) {
  let raw = (query || '')
    .replace(/site:linkedin\.com\/in\//gi, ' ')
    .replace(/site:[^\s]+/gi, ' ')
    .replace(/\blinkedin\b/gi, ' ')
    .replace(/\bAND\b/g, ' ')
    .replace(/[()]/g, ' ');

  // Handle unclosed quotes: if odd number of quotes, strip all quotes
  const quoteCount = (raw.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    raw = raw.replace(/"/g, ' ');
  }

  // Tokenize preserving quoted phrases (-?"phrase" or "phrase") and unquoted words (-word or word)
  const tokenRegex = /(-?"[^"]*")|(-?[\w.-]+)|([^\s]+)/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(raw)) !== null) {
    let token = match[0].trim();
    if (!token) continue;

    if (token === '""' || token === '-""' || token === '"' || token === '-') continue;

    if (token.startsWith('"') && token.endsWith('"')) {
      const inner = token.slice(1, -1).trim();
      if (!inner) continue;
      token = `"${inner}"`;
    } else if (token.startsWith('-"') && token.endsWith('"')) {
      const inner = token.slice(2, -1).trim();
      if (!inner) continue;
      token = `-"${inner}"`;
    }

    tokens.push(token);
  }

  // Strip leading/trailing prepositions and conjunctions (from unquoted plain tokens only)
  const isStopWord = (t: string) => /^(?:or|and|with|of|at|in|for|from|to|a|an|the|by|who|which)$/i.test(t);

  while (tokens.length > 0 && isStopWord(tokens[0])) {
    tokens.shift();
  }
  while (tokens.length > 0 && isStopWord(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  // Deduplicate repeated words (case-insensitive) while preserving original sequence, OR disjunctions, and quotes/hyphens
  const seenLower = new Set<string>();
  const dedupedWords: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'or') {
      if (dedupedWords.length > 0 && dedupedWords[dedupedWords.length - 1].toLowerCase() !== 'or') {
        dedupedWords.push('OR');
      }
    } else if (!seenLower.has(lower)) {
      seenLower.add(lower);
      dedupedWords.push(token);
    }
  }

  while (dedupedWords.length > 0 && isStopWord(dedupedWords[dedupedWords.length - 1])) {
    dedupedWords.pop();
  }
  while (dedupedWords.length > 0 && isStopWord(dedupedWords[0])) {
    dedupedWords.shift();
  }

  return dedupedWords.join(' ').trim();
}

export function normalizeQueryPlanItems(input: unknown): SearchQueryPlanItem[] {
  const rawQueries = Array.isArray((input as any)?.queries) ? (input as any).queries : [];
  return rawQueries
    .map((item: any) => {
      if (typeof item === 'string') return { query: item };
      if (item && typeof item === 'object') {
        return {
          query: typeof item.query === 'string' ? item.query : '',
          coveredRequirementIds: Array.isArray(item.coveredRequirementIds)
            ? item.coveredRequirementIds.filter((id: unknown) => typeof id === 'string').slice(0, 10)
            : undefined,
          family: item.family,
          intent: item.intent,
          expectedSignal: typeof item.expectedSignal === 'string' ? item.expectedSignal : undefined,
          priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : undefined,
          lane: item.lane === 'person' || item.lane === 'account' || item.lane === 'signal' ? item.lane : undefined,
          providerPreference: item.providerPreference === 'tavily' || item.providerPreference === 'brightdata' || item.providerPreference === 'corroborate' ? item.providerPreference : undefined,
          searchDepth: ['basic', 'fast', 'ultra-fast', 'advanced'].includes(item.searchDepth) ? item.searchDepth : undefined,
          topic: item.topic === 'news' || item.topic === 'general' ? item.topic : undefined,
          timeRange: ['week', 'month', 'year'].includes(item.timeRange) ? item.timeRange : undefined,
          country: typeof item.country === 'string' ? item.country.trim() : undefined,
        };
      }
      return { query: '' };
    })
    .map((item: SearchQueryPlanItem) => ({ ...item, query: sanitizeQueryText(item.query) }))
    .filter((item: SearchQueryPlanItem) => item.query);
}

export function toLinkedInSearchQuery(item: SearchQueryPlanItem) {
  const query = sanitizeQueryText(item.query);
  if (!query) return '';
  if (item.lane === 'signal' || item.lane === 'account') return query;
  if (/^site:linkedin\.com/i.test(query)) return query;
  return `site:linkedin.com/in/ ${query}`;
}

export { buildFallbackQueryPlan, buildStrategistPrompt } from './searchSpec.js';

