# 1. Discovery Session Engine: In-Process Core Seam

Date: 2026-08-21

## Status
Accepted

## Context
Previously, [`server/routes/api.ts`](../../server/routes/api.ts) contained an inline ~2,300-line discovery loop inside the `router.post('/find-leads')` endpoint. This coupled the HTTP transport layer (Express `req`/`res`) with multi-lane search planning, session map ring buffers, LLM judging, open-web intent enrichment, Pareto skyline reservation, and database persistence. In parallel, [`server/leadSearch/targetFulfillment.ts`](../../server/leadSearch/targetFulfillment.ts) had diverged as an uncalled duplicate clone.

This structure caused:
1. Low locality: changes to session recovery or enrichment logic required modifying a 3,300-line router file.
2. Poor testability: testing the discovery engine required simulating HTTP server environments and fake response objects.
3. Inability to execute background or worker-thread prospecting sessions without HTTP mocking.

## Decision
We consolidate the prospecting workflow into an in-process, deep module [`DiscoverySessionEngine`](../../server/leadSearch/discoveryEngine.ts) behind a clean public interface:
```typescript
export interface DiscoverySessionEngine {
  execute(request: DiscoveryRequest, listener?: DiscoveryEventListener): Promise<DiscoveryResult>;
  cancel(sessionId: string): boolean;
  getLiveTrace(sessionId: string): MiningTraceSummary | null;
  getLiveLogs(sessionId: string): string[] | null;
}
```

The engine encapsulates:
- Internal session lifecycle maps and ring-buffers (`activeSessions`, `activeSessionEvents`, `activeSessionControllers`, `cancelledSessions`).
- Adaptive prompt decomposition and multi-lane search execution.
- Closed-loop pass-rate diagnostics and strategist recovery.
- Signal-to-Company Reverse Flywheel account discovery.
- 3-Tier Finalist Judging and Pareto Skyline reservation.
- Phase 4 website TF-IDF intent and Phase 5 LinkedIn post SERP intent with temporal freshness decay.
- Atomic SQLite persistence with canonical identity deduplication.

`server/routes/api.ts` is reduced to a thin HTTP adapter layer.

## Consequences
- **Positive**: `server/routes/api.ts` shrinks by ~2,500 lines (>75% reduction).
- **Positive**: The discovery pipeline can be invoked by background workers, cron jobs, CLI tools, and unit tests with zero HTTP mocking.
- **Positive**: Deletes 1,100+ lines of duplicate clone code.
- **Neutral**: Callers wanting real-time logging supply an optional `DiscoveryEventListener`.
