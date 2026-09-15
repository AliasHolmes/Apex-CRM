# Apex CRM — Codebase Index

Generated: 2026-09-16 · Scope: all first-party code under `src/`, `server/`, `scripts/`, `test/`
(excludes `node_modules/`, `dist/`, `.venv-litellm/`, `.apex-data/`)

> Supersedes the 2026-09-12 index (now `CODEBASE_INDEX-2026-09-12.md`), which had drifted on
> schema version, route count, and test counts. Verified values below were measured directly
> from the tree, not inherited.

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
- [`docs/adr/0001`…`0006`](adr/) — six ADRs covering the engine, checkpointing, hardening,
  lean collection, deterministic pre-filtering, and prospect-quality grounding
- [`docs/BUG-REPORT-2026-09-15.md`](BUG-REPORT-2026-09-15.md) — most recent deep bug pass
  (7 findings, 6 fixed, pinned by `test/deepAuditRegression.test.ts`)
- [`docs/AUDIT-VERIFICATION-2026-09-15.md`](AUDIT-VERIFICATION-2026-09-15.md) — verification
  of commit `4c385da` plus the last production session's performance baseline

## 2. Quick stats

| Metric                                                           | Value                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Frontend (`src/`)                                                | ~11,587 lines across 35 files                                              |
| Backend engine (`server/leadSearch/`)                            | ~18,577 lines: 33 modules + 9 `stages/`                                    |
| Server core (`server.ts`, `db.ts`, `routes/api.ts`, `services/`) | ~12,221 lines                                                              |
| REST routes                                                      | 41 (all under `/api`, also mounted at `/api/v1`)                           |
| SQLite                                                           | 18 base tables + `leads_fts` (fts5) + `leads_fts_map`, schema **v21**, WAL |
| Test suite                                                       | 94 files, 674 tests / 149 suites, all passing                              |
| Total first-party LOC                                            | ~60,100                                                                    |
| Working tree                                                     | 13 modified files + 3 untracked (uncommitted)                              |

## 3. Tech stack

- **Frontend**: React 19 · Vite · Tailwind CSS 4 · Radix UI · Motion · Lucide ·
  `@tanstack/react-table` + `react-virtual` · TypeScript
- **Backend**: Express 5 · `node:sqlite` (schema-versioned, migrated in-transaction with
  pre-migration backups pruned to 3) · TypeScript, run by `tsx`
- **Retrieval/LLM**: Tavily (search + extract), Bright Data MCP (scrape/search),
  OpenAI-compatible LLM via Byesu `gpt-5.5` primary with Mistral/OpenRouter/Groq fallback
  chain, optional LiteLLM gateway in front, Langfuse telemetry
- **Discipline**: `tsc --noEmit` under `strict`, `noImplicitAny`, `noUnusedLocals`,
  `noUnusedParameters`; `prebuild` gates on typecheck; strict ASCII enforced by
  `test/encodingHygiene.test.ts`

## 4. Repository layout

```
server.ts                    Express app + static Vite serve (326 lines)
server/db.ts                 SQLite layer: schema v21, migrations, 40+ readers/writers (4,277)
server/routes/api.ts         41 REST routes (2,068)
server/services/             llm.ts (2,211) · brightdata.ts (1,917) · keyRotator ·
                             sessionStreamHub (SSE) · linkedinEvidence · privateHosts (SSRF) ·
                             outboundPrompt · langfuse
server/leadSearch/           the discovery engine
  discoveryEngine.ts         session loop, round budget, checkpoints, resume (2,441)
  prospectContract.ts        brief -> contract compilation + validation (1,563)
  finalistJudge.ts           tri-partition, contradiction checks, score normalization (1,136)
  scoring.ts                 normalizeToTenScale, Kalman fusion, MMR/Pareto (641)
  searchSpec.ts · strategist.ts · adaptiveScheduler.ts (MAB) · collectionCapacity.ts ·
  constraintAblation.ts · evidenceSelection.ts · intentEnrichment.ts · companyIntent.ts ·
  linkedinPostIntent.ts · siteProbe.ts · signalStore.ts · telemetry.ts ·
  featureFlags.ts · freeTier.ts · discoveryRouting.ts · leadMapping.ts ·
  sessionHelpers.ts · observations.ts · profileEnrichment.ts · rejections.ts ·
  roundDiagnostics.ts · scoutScoring.ts · targetFulfillment.ts · verification.ts ·
  evidence.ts · llmBudget.ts · pipelineTypes.ts
  stages/                    plan · retrieve · fuse · extract · verify · enrich · judge · select · persist
src/                         App.tsx (tab shell + error boundaries) · context/ (LeadContext,
                             ToastContext) · components/ (10 feature + 10 ui) · lib/ · utils/
test/                        94 files, node:test runner via tsx
scripts/dev.ts               spawns Vite + Express (+ optional LiteLLM child process)
```

## 5. The discovery pipeline

Order is defined by `StageName` in `server/leadSearch/pipelineTypes.ts`:

1. **plan** — CRM negative-domain exclusion, metro-saturation avoidance, strategist query
   generation (`planStage.ts`)
2. **retrieve** — two-wave parallel Tavily + Bright Data lanes, conditional supplemental
   fallback when Tavily yield is low (`retrieveStage.ts`)
3. **fuse** — corroboration fusion, dedupe, ablation tagging (`fuseStage.ts`)
4. **extract** — token-dieted LLM extraction, chunked (`extractStage.ts`)
5. **verify** — hard-requirement verification, borderline survival band (`verifyStage.ts`)
6. **enrich** — consolidated site probing + TF-IDF company intent + LinkedIn post intent,
   runs **after** selection (`enrichStage.ts`)
7. **judge** — pre-judge deterministic role triage, tri-partition by evidence, bounded
   micro-batch LLM judging (`judgeStage.ts`)
8. **select** — Pareto skyline + MMR diversification (`selectStage.ts`)
9. **persist** — identity-keyed upserts, FTS maintenance, exclude-list append (`persistStage.ts`)

Cross-cutting invariants:

- **`withSequentialLLMExecution`** (`llm.ts:357`) serializes every LLM call through one
  queue to prevent provider 429/524 collisions.
- **Stage-boundary checkpoints** (`mining_sessions.checkpoint_json`, 512KB guard) power
  1-click resume; resume rebuilds `seenCandidateKeys` and _replaces_ checkpoint counters.
- **Per-provider circuit breaker** with cooldown ladders and key rotation.

## 6. Configuration surface

138 keys in `.env` (mirrored by `.env.example`). Notable:

- `LEAD_SEARCH_MAX_ROUNDS` (`.env` = `"6"`) — authoritative round budget; the in-loop
  extension ceiling now defers to it when set (was hard-coded 10, which is how a run
  configured for 6 reached 10).
- `LLM_MAX_RETRIES=0` is now honoured; a 429 falls through immediately with a 5s cooldown.
- `BRIGHTDATA_SCRAPE_BATCH_MAX_URLS` clamped 1–20 (default 10).
- `LEAD_SEARCH_TIMEOUT_MS=0` disables the 15-minute safety timeout.
- `server/configValidation.ts` emits non-fatal boot warnings for misconfigurations.

`featureFlags.ts` exposes 15 env-overridable flags; **6 are marked `@deprecated` as
"graduated into standard architecture"** but remain overridable (see §9.6).

## 7. Test suite

94 files / 674 tests, `npm run test:all` (~6 min). Composition:

- **Engine behaviour**: `deepAuditRegression` (25), `prospectQuality` (31), `contractShape`
  (34), `constraintAblation` (16), `scoutPipeline` (12), `progressiveQualification` (12)
- **Provider/resilience**: `brightDataUpgrade` (44), `llmFallback` (32), `keyRotator`,
  `tavilyRotation`, `kalmanStability`, `serverResilience`, `sessionStreamHubPruning`
- **Persistence**: `leadPersistence`, `leadDedupe`, `leadIdentityMigration`,
  `sessionPersistenceAndResume`, `concurrencyShieldAndBulkDelete`
- **Contracts**: `uiContracts` (16), `encodingHygiene`, `contractShape`
- Curated subsets are wired as named `npm run test:*` scripts.

## 8. Assessment — what is strong

- **Verification discipline is real.** Every recent fix is pinned by a named regression
  test, and `deepAuditRegression.test.ts` was explicitly checked for non-vacuousness
  (reverting finding 1 makes exactly the 2 ranking assertions fail).
- **The audit loop closed correctly.** `AUDIT-VERIFICATION-2026-09-15.md` classified 23
  findings as 18 fixed / 3 partial / 2 not fixed; the two "not fixed" items were then
  picked up as findings 3 and 4 of `BUG-REPORT-2026-09-15.md` and fixed.
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
of the incorrect "2-4 rounds". The README badge now reads `674_Tests_Passing`, matching the
measured suite. Generating the badge from the test run remains an option but it is no longer
wrong.

### 9.2 `executeJudgeStage` is dead code with a live duplicate (medium)

`server/leadSearch/stages/judgeStage.ts:115` exports `executeJudgeStage`, but
`discoveryEngine.ts` only calls `evaluateIncrementalJudgeBatches`. The dead function's
body (lines ~180–230) duplicates `filterNonDecisionMakers` and the `judgmentInsight` /
`qualification` assignment verbatim from the live path (lines ~843–880). It survives only
because two tests import it. This is the exact failure mode the 2026-09-13 audit was
written about: a second copy of triage logic that can drift while the live copy is fixed.

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

### 9.4 No LLM completion cache (medium — the real bottleneck)

`llm.ts` contains no memoization or completion cache of any kind. The last measured
session spent **79% of wall clock in LLM latency**, with `extraction` at 37.8s per call
and the strategist repeating substantially across rounds. Both audit documents recommend a
completion cache before any further prompt dieting. This is the highest-leverage
unaddressed performance item.

### 9.5 Uncommitted work (low, but blocking)

13 modified files + 3 untracked files are not committed, including the entire
`deepAuditRegression` suite and both 2026-09-15 docs. The fixes are verified by tests but
have no commit, so a `git stash` or accidental reset loses them.

### 9.6 Flag surface that no longer means anything (low)

Six of the fifteen `featureFlags.ts` entries are annotated `@deprecated Graduated into
standard architecture; active unconditionally`, yet each still reads an env var that can
turn it off. An operator who sets `DISTRIBUTED_QUERY_ENFORCEMENT_ENABLED=0` gets a
silently degraded engine against the documented architecture. Either remove the switches
or document them as unsupported.

### 9.7 Test isolation hazard (low)

`test/llmUntrustedMessage.test.ts` does
`for (const key of Object.keys(process.env)) delete process.env[key]` in `beforeEach`,
restoring in `afterEach`. `node:test` runs files concurrently, so while this file runs the
process environment is empty for any concurrently-executing test in another file that
reads `process.env` at call time. It passes today because of scheduling luck and because
most other files snapshot env at import. Prefer deleting only the keys the file sets.

### 9.8 Carried-forward audit leftovers (low)

- `api.ts:349` still writes `runs: 0` on the single-lead verification path, which decays
  the query-run history that audit finding 1.6 only just started accumulating.
- `prospectContract.ts:1113` still _drops_ ungrounded hard requirements after warning;
  no counter reaches the session report, so visibility is console-only.

## 10. Recommended next actions

Updated 2026-09-16. Items 1, 2 and 4 below are done; the rest stand.

1. ~~**Commit the working tree.**~~ Done (`e3c851d`), along with the Atria provider work
   (`172fb00`) and its TPS assessment (`4de56b5`).
2. ~~**Fix `LeadContext.tsx:589`** to `< 1.0`.~~ Done — see §9.3.
3. **Delete `executeJudgeStage`** and migrate its two test callers to
   `evaluateIncrementalJudgeBatches`, removing the duplicate triage block. Still the
   clearest remaining correctness risk: a second copy of triage logic that can drift while
   the live copy is fixed.
4. ~~**Correct `CONTEXT.md:50`** and fix the README badge.~~ Done — see §9.1.
5. **Add an LLM completion cache** keyed on provider+model+prompt hash, behind a flag, with
   a TTL — this targets the 79% of wall clock that every other optimization has left
   untouched.
6. **Run one session and re-measure** against the 2026-09-13 baseline (1.2% yield,
   39.8% LLM failure rate, 79% LLM latency share). Still no session has run since the fixes.
