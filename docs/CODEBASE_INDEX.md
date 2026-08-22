# Apex CRM — Codebase Index

Generated: 2026-02-27 · Scope: all first-party code under `src/`, `server/`, `scripts/`, `test/` (excludes `node_modules/`, `dist/`, `.venv-litellm/`)

---

## 1. What this is

Apex CRM is a single-user, local-first prospect-scouting CRM. A natural-language "prospect brief" is compiled into a strict **Prospect Contract**, executed as a multi-lane retrieval session (Tavily + Bright Data + LLM), judged against cited evidence, enriched with company-website and LinkedIn-post intent signals, and persisted into a local SQLite store. React 19 UI for review/pipeline/outreach; Express 5 backend; all outreach on LinkedIn stays manual.

Primary reference docs:
- [`README.md`](../README.md) — product overview, architecture diagrams, API table
- [`CONTEXT.md`](../CONTEXT.md) — domain glossary (Discovery Session, Prospect Contract, Identity/Intent Plane, Finalist Judge, Pareto Skyline, Reverse Flywheel)
- [`docs/adr/0001-discovery-session-engine.md`](adr/0001-discovery-session-engine.md) — ADR: extraction of the discovery loop into in-process `DiscoverySessionEngine`

## 2. Quick stats

| Metric | Value |
| --- | --- |
| Frontend (`src/`) | ~8,360 lines across 26 files |
| Backend engine (`server/leadSearch/`) | ~7,615 lines across 27 modules |
| Server core (`server.ts`, `db.ts`, `routes/api.ts`, `services/`) | ~5,410 lines |
| REST routes | 33 (all under `/api`) |
| SQLite tables | 16 (schema v13, WAL mode) |
| Test suite | 26 files, ~4,085 lines |

## 3. Tech stack

- **Frontend**: React 19 · Vite · Tailwind CSS 4 · Radix UI · Motion · Lucide icons · TypeScript
- **Backend**: Node.js 24+ · Express 5 · native `node:sqlite` (WAL) · `p-queue` rate limiting · tsx dev runner · esbuild prod bundle
- **LLM**: LiteLLM gateway (`litellm.config.yaml`) or direct OpenAI-compatible fallback chain (Byesu → OpenRouter → Groq) with session circuit breaker
- **Retrieval**: Tavily Search/Extract with rotating key pool; Bright Data MCP (`search_engine`, `scrape_as_markdown`)

## 4. Repository layout

```text
├─ server.ts                 Express bootstrap (178 lines)
├─ src/                      React client (entry, components, context, lib, utils)
├─ server/
│  ├─ db.ts                  SQLite v13 schema, migrations, CRUD, identity dedupe
│  ├─ routes/api.ts          Thin HTTP adapter → 33 REST routes
│  ├─ services/              llm.ts, brightdata.ts, keyRotator.ts, linkedinEvidence.ts
│  └─ leadSearch/            Discovery Session Engine pipeline (27 modules)
├─ scripts/dev.ts            Dev orchestrator (Vite + Express concurrently)
├─ test/                     26 node:test suites (~4,085 lines)
├─ docs/                     CODEBASE_INDEX.md (this file), adr/
├─ .apex-data/               SQLite DB + WAL-safe backups (runtime artifact)
├─ litellm.config.yaml       LiteLLM proxy config
├─ vite.config.ts            Vite config (port 3000, proxy → API)
├─ .env.example              Full configuration template
└─ components.json           shadcn/ui config
```

## 5. Frontend index (`src/`)

### Entry & shell

| File | Lines | Role |
| --- | --- | --- |
| `main.tsx` | 9 | React root mount |
| `App.tsx` | 613 | App shell: dashboard tabs, health polling, provider status |
| `types.ts` | 348 | Shared types: `LinkedInProfile`, `LeadEvidence`, `PostIntentEvidence`, `ScoreBreakdown`; stage/review/action enums (`LEAD_STAGES`, `REVIEW_STATUSES`, `NEXT_ACTIONS`) |
| `index.css` | — | Tailwind theme tokens |

### Feature components (`src/components/`)

| File | Lines | Role |
| --- | --- | --- |
| `ScrapeWorkspace.tsx` | 1329 | Discovery launcher: brief input, preview contract, live mining trace/logs |
| `LeadTable.tsx` | 1390 | Prospect inventory: filtering, review statuses, evidence drawer, manual add |
| `CrmPipeline.tsx` | 1272 | Kanban-style stage pipeline with drag between stages |
| `OutreachStudio.tsx` | 1112 | Outreach draft generation & management per lead |
| `CrmCopilot.tsx` | 329 | `/chat` conversational assistant panel |
| `CrmOverview.tsx` | 207 | Dashboard KPIs and summaries |
| `ui/*` | 477 total | shadcn/Radix primitives: badge, button, card, dialog, input, label, table, tabs, textarea |

### State (`src/context/`)

| File | Lines | Exports | Role |
| --- | --- | --- | --- |
| `LeadContext.tsx` | 834 | `LeadProvider`, `useLeads` | Central client store: fetch/bulk/PATCH leads, dedupe on insert, enrichment, outreach drafts, health |
| `ToastContext.tsx` | 114 | `ToastProvider`, `useToast`, `ToastType` | Toast notifications |

### Lib & utils (`src/lib/`, `src/utils/`)

| File | Lines | Key exports | Role |
| --- | --- | --- | --- |
| `lib/pipeline.ts` | 103 | `PIPELINE_STAGES`, `getPipelineStageMeta` | Stage metadata & ordering |
| `lib/prospectWorkflow.ts` | 36 | `REVIEW_STATUS_OPTIONS`, `getLeadProvenance` | Review-status/next-action option maps |
| `lib/leadMutations.ts` | 42 | `rebaseLeadChanges`, `preferNewerCanonical` | Optimistic-concurrency rebasing of lead edits |
| `lib/navigation.ts` | 21 | `DASHBOARD_NAV_ITEMS`, `getTabFromHash` | Hash-based tab routing |
| `lib/ui.ts` | 23 | `PROSPECTS_PAGE_SIZE`, `isDiscoveryProviderConfigured` | UI constants/helpers |
| `utils/leadDedupe.ts` | 66 | `canonicalLinkedInIdentity`, `buildProfileDedupeKeys`, `hasDuplicateProfile` | LinkedIn canonical-identity dedupe keys |
| `utils/leadScore.ts` | 25 | `scoreLeadDeterministically`, `predictiveScoreFromComposite` | Client-side deterministic scoring |
| `lib/utils.ts` | 5 | `cn` | Tailwind class merge |

## 6. Backend index (`server/`)

### Core

| File | Lines | Role |
| --- | --- | --- |
| `server.ts` | 178 | Express app bootstrap, static serving, `/api` mount |
| `db.ts` | 1875 | SQLite v13: migrations w/ auto-backup, 16 tables, optimistic revision locks, `lead_identities` canonical dedupe, CRUD + summary helpers (`upsertLeadWithIdentity`, `readLeadsSummary`, `LeadRevisionConflictError`) |
| `routes/api.ts` | 941 | Thin HTTP adapter over services/engine (33 routes, §7) |

### Services (`server/services/`)

| File | Lines | Key exports | Role |
| --- | --- | --- | --- |
| `llm.ts` | 1016 | `openAIText`, `openAIStructured`, `createLLMSessionCircuitBreaker`, `tavilySearch`, `tavilyExtract`, JSON schemas (`leadsArraySchema`, `searchSpecSchema`, …), `APEX_SYSTEM_PROMPT` | LLM gateway + provider fallback chain; also hosts direct Tavily calls |
| `brightdata.ts` | 823 | `getBrightDataClient`, `scrapeAsMarkdown`, `executeBrightDataSearchWithRetry`, error classification/capability/status helpers | Bright Data MCP client: search + scrape-as-markdown, bounded retries, cooldowns |
| `keyRotator.ts` | 301 | `ApiKeyPool`, `parseApiKeys`, `classifyKeyRotationError`, `executeWithKeyRotation` | Multi-key rotation, 429 backoff, exhaustion quarantine |
| `linkedinEvidence.ts` | 236 | `parseLinkedInEvidence`, `normalizeLinkedInUrl`, `extractPublicEmail`, `buildTavilyEvidence` | Markdown → structured profile evidence parsing |

### Discovery pipeline (`server/leadSearch/`) — grouped by pipeline stage

**Brief compilation & contracts**

| File | Lines | Key exports |
| --- | --- | --- |
| `prospectContract.ts` | 552 | `ProspectContract`, `detectDecompositionMode` (single/dual stream), `buildDeterministicProspectContract`, `normalizeProspectContract`, LLM prompt builders |
| `searchSpec.ts` | 291 | `SearchSpec`, `RetrievalTask`, `normalizeSearchSpec`, strategist/fallback plan builders |
| `strategist.ts` | 73 | `normalizeQueryPlanItems`, `toLinkedInSearchQuery`, re-exports strategist prompt |
| `intentSignals.ts` | 182 | `compileIntentSignals`, `UNIVERSAL_SIGNALS`, freshness parsing/multiplier, signal fingerprints |

**Session orchestration**

| File | Lines | Key exports |
| --- | --- | --- |
| `discoveryEngine.ts` | 2535 | `DiscoverySessionEngine`, `executeDiscoverySession`, `discoveryEngine` singleton — session lifecycle, lanes, flywheel, judging, persistence |
| `targetFulfillment.ts` | 24 | `executeTargetFulfillmentSession` — forwarding facade to engine |
| `collectionCapacity.ts` | 125 | `MAX_COLLECTION_ROUNDS`, `buildCollectionCapacity`, stall/refinement logic |
| `adaptiveScheduler.ts` | 218 | `scheduleAdaptiveRetrievalTasks`, Thompson-sampling arm scoring (`sampleBeta`, `scoreAdaptiveArm`) |
| `roundDiagnostics.ts` | 67 | `buildRoundDiagnostics` — per-round pass rates & recovery detection |

**Retrieval routing & budgeting**

| File | Lines | Key exports |
| --- | --- | --- |
| `discoveryRouting.ts` | 105 | `resolveDiscoveryProviderMode`, `shouldRunTavilyForTask`, `filterTasksForBrightData` |
| `providerQueue.ts` | 55 | `runProviderQueue` — concurrency-bounded task queue |
| `freeTier.ts` | 136 | `ScoutFreeTierBudget`, per-provider free-tier capabilities |
| `llmBudget.ts` | 46 | `estimateTokenCount`, `chunkEvidenceBlocksByTokenBudget`, output budgets |

**Observation fusion**

| File | Lines | Key exports |
| --- | --- | --- |
| `observations.ts` | 203 | `fuseObservations`, `isSignalObservation`, company-hint extraction (deterministic/profile/LLM) |
| `signalStore.ts` | 84 | `SignalStore`, `companiesMatch`, `normalizeCompanyName` — reverse-flywheel brand matching |

**Evaluation & scoring**

| File | Lines | Key exports |
| --- | --- | --- |
| `finalistJudge.ts` | 320 | `FinalistJudgment`, strict-evidence partitioning, judge prompt/schema, `validateFinalistJudgments` |
| `evidenceSelection.ts` | 165 | `selectEvidenceForFinalist`, `hasStrictStructuredMatch` |
| `evidence.ts` | 50 | `createLeadEvidence`, quality inference from Tavily results |
| `verification.ts` | 174 | `verifyDecisionMakerFromEvidence`, career-trajectory DCR |
| `scoring.ts` | 506 | TF-IDF/BM25+ weights, Bayesian/Kalman fusion, sigmoid scaling, `computeParetoFrontier`, MMR selection, credible intervals, `computeScoreBreakdown` |
| `scoutScoring.ts` | 162 | `buildScoutEvidence`, `selectDiversifiedLeads` |
| `rejections.ts` | 27 | Rejection-reason taxonomy & counters |

**Intent enrichment (Phases 4–5)**

| File | Lines | Key exports |
| --- | --- | --- |
| `companyIntent.ts` | 206 | Phase 4: `checkCompanyWebsiteIntent` via website scrape vs. categorized signal dictionaries, `SignalCorpus` IDF |
| `linkedinPostIntent.ts` | 416 | Phase 5: `runLinkedInPostIntentEnrichment` — post SERP search + LLM classification, quality tiers |
| `intentEnrichment.ts` | 260 | `runIntentEnrichment` — orchestrates intent phases over finalist pool |
| `profileEnrichment.ts` | 241 | `enrichLeadProfile` — profile scrape w/ positive+negative cache |

**Observability**

| File | Lines | Key exports |
| --- | --- | --- |
| `telemetry.ts` | 392 | `MiningTelemetryRecorder`, `recordTrace`, cost estimation, retention limits, live-log hooks |

## 7. REST API surface (33 routes, all under `/api`)

Verified against `server/routes/api.ts`:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | App status/uptime |
| GET | `/llm-health` | LLM gateway/provider latency |
| GET | `/key-rotation-status` | Sanitized key-pool health |
| GET | `/provider-capabilities` | Scraper/search feature flags |
| POST | `/lead-search/preview` | Compile contract + query plan without executing |
| POST | `/find-leads` | Execute full discovery session |
| POST | `/scrape-url` | Scrape public page → markdown |
| POST | `/scrape-pasted` | Parse pasted text into leads |
| GET | `/mining-sessions` | List mining sessions |
| GET | `/mining-sessions/:sessionId` | Session detail |
| GET | `/mining-sessions/:sessionId/trace` | Live trace snapshot |
| GET | `/mining-sessions/:sessionId/stream` | Live SSE event stream |
| POST | `/mining-sessions/:sessionId/cancel` | Cancel active run |
| GET | `/search-logs` | Query performance/cost summaries |
| GET | `/search-logs/:id` | Single log detail |
| GET | `/search-logs/:id/live` | Live log stream |
| GET | `/leads` | Filtered lead listing |
| PUT | `/leads` | Replace stored leads |
| POST | `/leads/bulk` | Bulk upsert (dedupe-aware) |
| PATCH | `/leads/:id` | Stage/review/notes update (revision lock) |
| DELETE | `/leads` | Bulk clear |
| DELETE | `/leads/:id` | Soft-delete/archive |
| GET | `/leads/:id/activities` | Lead activity audit trail |
| POST | `/leads/:id/merge` | Merge duplicate identities |
| POST | `/leads/:id/enrich-profile` | Bright Data profile enrichment |
| GET | `/saved-searches` | List saved searches |
| POST | `/saved-searches` | Create/update saved search |
| DELETE | `/saved-searches/:id` | Delete saved search |
| GET | `/outreach-drafts` | List drafts |
| POST | `/outreach-drafts` | Save draft |
| DELETE | `/outreach-drafts/:id` | Delete draft |
| POST | `/generate-outbound` | Generate contextual outreach message |
| POST | `/chat` | Conversational CRM assistant |

## 8. Database schema (SQLite v13, `.apex-data/apex-crm.sqlite`)

16 tables created in `db.ts`:

`leads` · `app_meta` · `mcp_profile_cache` · `enrichment_cache` · `search_logs` · `mining_sessions` · `lead_activities` · `outreach_drafts` · `saved_searches` · `query_performance` · `provider_usage` · `llm_stage_logs` · `prospect_contract_cache` · `icp_hypothesis_cache` · `lead_identities` · `lead_identity_conflicts`

> ⚠️ README drift: the README's schema section still names `mining_traces`, `intent_cache`, and `search_specs`, which do **not** exist in `db.ts`. Trace data lives in `search_logs`/`llm_stage_logs`, contract/intent caching in `prospect_contract_cache`/`icp_hypothesis_cache`. Worth fixing the README.

WAL mode, foreign keys on, busy timeouts set, auto-backup under `.apex-data/backups/` before migrations. Canonical identity dedupe via `lead_identities` with conflict tracking.

## 9. Test suite map (`test/`, node:test runner)

npm script groups (from `package.json`):

| Script | Files |
| --- | --- |
| `test:intent-engine` | `adaptiveDecomposition`, `intentSignals`, `intentEnrichment`, `linkedinPostIntent` |
| `test:lead-search` | `leadSearchHelpers` |
| `test:scout` | `scoutPipeline` |
| `test:prospect-quality` | `prospectQuality` |
| `test:brightdata-upgrade` | `brightDataUpgrade` |
| `test:enrichment` | `enrichmentCache`, `linkedinEvidence`, `linkedinPostIntent` |
| `test:key-rotation` | `keyRotator`, `tavilyRotation` |
| `test:llm` | `llmFallback`, `llmBudget` |
| `test:telemetry` | `telemetry` |
| `test:glyphs` | `encodingHygiene` |
| `test:ui` | `uiContracts` |
| `test:persistence` | `leadPersistence` |
| `test:dedupe` | `leadDedupe`, `leadIdentityMigration`, `leadPersistence` |
| `test:lead-engine` | Everything above plus `adaptiveScheduler`, `signalStore`, `targetFulfillment(+Replay)`, `leadMutationContracts` |

Not wired into an npm group: `mathEngine.test.ts`.

Typecheck gate: `npm run lint` (= `tsc --noEmit`).

## 10. Configuration surface

- `.env.example` — full template: LLM gateway mode (`direct`/`litellm`), `OPENAI_*`, `TAVILY_API_KEYS` (+ singular), `BRIGHTDATA_API_TOKENS` (+ singular/`API_TOKEN`), `DISCOVERY_PROVIDER_MODE` (`bd_primary`/`hybrid`/`tavily_primary`), `BRIGHTDATA_MCP_TRANSPORT`, timeouts/retries, `SEARCH_LOG_RETENTION_LIMIT`
- `APEX_DB_PATH` — overrides default DB location (`db.ts`)
- `litellm.config.yaml` — LiteLLM proxy model routing
- Runtime artifacts: `.apex-data/` (DB + backups), log files in repo root (`apex-dev.*.log`, `adaptive_mining_terminal.log`)

## 11. How to navigate common tasks

| Task | Start here |
| --- | --- |
| Change a REST endpoint | `server/routes/api.ts` (adapter) → service/`leadSearch` module |
| Touch discovery behavior | `server/leadSearch/discoveryEngine.ts` → stage-specific module (§6) |
| Add/alter persistence | `server/db.ts` (schema v13 migrations + helpers) |
| Modify brief→contract logic | `server/leadSearch/prospectContract.ts`, `searchSpec.ts` |
| Change scoring/ranking | `server/leadSearch/scoring.ts`, `finalistJudge.ts` |
| UI screen work | matching component in `src/components/`, state in `context/LeadContext.tsx` |
| Provider/key issues | `services/keyRotator.ts`, `services/brightdata.ts`, `/api/key-rotation-status` |
