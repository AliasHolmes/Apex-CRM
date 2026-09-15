# Apex CRM — Codebase Index

Generated: 2026-09-12 · Scope: all first-party code under `src/`, `server/`, `scripts/`, `test/` (excludes `node_modules/`, `dist/`, `.venv-litellm/`, `.apex-data/`)

> Companion graph index: this repo is also indexed in `codebase-memory-mcp` as project `D-work-AI-Apex-crm`
> (1,827 nodes / 4,187 edges, status `ready`). See §12 for the sync protocol.

---

## 1. What this is

Apex CRM is a single-user, local-first prospect-scouting CRM. A natural-language "prospect brief" is compiled into a strict **Prospect Contract**, executed as a multi-lane retrieval session (Tavily + Bright Data + LLM) through a 9-stage pipelined engine, judged against cited evidence, enriched with company-website and LinkedIn-post intent signals, checkpointed at stage boundaries for resumability, and persisted into a local SQLite store. React 19 UI for review/pipeline/outreach; Express 5 backend; all outreach on LinkedIn stays manual.

Primary reference docs:

- [`README.md`](../README.md) — product overview, architecture diagrams, API table
- [`CONTEXT.md`](../CONTEXT.md) — domain glossary (Discovery Session, Prospect Contract, Identity/Intent Plane, Finalist Judge, Pareto Skyline, Reverse Flywheel)
- [`docs/adr/0001-discovery-session-engine.md`](adr/0001-discovery-session-engine.md) — ADR: extraction of the discovery loop into in-process `DiscoverySessionEngine`
- [`docs/adr/0002-stage-boundary-session-persistence-and-resumption.md`](adr/0002-stage-boundary-session-persistence-and-resumption.md) — ADR: durable stage-boundary checkpoints & session resumption
- [`docs/adr/0003-symbiotic-intelligence-hardening.md`](adr/0003-symbiotic-intelligence-hardening.md) — ADR: domain-clustered MAB, dynamic query strategy, DCR leadership scoring, site probe commercial signals, entity resolution
- [`docs/adr/0004-lean-adaptive-collection-and-targeted-enrichment.md`](adr/0004-lean-adaptive-collection-and-targeted-enrichment.md) — ADR: lean adaptive collection capacity, decoupled early stopping, targeted post-selection enrichment
- [`docs/adr/0005-deterministic-prefiltering-crm-feedback-and-sequential-execution.md`](adr/0005-deterministic-prefiltering-crm-feedback-and-sequential-execution.md) — ADR: deterministic pre-filtering, CRM negative feedback, pre-judge grounding, and strict sequential LLM execution
- [`.agents/rules/codebase_memory.md`](../.agents/rules/codebase_memory.md) — graph-index sync protocol (§12)

## 2. Quick stats

| Metric                                                           | Value                                            |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| Frontend (`src/`)                                                | ~11,088 lines across 35 files                    |
| Backend engine (`server/leadSearch/`)                            | ~18,100 lines across 42 modules (incl. 9 `stages/`) |
| Server core (`server.ts`, `db.ts`, `routes/api.ts`, `services/`) | ~11,050 lines                                    |
| REST routes                                                      | 40 (all under `/api`, also mounted at `/api/v1`) |
| SQLite tables                                                    | 17 tables + `leads_fts` virtual table (schema v20, WAL mode) |
| Test suite                                                       | 90 files, 601 test declarations                  |
| Graph index (codebase-memory-mcp)                                | 1,895 nodes · 4,395 edges · `ready`              |


## 3. Tech stack

- **Frontend**: React 19 · Vite · Tailwind CSS 4 · Radix UI · Motion · Lucide icons · TypeScript
- **Backend**: Node.js 24+ · Express 5 · native `node:sqlite` (WAL) · `p-queue` rate limiting · tsx dev runner · esbuild prod bundle
- **LLM**: LiteLLM gateway (`litellm.config.yaml`) or direct OpenAI-compatible fallback chain (Byesu → OpenRouter → Groq) with session circuit breaker
- **Retrieval**: Tavily Search/Extract with rotating key pool; Bright Data MCP (`search_engine`, `scrape_as_markdown`)

## 4. Repository layout

```text
├─ server.ts                 Express bootstrap, host/origin guard, /api + /api/v1 mount (325 lines)
├─ src/                      React client (entry, components, context, lib, utils)
├─ server/
│  ├─ db.ts                  SQLite v20 schema, migrations w/ auto-backup, CRUD, identity dedupe
│  ├─ hostValidation.ts      Host/Origin header validation (DNS-rebinding guard)
│  ├─ configValidation.ts    Boot-time env sanity warnings
│  ├─ routes/api.ts          Thin HTTP adapter → 40 REST routes
│  ├─ services/              llm.ts, brightdata.ts, keyRotator.ts, linkedinEvidence.ts, sessionStreamHub.ts
│  └─ leadSearch/            Discovery Session Engine (33 modules + 9 stages/)
├─ scripts/dev.ts            Dev orchestrator (Vite + Express concurrently)
├─ test/                     86 node:test suites (~16,470 lines)
├─ docs/                     CODEBASE_INDEX.md (this file), adr/
├─ .agents/rules/            Agent-facing conventions (graph-index sync protocol)
├─ .apex-data/               SQLite DB + WAL-safe backups (runtime artifact)
├─ litellm.config.yaml       LiteLLM proxy config
├─ vite.config.ts            Vite config (port 3000, proxy → API)
└─ components.json           shadcn/ui config
```

## 5. Frontend index (`src/`)

### Entry & shell

| File             | Lines | Role                                                                                                                                                                  |
| ---------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.tsx`       | 10    | React root mount                                                                                                                                                      |
| `App.tsx`        | 690   | App shell: dashboard tabs, health polling, provider status                                                                                                            |
| `types.ts`       | 396   | Shared types: `LinkedInProfile`, `LeadEvidence`, `PostIntentEvidence`, `ScoreBreakdown`; stage/review/action enums (`LEAD_STAGES`, `REVIEW_STATUSES`, `NEXT_ACTIONS`) |
| `index.css`      | 121   | Tailwind theme tokens                                                                                                                                                 |
| `vite-env.d.ts`  | 3     | Vite ambient types                                                                                                                                                    |

### Feature components (`src/components/`)

| File                          | Lines | Role                                                                                                          |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `LeadTable.tsx`               | 1645  | Prospect inventory: filtering, review statuses, evidence drawer, manual add                                   |
| `ScrapeWorkspace.tsx`         | 1432  | Discovery launcher: brief input, preview contract, live mining trace/logs                                     |
| `CrmPipeline.tsx`             | 1373  | Kanban-style stage pipeline with drag between stages                                                          |
| `OutreachStudio.tsx`          | 1197  | Outreach draft generation & management per lead                                                               |
| `TraceTerminal.tsx`           | 460   | Decoupled streaming telemetry terminal (outside React render tree)                                            |
| `CrmCopilot.tsx`              | 347   | `/chat` conversational assistant panel                                                                        |
| `ResumableSessionsBanner.tsx` | 331   | 1-click recovery banner for interrupted mining sessions (checkpoint resume)                                   |
| `CrmOverview.tsx`             | 232   | Dashboard KPIs and summaries                                                                                  |
| `ConflictDialog.tsx`          | 159   | Side-by-side diff modal resolving lead revision conflicts (HTTP 409): overwrite / accept server / smart merge |
| `TabErrorBoundary.tsx`        | 83    | Per-tab React error boundary — isolates a crashing dashboard tab from the shell                               |
| `ui/*`                        | 535 total | shadcn/Radix primitives: badge, button, card, dialog, input, label, table, tabs, textarea                  |

### State (`src/context/`)

| File               | Lines | Exports                                  | Role                                                                                                                            |
| ------------------ | ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `LeadContext.tsx`  | 1261  | `LeadProvider`, `useLeads`               | Central client store: fetch/bulk/PATCH leads, dedupe on insert, enrichment, outreach drafts, health, revision-conflict handling |
| `ToastContext.tsx` | 137   | `ToastProvider`, `useToast`, `ToastType` | Toast notifications                                                                                                             |

### Lib & utils (`src/lib/`, `src/utils/`)

| File                      | Lines | Key exports                                                                  | Role                                                |
| ------------------------- | ----- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `lib/traceStore.ts`       | 223   | `miningTraceStore`                                                           | `useSyncExternalStore` reactive SSE trace/log store |
| `utils/leadDedupe.ts`     | 165   | `canonicalLinkedInIdentity`, `buildProfileDedupeKeys`, `hasDuplicateProfile` | LinkedIn canonical-identity dedupe keys             |
| `lib/pipeline.ts`         | 111   | `PIPELINE_STAGES`, `getPipelineStageMeta`                                    | Stage metadata & ordering                           |
| `lib/leadMutations.ts`    | 48    | `rebaseLeadChanges`, `preferNewerCanonical`                                  | Optimistic-concurrency rebasing of lead edits       |
| `lib/prospectWorkflow.ts` | 42    | `REVIEW_STATUS_OPTIONS`, `getLeadProvenance`                                 | Review-status/next-action option maps               |
| `utils/leadScore.ts`      | 30    | `scoreLeadDeterministically`, `predictiveScoreFromComposite`                 | Client-side deterministic scoring                   |
| `lib/ui.ts`               | 26    | `PROSPECTS_PAGE_SIZE`, `isDiscoveryProviderConfigured`                       | UI constants/helpers                                |
| `lib/navigation.ts`       | 25    | `DASHBOARD_NAV_ITEMS`, `getTabFromHash`                                      | Hash-based tab routing                              |
| `lib/utils.ts`            | 6     | `cn`                                                                         | Tailwind class merge                                |

> No `src/hooks/` directory exists — the README's project-structure block still lists one.

## 6. Backend index (`server/`)

### Core

| File                    | Lines | Role                                                                                                                                                                                                                                                                                               |
| ----------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`             | 325   | Express app bootstrap, host/origin guard, static serving, `/api` + `/api/v1` mount                                                                                                                                                                                                                 |
| `db.ts`                 | 3980  | SQLite v20: migrations w/ auto-backup + batched SAVEPOINT backfills, 17 tables, optimistic revision locks, `lead_identities` canonical dedupe, `checkpoint_json` persistence + resumable-session queries, CRUD helpers (`upsertLeadWithIdentity`, `readLeadsSummary`, `LeadRevisionConflictError`), company domain extraction (`readStoredCompanyDomains`), metro saturation (`readStoredMetroSaturation`) |
| `routes/api.ts`         | 2149  | Thin HTTP adapter over services/engine (40 routes, §7) incl. async job mode (`?mode=job` / `Prefer: respond-async`) and SSE streams                                                                                                                                                                |
| `hostValidation.ts`     | 97    | `parseHostHeader`, `isLoopbackHost`, `isAllowedHost`, `isAllowedOrigin` — DNS-rebinding / CSRF-style request-origin guard                                                                                                                   |
| `configValidation.ts`   | 79    | `validateEngineConfig()` — boot-time env sanity warnings (non-fatal)                                                                                                                                                                                                                        |

### Services (`server/services/`)

| File                  | Lines | Key exports                                                                                                                                                                         | Role                                                                            |
| --------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `llm.ts`              | 1885  | `openAIText`, `openAIStructured`, `createLLMSessionCircuitBreaker`, `withSequentialLLMExecution`, `tavilySearch`, `tavilyExtract`, JSON schemas, `APEX_SYSTEM_PROMPT` | LLM gateway + provider fallback chain (strictly sequential); Tavily client with negative domain exclusions |
| `brightdata.ts`       | 1895  | `getBrightDataClient`, `scrapeAsMarkdown`, `executeBrightDataSearchWithRetry`, error classification/capability/status helpers                                                       | Bright Data MCP client: search + scrape-as-markdown, bounded retries, cooldowns |
| `keyRotator.ts`       | 434   | `ApiKeyPool`, `parseApiKeys`, `classifyKeyRotationError`, `executeWithKeyRotation`                                                                                                  | Multi-key rotation, 429 backoff, exhaustion quarantine                          |
| `linkedinEvidence.ts` | 330   | `parseLinkedInEvidence`, `normalizeLinkedInUrl`, `extractPublicEmail`, `buildTavilyEvidence`                                                                                        | Markdown → structured profile evidence parsing                                  |
| `sessionStreamHub.ts` | 197   | `sessionStreamHub`                                                                                                                                                                  | Per-session SSE broadcaster: one poll interval + one DB read fanned out to N subscribers |

### Discovery pipeline (`server/leadSearch/`)

#### Stage modules (`stages/`) — one module per pipeline stage

Stage order is defined by `StageName` in `pipelineTypes.ts`: `plan → retrieve → fuse → extract → verify → enrich → judge → select → persist`.

| File                      | Lines | Key exports                                                                                                                                                               | Role                                                      |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pipelineTypes.ts`        | 201   | `StageName`, `SessionConfig`, `PipelinePorts`, `PipelineSessionState`, `SessionContext`, `MiningSessionCheckpoint`, `LeadQueryRunTracker`, `StageResult`, `PipelineStage` | Shared stage contracts & checkpoint type                  |
| `stages/planStage.ts`     | 532   | `executePlanStage`                                                                                                                                                        | Adaptive batch/query derivation w/ CRM negative exclusions & metro saturation guidance |
| `stages/retrieveStage.ts` | 683   | `executeRetrieveStage`                                                                                                                                                    | Two-wave parallel Tavily/Bright Data lanes                |
| `stages/fuseStage.ts`     | 365   | `executeFuseStage`                                                                                                                                                        | Corroboration fusion of observations                      |
| `stages/extractStage.ts`  | 885   | `executeExtractStage`, `cleanSnippetNoise`, `buildCleanEvidence`                                                                                                          | Stage 2.5 Deterministic Pre-Filter Gate (0ms CRM dedupe, token diet, non-LinkedIn drop) & budgeted extraction |
| `stages/verifyStage.ts`   | 308   | `executeVerifyStage`                                                                                                                                                      | Hard-requirement verification                             |
| `stages/enrichStage.ts`   | 915   | `executeEnrichStage`                                                                                                                                                      | TF-IDF company intent + LinkedIn post intent              |
| `stages/judgeStage.ts`    | 1173  | `executeJudgeStage`                                                                                                                                                       | Pre-Judge role triage (0ms IC drop), site grounding, strict-evidence evaluation & bounded batch recursion |
| `stages/selectStage.ts`   | 175   | `executeSelectStage`                                                                                                                                                      | Pareto/MMR diversified finalist selection                 |
| `stages/persistStage.ts`  | 212   | `mapCandidateToPersistedLead`, `executePersistStage`                                                                                                                      | Lead persistence into SQLite inventory                    |

#### Engine orchestration & scheduling

| File                    | Lines | Key exports                                                                                                                                                   |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discoveryEngine.ts`    | 2488  | `DiscoverySessionEngine`, `executeDiscoverySession`, `discoveryEngine` singleton — session lifecycle, lanes, flywheel, checkpointing, resumption, persistence |
| `adaptiveScheduler.ts`  | 325   | `scheduleAdaptiveRetrievalTasks`, Thompson-sampling arm scoring (`sampleBeta`, `scoreAdaptiveArm`) w/ enhanced duplicate penalty & qualified reward        |
| `constraintAblation.ts` | 207   | `ABLATION_TIERS`, `classifyAblationTier`, `ablateQueryTask`, `createAblationTracker` — 4-tier requirement relaxation (Tier 1 immutable core never ablated)      |
| `roundDiagnostics.ts`   | 185   | `buildRoundDiagnostics` — per-round requirement pass rates, class summaries, bottleneck-class recovery detection                                             |
| `collectionCapacity.ts` | 145   | `MAX_COLLECTION_ROUNDS`, `buildCollectionCapacity`, stall/refinement logic                                                                                    |
| `targetFulfillment.ts`  | 26    | `executeTargetFulfillmentSession` — forwarding facade to engine                                                                                               |
| `featureFlags.ts`       | 101   | `isFlagEnabled.*` — env-overridable, default-ON flags for the Intelligent Hard Term phases, 7 hardening optimizations, and PIQ-BOS                            |

#### Brief compilation & contracts

| File                  | Lines | Key exports                                                                                                                                                |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prospectContract.ts` | 1563  | `ProspectContract`, `detectDecompositionMode` (single/dual stream), `buildDeterministicProspectContract`, `normalizeProspectContract`, LLM prompt builders |
| `searchSpec.ts`       | 745   | `SearchSpec`, `RetrievalTask`, `normalizeSearchSpec`, strategist/fallback plan builders w/ metro saturation detection                                     |
| `intentSignals.ts`    | 208   | `compileIntentSignals`, `UNIVERSAL_SIGNALS`, freshness parsing/multiplier, signal fingerprints                                                             |
| `strategist.ts`       | 148   | `normalizeQueryPlanItems`, `toLinkedInSearchQuery`, re-exports strategist prompt                                                                           |

#### Retrieval routing & budgeting

| File                  | Lines | Key exports                                                                                                                                                         |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `siteProbe.ts`        | 677   | `deriveCompanyDomainWithProvenance`, `groundCandidateWithSiteProbe`, `matchesCompanyIdentity`, `parseSiteSignalsFromEvidenceBlock`, `normalizeDomainUrl` — company-site probing, SSRF guards, & root page context grounding |
| `freeTier.ts`         | 149   | `ScoutFreeTierBudget`, per-provider free-tier capabilities                                                                                                          |
| `discoveryRouting.ts` | 118   | `resolveDiscoveryProviderMode`, `shouldRunTavilyForTask`, `filterTasksForBrightData`                                                                                |
| `providerQueue.ts`    | 63    | `runProviderQueue` — concurrency-bounded task queue                                                                                                                 |
| `llmBudget.ts`        | 53    | `estimateTokenCount`, `chunkEvidenceBlocksByTokenBudget`, output budgets                                                                                            |

#### Observation fusion

| File              | Lines | Key exports                                                                                    |
| ----------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `signalStore.ts`  | 395   | `SignalStore`, `companiesMatch`, `normalizeCompanyName` — reverse-flywheel brand matching      |
| `observations.ts` | 245   | `fuseObservations`, `isSignalObservation`, company-hint extraction (deterministic/profile/LLM) |

#### Evaluation & scoring

| File                   | Lines | Key exports                                                                                                                                        |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finalistJudge.ts`     | 1095  | `FinalistJudgment`, strict-evidence partitioning, judge prompt/schema, `validateFinalistJudgments`                                                 |
| `scoring.ts`           | 611   | TF-IDF/BM25+ weights, Bayesian/Kalman fusion, sigmoid scaling, `computeParetoFrontier`, MMR selection, credible intervals, `computeScoreBreakdown` |
| `scoutScoring.ts`      | 252   | `buildScoutEvidence`, `selectDiversifiedLeads`                                                                                                     |
| `evidenceSelection.ts` | 249   | `selectEvidenceForFinalist`, `hasStrictStructuredMatch`                                                                                            |
| `verification.ts`      | 203   | `verifyDecisionMakerFromEvidence`, career-trajectory DCR                                                                                           |
| `evidence.ts`          | 56    | `createLeadEvidence`, quality inference from Tavily results                                                                                        |
| `rejections.ts`        | 34    | Rejection-reason taxonomy & counters                                                                                                               |

#### Intent enrichment (Phases 4–5)

| File                    | Lines | Key exports                                                                                                     |
| ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------- |
| `linkedinPostIntent.ts` | 510   | Phase 5: `runLinkedInPostIntentEnrichment` — post SERP search + LLM classification, quality tiers               |
| `intentEnrichment.ts`   | 291   | `runIntentEnrichment` — orchestrates intent phases over finalist pool                                           |
| `companyIntent.ts`      | 291   | Phase 4: `checkCompanyWebsiteIntent` via website scrape vs. categorized signal dictionaries, `SignalCorpus` IDF |
| `profileEnrichment.ts`  | 263   | `enrichLeadProfile` — profile scrape w/ positive+negative cache                                                 |

#### Observability

| File           | Lines | Key exports                                                                                 |
| -------------- | ----- | ------------------------------------------------------------------------------------------- |
| `telemetry.ts` | 614   | `MiningTelemetryRecorder`, `recordTrace`, cost estimation, retention limits, live-log hooks |

#### Shared session infrastructure

| File                | Lines | Key exports                                                                                                                                                                       |
| ------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionHelpers.ts` | 289   | `effectiveScore`, `buildFallbackEvidence`, `findEvidenceForLead`, `incrementCounter`, `sleepWithAbort`, `runWithTransientRetry`, `isTransientLLMError`, `buildCheckpointEvidence` |
| `leadMapping.ts`    | 124   | `mapCandidateToPersistedLead` — canonical candidate-to-lead mapping (re-exported from `discoveryEngine` for checkpoint persistence and tests)                                     |

## 7. REST API surface (40 routes, all under `/api`)

Verified against `server/routes/api.ts`. The router is mounted twice in `server.ts`: at `/api` and `/api/v1`.

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
| GET    | `/mining-sessions/active`            | Currently running sessions                                                         |
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
| GET    | `/leads/stats`                       | Aggregate lead counts by stage/review status                                       |
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

## 8. Database schema (SQLite v20, `.apex-data/apex-crm.sqlite`)

`LATEST_SCHEMA_VERSION = 21` in `server/db.ts`. 18 regular tables + 1 FTS5 virtual table
(`leads_fts_map` was added in v21 for O(1) FTS maintenance):

`leads` · `leads_fts` (FTS5) · `app_meta` · `mcp_profile_cache` · `enrichment_cache` · `search_logs` · `mining_sessions` · `lead_activities` · `outreach_drafts` · `saved_searches` · `query_performance` · `provider_usage` · `llm_stage_logs` · `prospect_contract_cache` · `lead_identities` · `lead_identity_conflicts` · `discovered_companies` · `icp_hypothesis_cache`

Key columns and features added by recent migrations:

- `mining_sessions.checkpoint_json` (v14) — compact `MiningSessionCheckpoint` Tier-A snapshot written at stage boundaries (ADR-0002); powers boot-sweep reconciliation of `interrupted` sessions into `resumable` status.
- `query_performance.requirement_fail_digest` (v16) — serialized breakdown of requirement failure frequencies per query family/lane.
- `saved_searches.exclude_list_json` (v16) — accumulated canonical identities already returned for a saved search, preventing duplicate rediscovery across runs.
- `leads_fts` (v17) — SQLite FTS5 full-text search virtual table maintained via automatic triggers (`leads_ai`, `leads_ad`, `leads_au`) indexing promoted columns plus `json_extract` notes/tags for sub-5ms search.
- `discovered_companies` — reverse-flywheel account registry: `normalized_name` PK, signal counts, strongest signal, source URLs, confidence, `last_seen_at` (indexed DESC). Written by the signal store.
- `icp_hypothesis_cache` — `query_hash` PK cache of synthesized ICP hypotheses with `expires_at` TTL (indexed).

WAL mode, foreign keys on, busy timeouts set, auto-backup under `.apex-data/backups/` before migrations. Canonical identity dedupe via `lead_identities` with conflict tracking.

> ⚠️ README drift (verified 2026-09-12): the README's schema badge says **v19**, and its architecture diagrams / `Database & Schema` heading say **v15**, while the project-structure block says **v17**. The actual constant is **v20**. The README's table list itself is accurate — the previously-flagged `mining_traces` / `intent_cache` / `search_specs` names are no longer present. The README also references a `server/services/evidenceService.ts` and a `src/hooks/` directory, neither of which exists. Worth a README pass.

## 9. Test suite map (`test/`, node:test runner)

86 suites / 597 top-level test declarations / ~16,470 lines. `npm test` runs **all** of them (`tsx --test "test/*.test.ts"`); the npm groups below are curated subsets.

| Script                    | Files                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test:intent-engine`      | `adaptiveDecomposition`, `intentSignals`, `intentEnrichment`, `linkedinPostIntent`                                                                       |
| `test:lead-search`        | `leadSearchHelpers`                                                                                                                                      |
| `test:scout`              | `scoutPipeline`                                                                                                                                          |
| `test:prospect-quality`   | `prospectQuality`, `contractShape`                                                                                                                       |
| `test:taxonomy`           | `contractShape`                                                                                                                                          |
| `test:distributed-query`  | `distributedQueryEnforcement`                                                                                                                            |
| `test:semantic-grouping`  | `semanticGrouping`                                                                                                                                       |
| `test:evidence-aware`     | `evidenceAwareHardness`                                                                                                                                  |
| `test:class-scheduler`    | `classAwareScheduler`                                                                                                                                    |
| `test:enhanced-diagnostics` | `enhancedDiagnostics`                                                                                                                                  |
| `test:hard-terms`         | The six Phase 1–6 suites above combined                                                                                                                  |
| `test:optimizations`      | `fuzzyQuoteGrounding`, `safeSlugProbe`, `companyEntityResolution`, `resilienceAndCacheHygiene`                                                           |
| `test:critical-fixes`     | `llmStructuredArrayCoercion`, `siteProbeSsrfGuard`, `sessionStreamHubPruning`, `kalmanStability`                                                         |
| `test:brightdata-upgrade` | `brightDataUpgrade`                                                                                                                                      |
| `test:enrichment`         | `enrichmentCache`, `linkedinEvidence`, `linkedinPostIntent`                                                                                              |
| `test:key-rotation`       | `keyRotator`, `tavilyRotation`                                                                                                                           |
| `test:llm`                | `llmFallback`, `llmBudget`                                                                                                                               |
| `test:telemetry`          | `telemetry`                                                                                                                                              |
| `test:glyphs`             | `encodingHygiene`                                                                                                                                        |
| `test:ui`                 | `uiContracts`                                                                                                                                            |
| `test:persistence`        | `leadPersistence`                                                                                                                                        |
| `test:dedupe`             | `leadDedupe`, `leadIdentityMigration`, `leadPersistence`                                                                                                 |
| `test:piq-bos`            | `progressiveQualification`                                                                                                                               |
| `test:lead-engine`        | Large aggregate gate — every group above plus `adaptiveScheduler`, `signalStore`, `targetFulfillment(+Replay)`, `leadMutationContracts`, `sessionPersistenceAndResume`, `parallelRetrieval`, `rateLimitMigration`, `siteProbe` |

43 suites are not referenced by any named npm group (e.g. `architecturalImprovements`, `blueprintBlueprintCoverage`, `engineFixesVerification`, `fts5_search`, `highEfficiencyEngine`, `mathEngine`, `pillar1SearchStrategy`, `pillar2ExtractionJudging`, `semanticQualificationAudit`, `symbioticIntelligence`, `twoFunnelEngine`, `zeroYieldSafetyNet`). They still run under bare `npm test`.

Typecheck gate: `npm run lint` (= `tsc --noEmit`).

## 10. Configuration surface

- `.env.example` — full template. Groups: LLM (`OPENAI_*`, `LLM_GATEWAY_MODE`), Tavily (`TAVILY_API_KEYS`/`TAVILY_API_KEY`, depth, max results, country, concurrency, interval cap/ms, monthly credit budget, scout caps), Bright Data (`BRIGHTDATA_API_TOKENS`/`BRIGHTDATA_API_TOKEN`, plan, request budgets, batch limits, geo, cache TTL, timeouts, retries, MCP transport/stderr debug), and engine tunables
- `DISCOVERY_PROVIDER_MODE` — `bd_primary` / `hybrid` / `tavily_primary`
- Engine tunables: `LEAD_SEARCH_MAX_ROUNDS`, `LEAD_SEARCH_MIN_SCORE`, `LEAD_SEARCH_TIMEOUT_MS` (default 900000), `LEAD_EXTRACTION_CHUNK_RETRIES`, `LEAD_TELEMETRY_MAX_EVENTS`, `FINALIST_JUDGE_MAX_EVIDENCE_ITEMS` / `FINALIST_JUDGE_EVIDENCE_CHARS`, `BRIGHTDATA_SCRAPE_BATCH_MAX_URLS` (1-20, default 10), `APEX_STRUCTURED_LOGS`, `LEAD_SEARCH_RERANK_POOL_MULTIPLIER` / `_MAX`, `LEAD_ADAPTIVE_SCHEDULER_ENABLED`, `LEAD_ADAPTIVE_TASKS_PER_ROUND`, `LEAD_ADAPTIVE_MIN_OUTCOME_RUNS`, `LEAD_ADAPTIVE_EXPLORATION_STRENGTH`, `LEAD_ADAPTIVE_EXPLORATION_FLOOR_EVERY`, `LEAD_JUDGE_PASS_RATE_ASSUMPTION`, `LEAD_VERIFY_BORDERLINE_PER_ROUND`
- Feature flags (`featureFlags.ts`, all default ON, disable with `0`/`false`/`no`/`off`): `REQUIREMENT_TAXONOMY_ENABLED`, `DISTRIBUTED_QUERY_ENFORCEMENT_ENABLED`, `SEMANTIC_GROUPING_ENABLED`, `EVIDENCE_AWARE_HARDNESS_ENABLED`, `CLASS_AWARE_SCHEDULER_ENABLED`, `ENHANCED_DIAGNOSTICS_ENABLED`, `FUZZY_QUOTE_GROUNDING_ENABLED`, `SAFE_SLUG_PROBE_ENABLED`, `COMPANY_ENTITY_REGISTRY_ENABLED`, `ANCHORED_FLYWHEEL_QUERIES_ENABLED`, `FULL_JITTER_RETRY_ENABLED`, `TRANSIENT_NEGATIVE_CACHE_ENABLED`, `PROACTIVE_TOKEN_REGULATOR_ENABLED`, `PROGRESSIVE_QUALIFICATION_ENABLED`
- `APEX_DB_PATH` — overrides default DB location (`db.ts`)
- `litellm.config.yaml` — LiteLLM proxy model routing
- Runtime artifacts: `.apex-data/` (DB + backups), log files in repo root (`apex-dev.*.log`, `adaptive_mining_terminal.log`)

## 11. How to navigate common tasks

| Task                        | Start here                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change a REST endpoint      | `server/routes/api.ts` (adapter) → service/`leadSearch` module                                                                                               |
| Touch discovery behavior    | `server/leadSearch/discoveryEngine.ts` → stage module in `leadSearch/stages/` (§6)                                                                           |
| Add/alter persistence       | `server/db.ts` (schema v20 migrations + helpers)                                                                                                             |
| Checkpoint/resume logic     | `leadSearch/pipelineTypes.ts` (`MiningSessionCheckpoint`), `discoveryEngine.ts`, `routes/api.ts` (`/resume`, `/resumable`), UI `ResumableSessionsBanner.tsx` |
| Modify brief→contract logic | `server/leadSearch/prospectContract.ts`, `searchSpec.ts`                                                                                                     |
| Change scoring/ranking      | `server/leadSearch/scoring.ts`, `finalistJudge.ts`, `stages/selectStage.ts`                                                                                  |
| Tune query relaxation       | `server/leadSearch/constraintAblation.ts`, `roundDiagnostics.ts`                                                                                             |
| Toggle/rollback engine behavior | `server/leadSearch/featureFlags.ts` (env-overridable, default ON)                                                                                        |
| Company-site probing        | `server/leadSearch/siteProbe.ts`, `companyIntent.ts`                                                                                                         |
| UI screen work              | matching component in `src/components/`, state in `context/LeadContext.tsx`                                                                                  |
| Provider/key issues         | `services/keyRotator.ts`, `services/brightdata.ts`, `/api/key-rotation-status`                                                                               |
| Request-origin security     | `server/hostValidation.ts`, guard wiring in `server.ts`                                                                                                       |

## 12. Graph index & incremental sync protocol

This repository is indexed in `codebase-memory-mcp` as project `D-work-AI-Apex-crm`
(root `D:/work/AI/Apex crm`, data at `~/.cache/codebase-memory-mcp/D-work-AI-Apex-crm.db`).

Current state: **1,895 nodes · 4,395 edges · status `ready`**.

Excluded from the graph index: `.apex-data`, `.git`, `assets`, `dist`, `docs`, `node_modules`, `scripts`, `.venv-litellm/Lib`, `.venv-litellm/Scripts`.

Protocol (see [`.agents/rules/codebase_memory.md`](../.agents/rules/codebase_memory.md)):

1. **On task start** — `detect_changes(project="D-work-AI-Apex-crm")` to inspect recently changed files and impacted symbols.
2. **If changes detected** — `index_repository(repo_path="D:/work/AI/Apex crm", mode="fast")` to incrementally refresh the graph.
3. **For code discovery** — prefer graph tools (`search_graph`, `trace_path`, `get_code_snippet`, `query_graph`) over raw grep/file scanning.

CLI equivalent when the MCP server is not attached to the session:

```bash
codebase-memory-mcp cli detect_changes '{"project":"D-work-AI-Apex-crm"}'
codebase-memory-mcp cli index_repository '{"repo_path":"D:/work/AI/Apex crm","mode":"fast"}'
codebase-memory-mcp cli search_graph '{"project":"D-work-AI-Apex-crm","query":"DiscoverySessionEngine","limit":5}'
```

> Note: `docs/` is excluded from the graph index, so this file is not itself a graph node.
> No ADR has been stored via `manage_adr` yet (`adr_present: false`) — the four markdown ADRs under `docs/adr/` are the source of truth.
