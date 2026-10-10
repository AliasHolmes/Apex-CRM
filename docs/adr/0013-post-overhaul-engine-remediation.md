# 13. Post-Overhaul Engine Remediation: Concurrency, Lifecycle, and Frontend

Date: 2026-10-09

## Status

Accepted

## Scope

Follow-up remediation after ADR-0011 (Atria-primary / Byesu second-priority routing) and ADR-0012 (streaming judge seam, caches, saturation response): extraction concurrency, judge-submission coalescing, post-intent parallelism, retrieval->extraction streaming, DB lifecycle (pruners, stale error messages), log buffering, queue-wait telemetry consumption, and the frontend hydration/render path. Files: [`discoveryEngine.ts`](../../server/leadSearch/discoveryEngine.ts), [`extractStage.ts`](../../server/leadSearch/stages/extractStage.ts), [`retrieveStage.ts`](../../server/leadSearch/stages/retrieveStage.ts), [`linkedinPostIntent.ts`](../../server/leadSearch/linkedinPostIntent.ts), [`persistStage.ts`](../../server/leadSearch/stages/persistStage.ts), [`db.ts`](../../server/db.ts), [`server.ts`](../../server.ts), [`routes/api.ts`](../../server/routes/api.ts), [`LeadContext.tsx`](../../src/context/LeadContext.tsx), [`LeadTable.tsx`](../../src/components/LeadTable.tsx), [`ScrapeWorkspace.tsx`](../../src/components/ScrapeWorkspace.tsx), [`traceStore.ts`](../../src/lib/traceStore.ts), [`App.tsx`](../../src/App.tsx), [`index.html`](../../index.html), `.env`.

---

## Context

After the provider overhaul landed, a fresh audit measured what still bound session latency and review quality:

1. **Extraction could not fill the provider slots**: `LEAD_EXTRACTION_CONCURRENCY=8` (`.env`) and the config guardrail (max 8) were both updated, but two hardcoded `Math.min(..., 6)` ceilings in the engine and the stage silently capped the wave at 6 - two Atria slots idle for every extraction wave (~33% of the stage).
2. **The streaming judge seam submitted groups of one**: `enrichStage` fires `onTargetsReady` per target, and the pool ran `concurrency: 1`, so enriched leads were judged strictly serially, one candidate per call - paying the ~1.2k-token system prompt + contract prefill per candidate instead of per micro-batch.
3. **Phase 5 post-intent batches ran in a serial `for` loop** while the fast tier (Byesu, 10 slots) sat idle.
4. **Retrieval->extraction was a hard phase barrier**: the fastest query's results waited for the slowest query before fusion and extraction began (~5-10s per round).
5. **`routingTier: "fast"` on extraction was dead config**: `orderProvidersForTier` no-ops without a provider order, and routing extraction to Byesu would violate the ADR-0011 policy anyway (extraction stays on Atria).
6. **No lifecycle for the v26 knowledge-graph tables**: `candidate_verdicts`, `company_profiles`, `company_attribution_verdicts` had `expires_at` columns but no pruner; only `enrichment_cache` was pruned.
7. **Stale error messages on completed sessions**: `persistStage` never passed `errorMessage: null`, so a resumed-and-completed session kept the interrupted message (verified live: 5 `success` rows carrying error text).
8. **The public `addLog` path bypassed the 1,500-line trim** that the internal `logEvent` path applied.
9. **Frontend**: rehydrate transferred the entire lead table (~23.8MB / ~0.5s main-thread freeze at 2,846 leads); ~100ms of per-hydration memo passes re-derived dedupe keys and search text for unchanged leads; SSE frames re-embedded the full ~20KB session row on every delta; the 3s status poll duplicated the SSE data path and ran in hidden tabs; the history dialog SELECTed ~430KB/row of columns it then discarded; the lead table rendered ~5-7k DOM nodes per page; the `motion` engine and two blocking Google Fonts stylesheets sat in the critical path.

## Decision

### 1. Extraction ceiling 8 (both call sites)
`discoveryEngine.ts` and `extractStage.ts` clamp to 8, matching the env and guardrail. Provider slots remain the real bound. The dead `routingTier: "fast"` was removed from the extraction call.

### 2. Coalesced streaming judge submissions
Ready leads are buffered (`LEAD_STREAMING_JUDGE_BATCH_TARGET`, default 3) and flushed on size or after a 120ms debounce (`LEAD_STREAMING_JUDGE_FLUSH_MS`); the buffer always flushes before drain. Pool concurrency is 2 (real parallelism bounded by the 8 Atria slots). Result: enriched leads are judged in micro-batches of ~3 while still overlapping enrichment.

### 3. Parallel post-intent batches
The serial `for` loop became a `runProviderQueue` wave bounded by `LINKEDIN_POST_INTENT_CONCURRENCY` (default 3). Per-batch failure handling is preserved.

### 4. Retrieval->extraction streaming
`retrieveStage` gained an `onQuerySettled` hook fired per query (in `finally`, so failures still fire). The engine fuses each settled batch (the fuse stage is synchronous internally, so parallel hooks cannot interleave) and submits the fused items to an early-extraction live pool running `executeExtractStage` per wave; wave failures un-mark their items so the final pass retries them. The final pass fuses the remainder (early items excluded by object identity to keep `rawCandidates` exact) and extracts only what the early waves did not. `provisionalLeads` is `[...earlyProfiles, ...finalProfiles]`. Gated by `LEAD_STREAMING_EXTRACTION` (default on, `false` restores the wholesale path).

### 5. DB lifecycle
`pruneExpiredKnowledgeGraph()` deletes expired rows from the three v26 tables; it runs at session start and in the server's maintenance interval. `clearStaleSessionErrorMessages()` is a one-time hygiene pass at startup for rows written before the persist fix. The log-buffer trim was applied to `addLog`. `persistStage` now writes `errorMessage: null` on terminal success/partial.

### 6. Frontend
- **Delta hydration**: `/api/leads?updatedSince=<high-water>` returns only changed rows (`delta: true` + `latestUpdatedAt`); the client keeps an id-keyed hydration map, merges deltas, and falls back to a full fetch when the row count no longer matches. The ETag path is unchanged (it hashes all query params, so 304s still work).
- **Per-lead memo cache**: dedupe keys and search text are cached per lead id, invalidated by `updatedAt|revision`, so a rehydrate only pays for changed leads (~100ms -> ~10ms).
- **Slim SSE frames**: the session row is embedded only when `updated_at` changed or on terminal frames; the client keeps its last snapshot on `null`.
- **Poll as fallback**: the 3s watcher polls every 3rd tick while the SSE is open (`traceStore.isStreamConnected`), every tick when it is not, and pauses entirely in hidden tabs; the resumable banner does the same.
- **Row virtualization via `content-visibility: auto`**: off-screen rows skip subtree rendering while keeping the real table layout (in-table `react-virtual` was rejected: density modes + Radix Selects + a non-scrolling container made measured virtualization invasive for the primary CRM view).
- **Entry chunk**: the `motion` engine is out of `App.tsx` (tab fade is a CSS keyframe honoring `prefers-reduced-motion`); the Google Fonts stylesheet loads non-blocking with a `noscript` fallback.
- **History dialog**: `readSearchLogDigests` selects only the light columns (~10MB of SQLite reads per open removed).

## Consequences

- **Positive**: extraction waves use all 8 Atria slots; enriched candidates are judged in micro-batches instead of 1-by-1; post-intent and early-extraction waves run concurrently with their upstream phases; retrieval's fast queries no longer wait for its slowest.
- **Positive**: knowledge-graph tables are bounded; completed sessions no longer carry stale failures; hydration after a round transfers KB instead of ~24MB with a ~0.5s freeze; session-record bandwidth drops sharply (slim frames + fallback polling).
- **Negative / accepted**: the streaming extraction seam can judge candidates that enrichment later rejects (bounded by the drain-time membership check); early-wave extraction results depend on the shared `evidenceByUrl` map (mutated in place by design, consistent with the single-pass behavior).
- **Verification**: 13 new unit/wiring tests + the existing suites green; a non-saturated canary must confirm 8-wide extraction waves, judge groups of ~3, and near-zero `Queue sum`.
