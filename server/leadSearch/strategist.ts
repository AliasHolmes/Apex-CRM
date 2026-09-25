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
  judgedCandidates?: number;
  hardFailedCandidates?: number;
  unknownCandidates?: number;
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

import type { DatasetFilter, DatasetFilterLeaf } from '../services/brightdata.js';

function normalizeCountryToCode(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 2 && /^[a-z]{2}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const map: Record<string, string> = {
    "united states": "US",
    usa: "US",
    "united kingdom": "GB",
    uk: "GB",
    canada: "CA",
    germany: "DE",
    france: "FR",
    israel: "IL",
    australia: "AU",
    india: "IN",
    singapore: "SG",
    netherlands: "NL",
    switzerland: "CH",
    sweden: "SE",
    spain: "ES",
    italy: "IT",
    brazil: "BR",
    japan: "JP",
  };
  return map[trimmed] || null;
}

export function toDatasetFilter(
  item: SearchQueryPlanItem,
  fallbackCountry?: string,
): DatasetFilter | null {
  const query = sanitizeQueryText(item.query);
  if (!query) return null;

  const filters: DatasetFilterLeaf[] = [];

  // 1. Country code filter
  const rawCountry =
    item.country ||
    fallbackCountry ||
    process.env.BRIGHTDATA_SEARCH_GEO_LOCATION ||
    "";
  const countryCode = normalizeCountryToCode(rawCountry);
  if (countryCode) {
    filters.push({ name: "country_code", operator: "=", value: countryCode });
  }

  // 2. Position / Role extraction
  const commonRoles = [
    "co-founder",
    "founder",
    "ceo",
    "cto",
    "cpo",
    "cfo",
    "cro",
    "coo",
    "cmo",
    "cio",
    "vp of engineering",
    "vp of sales",
    "vp of marketing",
    "vp of product",
    "vice president",
    "vp",
    "head of engineering",
    "head of product",
    "head of sales",
    "head of growth",
    "head of marketing",
    "head",
    "director of engineering",
    "director of product",
    "director of sales",
    "director",
    "partner",
    "managing director",
    "president",
    "owner",
    "lead architect",
    "lead engineer",
    "staff engineer",
    "principal engineer",
  ];

  const lowerQuery = query.toLowerCase();
  let matchedRole: string | undefined;
  for (const role of commonRoles) {
    const roleRegex = new RegExp(`\\b${role.replace("-", "[- ]")}s?\\b`, "i");
    if (roleRegex.test(lowerQuery)) {
      matchedRole = role;
      break;
    }
  }

  if (matchedRole) {
    const titleVal = matchedRole
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    filters.push({ name: "position", operator: "includes", value: titleVal });
  }

  // 3. Location / City extraction
  const techHubs = [
    "san francisco",
    "austin",
    "new york",
    "seattle",
    "boston",
    "los angeles",
    "chicago",
    "denver",
    "miami",
    "atlanta",
    "london",
    "toronto",
    "berlin",
    "paris",
    "tel aviv",
    "singapore",
  ];
  let matchedCity: string | undefined;
  for (const hub of techHubs) {
    const hubRegex = new RegExp(`\\b${hub}\\b`, "i");
    if (hubRegex.test(lowerQuery)) {
      matchedCity = hub;
      const cityVal = hub
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
      filters.push({ name: "city", operator: "includes", value: cityVal });
      break;
    }
  }

  // 3.5. Elastic Domain / Industry keyword extraction
  // Strips role, city, and search syntax to preserve targeted industry/agency terms
  let domainQuery = lowerQuery
    .replace(/site:\S+/gi, " ")
    .replace(/["'()]/g, " ");

  if (matchedRole) {
    const roleRegex = new RegExp(`\\b${matchedRole.replace("-", "[- ]")}s?\\b`, "gi");
    domainQuery = domainQuery.replace(roleRegex, " ");
  }
  if (matchedCity) {
    const cityRegex = new RegExp(`\\b${matchedCity}\\b`, "gi");
    domainQuery = domainQuery.replace(cityRegex, " ");
  }

  const genericStopwords = new Set([
    "in", "at", "for", "the", "and", "or", "of", "with", "to", "by", "from",
    "startup", "startups", "company", "companies", "business", "businesses",
    "people", "profile", "profiles", "linkedin", "who", "are", "is", "a", "an"
  ]);

  const candidateDomainWords = domainQuery
    .split(/[^a-z0-9+#.-]+/i)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2 && !genericStopwords.has(w));

  if (candidateDomainWords.length > 0) {
    const domainKeyword = candidateDomainWords.slice(0, 2).join(" ");
    if (domainKeyword) {
      filters.push({ name: "about", operator: "includes", value: domainKeyword });
    }
  }

  // 4. If no position matched, use meaningful keyword
  if (!matchedRole) {
    const words = query.split(/\s+/).filter((w) => w.length > 2);
    if (words.length > 0) {
      filters.push({ name: "position", operator: "includes", value: words[0] });
    }
  }

  if (filters.length === 0) {
    return { name: "position", operator: "includes", value: query.slice(0, 50) };
  }

  if (filters.length === 1) {
    return filters[0];
  }

  return {
    operator: "and",
    filters,
  };
}

export { buildFallbackQueryPlan, buildStrategistPrompt } from './searchSpec.js';


