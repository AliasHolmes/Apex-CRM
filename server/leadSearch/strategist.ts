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
  return (query || '')
    .replace(/site:linkedin\.com\/in\//gi, '')
    .replace(/linkedin/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
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
          country: typeof item.country === 'string' ? item.country.trim().slice(0, 2) : undefined,
        };
      }
      return { query: '' };
    })
    .map((item: SearchQueryPlanItem) => ({ ...item, query: sanitizeQueryText(item.query) }))
    .filter((item: SearchQueryPlanItem) => item.query);
}

export function buildFallbackQueryPlan(query: string): SearchQueryPlanItem[] {
  const base = sanitizeQueryText(query);
  const fallbacks: SearchQueryPlanItem[] = [
    { query: `${base} founder owner`, family: 'persona_title', intent: 'find_decision_makers', expectedSignal: 'Founder or owner profiles', priority: 1 },
    { query: `${base} operations director`, family: 'persona_title', intent: 'expand_surface_area', expectedSignal: 'Operations leaders', priority: 2 },
    { query: `${base} growth manager`, family: 'growth_signal', intent: 'find_buying_signal', expectedSignal: 'Growth responsibility', priority: 3 },
    { query: `${base} automation CRM`, family: 'tooling_signal', intent: 'find_buying_signal', expectedSignal: 'Tooling or automation context', priority: 4 },
  ];
  return fallbacks.filter(item => item.query.trim().length > 0);
}
export function toLinkedInSearchQuery(item: SearchQueryPlanItem) {
  const query = sanitizeQueryText(item.query);
  return query ? `site:linkedin.com/in/ ${query}` : '';
}

export function buildStrategistPrompt(params: {
  query: string;
  round: number;
  maxRounds: number;
  remaining: number;
  previousQueries: string[];
  previousRoundSummary: Record<string, any>;
}) {
  const previousNote = params.previousQueries.length
    ? `\nPrevious queries already used. Avoid repeating these: ${params.previousQueries.join(' | ')}`
    : '';

  return `You are an expert search strategist. The user is looking for leads matching this description:
"${params.query}"

Generate exactly 4 simple, targeted query objects for LinkedIn-indexed profiles.
Rules:
1. Tavily Search does NOT support complex Google dorks or boolean operators.
2. Do NOT include the word LinkedIn or site:.
3. Use at least 3 query families.
4. Include at least one pain_signal, growth_signal, or tooling_signal query.
5. This is round ${params.round}/${params.maxRounds}; ${params.remaining} qualified leads are still needed.
6. Adapt using this previous round summary: ${JSON.stringify(params.previousRoundSummary)}.${previousNote}

Return JSON in this shape:
{
  "queries": [
    {
      "query": "plain search phrase",
      "family": "persona_title | industry_vertical | pain_signal | growth_signal | tooling_signal | local_market | company_type",
      "intent": "find_decision_makers | find_buying_signal | expand_surface_area | recover_from_low_yield | reduce_duplicates",
      "expectedSignal": "short reason this query should work",
      "priority": 1
    }
  ]
}`;
}
