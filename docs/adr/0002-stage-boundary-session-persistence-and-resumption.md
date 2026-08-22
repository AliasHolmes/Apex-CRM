# 2. Stage-Boundary Session Persistence, Resumption, and Async 202 Handshake

Date: 2026-08-22

## Status
Accepted

## Context
Following the 9-stage extraction of [`DiscoverySessionEngine`](../../server/leadSearch/discoveryEngine.ts) (ADR-0001), session state lived exclusively in transient Node.js memory (`activeSessions`, `activeSessionEvents`, `activeSessionControllers`). When a server process restarted, crashed, or encountered timeouts during a long-running search:
1. All in-flight search rounds, query performance attributions, and candidate evaluations were completely lost.
2. The boot sweep (`reconcileOrphanedMiningSessions`) could only flag sessions as `interrupted` with no mechanism to resume.
3. HTTP clients calling `POST /api/find-leads` maintained long-lived blocking connections (often >60s), making them vulnerable to intermediate proxy timeouts (e.g., HTTP 504) even while SSE streams were actively delivering progress.

## Decision

We introduce a durable session lifecycle based on a **3-Tier State Model**, stage-boundary checkpointing, explicit user-driven resumption, and a dual-mode HTTP 202 async handshake:

### 1. 3-Tier State Separation
- **Tier-A (Durable State - Serialized at Stage Boundaries)**:
  - Bounded, session-scoped data: `round`, `stage`, `contract`, `queryRuns`, `acceptedLeads`, `qualifiedLeads`, `finalLeads` (bounded by pool size $\le 240$), `rejectionCounts`, `failureCounts`, `brightDataStats`, `previousRoundSummary`.
  - Serialized to `mining_sessions.checkpoint_json` in SQLite after each stage and round completion.
- **Tier-B (Transient Derived State - Rebuilt on Resume, Never Serialized)**:
  - `existingKeys` (reloaded from SQLite via `readExistingIdentityKeys`), `seenCandidateKeys` (reconstructed from persisted and accepted leads), `urlRetryQueue` (fresh Set).
  - Eliminates state rot and avoids serializing unbounded sets.
- **Tier-C (Process Handles - Instantiated Fresh per Node.js Process)**:
  - `AbortController`, `llmCircuitBreaker`, `freeTierBudget`, `telemetry` (fresh `MiningTelemetryRecorder`).
  - Cancellation state is reconciled with `cancelledSessions` on resume.

### 2. Boot Sweep and Explicit Resumption
- On process startup, `reconcileOrphanedMiningSessions` marks active sessions as `interrupted` with `resumable: true` and records the last completed round.
- Mining sessions are **not** auto-resumed on boot to prevent unexpected API costs and background credit consumption.
- Users explicitly trigger resumption via `POST /api/mining-sessions/:id/resume`.

### 3. Dual-Mode HTTP 202 Handshake
- `POST /api/find-leads` supports a transition mode:
  - With `?mode=job` or `Prefer: respond-async`, the endpoint immediately responds with `202 Accepted` and `{ sessionId, status: 'running', streamUrl: '/api/mining-sessions/:id/events' }`.
  - Default remains synchronous blocking during the transition phase to support backward-compatible clients and existing tests.
  - The frontend progressively switches to consume SSE as the single source of truth before the synchronous mode is deprecated.

## Consequences
- **Positive**: Long-running discovery sessions survive crashes and server restarts; users can resume from round $N$ without burning re-scraping credits.
- **Positive**: Eliminates HTTP 504 gateway timeouts on long searches.
- **Positive**: Clean separation prevents memory leaks and state corruption across resumes.
- **Neutral**: Requires lightweight SQLite JSON writes at stage and round boundaries.
