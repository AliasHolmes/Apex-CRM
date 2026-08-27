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
  return (query || '')
    .replace(/site:linkedin\.com\/in\//gi, '')
    .replace(/site:[^\s]+/gi, '')
    .replace(/\blinkedin\b/gi, '')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/[()"]/g, ' ')
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

export function toLinkedInSearchQuery(item: SearchQueryPlanItem) {
  const query = sanitizeQueryText(item.query);
  if (!query) return '';
  return item.lane === 'signal' ? query : `site:linkedin.com/in/ ${query}`;
}

export { buildFallbackQueryPlan, buildStrategistPrompt } from './searchSpec.js';

