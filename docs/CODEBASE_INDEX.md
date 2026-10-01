# Apex CRM — Codebase Index

Generated: 2026-10-02 · Scope: all first-party code under `src/`, `server/`, `scripts/`, `test/`
(excludes `node_modules/`, `dist/`, `.apex-data/`)

> Supersedes the 2026-09-25 index, which had drifted on schema version (v23 → v26), test
> counts (129 files → 154, 860 tests → 976 tests), table inventory (20 → 24 tables),
> and module listings. Verified values below were measured directly from the tree, not inherited:
> `tsc --noEmit` passes with 0 errors and the full suite (`npm test`) passes 976 tests across
> 176 test suites as of this date.

---

## 1. What this is

Apex CRM is a single-user, local-first prospect-scouting CRM. A natural-language "prospect
brief" is compiled into a strict **Prospect Contract**, executed as a multi-lane retrieval
session (Tavily + Bright Data + LLM) through a 9-stage pipelined engine, judged against
cited evidence, enriched with company-website and LinkedIn-post intent signals,
checkpointed at stage boundaries for resumability, and persisted into a local SQLite
store. React 19 UI for review/pipeline/outreach; Express 5 backend; all outreach on
LinkedIn stays manual.

Primary reference docs:

- [`README.md`](../README.md) — product overview, architecture diagrams, API table
- [`CONTEXT.md`](../CONTEXT.md) — domain glossary
- [`docs/adr/0001`…`0007`](adr/) — seven ADRs covering the engine, checkpointing, hardening,
  lean collection, deterministic pre-filtering, quality grounding, and industry-agnostic dual concurrency

The audit trail has been retired from the tree. The 2026-09-12 and 2026-09-13 audits, their
2026-09-15 verification, and the 2026-09-15 bug report are all superseded: every finding is
either fixed (commits `4c385da`, `e3c851d`, `4ae2193`) and pinned by a regression test, or
carried forward in §9 below. Recover them from git history if the detail is ever needed.

## 2. Quick stats

| Metric                                                           | Value                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Frontend (`src/`)                                                | ~11,800 lines across 36 files                                              |
| Backend engine (`server/leadSearch/`)                            | ~23,400 lines: 43 modules + 9 `stages/`                                    |
| Server core (`server.ts`, `db.ts`, `routes/api.ts`, `services/`) | ~14,600 lines                                                              |
| REST routes                                                      | 41 (all under `/api`, also mounted at `/api/v1`)                           |
| SQLite                                                           | 24 base tables + `leads_fts` (fts5), schema **v26**, WAL                   |
| Test suite                                                       | 154 files (153 `.test.ts` + 1 `.eval.ts`), 976 unit tests / 176 suites + 13 eval tests, all passing |
| Total first-party LOC                                            | ~74,500 (incl. ~26,200 test LOC)                                           |
| Working tree                                                     | clean (all fixes committed through `129173a`)                              |

## 3. Tech stack

- **Frontend**: React 19 · Vite · Tailwind CSS 4 · Radix UI · Motion · Lucide ·
  `@tanstack/react-table` + `react-virtual` · TypeScript
- **Backend**: Express 5 · `node:sqlite` (schema-versioned, migrated in-transaction with
  pre-migration backups pruned to 3) · TypeScript, run by `tsx`
- **Retrieval/LLM**: Tavily (search + extract), Bright Data MCP (scrape/search),
  cross-round query retrieval cache, OpenAI-compatible LLM with Provider-Affinity Dual Concurrency
  (Atria primary with 10-minute dynamic reasoning headroom + Byesu secondary parallel overflow),
  OpenRouter/Groq fallback chain, Langfuse telemetry
- **Discipline**: `tsc --noEmit` under `strict`, `noImplicitAny`, `noUnusedLocals`,
  `noUnusedParameters`; `prebuild` gates on typecheck; strict ASCII enforced by
  `test/encodingHygiene.test.ts`

## 4. Repository layout

```
server.ts                    Express app + static Vite serve (333 lines)
server/db.ts                 SQLite layer: schema v26, migrations, 40+ readers/writers (5,559)
server/routes/api.ts         41 REST routes + binary outcome / cluster feedback (2,160)
server/services/             llm.ts (3,095, provider-affinity dual concurrency, Atria reasoning headroom, completion cache) ·
                             brightdata.ts (2,242) · keyRotator ·
                             sessionStreamHub (SSE) · linkedinEvidence · privateHosts (SSRF) ·
                             outboundPrompt · langfuse
server/leadSearch/           the discovery engine
  discoveryEngine.ts         session loop, round budget, checkpoints, resume (2,540)
  prospectContract.ts        brief -> contract compilation + validation, plural-persona & city-anchor support (1,930)
  finalistJudge.ts           strict citation grounding, polarity-guarded fuzzy quotes, verdict reuse (1,340)
  scoring.ts                 normalizeToTenScale, Kalman fusion, MMR/Pareto, brief-gated authority weighting (690)
  queryUnderstanding.ts      complexity classifier (vague/standard/rich), resolveGeo (pronoun guard), salience compression
  candidateVerdicts.ts       persistent qualification and hard-fail verdict cache (Schema v26)
  defaultRoles.ts            open-ended role and business function extractor for any industry
  geo.ts                     universal ISO 3166-1 country code resolution via Intl
  retrievalCache.ts          cross-round query-hash-keyed search retrieval cache
  aliasMap.ts                symmetrical bidirectional role/geo/company/tool alias normalization for hot loops
  queryRewriter.ts           bounded complexity-aware zero-yield rewriter (Tier-1 immutable anchor protection)
  companyAttribution.ts      gated company-to-prospect LLM attribution + business-model contradiction gating (Schema v26)
  profileQuality.ts          deterministic social-proof parsing, ghost/company-page & company-scoped contradiction gates
  providerQueue.ts           bounded-concurrency provider task queue (runProviderQueue)
  searchSpec.ts · strategist.ts · adaptiveScheduler.ts (open-ended MAB clusters, outcome boost, hard-fail penalty) ·
  collectionCapacity.ts · constraintAblation.ts · evidenceSelection.ts (alias-aware, location provenance guard) ·
  intentSignals.ts (abbreviated units, 45d neutral undated age) · intentEnrichment.ts ·
  companyIntent.ts · linkedinPostIntent.ts (annotate-only) · siteProbe.ts (provenance-tagged, press-URL guard) ·
  signalStore.ts · telemetry.ts · featureFlags.ts · freeTier.ts · discoveryRouting.ts · leadMapping.ts ·
  sessionHelpers.ts · observations.ts · profileEnrichment.ts · rejections.ts ·
  roundDiagnostics.ts · scoutScoring.ts · targetFulfillment.ts · verification.ts ·
  evidence.ts · llmBudget.ts · pipelineTypes.ts · titleTriage.ts (alias-aware)
  stages/                    plan (resolveGeo, cluster MAB, cross-session companies, outcome rate) ·
                             retrieve (retrieval cache + vagueness-aware depth + rewriter on both paths) ·
                             fuse (symmetrical alias-aware) · extract · verify ·
                             enrich (provenance-tagged site probe + annotate-only post intent) ·
                             judge (strict grounding + polarity guard + verdict reuse) · select ·
                             persist (CRM workflow preservation + derived session status)
src/                         App.tsx (tab shell + error boundaries) · context/ (LeadContext,
                             ToastContext) · components/ (10 feature + 9 ui) · lib/ · utils/
test/                        154 files (153 .test.ts + queryIntelligence.eval.ts), node:test runner via tsx
scripts/dev.ts               spawns Vite + Express (84 lines)
```

## 5. The discovery pipeline

Order is defined by `StageName` in `server/leadSearch/pipelineTypes.ts`:

1. **plan** — CRM negative-domain exclusion, JSON-aware metro-saturation avoidance
   (`$.profile.location` / `$.profile.city`), cross-session `discovered_companies` seeding
   (`readDiscoveredCompanyNames(25)`), `resolveGeo` with pronoun-collision and city-only
   geo guards (no `USA` invention for open-global briefs), strategist query generation,
   cluster-keyed `historicalYield` (`domain_cluster|family|lane|provider`), and
   `readOutcomeRate().rate` injection into `scheduleAdaptiveRetrievalTasks` (`planStage.ts`)
2. **retrieve** — two-wave parallel Tavily + Bright Data lanes, conditional supplemental
   fallback when Tavily yield is low, vagueness-aware `maxResults`/depth
   (`vague: 20`, `rich: precision-tuned`), bounded `queryRewriter` rescue dispatched across
   both credit-reservation and standard paths with `demotedRequirementId` threading and
   Tier-1 immutable anchor protection (`retrieveStage.ts`, `queryRewriter.ts`)
3. **fuse** — corroboration fusion, dedupe, ablation tagging, symmetrical bidirectional
   alias-aware term scoring (`MD` <-> `managing director`, `US` <-> `United States`)
   (`fuseStage.ts`, `aliasMap.ts`)
4. **extract** — Stage 2.5 zero-LLM pre-filter gate + token-dieted LLM extraction, chunked (`extractStage.ts`)
5. **verify** — hard-requirement verification, borderline survival band (`verifyStage.ts`)
6. **judge** — pre-judge alias-aware role triage (`MD`/`VP`/`CTO` expanded),
   tri-partition by evidence (excluding company-derived locations from `person_location`
   auto-pass), `EVIDENCE_GROUNDING_MODE=strict` quote enforcement with negation polarity
   guard (`0.7 * window + 0.3 * setOverlap`), company-scoped `b2b_saas` contradiction
   checks, `hard_fail` precedence over `fabricatedPass`, and contract-aware ranking
   (hard `1.2x` + soft `0.4x`) (`judgeStage.ts`, `titleTriage.ts`,
   `finalistJudge.ts`, `profileQuality.ts`, `scoring.ts`)
7. **select** — pre-selection intent probing on top qualified candidates (Phase 4 company
   intent + Phase 5 LinkedIn post intent on top `ceil(targetLimit * 1.5)` pool) to activate
   all 4 Pareto dimensions, followed by Pareto skyline + MMR diversification (`selectStage.ts`)
8. **enrich** — post-selection consolidated site probing (tagging `_locationProvenance = 'company_site'`
   and rejecting non-matching press URLs via `urlHostSharesCompanyToken`) for selected finalists
   (`enrichStage.ts`, `siteProbe.ts`)
9. **persist** — identity-keyed upserts preserving CRM-owned workflow fields (`stage`,
   `reviewStatus`, `nextAction`, `notes` protected unless `forceOverwrite: true`), FTS
   maintenance, exclude-list append, and session/log status (`success | partial_success | error`)
   derived from actual `persistenceStatus` (`persistStage.ts`, `db.ts`)

Cross-cutting invariants:

- **`withSequentialLLMExecution`** (`llm.ts`) serializes every LLM call through one
  queue by default to prevent provider 429/524 collisions. Behind
  `FEATURE_LLM_STAGE_QUEUES=true` it shards into `strategist | extraction |
  judge | general` lanes (max 2 each, global cap 4) with backoff preserved.
  `ExecuteDiscoveryOptions` supports `parentSessionId`/`deltaBrief` follow-ups
  and `interactive=false` headless expander fallback. The MAB pools priors by
  24 quantized brief centroids while preserving all `contract_guard` tasks above the
  `maxTasks+2` cap so hard-requirement coverage is never pruned.
- **Stage-boundary checkpoints** (`mining_sessions.checkpoint_json`, 512KB guard) power
  1-click resume; resume rebuilds `seenCandidateKeys` and _replaces_ checkpoint counters.
- **Per-provider circuit breaker** with cooldown ladders and key rotation.

## 6. Configuration surface

144 keys in `.env` (mirrored by `.env.example`). Notable:

- `EVIDENCE_GROUNDING_MODE` (`.env.example` = `"strict"`) — enforces verbatim, alias, or
  polarity-guarded fuzzy quote citations on every `pass` verdict (`"legacy"`/`"permissive"`
  restores pre-G1 behavior).
- `LEAD_SEARCH_MAX_ROUNDS` (`.env` = `"6"`) — authoritative round budget; the in-loop
  extension ceiling now defers to it when set (was hard-coded 10, which is how a run
  configured for 6 reached 10).
- `LLM_MAX_RETRIES=0` is now honoured; a 429 falls through immediately with a 5s cooldown.
- `BRIGHTDATA_SCRAPE_BATCH_MAX_URLS` clamped 1–20 (default 10).
- `LEAD_SEARCH_TIMEOUT_MS=0` disables the 15-minute safety timeout.
- `server/configValidation.ts` emits non-fatal boot warnings for misconfigurations.

`featureFlags.ts` exposes 15 flags; **6 have graduated into permanent architectural
invariants** that return `true` unconditionally (see §9.6), the rest remain
env-overridable.

## 7. Test suite

129 files / 860 unit & integration tests (172 suites) via `npm test` + 13 eval tests via
`npm run test:eval` (verified passing 2026-09-25). Composition:

- **Query & intelligence eval**: `queryIntelligence.eval` (13 suites covering 30+ gold briefs,
  pronoun-collision guard G21, plural-persona extraction G22, city-only geo anchoring G24,
  and qualified-yield baseline)
- **Engine behaviour**: `deepAuditRegression` (25), `prospectQuality` (31), `contractShape`
  (34), `constraintAblation` (16), `scoutPipeline` (12), `progressiveQualification` (12),
  `fuzzyQuoteGrounding`, `profileQuality`, `siteProbe`, `adaptiveScheduler`
- **Provider/resilience**: `brightDataUpgrade` (44), `llmFallback` (29), `keyRotator`,
  `tavilyRotation`, `kalmanStability`, `serverResilience`, `sessionStreamHubPruning`
- **Persistence**: `leadPersistence` (incl. G15 CRM workflow preservation), `leadDedupe`,
  `leadIdentityMigration`, `sessionPersistenceAndResume`, `concurrencyShieldAndBulkDelete`,
  `crmNegativeExclusions` (incl. G13 JSON metro saturation)
- **Contracts**: `uiContracts` (16), `encodingHygiene`, `contractShape`
- Curated subsets are wired as named `npm run test:*` scripts (incl. `npm run test:eval`).

## 8. Assessment — what is strong

- **Verification discipline is real.** Every recent fix is pinned by a named regression
  test, and `deepAuditRegression.test.ts` was explicitly checked for non-vacuousness
  (reverting finding 1 makes exactly the 2 ranking assertions fail).
- **The audit loop closed correctly.** The 2026-09-15 verification classified 23 findings as
  18 fixed / 3 partial / 2 not fixed; the two "not fixed" items were then picked up by the
  2026-09-15 bug pass (findings 3 and 4) and fixed in `e3c851d`.
- **The SSRF surface is now correct.** `siteProbe.ts` follows redirects manually with
  per-hop re-validation, and `privateHosts.ts` canonicalises decimal/hex/octal/shortened
  IPv4 forms and blocks `224.0.0.0/4`, `240.0.0.0/4`, `192.0.0.0/24`.
- **Score normalization is centralized.** `normalizeToTenScale` (`scoring.ts:43`) is the
  single implementation of the exclusive `< 1.0` rule, with the rationale documented at
  the definition so the two halves of the engine cannot drift apart again.
- **Bounded everywhere.** session logs (1,500 lines), trace events (2MB), checkpoints
  (512KB), backups (3 newest), trace terminal buffers.

## 9. Assessment — open issues

Ordered by leverage, not severity.

### 9.1 Documentation drift — RESOLVED (2026-09-16)

`CONTEXT.md:50` now states the derived caps (3 rounds up to target 30, 4 up to 50, 6 above),
the `MAX_COLLECTION_ROUNDS = 24` ceiling, and the `LEAD_SEARCH_MAX_ROUNDS` override, instead
of the incorrect "2-4 rounds". The README badge now reads `681_Tests_Passing`, matching the
measured suite. Generating the badge from the test run remains an option but it is no longer
wrong. *(2026-09-25 note: the badge has since been simplified to `Lead_Engine-Passing`;
current counts live in §2.)*

### 9.2 `executeJudgeStage` dead code — RESOLVED (2026-09-16)

Confirmed dead before removal: no production caller, and no stage registry or dynamic
dispatch resolved to it. `discoveryEngine.ts` called `evaluateIncrementalJudgeBatches`
only (lines 1754, 2064). The function spanned lines 115-795 — ~680 lines, 56% of the file.

Three findings changed the remedy from the original "delete it and migrate its two test
callers":

1. **Two of the four dependent tests asserted on write-only state.** `stats.rerank.poolSize`
   and `stats.rerank.judge` were written only by the dead function and read by nothing in
   `server/` or `src/`, so there was nothing meaningful to migrate them to.
2. **`candidatePoolCap` and `judgeOutcomeTotals` were dead-only, not duplicated.** The live
   path bounds its pool upstream via `collectionCapacity.candidateCeiling` and
   `postTriage.needsJudge`. Anyone wanting these in production must build them in the live
   path, not migrate a test.
3. **The safety net had drifted, and the LIVE copy was the untested one.** The live safety
   net (`discoveryEngine.ts:2086`) is marked deprecated and had different semantics, adding
   dedupe against already-qualified leads plus `_autoFailed`, contradiction and
   `disqualified` checks. Its three shared checks lived in the exported
   `isEligibleForSafetyNet`, which the live filter was duplicating inline.

What was done:

- The live safety-net promotion loop was extracted into an exported, tested
  `promoteSafetyNetCandidates` (`judgeStage.ts`), and the live eligibility filter now calls
  `isEligibleForSafetyNet` instead of duplicating it. Both changes are behaviour-preserving.
- `executeJudgeStage` plus `JudgeStageInput` / `JudgeStageOutput` were deleted.
  `judgeStage.ts` went from 1,303 to 608 lines. Eight now-unused imports were dropped:
  `finalistCandidateFromLead`, `partitionCandidatesByStrictEvidence`, `runProviderQueue`,
  `buildFallbackEvidence`, `findEvidenceForLead`, `SessionEvidenceMeta`, `EvidenceMeta`,
  `normalizeDedupeValue`.
- `discoveryEngine.ts` shed four now-unused imports: `rankLeadForFinalSelection`,
  `isEligibleForSafetyNet`, and the `effectiveScore` / `sharedEffectiveScore` alias.
- The four dead-path tests were removed. Coverage was **replaced, not lost**: eleven
  assertions now cover `isEligibleForSafetyNet` and `promoteSafetyNetCandidates` directly,
  where previously the only tests exercised a copy that production never ran.

**Note for future readers:** `candidatePoolCap` and `judgeOutcomeTotals` no longer exist
anywhere in the codebase. If pool capping or judge-outcome telemetry is wanted in
production, it must be built in the live path — the deleted tests were the only record of
the intent.

### 9.3 Residual `<= 1.0` score inversion — RESOLVED (2026-09-16)

The bug report fixed five of six sites and added `normalizeToTenScale`; the sixth was in the
frontend. `src/context/LeadContext.tsx` no longer contains an executable `<= 1.0` comparison.
Both call sites — `handleLeadAdded` and the bulk-import path — now use a shared
`normalizeServerScore` (`src/utils/leadScore.ts`) that mirrors `normalizeToTenScale` in
`server/leadSearch/scoring.ts`, so the client and server halves of the rule cannot drift
apart again. It returns `undefined` for absent input so each caller keeps its own fallback
(`scoreLeadDeterministically` vs `0`) rather than adopting a default inside the helper.

Pinned by `test/verifiedBugfixes.test.ts` ("Client-side score normalization"), which covers
the unit rule, the full composite math (`compositeFrom(1) === 10`, not `100`), and a source
guard that fails if an executable `<= 1.0` comparison is reintroduced in `LeadContext.tsx`.
Non-vacuousness was verified by reintroducing the original expression at the call site and
confirming the guard fails.

### 9.4 No LLM completion cache — RESOLVED (2026-09-25)

`server/services/llm.ts` now consults a durable completion cache before dispatching:
`getLlmCacheEntry(promptHash)` (llm.ts:2192) short-circuits repeat completions, and
fresh responses are persisted via `upsertLlmCacheEntry` (llm.ts:2240, :2307). The cache
is backed by the `llm_completion_cache` table (`prompt_hash` PK, provider/model/response/
usage payload, `expires_at` TTL with `purgeLlmCacheExpired` sweeps). Pinned by
`test/llmCompletionCache.test.ts`. This was the highest-leverage performance item
(79% of session wall clock in LLM latency); whether it moved the needle still requires
the re-measurement in §10.6.

### 9.5 Uncommitted work — RESOLVED (2026-09-16)

The working tree is clean. The engine fixes, the `deepAuditRegression` suite and the
documentation are committed (`e3c851d`, `4ae2193`), so nothing is at risk from a stash or
an accidental reset.

### 9.6 Flag surface that no longer means anything — RESOLVED (2026-09-17)

Six deprecated architecture flags in `server/leadSearch/featureFlags.ts` (`taxonomy`, `distributedQuery`, `semanticGrouping`, `enhancedDiagnostics`, `transientNegativeCache`, `proactiveTokenRegulator`) have been graduated into permanent architectural invariants that return `true` unconditionally, eliminating the risk of operators unintentionally degrading engine correctness via env vars.

### 9.7 Test isolation hazard — RESOLVED (2026-09-17)

Wholesale `delete process.env[key]` wipe loops in `test/llmUntrustedMessage.test.ts`, `test/llmFallback.test.ts`, `test/tavilyRotation.test.ts`, and `test/brightDataUpgrade.test.ts` have been replaced with scoped `MANAGED_KEYS` snapshots. This eliminates cross-suite test pollution during parallel `node:test` execution.

### 9.8 Carried-forward audit leftovers — RESOLVED (2026-09-17)

- `server/db.ts:recordQueryPerformance`: Protected `runs` decay behind `runs = CASE WHEN excluded.runs > 0 THEN CAST(ROUND(query_performance.runs * 0.95 + excluded.runs) AS INTEGER) ELSE query_performance.runs END`, preventing single-lead CRM reviews (`runs: 0`) from degrading historical query run counts.
- `server/leadSearch/prospectContract.ts`: Dropped ungrounded hard requirements are now recorded in `contract.droppedUngroundedRequirements`, surfaced in compilation log diagnostics, and emitted as structured trace telemetry events (`contract_dropped_ungrounded`) in `discoveryEngine.ts`.
- `server/leadSearch/stages/selectStage.ts`: All conversion funnel counts (`rawCandidates`, `uniqueCandidates`, `extractedCandidates`, `acceptedCandidates`, `duplicateCandidates`, `searchLatencyMs`, `providerUnits`) are now written to `recordQueryPerformance`.
- `server/leadSearch/stages/planStage.ts`: `requirementFailDigest` is now populated in `historicalYield`, restoring the frequent failure prompt guidance.

### 9.9 `LLM_MAX_RETRIES` is overridden on the 429 path — RESOLVED (2026-09-17)

`server/services/llm.ts` now strictly honors configured `LLM_MAX_RETRIES` on 429 and 5xx responses:
```ts
const statusMaxRetries = maxRetries;
```
When `LLM_MAX_RETRIES=0` (or `1`), the engine cascades immediately after the configured retry count rather than forcing a 2-retry minimum. Furthermore, the request timeout timer is armed only once queued HTTP execution begins, preventing queue wait starvation.

### 9.10 Intelligence Gap Remediation (G1–G24) — RESOLVED (2026-09-23, `5a052c4`)

All 24 findings from the 2026-09-22 intelligence gap audit have been resolved across 34 files and verified across 860 unit/integration tests + 13 eval tests:

- **Evidence Integrity & Grounding (G1, G2, G3, G4, G9)**: Added `EVIDENCE_GROUNDING_MODE=strict` (default), polarity-guarded fuzzy quote verification (`0.7 * window + 0.3 * setOverlap`), `hard_fail` precedence over `fabricatedPass`, `_locationProvenance = 'company_site'` exclusion from `person_location` auto-pass, `urlHostSharesCompanyToken` press-URL rejection, and symmetrical bidirectional alias matching (`aliasIncludes`).
- **Retrieval Determinism & Planning (G5, G6, G7, G8, G10, G13, G16, G21, G22, G24)**: Added top-level `discoveryFamily`/`discoveryLane` persistence, cluster-keyed `historicalYield` (`domain_cluster|family|lane|provider`), `contract_guard` retention above `maxTasks+2`, seeded PRNG (`seedAdaptiveRandom`), non-reservation `queryRewriter` dispatch with `demotedRequirementId` and Tier-1 anchor protection, company-scoped `b2b_saas` contradiction checks, SQLite JSON `$.profile.location` saturation counting, derived persistence status (`success | partial_success | error`), 2-char pronoun-collision geo guards, plural-persona role matching, and city-only geo anchoring without vertical-equals-location collisions.
- **Intent, Learning & Persistence (G11, G12, G14, G15, G17, G20)**: Added `UNKNOWN_AGE_DAYS = 45` neutral undated freshness and abbreviated recency units (`2d`, `1w`, `3mo`, `1y`, `2h`), annotate-only post-intent enrichment, cross-session `discovered_companies` seeding into `planStage`, CRM workflow field preservation (`stage`, `reviewStatus`, `nextAction`, `notes` protected unless `forceOverwrite: true`), schema v23 `lead_outcomes` binary feedback (`REPLIED`, `KEEP`, `CONVERTED` vs `REJECT`, `LOST`) wired into `scoreAdaptiveArm` alongside `hard_failed_candidates` penalties, and the `npm run test:eval` golden-brief harness.

### 9.11 Industry-Agnostic Engine, Schema v24-v26, and Dual-Provider Concurrency — RESOLVED (2026-10-02, `129173a`)

Resolved across 50 files and verified across 976 unit & integration tests (176 suites) + 13 eval tests:

- **Industry-Agnostic Generalization**:
  - Removed agency and SaaS-specific prompt and pipeline hardcoding. Added `openIndustryClusters` in `adaptiveScheduler.ts` allowing arbitrary brief domains to form isolated MAB bandit learning scopes.
  - Added dynamic role title and business function extraction (`defaultRoles.ts`, `prospectContract.ts`) with strictly bounded term-synonym expansion.
  - Added universal ISO 3166-1 alpha-2 geographic resolution (`geo.ts`) via native ECMAScript `Intl.DisplayNames`, recognizing all 249 ISO countries without synthetic US anchor invention.
  - Scoped decision-maker authority weighting in `scoring.ts` to trigger only when the user's brief explicitly requests authority or executive leadership.
- **SQLite Schema v24–v26 Migrations**:
  - **Schema v24**: Added `lead_outcomes.scope_key` column and index for domain-cluster-scoped disposition attribution.
  - **Schema v25 & v26**: Added `candidate_verdicts` table (`identity_key`, `requirement_hash`, `evidence_hash`, `qualification_json`, `verdict`, `reason`, `failed_requirement_id`), enabling 0ms evaluation reuse across rounds when candidate evidence is unchanged.
  - Added persistent company taxonomy (`company_profiles`) and per-brief company attribution verdicts (`company_attribution_verdicts`).
  - Added cross-round query retrieval cache (`retrievalCache.ts` backed by `search_cache`).
- **Provider-Affinity Dual Concurrency & Atria Reasoning Headroom**:
  - Configured independent per-provider concurrency slots (`ATRIA_CONCURRENT_SLOTS=1`, `BYESU_CONCURRENT_SLOTS=1`).
  - In `withProviderFallback` (`server/services/llm.ts`), dispatches to Atria as the prioritized primary model when idle, and immediately overflows to Byesu concurrently when Atria is in-flight, achieving safe parallel dual-model concurrency without triggering 429 rate limits or 524 gateway timeouts.
  - Elevated `ATRIA_MAX_TIMEOUT_MS` to `600_000ms` (10 minutes) with a `120_000ms` floor and token-scaling coefficients (`computeAtriaDynamicTimeoutMs`), preventing reasoning aborts on deep chain-of-thought models.

## 10. Recommended next actions

Updated 2026-10-02.

1. ~~**Industry-Agnostic Engine generalization.**~~ Done — open industry clusters, universal ISO geo, dynamic role extraction, brief-gated authority.
2. ~~**Candidate & Company Attribution Persistence.**~~ Done — Schema v26 `candidate_verdicts`, `company_profiles`, `company_attribution_verdicts`.
3. ~~**Provider-Affinity Dual Concurrency & Atria Reasoning Timeouts.**~~ Done (`129173a`) — Atria 10m reasoning cap, dual 1-slot affinity routing.
4. ~~**Merge to main and branch cleanup.**~~ Done — fast-forward merged to `main`, pushed to `origin/main`, secondary branch deleted.
5. **Run a live production discovery session** to monitor real-time Atria vs. Byesu parallel dispatch in `search_logs.trace_events` under live network traffic.
