# Apex CRM — Codebase Index

Generated: 2026-08-23 · Scope: all first-party code under `src/`, `server/`, `scripts/`, `test/` (excludes `node_modules/`, `dist/`, `.venv-litellm/`)

---

## 1. What this is

Apex CRM is a single-user, local-first prospect-scouting CRM. A natural-language "prospect brief" is compiled into a strict **Prospect Contract**, executed as a multi-lane retrieval session (Tavily + Bright Data + LLM) through a 9-stage pipelined engine, judged against cited evidence, enriched with company-website and LinkedIn-post intent signals, checkpointed at stage boundaries for resumability, and persisted into a local SQLite store. React 19 UI for review/pipeline/outreach; Express 5 backend; all outreach on LinkedIn stays manual.

Primary reference docs:

- [`README.md`](../README.md) — product overview, architecture diagrams, API table
- [`CONTEXT.md`](../CONTEXT.md) — domain glossary (Discovery Session, Prospect Contract, Identity/Intent Plane, Finalist Judge, Pareto Skyline, Reverse Flywheel)
- [`docs/adr/0001-discovery-session-engine.md`](adr/0001-discovery-session-engine.md) — ADR: extraction of the discovery loop into in-process `DiscoverySessionEngine`
- [`docs/adr/0002-stage-boundary-session-persistence-and-resumption.md`](adr/0002-stage-boundary-session-persistence-and-resumption.md) — ADR: durable stage-boundary checkpoints & session resumption

## 2. Quick stats

| Metric                                                           | Value                                               |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| Frontend (`src/`)                                                | ~9,983 lines across 33 files                        |
| Backend engine (`server/leadSearch/`)                            | ~11,415 lines across 40 modules (incl. 9 `stages/`) |
| Server core (`server.ts`, `db.ts`, `routes/api.ts`, `services/`) | ~6,733 lines                                        |
| REST routes                                                      | 38 (all under `/api`)                               |
| SQLite tables                                                    | 15 (schema v15, WAL mode)                           |
| Test suite                                                       | 30 files, ~6,283 lines                              |

## 3. Tech stack

- **Frontend**: React 19 · Vite · Tailwind CSS 4 · Radix UI · Motion · Lucide icons · TypeScript
- **Backend**: Node.js 24+ · Express 5 · native `node:sqlite` (WAL) · `p-queue` rate limiting · tsx dev runner · esbuild prod bundle
- **LLM**: LiteLLM gateway (`litellm.config.yaml`) or direct OpenAI-compatible fallback chain (Byesu → OpenRouter → Groq) with session circuit breaker
- **Retrieval**: Tavily Search/Extract with rotating key pool; Bright Data MCP (`search_engine`, `scrape_as_markdown`)

## 4. Repository layout

```text
├─ server.ts                 Express bootstrap (197 lines)
├─ src/                      React client (entry, components, context, lib, utils)
├─ server/
│  ├─ db.ts                  SQLite v15 schema, migrations w/ auto-backup, CRUD, identity dedupe
│  ├─ routes/api.ts          Thin HTTP adapter → 38 REST routes
│  ├─ services/              llm.ts, brightdata.ts, keyRotator.ts, linkedinEvidence.ts
│  └─ leadSearch/            Discovery Session Engine (31 modules + 9 stages/)
├─ scripts/dev.ts            Dev orchestrator (Vite + Express concurrently)
├─ test/                     30 node:test suites (~6,283 lines)
├─ docs/                     CODEBASE_INDEX.md (this file), adr/
├─ .apex-data/               SQLite DB + WAL-safe backups (runtime artifact)
├─ litellm.config.yaml       LiteLLM proxy config
├─ vite.config.ts            Vite config (port 3000, proxy → API)
└─ components.json           shadcn/ui config
```

## 5. Frontend index (`src/`)

### Entry & shell

| File        | Lines | Role                                                                                                                                                                  |
| ----------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.tsx`  | 10    | React root mount                                                                                                                                                      |
| `App.tsx`   | 665   | App shell: dashboard tabs, health polling, provider status                                                                                                            |
| `types.ts`  | 383   | Shared types: `LinkedInProfile`, `LeadEvidence`, `PostIntentEvidence`, `ScoreBreakdown`; stage/review/action enums (`LEAD_STAGES`, `REVIEW_STATUSES`, `NEXT_ACTIONS`) |
| `index.css` | —     | Tailwind theme tokens                                                                                                                                                 |

### Feature components (`src/components/`)

| File                          | Lines      | Role                                                                                                          |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `LeadTable.tsx`               | 1532       | Prospect inventory: filtering, review statuses, evidence drawer, manual add                                   |
| `ScrapeWorkspace.tsx`         | 1483       | Discovery launcher: brief input, preview contract, live mining trace/logs                                     |
| `CrmPipeline.tsx`             | 1330       | Kanban-style stage pipeline with drag between stages                                                          |
| `OutreachStudio.tsx`          | 1184       | Outreach draft generation & management per lead                                                               |
| `CrmCopilot.tsx`              | 347        | `/chat` conversational assistant panel                                                                        |
| `ResumableSessionsBanner.tsx` | 331        | 1-click recovery banner for interrupted mining sessions (checkpoint resume)                                   |
| `CrmOverview.tsx`             | 227        | Dashboard KPIs and summaries                                                                                  |
| `ConflictDialog.tsx`          | 159        | Side-by-side diff modal resolving lead revision conflicts (HTTP 409): overwrite / accept server / smart merge |
| `TraceTerminal.tsx`           | 84         | Decoupled streaming telemetry terminal (outside React render tree)                                            |
| `ui/*`                        | ~500 total | shadcn/Radix primitives: badge, button, card, dialog, input, label, table, tabs, textarea                     |

### State (`src/context/`)

| File               | Lines | Exports                                  | Role                                                                                                                            |
| ------------------ | ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `LeadContext.tsx`  | 1046  | `LeadProvider`, `useLeads`               | Central client store: fetch/bulk/PATCH leads, dedupe on insert, enrichment, outreach drafts, health, revision-conflict handling |
| `ToastContext.tsx` | 130   | `ToastProvider`, `useToast`, `ToastType` | Toast notifications                                                                                                             |

### Lib & utils (`src/lib/`, `src/utils/`)

| File                      | Lines | Key exports                                                                  | Role                                                |
| ------------------------- | ----- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `lib/traceStore.ts`       | 173   | `miningTraceStore`                                                           | `useSyncExternalStore` reactive SSE trace/log store |
| `lib/pipeline.ts`         | 111   | `PIPELINE_STAGES`, `getPipelineStageMeta`                                    | Stage metadata & ordering                           |
| `utils/leadDedupe.ts`     | 73    | `canonicalLinkedInIdentity`, `buildProfileDedupeKeys`, `hasDuplicateProfile` | LinkedIn canonical-identity dedupe keys             |
| `lib/leadMutations.ts`    | 48    | `rebaseLeadChanges`, `preferNewerCanonical`                                  | Optimistic-concurrency rebasing of lead edits       |
| `lib/prospectWorkflow.ts` | 42    | `REVIEW_STATUS_OPTIONS`, `getLeadProvenance`                                 | Review-status/next-action option maps               |
| `utils/leadScore.ts`      | 30    | `scoreLeadDeterministically`, `predictiveScoreFromComposite`                 | Client-side deterministic scoring                   |
| `lib/ui.ts`               | 26    | `PROSPECTS_PAGE_SIZE`, `isDiscoveryProviderConfigured`                       | UI constants/helpers                                |
| `lib/navigation.ts`       | 25    | `DASHBOARD_NAV_ITEMS`, `getTabFromHash`                                      | Hash-based tab routing                              |
| `lib/utils.ts`            | 6     | `cn`                                                                         | Tailwind class merge                                |

## 6. Backend index (`server/`)

### Core

| File            | Lines | Role                                                                                                                                                                                                                                                                                               |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`     | 197   | Express app bootstrap, static serving, `/api` mount                                                                                                                                                                                                                                                |
| `db.ts`         | 2956  | SQLite v15: migrations w/ auto-backup + batched SAVEPOINT backfills, 15 tables, optimistic revision locks, `lead_identities` canonical dedupe, `checkpoint_json` persistence + resumable-session queries, CRUD helpers (`upsertLeadWithIdentity`, `readLeadsSummary`, `LeadRevisionConflictError`) |
| `routes/api.ts` | 1187  | Thin HTTP adapter over services/engine (38 routes, §7) incl. async job mode (`?mode=job` / `Prefer: respond-async`) and SSE streams                                                                                                                                                                |

### Services (`server/services/`)

| File                  | Lines | Key exports                                                                                                                                                                         | Role                                                                            |
| --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `llm.ts`              | 1130  | `openAIText`, `openAIStructured`, `createLLMSessionCircuitBreaker`, `tavilySearch`, `tavilyExtract`, JSON schemas (`leadsArraySchema`, `searchSpecSchema`, …), `APEX_SYSTEM_PROMPT` | LLM gateway + provider fallback chain; also hosts direct Tavily calls           |
| `brightdata.ts`       | 1143  | `getBrightDataClient`, `scrapeAsMarkdown`, `executeBrightDataSearchWithRetry`, error classification/capability/status helpers                                                       | Bright Data MCP client: search + scrape-as-markdown, bounded retries, cooldowns |
| `keyRotator.ts`       | 344   | `ApiKeyPool`, `parseApiKeys`, `classifyKeyRotationError`, `executeWithKeyRotation`                                                                                                  | Multi-key rotation, 429 backoff, exhaustion quarantine                          |
| `linkedinEvidence.ts` | 286   | `parseLinkedInEvidence`, `normalizeLinkedInUrl`, `extractPublicEmail`, `buildTavilyEvidence`                                                                                        | Markdown → structured profile evidence parsing                                  |

### Discovery pipeline (`server/leadSearch/`)

#### Stage modules (`stages/`) — one module per pipeline stage

Stage order is defined by `StageName` in `pipelineTypes.ts`: `plan → retrieve → fuse → extract → verify → enrich → judge → select → persist`.

| File                      | Lines | Key exports                                                                                                                                                               | Role                                                      |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pipelineTypes.ts`        | 149   | `StageName`, `SessionConfig`, `PipelinePorts`, `PipelineSessionState`, `SessionContext`, `MiningSessionCheckpoint`, `LeadQueryRunTracker`, `StageResult`, `PipelineStage` | Shared stage contracts & checkpoint type                  |
| `stages/planStage.ts`     | 231   | `executePlanStage`                                                                                                                                                        | Adaptive batch/query derivation (pure commit at boundary) |
| `stages/retrieveStage.ts` | 417   | `executeRetrieveStage`                                                                                                                                                    | Two-wave parallel Tavily/Bright Data lanes                |
| `stages/fuseStage.ts`     | 143   | `executeFuseStage`                                                                                                                                                        | Corroboration fusion of observations                      |
| `stages/extractStage.ts`  | 456   | `executeExtractStage`                                                                                                                                                     | Budgeted LLM extraction chunking                          |
| `stages/verifyStage.ts`   | 206   | `executeVerifyStage`                                                                                                                                                      | Hard-requirement verification                             |
| `stages/enrichStage.ts`   | 633   | `executeEnrichStage`                                                                                                                                                      | TF-IDF company intent + LinkedIn post intent              |
| `stages/judgeStage.ts`    | 301   | `executeJudgeStage`                                                                                                                                                       | Multi-tier finalist evaluation                            |
| `stages/selectStage.ts`   | 97    | `executeSelectStage`                                                                                                                                                      | Pareto/MMR diversified finalist selection                 |
| `stages/persistStage.ts`  | 212   | `mapCandidateToPersistedLead`, `executePersistStage`                                                                                                                      | Lead persistence into SQLite inventory                    |

#### Engine orchestration & scheduling

| File                    | Lines | Key exports                                                                                                                                                   |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discoveryEngine.ts`    | 1600  | `DiscoverySessionEngine`, `executeDiscoverySession`, `discoveryEngine` singleton — session lifecycle, lanes, flywheel, checkpointing, resumption, persistence |
| `targetFulfillment.ts`  | 26    | `executeTargetFulfillmentSession` — forwarding facade to engine                                                                                               |
| `collectionCapacity.ts` | 142   | `MAX_COLLECTION_ROUNDS`, `buildCollectionCapacity`, stall/refinement logic                                                                                    |
| `adaptiveScheduler.ts`  | 241   | `scheduleAdaptiveRetrievalTasks`, Thompson-sampling arm scoring (`sampleBeta`, `scoreAdaptiveArm`)                                                            |
| `roundDiagnostics.ts`   | 76    | `buildRoundDiagnostics` — per-round pass rates & recovery detection                                                                                           |

#### Brief compilation & contracts

| File                  | Lines | Key exports                                                                                                                                                |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prospectContract.ts` | 646   | `ProspectContract`, `detectDecompositionMode` (single/dual stream), `buildDeterministicProspectContract`, `normalizeProspectContract`, LLM prompt builders |
| `searchSpec.ts`       | 319   | `SearchSpec`, `RetrievalTask`, `normalizeSearchSpec`, strategist/fallback plan builders                                                                    |
| `strategist.ts`       | 80    | `normalizeQueryPlanItems`, `toLinkedInSearchQuery`, re-exports strategist prompt                                                                           |
| `intentSignals.ts`    | 208   | `compileIntentSignals`, `UNIVERSAL_SIGNALS`, freshness parsing/multiplier, signal fingerprints                                                             |

#### Retrieval routing & budgeting

| File                  | Lines | Key exports                                                                                                                                                         |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `siteProbe.ts`        | 403   | `deriveCompanyDomainWithProvenance`, `matchesCompanyIdentity`, `parseSiteSignalsFromEvidenceBlock`, `normalizeDomainUrl` — company-site probing & identity matching |
| `discoveryRouting.ts` | 118   | `resolveDiscoveryProviderMode`, `shouldRunTavilyForTask`, `filterTasksForBrightData`                                                                                |
| `providerQueue.ts`    | 63    | `runProviderQueue` — concurrency-bounded task queue                                                                                                                 |
| `freeTier.ts`         | 149   | `ScoutFreeTierBudget`, per-provider free-tier capabilities                                                                                                          |
| `llmBudget.ts`        | 53    | `estimateTokenCount`, `chunkEvidenceBlocksByTokenBudget`, output budgets                                                                                            |

#### Observation fusion

| File              | Lines | Key exports                                                                                    |
| ----------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `observations.ts` | 228   | `fuseObservations`, `isSignalObservation`, company-hint extraction (deterministic/profile/LLM) |
| `signalStore.ts`  | 97    | `SignalStore`, `companiesMatch`, `normalizeCompanyName` — reverse-flywheel brand matching      |

#### Evaluation & scoring

| File                   | Lines | Key exports                                                                                                                                        |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finalistJudge.ts`     | 389   | `FinalistJudgment`, strict-evidence partitioning, judge prompt/schema, `validateFinalistJudgments`                                                 |
| `evidenceSelection.ts` | 186   | `selectEvidenceForFinalist`, `hasStrictStructuredMatch`                                                                                            |
| `verification.ts`      | 197   | `verifyDecisionMakerFromEvidence`, career-trajectory DCR                                                                                           |
| `scoring.ts`           | 590   | TF-IDF/BM25+ weights, Bayesian/Kalman fusion, sigmoid scaling, `computeParetoFrontier`, MMR selection, credible intervals, `computeScoreBreakdown` |
| `scoutScoring.ts`      | 176   | `buildScoutEvidence`, `selectDiversifiedLeads`                                                                                                     |
| `evidence.ts`          | 56    | `createLeadEvidence`, quality inference from Tavily results                                                                                        |
| `rejections.ts`        | 33    | Rejection-reason taxonomy & counters                                                                                                               |

#### Intent enrichment (Phases 4–5)

| File                    | Lines | Key exports                                                                                                     |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `linkedinPostIntent.ts` | 475   | Phase 5: `runLinkedInPostIntentEnrichment` — post SERP search + LLM classification, quality tiers               |
| `intentEnrichment.ts`   | 291   | `runIntentEnrichment` — orchestrates intent phases over finalist pool                                           |
| `companyIntent.ts`      | 240   | Phase 4: `checkCompanyWebsiteIntent` via website scrape vs. categorized signal dictionaries, `SignalCorpus` IDF |
| `profileEnrichment.ts`  | 263   | `enrichLeadProfile` — profile scrape w/ positive+negative cache                                                 |

#### Observability

| File           | Lines | Key exports                                                                                 |
| -------------- | ----- | ------------------------------------------------------------------------------------------- |
| `telemetry.ts` | 441   | `MiningTelemetryRecorder`, `recordTrace`, cost estimation, retention limits, live-log hooks |

#### Shared session infrastructure

| File                | Lines | Key exports                                                                                                                                                                       |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionHelpers.ts` | ~180  | `effectiveScore`, `buildFallbackEvidence`, `findEvidenceForLead`, `incrementCounter`, `sleepWithAbort`, `runWithTransientRetry`, `isTransientLLMError`, `buildCheckpointEvidence` |
| `leadMapping.ts`    | 123   | `mapCandidateToPersistedLead` — canonical candidate-to-lead mapping (re-exported from `discoveryEngine` for checkpoint persistence and tests)                                     |

#### Streaming & config

| File                           | Lines | Key exports                                                                                                   |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------- |
| `services/sessionStreamHub.ts` | ~150  | `sessionStreamHub` — per-session SSE broadcaster: one poll interval + one DB read fanned out to N subscribers |
| `configValidation.ts`          | ~70   | `validateEngineConfig()` — boot-time env sanity warnings (non-fatal)                                          |

## 7. REST API surface (38 routes, all under `/api`)

Verified against `server/routes/api.ts`:

| Method | Route                                | Purpose                                                                            |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------- |
| GET    | `/health`                            | App status/uptime                                                                  |
| GET    | `/llm-health`                        | LLM gateway/provider latency                                                       |
| GET    | `/key-rotation-status`               | Sanitized key-pool health                                                          |
| GET    | `/provider-capabilities`             | Scraper/search feature flags                                                       |
| GET    | `/engine-metrics`                    | Aggregated engine health: stop reasons, persistence statuses, per-stage LLM totals |
| POST   | `/lead-search/preview`               | Compile contract + query plan without executing                                    |
| POST   | `/find-leads`                        | Execute full discovery session (sync HTTP 200 or async HTTP 202 via `?mode=job`)   |
| POST   | `/scrape-url`                        | Scrape public page → markdown                                                      |
| POST   | `/scrape-pasted`                     | Parse pasted text into leads                                                       |
| GET    | `/mining-sessions`                   | List mining sessions                                                               |
| GET    | `/mining-sessions/resumable`         | List interrupted sessions available for resume                                     |
| DELETE | `/mining-sessions/resumable`         | Dismiss resumable sessions                                                         |
| GET    | `/mining-sessions/:sessionId`        | Session detail                                                                     |
| DELETE | `/mining-sessions/:sessionId`        | Delete session record                                                              |
| GET    | `/mining-sessions/:sessionId/trace`  | Live trace snapshot                                                                |
| GET    | `/mining-sessions/:sessionId/stream` | Live SSE event stream                                                              |
| POST   | `/mining-sessions/:sessionId/cancel` | Cancel active run                                                                  |
| POST   | `/mining-sessions/:sessionId/resume` | Resume interrupted session from checkpoint                                         |
| GET    | `/search-logs`                       | Query performance/cost summaries                                                   |
| GET    | `/search-logs/:id`                   | Single log detail                                                                  |
| GET    | `/search-logs/:id/live`              | Live log stream                                                                    |
| GET    | `/leads`                             | Filtered lead listing                                                              |
| PUT    | `/leads`                             | Replace stored leads                                                               |
| POST   | `/leads/bulk`                        | Bulk upsert (dedupe-aware)                                                         |
| PATCH  | `/leads/:id`                         | Stage/review/notes update (revision lock; 409 on conflict)                         |
| DELETE | `/leads`                             | Bulk clear                                                                         |
| DELETE | `/leads/:id`                         | Soft-delete/archive                                                                |
| GET    | `/leads/:id/activities`              | Lead activity audit trail                                                          |
| POST   | `/leads/:id/merge`                   | Merge duplicate identities                                                         |
| POST   | `/leads/:id/enrich-profile`          | Bright Data profile enrichment                                                     |
| GET    | `/saved-searches`                    | List saved searches                                                                |
| POST   | `/saved-searches`                    | Create/update saved search                                                         |
| DELETE | `/saved-searches/:id`                | Delete saved search                                                                |
| GET    | `/outreach-drafts`                   | List drafts                                                                        |
| POST   | `/outreach-drafts`                   | Save draft                                                                         |
| DELETE | `/outreach-drafts/:id`               | Delete draft                                                                       |
| POST   | `/generate-outbound`                 | Generate contextual outreach message                                               |
| POST   | `/chat`                              | Conversational CRM assistant                                                       |

## 8. Database schema (SQLite v16, `.apex-data/apex-crm.sqlite`)

15 tables created in `db.ts` (`LATEST_SCHEMA_VERSION = 16`):

`leads` · `app_meta` · `mcp_profile_cache` · `enrichment_cache` · `search_logs` · `mining_sessions` · `lead_activities` · `outreach_drafts` · `saved_searches` · `query_performance` · `provider_usage` · `llm_stage_logs` · `prospect_contract_cache` · `lead_identities` · `lead_identity_conflicts`

Key columns added by recent migrations:

- `mining_sessions.checkpoint_json` (v14) — compact `MiningSessionCheckpoint` Tier-A snapshot written at stage boundaries (ADR-0002); powers boot-sweep reconciliation of `interrupted` sessions into `resumable` status.
- `query_performance.requirement_fail_digest` (v16) — serialized breakdown of requirement failure frequencies per query family/lane.
- `saved_searches.exclude_list_json` (v16) — accumulated canonical identities already returned for a saved search to prevent duplicate rediscovery across runs.

WAL mode, foreign keys on, busy timeouts set, auto-backup under `.apex-data/backups/` before migrations. Canonical identity dedupe via `lead_identities` with conflict tracking.

> ⚠️ README drift: the README's schema section still names `mining_traces`, `intent_cache`, and `search_specs`, which do **not** exist in `db.ts`. Trace data lives in `search_logs`/`llm_stage_logs`; contract caching lives in `prospect_contract_cache`. Worth fixing the README.

## 9. Test suite map (`test/`, node:test runner)

npm script groups (from `package.json`):

| Script                    | Files                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test:intent-engine`      | `adaptiveDecomposition`, `intentSignals`, `intentEnrichment`, `linkedinPostIntent`                                                                                                                     |
| `test:lead-search`        | `leadSearchHelpers`                                                                                                                                                                                    |
| `test:scout`              | `scoutPipeline`                                                                                                                                                                                        |
| `test:prospect-quality`   | `prospectQuality`                                                                                                                                                                                      |
| `test:brightdata-upgrade` | `brightDataUpgrade`                                                                                                                                                                                    |
| `test:enrichment`         | `enrichmentCache`, `linkedinEvidence`, `linkedinPostIntent`                                                                                                                                            |
| `test:key-rotation`       | `keyRotator`, `tavilyRotation`                                                                                                                                                                         |
| `test:llm`                | `llmFallback`, `llmBudget`                                                                                                                                                                             |
| `test:telemetry`          | `telemetry`                                                                                                                                                                                            |
| `test:glyphs`             | `encodingHygiene`                                                                                                                                                                                      |
| `test:ui`                 | `uiContracts`                                                                                                                                                                                          |
| `test:persistence`        | `leadPersistence`                                                                                                                                                                                      |
| `test:dedupe`             | `leadDedupe`, `leadIdentityMigration`, `leadPersistence`                                                                                                                                               |
| `test:lead-engine`        | Everything above plus `adaptiveScheduler`, `signalStore`, `targetFulfillment(+Replay)`, `leadMutationContracts`, `sessionPersistenceAndResume`, `parallelRetrieval`, `rateLimitMigration`, `siteProbe` |

Not wired into an npm group: `mathEngine.test.ts`.

Typecheck gate: `npm run lint` (= `tsc --noEmit`).

## 10. Configuration surface

- `.env.example` — full template: LLM gateway mode (`direct`/`litellm`), `OPENAI_*`, `TAVILY_API_KEYS` (+ singular), `BRIGHTDATA_API_TOKENS` (+ singular/`API_TOKEN`), `DISCOVERY_PROVIDER_MODE` (`bd_primary`/`hybrid`/`tavily_primary`), `BRIGHTDATA_MCP_TRANSPORT`, timeouts/retries, `SEARCH_LOG_RETENTION_LIMIT`
- Engine tunables: `LEAD_SEARCH_TIMEOUT_MS` (default 15 min, 0 disables), `LEAD_EXTRACTION_CHUNK_RETRIES`, `LEAD_TELEMETRY_MAX_EVENTS`, `FINALIST_JUDGE_MAX_EVIDENCE_ITEMS` / `FINALIST_JUDGE_EVIDENCE_CHARS` (judge prompt token diet), `BRIGHTDATA_SCRAPE_BATCH_MAX_URLS` (1-20, default 10), `APEX_STRUCTURED_LOGS`, `LEAD_ADAPTIVE_EXPLORATION_FLOOR_EVERY`, `LEAD_JUDGE_PASS_RATE_ASSUMPTION`, `LEAD_VERIFY_BORDERLINE_PER_ROUND`
- `APEX_DB_PATH` — overrides default DB location (`db.ts`)
- `litellm.config.yaml` — LiteLLM proxy model routing
- Runtime artifacts: `.apex-data/` (DB + backups), log files in repo root (`apex-dev.*.log`, `adaptive_mining_terminal.log`)

## 11. How to navigate common tasks

| Task                        | Start here                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change a REST endpoint      | `server/routes/api.ts` (adapter) → service/`leadSearch` module                                                                                               |
| Touch discovery behavior    | `server/leadSearch/discoveryEngine.ts` → stage module in `leadSearch/stages/` (§6)                                                                           |
| Add/alter persistence       | `server/db.ts` (schema v15 migrations + helpers)                                                                                                             |
| Checkpoint/resume logic     | `leadSearch/pipelineTypes.ts` (`MiningSessionCheckpoint`), `discoveryEngine.ts`, `routes/api.ts` (`/resume`, `/resumable`), UI `ResumableSessionsBanner.tsx` |
| Modify brief→contract logic | `server/leadSearch/prospectContract.ts`, `searchSpec.ts`                                                                                                     |
| Change scoring/ranking      | `server/leadSearch/scoring.ts`, `finalistJudge.ts`, `stages/selectStage.ts`                                                                                  |
| Company-site probing        | `server/leadSearch/siteProbe.ts`, `companyIntent.ts`                                                                                                         |
| UI screen work              | matching component in `src/components/`, state in `context/LeadContext.tsx`                                                                                  |
| Provider/key issues         | `services/keyRotator.ts`, `services/brightdata.ts`, `/api/key-rotation-status`                                                                               |
