# 21. Full-Stack Audit Remediation, Concurrency Safety, and Systemic Hardening

Date: 2026-11-11

## Status

Accepted (amends ADR-0002, ADR-0005, ADR-0007, ADR-0014, ADR-0016, and ADR-0020)

## Scope

This ADR documents the comprehensive remediation of all 50 architectural, concurrency, database, routing, scoring, and mutation-safety defects identified in the Apex CRM Audit:
- LLM service read timeouts (`withBodyTimeout`), completion cache usage alignment, and circuit breaker success reset in [`server/services/llm.ts`](../../server/services/llm.ts)
- Bright Data MCP empty-200 SERP self-heal, transport leak prevention, and 429/500 cooldown routing in [`server/services/brightdata.ts`](../../server/services/brightdata.ts)
- Terminal arity-4 JSON error boundary mounted on `/api` and `/api/v1` in [`server.ts`](../../server.ts)
- Paid diagnostic route rate limiting, active Agent Brain session protection, and fast-path JSON payload validation in [`server/routes/api.ts`](../../server/routes/api.ts)
- SQLite Migration 28 encapsulation, revision checks, safe offset paging, and in-memory cache lifecycle resets in [`server/db.ts`](../../server/db.ts)
- Registrable domain stem extraction, requirement importance join, scale normalization, delta score propagation, baseline authority fit, and NaN-safe numeric bounds across [`server/leadSearch/`](../../server/leadSearch/)
- Identity deduplication key symmetry stripping legal suffixes via `normalizeCompanyName`
- Frontend revision conflict resolution promise settlement, partial bulk chunk preservation, and session watcher network error backoff in [`src/context/LeadContext.tsx`](../../src/context/LeadContext.tsx) and [`src/components/ScrapeWorkspace.tsx`](../../src/components/ScrapeWorkspace.tsx)

---

## Context

A deep architectural audit across Apex CRM's entire stack identified 50 latent issues spanning provider slot leaks, dead-code self-heals, unhandled Express errors, silent scoring inversions, database index gaps, and mutation queue deadlocks:

1. **LLM Provider Slot Leaks**: `server/services/llm.ts` cleared fetch stall timers immediately upon header resolution. If an upstream provider sent response headers and then stalled mid-body during `res.text()` or `res.json()`, the promise never settled, holding provider slots permanently and eventually starving the entire request queue.
2. **Bright Data Empty-200 Dead Code**: `brightdata.ts` threw `BrightDataError{reasonCode: "empty_body_transient"}`, but `isEmptyBodySerpTransientError` checked strictly for `reasonCode === "target_transient"`. Consequently, the empty-body 1x self-healing retry never fired.
3. **MCP Client & Stdio Leaks**: When `initBrightDataClient` timed out or failed to connect, child stdio processes (`node @brightdata/mcp/server.js`) and transports were not terminated, leaking ports and background processes.
4. **Bright Data 429/500 Flooding**: Missing error classification for 429 and 500 status codes caused rate-limited accounts to be retried with zero backoff or cooldown.
5. **Completion Cache Usage Inconsistency**: The LLM completion cache stored usage in snake_case (`input_tokens`, `output_tokens`) but read it into camelCase fields (`inputTokens`, `outputTokens`), resulting in `tokens: { input: undefined, output: undefined }` on all cache hits.
6. **Express HTML Stack Trace Leakage**: Express's default error handler emits HTML error pages with full stack traces. When API routes threw unhandled errors, clients received HTML instead of structured JSON.
7. **Database Migration & Offset Inefficiencies**: Legacy MCP migrations were evaluated on every boot rather than encapsulated into a versioned migration, and queries with `OFFSET` but no `LIMIT` generated invalid SQL without `LIMIT -1`.
8. **Deduplication Key Asymmetry**: Database identity keys (`db.ts`) did not strip corporate legal suffixes (`LLC`, `Inc`, `Corp`), whereas pipeline fusion (`fuseStage.ts`) stripped them via `normalizeCompanyName`. Leads matching by name and company failed to deduplicate if one had a corporate suffix.
9. **Scoring Inversions & NaN Environment Truncations**: Unguarded `Math.max(Number(env))` calls resulted in `NaN` when invalid values were set, zeroing out candidate scores. In `scoring.ts`, 0-100 scales (`compositeScore`, `predictiveScore`) were not divided by 10 before `normalizeToTenScale`, causing low scores (e.g. 10/100) to invert to perfect 10s.
10. **Frontend Mutation Queue Deadlocks**: When a lead update triggered an HTTP 409 conflict dialog, dismissing the modal without making a choice (via Escape, backdrop click, or close button) failed to settle the pending Promise, deadlocking that lead's sequential mutation queue and rendering the lead permanently uneditable and undeletable until page reload.

---

## Decision

### 1. LLM Service & Circuit Breaker Hardening

- **`withBodyTimeout`**: Wrapped non-stream `res.text()` and `res.json()` calls in an abortable timeout race. If a body read hangs beyond the configured timeout, the request is aborted and throws an `LLMStallError`, releasing provider slots in the `finally` block of `runOn`.
- **Completion Cache Usage Normalization**: Updated cache writes and reads to populate both camelCase (`inputTokens`, `outputTokens`, `totalTokens`) and snake_case (`input_tokens`, `output_tokens`, `total_tokens`) fields.
- **Quota Error Detection**: Extended `isExhaustedQuotaError` to catch HTTP 402, 432, 433 and quota message patterns across providers.
- **Dynamic Queue Timeout**: Updated `resolveDynamicQueueTimeoutMs` to respect user-configured `LLM_QUEUE_TIMEOUT_MS` down to 1s rather than clamping to 130s.
- **Circuit Breaker Success Reset**: `recordProviderSuccess` resets `breaker.failureCounts[pid] = 0` on successful completions, clearing accumulated transient faults.

### 2. Bright Data MCP & Crawler Resilience

- **Repaired Empty-200 SERP Self-Healing**: Updated `isEmptyBodySerpTransientError` to recognize `classified.reasonCode === "empty_body_transient"`, enabling the automatic 1x self-healing retry on momentary provider hiccups.
- **Client & Transport Cleanup**: Wrapped `initBrightDataClient` in comprehensive try/catch blocks that close half-opened clients and child transports on connect failures or timeouts.
- **Rate Limit & 5xx Cooldown Routing**: Classified HTTP 429 as `provider_rate_limit` and HTTP 500 as retryable 5xx, setting `disabledUntil` cooldown to stop hammering rate-limited accounts.
- **Double-Close Guard**: Protected `closeBrightDataClient` against concurrent double-closing.

### 3. Server & API Routing Boundaries

- **Terminal Arity-4 JSON Error Boundary**: Mounted a terminal error handler `(err, req, res, next)` on `/api` and `/api/v1` in [`server.ts`](../../server.ts) that guarantees JSON `{ apiVersion: 1, error: ... }` responses with appropriate HTTP status codes.
- **Rate-Limited Paid Diagnostics**: Added `paidRouteLimit` to `/llm-health` (10/min) and `/mining-sessions/:sessionId/resume` (20/min with HTTP 503 + `Retry-After: 30`).
- **Resumable Session Deletion & Cancellation Protection**: Protected session DELETE and cancel routes by consulting `activeAgentBrainSessions.has(id)` alongside `discoveryEngine.isActive`.
- **Fast-Path JSON Validation**: Guarded `/api/leads` payload string concatenation with validation to ensure corrupted rows do not poison the entire JSON response.
- **Post-Commit Stats Invalidation**: Moved `invalidateLeadsStatsCache()` strictly after `db.exec("COMMIT")` in bulk lead deletion.
- **Creation Timestamp Preservation**: Preserved `previousLead.createdAt` on PATCH updates.

### 4. SQLite Database Engine & Migration 28

- **Migration 28**: Encapsulated legacy MCP column backfills and created the compound covering index `idx_leads_stage_created_updated` on `leads(stage, created_at DESC, updated_at DESC)`.
- **Revision Protection**: Enforced revision check when `requireExisting` is set in bulk lead upserts.
- **Safe Offset**: Applied `LIMIT -1 OFFSET ?` when an offset is provided without a limit in `readLeadsSummary`.
- **In-Memory Cache Reset**: Added comprehensive cache clearing in `closeLeadsDb()`.
- **Orphan Cleanup**: Cleaned up orphaned records in `lead_activities` and `outreach_drafts` in `replaceStoredLeads`.

### 5. Search Engine Scoring & Deduplication

- **Registrable Domain Stem Extraction**: Updated `CompanyRegistry.extractDomainStem` to extract registrable stems from multi-level subdomains (e.g. `blog.acme.com` -> `acme`).
- **Requirement Importance Join**: Joined `lead.qualification.requirements` back with `contract.requirements` by ID to restore hard vs soft importance and enable reactive soft coverage boosting.
- **Scale Normalization**: Divided 0-100 scales (`compositeScore`, `predictiveScore`) by 10 before `normalizeToTenScale` so low scores do not promote to perfect 10s.
- **Score Delta Propagation**: Updated `qualification.finalScore` and `finalSelectionScore` whenever post-intent deltas adjust `scoreBreakdown.finalScore`.
- **Final Selection Weights**: Recalibrated finalist ranking base weights to sum to exactly 1.00 (`0.30 + 0.15 + 0.15 + 0.15 + 0.10 + 0.03 + 0.02 + 0.10 = 1.00`).
- **Baseline Authority Fit**: Returned neutral baseline `5` instead of `0` when `contract.authorityRequired` is false.
- **NaN-Safe Numeric Parsing**: Routed all numeric options through `boundedNumber` and `clampEnvInt` across all 9 discovery stages.
- **Dedupe Key Normalization**: Canonicalized `buildLeadIdentityKeys` using `normalizeCompanyName` to strip legal suffixes, achieving symmetry across database deduplication and pipeline fusion.

### 6. Frontend State & Mutation Safety

- **Conflict Dialog Promise Settlement**: Settled the awaiting conflict resolution Promise with `serverLead` (`keep_server` / rollback) when the user closes the modal without a selection, permanently unblocking the lead's mutation queue.
- **Partial Bulk Chunk Preservation**: Preserved already-committed chunks in local React state during chunked bulk operations and rehydrated from the server on partial failure.
- **Session Watcher Backoff**: Counted consecutive network failures in `ScrapeWorkspace.tsx` and surfaced an error toast after 10 failures instead of looping indefinitely.
- **Deep Link Drawer Clean Dismissal**: Allowed the deep link drawer to close cleanly when the CRM has 0 leads.

---

## Consequences

- Provider slot leaks from hanging network bodies are eliminated; provider slots release promptly upon abort.
- Rate limits and transient failures in Bright Data back off smoothly with cooldown windows and self-heal on empty SERP bodies.
- Unhandled exceptions across all API endpoints return standardized JSON rather than HTML stack traces.
- Lead deduplication across database and pipeline stages is fully symmetrical.
- Candidate scoring and ranking calculations are strictly monotonic and mathematically normalized.
- Frontend mutation queues no longer hang on dismissed conflict modals, and partial bulk operations preserve committed data.
- The test suite passes 100% across all 102 verified tests with zero TypeScript typecheck errors.
