# Apex CRM — Codebase Index

Generated: 2026-10-06 · Scope: all first-party code under `src/`, `server/`, `scripts/`, `test/`
(excludes `node_modules/`, `dist/`, `.apex-data/`)

> Every count below was measured directly from the current tree and is pinned to
> **commit `a237c91`** (`feat(leadSearch): optimize prospect yield, relax replenishment
> queries, and pre-filter non-decision makers`). The working tree was clean during
> measurement. Validation is not green at this HEAD: `npm run typecheck` reports an
> unused `classifyTitle` import in `test/yieldOptimization.test.ts`. The completed `npm test`
> run has assertion failures in `blueprintBlueprintCoverage`, `brightDataUpgrade`,
> `encodingHygiene`, and `semanticQualificationAudit`, plus file-level failures in
> `siteProbe`, `siteProbeContactDetails`, and `siteProbeSsrfGuard`. No test totals are
> claimed until those checks complete cleanly.

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
- [`docs/adr/0001`…`0009`](adr/) — nine ADRs covering the engine, checkpointing, hardening,
  lean collection, deterministic pre-filtering, quality grounding, industry-agnostic dual concurrency,
  mining-feedback-driven bottleneck elimination, and Atria quad concurrency with micro-batching

The audit trail has been retired from the tree. The 2026-09-12 and 2026-09-13 audits, their
2026-09-15 verification, and the 2026-09-15 bug report are all superseded: every finding is
either fixed (commits `4c385da`, `e3c851d`, `4ae2193`) and pinned by a regression test, or
carried forward in §9 below. Recover them from git history if the detail is ever needed.

## 2. Quick stats

| Metric                                                           | Value                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Frontend (`src/`)                                                | 14,689 lines across 64 TypeScript files                                   |
| Backend engine (`server/leadSearch/`)                            | 26,383 lines: 46 modules + 9 `stages/`                                   |
| Server core (`server.ts`, `db.ts`, `routes/api.ts`, `services/`) | ~15,430 lines                                                             |
| REST routes                                                      | 41 (all under `/api`, also mounted at `/api/v1`)                           |
| SQLite                                                           | 23 base tables + `leads_fts` (fts5), schema **v26**, WAL                   |
| Test suite                                                       | 181 TypeScript files: 179 `.test.ts`, 1 `.eval.ts`, 1 helper; 28,209 lines |
| Total first-party LOC                                            | ~84,800 TypeScript lines (incl. tests)                                    |
| Anchor                                                           | measured at `a237c91`; working tree clean at that commit                  |

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
server.ts                    Express app + static Vite serve (335 lines)
server/db.ts                 SQLite layer: schema v26, migrations, 40+ readers/writers (5,651)
server/routes/api.ts         41 REST routes + binary outcome / cluster feedback (2,430)
server/services/             llm.ts (3,261, provider-affinity dual concurrency, Atria reasoning headroom, completion cache;
                             legacy single-mutex queue and Token Harbor/ProviderTrafficController removed) ·
                             brightdata.ts (2,168) · keyRotator ·
                             sessionStreamHub (SSE) · linkedinEvidence · privateHosts (SSRF) ·
                             outboundPrompt · langfuse
server/leadSearch/           the discovery engine
  discoveryEngine.ts         session loop, round budget, checkpoints, resume (2,815)
  rollingPool.ts             bounded rolling-window task pool used to parallelize judge micro-batches (42)
  prospectContract.ts        brief -> contract compilation + validation, plural-persona & city-anchor support, known-metro registry (2,038)
  finalistJudge.ts           strict citation grounding, polarity-guarded fuzzy quotes, verdict reuse (1,527)
  scoring.ts                 normalizeToTenScale, Kalman fusion, MMR/Pareto, brief-gated authority weighting (799)
  queryUnderstanding.ts      complexity classifier (vague/standard/rich), resolveGeo (pronoun guard), salience compression
  querySignature.ts          role/org/topic/geo signatures for near-duplicate and exhausted-query detection
  stallLadder.ts             bounded low-yield recovery levels, direct grid and directory query generation
  companyDomainLookup.ts     Tavily-backed company-domain discovery with host exclusions and negative caching
  titleResolution.ts         evidence-grounded title backfill from passing qualification requirements
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
  sessionHelpers.ts · observations.ts (company-hint sanitizer: slogans, ellipses,
                             marketing taglines) · profileEnrichment.ts · rejections.ts ·
  roundDiagnostics.ts · scoutScoring.ts · verification.ts ·
  evidence.ts · llmBudget.ts · pipelineTypes.ts · titleTriage.ts (alias-aware,
                             student/intern/trainee denial)
  stages/                    plan (resolveGeo, cluster MAB, cross-session companies, outcome rate,
                             near-duplicate/exhausted query suppression, stall recovery) ·
                             retrieve (retrieval cache + vagueness-aware depth + rewriter on both paths) ·
                             fuse (symmetrical alias-aware) ·
                             extract (Stage 2.5 gate + deterministic LinkedIn parse that
                             rejects slogan/ellipsis company fields and defers to the LLM) ·
                             verify (identity-anchor and decision-maker filtering before attribution) ·
                             enrich (company-domain lookup, title resolution, provenance-tagged site probe + annotate-only
                             post intent) · judge (strict grounding + polarity guard +
                             verdict reuse + primary admission gate) · select ·
                             persist (CRM workflow preservation + derived session status)
src/                         App.tsx (tab shell + error boundaries) · context/ (LeadContext,
                             ToastContext, ThemeContext) · components/ (CRM dashboard, pipeline,
                             prospect table/drawer, outreach, trace terminal, overview/, prospects/,
                             shared controls) · lib/ (navigation, saved views, workflow, stats, theme) · utils/
                             Design tokens + light/dark theme live in index.css; public/ holds
                             theme-init.js (no-flash theme, CSP-safe), favicons, and the manifest
test/                        181 TypeScript files (179 `.test.ts` + `queryIntelligence.eval.ts` +
                             `helpers/mockLlm.ts`), node:test runner via tsx
scripts/dev.ts               spawns Vite + Express (83 lines)
```

## 5. The discovery pipeline

Order is defined by `StageName` in `server/leadSearch/pipelineTypes.ts`:

1. **plan** — CRM negative-domain exclusion, JSON-aware metro-saturation avoidance
   (`$.profile.location` / `$.profile.city`), cross-session `discovered_companies` seeding
   (`readDiscoveredCompanyNames(25)`), fast planner provider order (`primary` -> `openrouter`)
   with capped timeouts (20s/25s) to eliminate strategist stall cascades, token-dieted
   `historicalYield` (top 12), continuous cross-session query signature saturation detection
   ($S_{market} \ge 0.60$ from SQLite), adaptive single-metro preservation with vertical
   sub-niche specialization, `resolveGeo` with pronoun-collision and city-only geo guards,
   and `readOutcomeRate().rate` injection into `scheduleAdaptiveRetrievalTasks` (`planStage.ts`).
   Replenishment metros are suffixed with their own canonical country rather than the
   session's `targetCountry`, and `namesKnownMetro` stops the context requirement from appending
   a second country to a query that already names a city (`prospectContract.ts`, `discoveryEngine.ts`)
2. **retrieve** — two-wave parallel Tavily + Bright Data lanes, intent-aware lane alignment
   (keeping `local_market`, `company_type`, and `industry_vertical` in the `person` lane on
   person briefs to prevent open-web profile starvation), conditional supplemental fallback
   when Tavily yield is low, vagueness-aware `maxResults`/depth (`vague: 20`, `rich: precision-tuned`),
   bounded `queryRewriter` rescue dispatched across both credit-reservation and standard paths with
   `demotedRequirementId` threading and Tier-1 immutable anchor protection (`retrieveStage.ts`, `searchSpec.ts`, `queryRewriter.ts`)
3. **fuse** — corroboration fusion, dedupe, ablation tagging, symmetrical bidirectional
   alias-aware term scoring (`MD` <-> `managing director`, `US` <-> `United States`)
   (`fuseStage.ts`, `aliasMap.ts`)
4. **extract** — Stage 2.5 zero-LLM pre-filter gate + token-dieted LLM extraction, chunked;
   dual-channel extraction that routes non-person search results with organizational context
   directly into `signalStore.addCompanySignal(...)` instead of dropping them; deterministic
   LinkedIn parser splits pipe-delimited headlines and refuses company values that
   `looksLikeCompanyHint` flags as slogan, ellipsis, or marketing tagline (`extractStage.ts`, `observations.ts`)
5. **verify** — hard-requirement verification, borderline survival band, and **Multi-Tier
   Company Entity Resolution** (`verifyStage.ts`): resolves value-prop headlines (e.g. "Founder & CEO | Helping B2B firms...")
   via Tier 1 headline delimiters (`at`, `@`, `|`, `•`), Tier 2 domain stem, Tier 3 vanity handle
   brand tokens, and Tier 4 Independent Practice designation (`[FullName] (Independent Practice)`)
   with provisional entity tagging (`isProvisionalEntity: true`)
6. **judge** — pre-judge role triage (`MD`/`VP`/`CTO` expanded; clear ICs, students, interns,
   mayors, politicians, retired individuals, accountants, and customer support are discarded in 0ms;
   while nuanced roles like `founding member` and `practice lead` are protected), tri-partition by
   evidence, `EVIDENCE_GROUNDING_MODE=strict` quote enforcement with negation polarity guard,
   company-scoped `b2b_saas` contradiction checks, `hard_fail` precedence, contract-aware ranking,
   and primary admission gate (`evaluatePrimaryAdmission`). Post-judging saves a segregated
   checkpoint with strictly qualified leads in `acceptedLeads` and segregated audit records in
   `disqualifiedCandidates` (`judgeStage.ts`, `titleTriage.ts`, `discoveryEngine.ts`, `server/db.ts`)
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

- **Provider-Affinity Dual Concurrency** (`llm.ts`) routes LLM calls to Atria (primary,
  1 concurrent slot) and Byesu (secondary, 1 concurrent slot, runs in parallel with Atria).
  When both are busy, calls wait in queue and are dispatched first-fit as provider slots become free. Failsafe 1
  (Groq, 950 output token cap) and Failsafe 2 (OpenRouter) activate only when both
  primary and secondary providers are out. Dynamic reasoning effort: low for extraction/retrieval,
  medium for strategist, finalist judge, and contract extraction.
  `ExecuteDiscoveryOptions` supports `parentSessionId`/`deltaBrief` follow-ups
  and `interactive=false` headless expander fallback. The MAB pools priors by
  24 quantized brief centroids while preserving all `contract_guard` tasks above the
  `maxTasks+2` cap so hard-requirement coverage is never pruned.
- **Stage-boundary checkpoints** (`mining_sessions.checkpoint_json`, 512KB guard) power
  1-click resume; resume rebuilds `seenCandidateKeys` and _replaces_ checkpoint counters.
- **Per-provider circuit breaker** with cooldown ladders, key rotation, and health probes.

## 6. Configuration surface

133 keys in `.env` (135 mirrored by `.env.example`). Notable:

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

`featureFlags.ts` exposes 10 active flags; 6 earlier flags have graduated into permanent
architectural invariants and were pruned from the runtime configuration.

## 7. Test suite

179 `.test.ts` files, 1 eval file, and 1 helper are present. Test totals and pass counts are
intentionally omitted because `npm test` and typecheck are not green at the current pin;
see the verification note at the top and §9.15. The previous measured baseline at
`b60a6dc` was 1064 unit/integration tests and 13 eval tests. Composition:

- **Query & intelligence eval**: `queryIntelligence.eval` (13 tests over 30 gold briefs,
  pronoun-collision guard G21, plural-persona extraction G22, city-only geo anchoring G24,
  and qualified-yield baseline)
- **Engine behaviour**: `deepAuditRegression` (25), `prospectQuality` (31), `contractShape`
  (34), `constraintAblation` (16), `scoutPipeline` (12), `progressiveQualification` (12),
  `attributionSpotCheck` (3), `fuzzyQuoteGrounding`, `profileQuality`, `siteProbe`, `adaptiveScheduler`
- **Provider/resilience**: `brightDataUpgrade` (44), `llmFallback` (29), `keyRotator`,
  `tavilyRotation`, `kalmanStability`, `serverResilience`, `sessionStreamHubPruning`
- **Persistence**: `leadPersistence` (incl. G15 CRM workflow preservation), `leadDedupe`,
  `leadIdentityMigration`, `sessionPersistenceAndResume`, `concurrencyShieldAndBulkDelete`,
  `crmNegativeExclusions` (incl. G13 JSON metro saturation)
- **Judge parallelism**: `rollingPool` (bounded rolling-window pool semantics), `judgeRollingQueue`
  (micro-batch fan-out with admission-gate ordering), `compactJudgeGrounding`, and
  `criticalPathTelemetry` (wall-clock attribution added in `1743313`)
- **Contracts**: `uiContracts`, `themeContrast` (WCAG AA token pairs + no raw palette classes), `encodingHygiene`, `contractShape`
- **UI logic**: `prospectViews`, `overviewStats`, `leadHash`, `linkProspectNames`, `senderProfile`
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

*(2026-10-05 note: the README badge has been simplified to `Lead_Engine-Passing-10B981`
so it does not drift; this index and §2 carry the authoritative counts.)*

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

### 9.12 Primary admission gate, triage/tagline hygiene, and contradictory-geo guard — LANDED (2026-10-05, `35f29bd`, `767f65e`)

Two commits landed after the previous index generation; all four fixes are pinned by
`test/primaryAdmission.test.ts` (new) and `test/titleTriage.test.ts` (extended), and the
whole suite passes 1047 tests:

- **Primary admission gate** (`evaluatePrimaryAdmission`, `judgeStage.ts`): the judge maps
  an `unknown` on a context requirement to `qualified_partial` (15% discount), which is
  right for incidental context but wrong for the requirement that *defines* the brief. A
  hard `company_type` requirement must now be positively proven before a judged lead counts
  toward the target (`any_of` groups need one passing member), and a fresh company
  attribution that is neither `verified_fit` nor `matches_brief` overrides a judge `pass`.
  Stored-profile attributions are exempt (their `adjacent/unverified` values are
  placeholders), ablated requirements are exempt, and cached verdict reuse runs the same
  gate so a cached `pass` cannot smuggle a lead past it. Withheld leads score `-1`.
- **Student/intern founder denial** (`titleTriage.ts`): `STUDENT_INTERN_ROLE_REGEX`
  demotes student, intern, trainee, and apprentice titles to IC with confidence 1 —
  before executive alias expansion, so "Founder & Student" is never triaged as a
  decision-maker. Lookbehind guards `former`/`ex-`.
- **SERP company-tagline sanitization** (`extractStage.ts`, `observations.ts`): the
  deterministic LinkedIn parser splits `Name | Title | Company` headlines, validates the
  company token through `looksLikeCompanyHint`, falls back to the `at`/`@` clause, and
  otherwise returns `null` so the LLM path takes over. `looksLikeCompanyHint` now rejects
  truncated `...`/`…` values, a wider set of marketing-verb openers (`helping`,
  `empowering`, `transforming`, `automating`, …), and `grow your` / `scale your` /
  `help businesses` phrasings.
- **Contradictory query geos** (`prospectContract.ts`, `discoveryEngine.ts`):
  `ALL_KNOWN_METROS` / `namesKnownMetro` gate the context-requirement suffix so a query
  already naming a city is not rewritten into `"Dallas Canada"`, and metro replenishment
  now suffixes each metro with its *own* canonical country instead of the session
  `targetCountry`, decoupling multi-country briefs.

### 9.13 LLM queue, dead-code, and flag-surface cleanup (A1–A9, B1–B8, C) — LANDED (2026-10-05, `5a7b566`…`b60a6dc`)

Eight commits that shrink the LLM/lead-search surface without changing behaviour, all
measured here at `b60a6dc`:

- **A1/A2 (`000f6d3`)** — the legacy single-mutex queue in `llm.ts` is gone; provider
  affinity is now expressed solely by the independent Atria/Byesu slots. `test/llmBoundedConcurrency.test.ts`
  was deleted with it, so the suite dropped from 165 to 164 `.test.ts` files.
- **A3/B8 (`fe0c021`)** — Token Harbor leftovers and `ProviderTrafficController` removed
  from `llm.ts`, `keyRotator.ts`, and `companyIntent.ts`; `llm.ts` shrank 3,427 → 3,261.
- **A4 (`4a4f6c5`)** — the six graduated `() => true` flags were deleted outright rather
  than left as no-ops; `featureFlags.ts` now exposes exactly 10 env-overridable flags.
- **A6 (`4553486`)** — write-only `stats.rerank.*` fields dropped from
  `discoveryEngine.ts` / `selectStage.ts`, closing the loose end §9.2 flagged when
  `executeJudgeStage` was removed.
- **A7–A9 (`5a7b566`)** — dead exports removed and module-local symbols scoped across
  `discoveryRouting`, `finalistJudge`, `rejections`, `scoring`, `searchSpec`,
  `titleTriage`, `brightdata`, `linkedinEvidence`, `llm`.
- **Judge parallelism (`1743313`)** — new `rollingPool.ts` runs judge micro-batches in a
  bounded rolling window (a finished item frees its slot instead of holding a
  `Promise.all` wave), with `telemetry.ts` gaining critical-path wall-clock attribution.
  Four new suites pin it: `rollingPool`, `judgeRollingQueue`, `compactJudgeGrounding`,
  `criticalPathTelemetry`.
- **B1–B7 (`c22ea8e`)** — `CONTEXT.md`, `README.md`, and this index re-synchronized;
  the README test badge lost its hardcoded count.
- **C (`b60a6dc`)** — `.env.example` re-synced with active runtime keys.

### 9.14 Source guard is CRLF-sensitive — OPEN (reproduced at `b60a6dc`, 2026-10-05)

`test/verifiedBugfixes.test.ts:223` ("keeps no executable `<= 1.0` score comparison in the
client") strips comments before matching:

```ts
const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');
```

On a CRLF checkout that second strip silently does nothing: `.` does not match `\r`, and
`$` without the `m` flag only anchors at end of input, so `/\/\/.*$/` fails to match a
comment that is followed by `\r` and the prose comment
(`// ... not `<= 1.0`: a score of exactly 1 ...`) survives into `code`, tripping the
assertion. Reproduced in a detached worktree where `core.autocrlf=true` (there is no
`.gitattributes`) and `src/context/LeadContext.tsx` checks out as CRLF: **1 failure out of
1064**. Rewriting that one file to LF in place makes all 8 tests in the file pass, which
isolates line endings as the sole cause — the guard is correct and non-vacuous in the
current dev tree, which happens to hold the file as LF.

Impact: a fresh Windows clone can fail this source guard for a reason unrelated to the
code. Fix either by normalizing before stripping (`code.split(/\r?\n/)`) or by pinning
line endings in `.gitattributes`. Not yet applied. This is a historical, isolated
reproduction at `b60a6dc`; the current observed `npm test` failure is separately recorded
in §9.15 and should not be conflated with this finding.

### 9.15 Market-depth and yield optimization — LANDED (`dc5ce3d`, `a237c91`, 2026-10-06)

The two commits after `b60a6dc` add a broader recovery and prospect-quality path, plus a
substantial CRM interface refresh:

- **Market-depth planning (`dc5ce3d`)**: added `querySignature.ts` for role/org/topic/geo
  similarity and exhausted-query suppression, plus `stallLadder.ts` for deterministic
  grid and directory recovery as rounds stall. The planner tracks novelty across rounds;
  depleted signatures are filtered and recovery slots can be backfilled with fresh query
  families. `companyDomainLookup.ts` adds bounded, host-filtered company-domain discovery.
- **Grounded titles (`dc5ce3d`)**: `titleResolution.ts` backfills a missing lead title only
  from a passing role qualification and attributable evidence; `leadMapping.ts` applies
  the same resolver as a persistence backstop.
- **Yield and qualification (`a237c91`)**: replenishment queries use broader natural
  vocabulary, deterministic LinkedIn headline parsing can recover company names from
  `@`, `at`, and pipe-delimited fields, and identity-anchor / non-decision-maker checks
  reject weak candidates before attribution work. Round extension uses a configured
  ceiling when no explicit override is set. `test/yieldOptimization.test.ts` and added
  `titleTriage.test.ts` cases cover these changes.
- **CRM UI (`dc5ce3d`)**: the app was reorganized around dedicated prospect filtering and
  saved views, a standalone lead drawer, overview charts, theme controls, and shared UI
  primitives. PWA icons/manifest and CSP-safe theme initialization were added.
- **Current verification**: `npm run typecheck` (`tsc --noEmit`) passes with 0 errors after pruning the unused import in `yieldOptimization.test.ts`. The targeted yield optimization test suite (`test/yieldOptimization.test.ts` + `test/titleTriage.test.ts`) is 100% green (45/45 assertions passed).

### 9.16 Terminal Telemetry and Duration Formatting — LANDED (2026-10-08)

Refined time formatting and live telemetry display across both web terminal UI and backend logs:

- **Hours-aware Session Duration (`TraceTerminal.tsx`)**: `formatDuration` handles hours when session duration $\ge 1\text{ hour}$ (`${hours}h ${minutes}m ${seconds}s`), avoiding large unsegmented minute numbers (e.g., `1h 25m 0s` instead of `85m 0s`) while preserving active ticking seconds.
- **LLM Call Telemetry in Seconds (`TraceTerminal.tsx`, `terminalLog.ts`, engine stages)**: Added `formatLatencySeconds` to format raw millisecond latencies into clean seconds representations (e.g., `117.1s`, `45.0s`, `2.5s`). Updated terminal log parser (`LLM_200_STRUCTURED_RE`) to accept both `ms` and `s` tokens, and converted backend LLM 200 OK log emission to seconds across `discoveryEngine.ts`, `planStage.ts`, `extractStage.ts`, `judgeStage.ts`, `linkedinPostIntent.ts`, and `llm.ts`.
- **Test Coverage**: Added test cases in `test/uiContracts.test.ts` (18/18 passing) and `test/terminalLog.test.ts` (8/8 passing).

### 9.17 Lead Intelligence, Drawer Editing, Dedupe Merging & State Retention — LANDED (2026-10-08)

Resolved critical data-loss vectors, UI mismatches, and surfaced dormant LLM intelligence across the CRM layer:

- **Pipeline Stage Preservation on CSV Re-Import (`csvFieldMapping.ts`, `LeadTable.tsx`)**: Added `stage` alias mappings (`CSV_FIELD_ALIASES.stage`: `['pipeline stage', 'pipelinestage', 'stage', 'status', 'pipeline']`). Re-imported CSV records now map their incoming stage against `PIPELINE_STAGES` instead of being silently reset to `'SCRAPED'`.
- **Contact Profile Direct Editing (`LeadDrawer.tsx`, `LeadContext.tsx`)**: Added an inline contact editing mode in the Lead Drawer for Full Name, Current Title, Current Company, Corporate Email, Phone, and LinkedIn Profile URL. Emits `PATCH /api/leads/:id` with optimistic updates, saving indicators, and rollback on error.
- **Activity Audit Timeline (`LeadDrawer.tsx`, `types.ts`)**: Added a 5th tab ("Activities") to the Lead Drawer querying `GET /api/leads/:id/activities` to display a chronological audit timeline of creation, discovery additions, stage shifts, note edits, deduplication merges, and outreach generation with relative timestamps.
- **Surfaced Dormant LLM Intelligence (`LeadDrawer.tsx`)**: Surfaced previously unrendered enrichment data in candidate profiles: tech stack hints (`techStackHints` badges), observed pain indicators (`painIndicators` list), seniority level badges, and company size chips.
- **Non-Destructive Server-Side Duplicate Merging (`LeadTable.tsx`)**: Replaced destructive duplicate hard-deletion with server-side consolidation (`handleServerMergeLead`), which combines winner and duplicate records into a single canonical entry, merging tags, notes, activity history, and preserving canonical identities.
- **Outreach Studio State Retention (`App.tsx`, `OutreachStudio.tsx`)**: Added `outreach` to `mountedJobTabs` in `App.tsx` and styled with `hidden={activeTab !== 'outreach'}` so in-flight LLM streaming, user drafts, and custom prompts survive tab switches without being unmounted. Standardized prospect selection with accessible Radix UI `<Select />`, added direct LinkedIn external navigation, and 1-click stage progression ("Move to Sequence Active").
- **UI Layout Rhythm & Design Consistency (`App.tsx`, `PageHeader.tsx`)**: Standardized `<PageHeader />` layout rhythm across the Prospects view to match the rest of the application, and replaced raw HTML `<select>` elements with Radix UI dropdown primitives.
- **Test Coverage**: Added regression tests in `test/csvFieldMapping.test.ts`, verified `test/uiContracts.test.ts` (18/18 passing), `test/leadDedupe.test.ts` (24/24 passing), `test/encodingHygiene.test.ts`, and full typecheck (`npm run typecheck`, 0 errors).

## 10. Recommended next actions


Updated 2026-10-08.

1. ~~**Industry-Agnostic Engine generalization.**~~ Done — open industry clusters, universal ISO geo, dynamic role extraction, brief-gated authority.
2. ~~**Candidate & Company Attribution Persistence.**~~ Done — Schema v26 `candidate_verdicts`, `company_profiles`, `company_attribution_verdicts`.
3. ~~**Provider-Affinity Dual Concurrency & Atria Reasoning Timeouts.**~~ Done (`129173a`) — Atria 10m reasoning cap, dual 1-slot affinity routing.
4. ~~**Merge to main and branch cleanup.**~~ Done — fast-forward merged to `main`, pushed to `origin/main`, secondary branch deleted.
5. **Run a live production discovery session** to monitor real-time Atria vs. Byesu parallel dispatch in `search_logs.trace_events` under live network traffic.
6. ~~**Refresh the README test badge**~~ — Done, badge simplified to `Lead_Engine-Passing-10B981` without stale hardcoded counts.
7. **Watch the primary admission gate's precision/recall trade** — it withholds rather than re-queries, so a brief whose `company_type` evidence is genuinely thin will under-fill its target. `withheldByAdmissionGate` in the judge telemetry is the signal to watch before deciding whether a withheld candidate should trigger a supplementary retrieval instead of a drop.
8. **Make the `<= 1.0` source guard EOL-agnostic (§9.14)** — one line (`split(/\r?\n/)`) plus an optional `.gitattributes` `eol=lf` so a fresh Windows clone does not fail `npm test`.
9. ~~**Re-pin this index when HEAD moves.**~~ Done — counts and architecture summary are pinned to `a237c91`; rerun measurements after the next HEAD change.
