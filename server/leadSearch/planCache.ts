/**
 * Round-level query-plan cache (ADR-0012).
 *
 * The strategist LLM call runs every round, but a round that changes nothing about the
 * brief shape (same domain cluster, same search spec, same target, same CRM/metro
 * feedback state) re-derives essentially the same query plan. This in-memory cache skips
 * that call: sessions re-mining the same brief shape - and later rounds of the same
 * session where the spec did not change - reuse the plan.
 *
 * Deliberately in-memory (not SQLite): it is a latency optimization, not a source of
 * truth, and stale entries must disappear on restart. Entries carry a TTL and the cache
 * is size-capped; the dedupe/signature-exhaustion filters downstream still apply to
 * cached plans, so a reuse can never resurrect an exhausted query.
 */

const MAX_ENTRIES = 64;
const TTL_MS = 6 * 60 * 60 * 1000;

type PlanCacheEntry = {
  planItems: unknown[];
  storedAt: number;
};

const cache = new Map<string, PlanCacheEntry>();

export function readPlanCache(key: string, now = Date.now()): unknown[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (now - entry.storedAt > TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency by re-inserting (Map preserves insertion order).
  cache.delete(key);
  cache.set(key, entry);
  return entry.planItems;
}

export function writePlanCache(key: string, planItems: unknown[], now = Date.now()): void {
  if (!key || !Array.isArray(planItems) || planItems.length === 0) return;
  cache.set(key, { planItems, storedAt: now });
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function clearPlanCache(): void {
  cache.clear();
}

export function planCacheSize(): number {
  return cache.size;
}
