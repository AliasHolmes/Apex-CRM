import { getSearchCacheEntry, upsertSearchCacheEntry } from "../db.js";

export type CachedSearchResult = { text: string; sources: any[]; items: any[] };

const CACHE_MARKER = 1;

/** Days a retrieval result stays reusable (LEAD_RETRIEVAL_CACHE_TTL_DAYS, default 3, 0 disables, max 30). */
export function retrievalCacheTtlDays(): number {
  const raw = Number(process.env.LEAD_RETRIEVAL_CACHE_TTL_DAYS ?? 3);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 30) : 0;
}

export function buildRetrievalCacheKey(
  provider: string,
  query: string,
  options: {
    maxResults?: number;
    searchDepth?: string;
    includeDomains?: string[];
    timeRange?: string;
    topic?: string;
    country?: string;
  } = {},
): string {
  const domains = (options.includeDomains || [])
    .map((d) => String(d).trim().toLowerCase())
    .sort()
    .join(",");
  return [
    `retrieval:${provider}`,
    `max=${options.maxResults ?? ""}`,
    `depth=${options.searchDepth ?? ""}`,
    `dom=${domains}`,
    `time=${options.timeRange ?? ""}`,
    `topic=${options.topic ?? ""}`,
    `country=${String(options.country ?? "").toLowerCase()}`,
    String(query || "").trim().toLowerCase().replace(/\s+/g, " "),
  ].join("|");
}

export function readCachedSearch(key: string, now = new Date()): CachedSearchResult | null {
  if (retrievalCacheTtlDays() === 0) return null;
  const payload = getSearchCacheEntry(key, now)?.results?.[0];
  if (!payload || payload.__apexRetrievalCache !== CACHE_MARKER) return null;
  if (!Array.isArray(payload.items) || payload.items.length === 0) return null;
  return {
    text: String(payload.text || ""),
    sources: Array.isArray(payload.sources) ? payload.sources : [],
    items: payload.items,
  };
}

export function writeCachedSearch(key: string, result: CachedSearchResult, now = new Date()): void {
  const ttlDays = retrievalCacheTtlDays();
  if (ttlDays === 0 || !Array.isArray(result?.items) || result.items.length === 0) return;
  upsertSearchCacheEntry(
    key,
    [{ __apexRetrievalCache: CACHE_MARKER, text: result.text || "", sources: result.sources || [], items: result.items }],
    "tavily",
    ttlDays,
    now,
  );
}
