import { getSearchCacheEntry, upsertSearchCacheEntry } from "../db.js";
import { buildQuerySignature } from "./querySignature.js";
import type { ProspectContract } from "./prospectContract.js";

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

/**
 * Coarse-grain cache key at the market-slice level (role class, org class, geo anchor,
 * top topic tokens) instead of the literal query. Re-mined briefs generate slightly
 * different query strings for the same slice; this key lets them share SERP results that
 * the exact-query key misses. Downstream fusion and CRM dedupe still apply.
 */
export function buildRetrievalSignatureKey(
  provider: string,
  query: string,
  options: { contract?: ProspectContract; maxResults?: number } = {},
): string {
  const sig = buildQuerySignature(query, { contract: options.contract });
  const topics = [...new Set(sig.topicTokens)].sort().slice(0, 8).join(",");
  return [
    `retrieval-sig:${provider}`,
    `role=${sig.roleClass}`,
    `org=${sig.orgClass}`,
    `geo=${sig.geoAnchor}`,
    `topics=${topics}`,
    `max=${options.maxResults ?? ""}`,
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
