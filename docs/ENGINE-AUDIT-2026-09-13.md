# Apex CRM — Prospect Collection Engine Audit

Date: 2026-09-13 (revision 2)
Scope: the prospect **collection** engine — brief → retrieval → extraction → verification →
enrichment → judging → selection → persistence. Outreach, sequences, replies and
conversion are out of scope by prior direction.

Method: seven parallel code-reading passes across the engine, frontend, and test suite
(~28k lines), followed by direct verification of every high-severity claim by reading the
cited lines.

**Evidence markers:**
- **[verified]** — I read the code and confirmed the claim.
- **[reported]** — surfaced by a review pass; plausible, not independently confirmed.

Excluded as known: the ADR-0001→0005 mechanisms themselves, and the 17 findings in
`AUDIT-2026-09-12.md`.

---

## Executive summary

Three things dominate this revision:

1. **Roughly half the engine's advertised intelligence is not executing.** Four documented
   capabilities — pre-judge role triage, pre-judge context grounding, speculative stage
   overlap, and targeted post-selection enrichment — are dead, misordered, or never
   invoked. This is not a performance problem; it means the system is not the system the
   docs describe.
2. **The toolchain cannot detect any of it.** `tsconfig.json` has no `strict`,
   `noUnusedLocals`, or `noUnusedParameters`, so `npm run lint` reports zero diagnostics on
   a codebase with dead imports and dead exports. `npm test` strips types rather than
   checking them, and the 93-file suite contains no end-to-end wiring test. Every defect
   below is invisible to the current gates.
3. **Ranking is not comparable across candidates.** Intent scores depend on scrape order,
   judge scores depend on batch composition, and the judge's own hard-fail verdict is never
   persisted. The final ordering is therefore not reproducible.

---

## Part 1 — Dead and misordered capabilities

### 1.1 Pre-judge role triage does not run [verified]

`judgeStage.ts:141-196` implements `NON_DECISION_MAKER_REGEX` triage (drops intern / staff
engineer / ML engineer / data scientist / recruiter / account executive in 0ms). It lives
only inside `executeJudgeStage` (`:58`).

`executeJudgeStage` is imported at `discoveryEngine.ts:174` and **never called** — the
engine only calls `evaluateIncrementalJudgeBatches` (`:1917`, `:2224`). Documented in
README §10 and ADR-0005 §4. It is not executing.

### 1.2 Pre-judge context grounding does not run [verified]

`groundCandidateWithSiteProbe` (`siteProbe.ts:567`) is imported at `judgeStage.ts:24` and
has **zero call sites** anywhere in `server/`, `src/`, `test/`, or `scripts/` — not even
inside the dead `executeJudgeStage`. The ~250ms site probe described in README §10 and
ADR-0005 §3 never fires.

### 1.3 "Speculative stage overlap" does not exist [reported]

README §2 claims the strategist pre-computes round N+1 queries in the background while
round N extracts. `discoveryEngine.ts:1352` awaits `executePlanStage` inline, once per
round, with no prefetch or background path. `planningGeneration` is incremented
(`:1265`, `:1351`, `:1980`) but never compared, so the "generation guard" guards nothing.

### 1.4 Enrichment runs *before* Pareto, not after [verified]

README §9 and ADR-0004 §3 claim heavy Phase 4 (company site) and Phase 5 (LinkedIn post)
enrichment is deferred until *after* finalist judging **and Pareto diversification**, to
avoid wasted work. Actual order in `selectStage.ts`: Phase 4 (`:57-101`) → Phase 5
(`:103-122`) → `selectDiversifiedLeads` (`:124-125`).

Enrichment therefore runs on the full qualified cushion pool (target × 1.15–1.35) before
diversification trims to the target. The claimed saving is not being realized, and the
enrichment cost is paid on candidates that are then discarded.

### 1.5 Deep profile enrichment may never run [verified]

`discoveryEngine.ts:947-948` defaults `BRIGHTDATA_PROFILE_ENRICHMENT_STAGE` to
`"on_demand"`. `stages/enrichStage.ts:141` only branches on `=== "post_filter"`. A
repo-wide grep for `on_demand` finds only the default, a comment, and a UI value
(`ScrapeWorkspace.tsx:843`) — there is no handler.

Unless the env var is explicitly set to `post_filter`, the entire block at
`enrichStage.ts:141-865` (batched cache lookups, `scrapeBatchAsMarkdown`, retry queue, site
probe) is unreachable. Either the default is wrong or the branch is dead.

### 1.6 Cross-session yield history is permanently empty [verified]

`runs` is passed as `0` at both call sites (`stages/selectStage.ts:149`, `routes/api.ts:473`).
`db.ts:3269` computes `runs = ROUND(runs * 0.95 + excluded.runs)`, so it stays `0` forever.
`searchSpec.ts:668` then filters `entry.runs > 0`, dropping every row.

The strategist prompt's "historical family/provider yield" line is always `"no history
yet"`. Note the bandit itself still works — it reads `outcome_runs`, which *is* incremented
(`selectStage.ts:150`). It is the prompt-level history that is dead. The correct fix is to
pass `runs: 1` from the retrieval lane, not the select stage.

---

## Part 2 — Silent quality defects

### 2.1 TF-IDF intent scores depend on scrape order [verified]

`SignalCorpus` documents (`companyIntent.ts:18-21`): *"Call computeWeight() after all
companies have been registered."* The code does the opposite — `registerOccurrences()` at
`:243-244` then `computeWeight()` at `:256-258`, both inside the per-company scrape.

Company #1 scores with `totalDocs = 1`, company #20 with `totalDocs = 20`. IDF shrinks as
the session progresses, so **early candidates get systematically inflated intent scores**.
This propagates into `scoring.ts` and the Pareto objective vector, making cross-candidate
and cross-round ranking invalid. Fix: two passes — register all, then score all.

### 2.2 `normalizeScoreTo10` maps a valid score of `1` to `10` [verified]

`finalistJudge.ts:61-68`:
```ts
if (num <= 1.0 && num > 0)
  return Math.min(10, Math.max(0, Number((num * 10).toFixed(2))));
```
The schema and prompt mandate a 1–10 scale, so a model rating the weakest possible match
(`1`) is read as a 0–1 probability and promoted to `10`. `authorityFit = 1 → 10` then
clears the `stronglyRatedIdentity` gate at `:551`. **The worst-rated candidate can qualify.**

### 2.3 Malformed judgments silently default to a pass [reported]

`coerceParsed` (`llm.ts:1636-1644`) validates only that top-level `judgments` is an array.
`validateFinalistJudgments` (`finalistJudge.ts:440-452`) counts a judgment valid if
`requirements` is merely an array, then defaults missing scores to `7` (`:532-537`). A
judgment with `requirements: []` and no scores satisfies `identityVerified` when
`identityHardTotal === 0`, and clears `stronglyRatedIdentity` at 7 ≥ 6.5 — producing
`qualified` on no evidence. It also inflates `validJudgmentCount`, suppressing split-retry.

### 2.4 The citation guard is one-directional [verified]

`finalistJudge.ts:341-345`:
```ts
if (status !== 'pass' || !evidenceQuote) { quoteValid = true; }
```
A `pass` with **no quote** is accepted unconditionally, so the fabrication check only fires
when the model volunteers a quote — and the system prompt (`:155`) discourages quoting. The
guard is opt-in by the thing it is guarding.

*Correction to an earlier pass:* this code does **not** convert `fail` verdicts to
`unknown`. Any non-`pass` status sets `quoteValid = true` and is preserved. Only a `pass`
whose supplied quote fails to ground becomes `unknown`. The asymmetry is the real defect.

### 2.5 The judge's hard-fail verdict is never persisted [verified]

The live `evaluateIncrementalJudgeBatches` returns `judgmentInsights` as a `Map`
(`judgeStage.ts:797`, `:1140`) but never assigns `lead.judgmentInsight`. The only assignment
is at `judgeStage.ts:683` — inside the dead `executeJudgeStage`.

Three consumers read that field and are therefore inert: `discoveryEngine.ts:2262`,
`roundDiagnostics.ts:157`, `selectStage.ts:59`. All three are `judgmentInsight?.status ===
"hard_fail"` filters, so LLM-hard-failed candidates are not being excluded, and the
zero-yield safety net can rescue them.

### 2.6 Hard requirements silently dropped at compile time [verified]

`prospectContract.ts:1114`:
```ts
if (importance === 'hard' && !sourceAppearsInBrief(sourcePhrase, brief)) continue;
```
Any hard requirement whose `sourcePhrase` is not a literal substring of the brief is
discarded with no log and no counter. Same filter at `:166` and `:562`. Defensible as an
anti-hallucination guard, but a paraphrased requirement is silently lost rather than
re-derived — add a counter and surface dropped constraints in the session report.

### 2.7 Location requirement auto-passes from the search query [verified]

`evidenceSelection.ts:79-84`: when `lead.location` and `profile.location` are both absent,
`person_location` falls back to `lead._sourceQuery || lead.evidence?.sourceQuery`. Any
candidate returned by a query containing "New York" passes the location requirement
regardless of where they actually are. Should be flagged unverified, not auto-passed.

### 2.8 Query ablation is undone by the judge [reported]

`constraintAblation.ts` + `retrieveStage.ts:190` relax a hard term to widen recall, but
`finalistJudge.ts:194-200` sends *all* hard requirements and `:560` hard-fails on any
`fail`. `_ablatedRequirementId` only blocks auto-pass (`:720`, `:997`). Candidates rescued
by ablation are re-rejected on exactly the relaxed requirement.

### 2.9 Site-probe enrichment cache never hits [verified]

`siteProbe.ts:556` writes `normalizedUrl: sourceUrl` (full URL, e.g. `https://acme.com/about`).
`:585` reads `normalizedUrl: host` (bare hostname, e.g. `acme.com`). `normalizeCacheValue`
(`db.ts:2212`) only trims and lowercases — no scheme or `www.` stripping. The keys never
match, so every company is re-fetched every session. (Moot while 1.2 stands, but it will
bite the moment that feature is re-enabled.)

---

## Part 3 — Judge and verification internals [reported unless marked]

| # | Finding | Location | Severity |
|---|---|---|---|
| 3.1 | A thrown judge call mass-promotes the unjudged batch to `qualified_partial` with a score floor of 60. The floor is deliberate (comment at `:830-845`), but the effect is that a provider outage converts never-evaluated candidates into qualified ones | `judgeStage.ts:1040-1109`, `:830-876` | High |
| 3.2 | Status matching is exact and case-sensitive: `"Pass"`, `"FAIL"`, `"qualified"` all collapse to `unknown` — a fail becomes a false rejection, an identity pass is lost | `finalistJudge.ts:333-334` | Med |
| 3.3 | Evidence truncation slices each item to 500 chars **after** term-matching, so the decisive sentence can be cut when it sits past char 500 of the joined text | `finalistJudge.ts:229`, `evidenceSelection.ts:237` | Med |
| 3.4 | Certainty is not comparable across paths: the deterministic path uses `evidenceCoverageScore` on a raw 0–10 scale with no ×10 (`:743-747`, `:1070-1074`), the LLM path uses `normalizeScoreTo10`. Both feed the same 0.25 weight (`:586-591`) | `finalistJudge.ts` | Med |
| 3.5 | `FINALIST_JUDGE_CONCURRENCY` is inert on the live path — batches are awaited sequentially (`:1113-1122`); the value only changes wave grouping | `judgeStage.ts` | Med |
| 3.6 | The same text appears twice per prompt: `:232` reprints Name/Title/Company/Location already in `e0`; `sourceEvidencePieces` is called twice (`:165` vs `:171`) | `finalistJudge.ts` | Med |
| 3.7 | `evidenceSelection.ts` returns `budgetChars`, `totalChars`, `coveredHardRequirementIds` — no production consumer (tests only). Budgets `650/850/1100/1400` are hardcoded while `MAX_EVIDENCE_ITEMS`/`EVIDENCE_CHARS` are env-tunable | `evidenceSelection.ts:6-8`, `finalistJudge.ts:177-188` | Med |
| 3.8 | Fuzzy `company_type` match bypasses the judge: `[acceptableTerms[0]]` is returned when only a domain stem plus a client-service word co-occur, and `hasStrictStructuredMatch` then auto-passes | `evidenceSelection.ts:27-50`, `:96-107` | Med |
| 3.9 | `selectDiversifiedLeads` re-normalizes via `normalizeScorePool`, so a lead's final score depends on pool composition; MMR/sort ties fall back to array order | `scoutScoring.ts:129`, `scoring.ts:283` | Low |
| 3.10 | Docstring says `semantic≥7 / authority≥8`; code uses 6.5 / 7.5. Concurrency clamps differ (2 at `:589` vs 4 at `:814`) | `finalistJudge.ts:379-380`, `:551` | Low |
| 3.11 | `state.debugLogs` is pushed with no cap (`extractStage.ts:746`, `planStage.ts:233,296,384`), truncated only at checkpoint (`discoveryEngine.ts:2016`) | — | Low |

### Evidence window defaults are wrong in the docs [verified]

`finalistJudge.ts:177-188` sets `MAX_EVIDENCE_ITEMS` default **3** (range 1–8) and
`EVIDENCE_CHARS` default **500** (range 200–1600). ADR-0003 §4 claims 5 items / 800 chars.

---

## Part 4 — Wasted spend and latency

### 4.1 Tavily search/extract has no internal timeout [verified]

`llm.ts:1243` (search) and `:1314` (extract) call `fetch(..., { signal: options.signal })`
with no `AbortController` of their own. Callers passing no signal (`routes/api.ts:887`) can
hang indefinitely. No backoff between rotated keys either (`keyRotator.ts:333-374` rotates
immediately). Fix: reuse the composite-signal pattern already present at `llm.ts:399-421`.

### 4.2 `LLM_MAX_RETRIES=0` is silently ignored [verified]

`llm.ts:380-383`: `effectiveMaxRetries = retry429 ? Math.max(maxRetries, 2) : maxRetries`.
With the shipped `.env` (`LLM_MAX_RETRIES=0`, `LLM_RETRY_429=true`) every 429 retries twice
(1.5s + 3s) — and **the sleep runs inside `withSequentialLLMExecution`**, stalling every
other LLM call in the session.

### 4.3 Provider cooldown never applies [verified]

`llm.ts:836-840`: cooldown is `0` when `LLM_MAX_RETRIES === "0"`, which the shipped `.env`
sets. A 429/524/timeout provider is never cooled and is retried first on every subsequent
call. The log at `:844` still claims a cooldown was applied.

### 4.4 Bright Data failure cooldown clamped to 5s [verified]

`brightdata.ts:284-291`: `cooldownMsForFailure()` returns `Math.min(planned, failureCooldownMs())`
and `failureCooldownMs()` (`:216`) is `BRIGHTDATA_FAILURE_COOLDOWN_MS || 5000`. The
escalation ladder is clamped to 5s always — `consecutiveFailures` escalation is inert.

### 4.5 Other spend and latency items [reported]

- `brightdata.ts:770-775` — `probeBrightDataRecovery()` issues a **real paid** SERP query
  for `"example"`, and the 10s race timer is never cleared. Called at `discoveryEngine.ts:1293`.
- `brightdata.ts:1751-1753` — mandatory 500–1200ms jitter before every search.
- No completion cache exists anywhere (grep: 0 hits). Identical strategist/extract prompts
  are re-billed; the parse-failure retry (`llm.ts:1727-1746`) resends the full evidence
  prompt when only parsing failed.
- `llm.ts:1256`, `:1332` — `include_usage: true` requested and never read; `raw_content`
  (`TAVILY_INCLUDE_RAW_CONTENT=true`) paid for but usually discarded (`:1286` prefers `content`).
- `db.ts:2254-2293`, `:2618-2641` — `(? != '' AND normalized_url = ?) OR (...)` defeats
  `idx_enrichment_cache_url`/`_username` → full scan of the largest table per lookup.
- `enrichStage.ts:616,719` — concurrency hardcoded `3`/`2` while `profileConcurrency` is
  destructured (`:106`) and never used. Same pattern for `COMPANY_INTENT_CONCURRENCY`
  (`discoveryEngine.ts:939-942` → hardcoded `1` at `:2330`; `selectStage.ts:67` overwrites
  with `1`).
- `roundCandidateKeys` is never folded into `seenCandidateKeys` (`fuseStage.ts:261-263`), so
  candidates dropped by budget slicing are re-fetched and re-sent to the extraction LLM in
  later rounds. `rawResultsCount` (`discoveryEngine.ts:1724`) also sums two overlapping sets.
- `accumulatedViableCount` counts unjudged candidates as viable (`roundDiagnostics.ts:109-119`),
  suppressing recovery and inflating early-exit math.
- `siteProbe.ts:669-678` — negative cache written on *any* throw, including the 2.5s abort
  timeout → transient timeouts poison a company for 48h.
- `keyRotator.ts:161-163` — `exhausted` inferred from bare words (`credit|balance|quota`) in
  any message, and `isUsable()` (`:313-316`) then excludes the key **permanently** for the
  process lifetime.
- `scoring.ts:357-359` — `bm25Bonus` reaches 0.50, i.e. 5× the entire LLM judge term
  (0.02×10 = 0.2). The judge's score is close to noise in final ranking.
- `scoutScoring.ts:127` omits the `>10 → /10` branch present in `scoring.ts:203/224/340` →
  0-100 scores clamp to 10, creating artificial ties.

---

## Part 5 — Persistence and API

### 5.1 Resumable-session poll parses full checkpoints [verified]

`db.ts:3582-3594` — `readResumableMiningSessions` uses `SELECT *` and
`toMiningSessionRecord` parses `checkpoint_json` (`:3549`), for up to 20 sessions
(≤512KB each). The sibling `readMiningSessions` (`:3576`) correctly selects a column list.
The client polls every 15s and uses only id/prompt/status/started_at/round.

Fix: `SELECT id, prompt, status, started_at, json_extract(checkpoint_json,'$.round')`.

### 5.2 `ORDER BY score` does not match its index [verified]

`db.ts:1528` emits `ORDER BY leads.score DESC, leads.created_at DESC`; the index at `:811`
is `(score DESC)` only. SQLite cannot use it to satisfy the sort → full scan plus temp
B-tree sort over rows carrying the `payload` blob. Reached by `/api/chat`.

### 5.3 Migration backups are never pruned [verified]

`db.ts:280-318` writes a full `VACUUM INTO` copy per migration with no retention. Current
state: **572 MB across 22 files** in `.apex-data/backups/`. The only reference to the
backups directory in `db.ts` is `:287` — there is no cleanup path.

### 5.4 Other persistence items [reported]

- `api.ts:328-343` — the unfiltered `/api/leads` "fast path" has no `LIMIT`.
- `db.ts:2045-2052` — `upsertLeadInExistingTransaction` rewrites
  `app_meta('leads_initialized')` on **every** lead upsert.
- `db.ts:2001-2012` — `ON CONFLICT DO UPDATE` rewrites indexed columns unconditionally.
- `db.ts:4178-4183`, `:4215-4221` — `payload LIKE '%website%'` full blob scans plus
  `JSON.parse` of up to 1000 payloads, run at every session start.
- `db.ts:3836-3852` — session delete orphans `search_logs` / `llm_stage_logs` (no FK).
- `db.ts:1792-1796` — `replaceStoredLeads` orphans `lead_activities` / `outreach_drafts`.
- `db.ts:805` — `idx_leads_stage` is fully redundant with `idx_leads_stage_created`.
- `db.ts:1253` — `PRAGMA optimize` at open, before any query: a no-op.
- `db.ts:3733`, `:3783` — `upsertMiningSession` does `SELECT *` then re-serializes the whole
  checkpoint blob on every status update.

---

## Part 6 — Frontend (collection surfaces) [reported]

| # | Finding | Location | Severity |
|---|---|---|---|
| 6.1 | SSE `end` handler sets `status:'completed'` and calls `disconnect()` but never `notify()` — `useSyncExternalStore` does not re-render, so the terminal can keep showing "Streaming" after the stream ends | `traceStore.ts:184-188`, `:229-237` | High |
| 6.2 | Every persistence event issues **two concurrent full `/api/leads` fetches** (`rehydrateLeads(true)` plus `notifyLeadsUpdated()` → window listener). `rehydrateLeads` has no request-id, so a slower older response can overwrite a newer one | `ScrapeWorkspace.tsx:357-360`, `LeadContext.tsx:444-447`, `:350-428` | High |
| 6.3 | `logs.map((log,i) => … key={i})` renders up to 2000 `motion.div` lines with **no virtualization and index keys**; every stream message re-renders all lines and re-runs `renderTerminalLog` regex per line | `TraceTerminal.tsx:706-733`, `traceStore.ts:133` | High |
| 6.4 | `workspace` and `inventory` tabs stay mounted forever (only `hidden`), so a hidden `LeadTable` re-renders on every leads change and recomputes regex-heavy dedupe over all leads | `App.tsx:406-426`, `LeadTable.tsx:557-590` | High |
| 6.5 | `handleLeadDiscovery` has no `if (loading) return;` guard, so a fast double-submit creates two server sessions | `ScrapeWorkspace.tsx:811-861` | Med |
| 6.6 | A failed resume silently removes the banner row (failure swallowed upstream); `activeSessionId` is read from a ref during render so the filter is stale | `ResumableSessionsBanner.tsx:80-93`, `ScrapeWorkspace.tsx:934-940`, `:1217` | Med |
| 6.7 | Dedupe both false-merges and misses merges: email-domain fallback merges distinct Gmail users (`name_domain:john smith::gmail.com`), while `name_company`/`name_domain` keys are only added when there is no LinkedIn identity, so the same person with and without a LinkedIn URL never merges | `leadDedupe.ts:123-134`, `:155-156` | Med |
| 6.8 | On SSE error the store does a one-shot status fetch and never reconnects — the live log stream stays frozen after a transient drop | `traceStore.ts:190-219` | Med |
| 6.9 | Chat autoscroll has no "user scrolled up" check, yanking the viewport while the user reads history | `CrmCopilot.tsx:91-98` | Med |
| 6.10 | "Show all" renders every card in a stage inside `AnimatePresence` with no windowing | `CrmPipeline.tsx:636`, `:813-843` | Med |
| 6.11 | `useToast()` returns a value whose identity changes with `toast`, so all consumers re-render on every show/dismiss | `ToastContext.tsx:122-129` | Low |
| 6.12 | Client re-derives `compositeScore`/`predictiveScore` on add/import, overwriting server scores on the same 0-100 scale shown to users | `LeadContext.tsx:581-601` | Low |

Note: there is **no** virtualizer in the codebase (grep for `useVirtualizer`: no matches),
so the "virtualizer measurement" hypothesis does not apply. The cost is 6.3 and 6.4.

---

## Part 7 — Toolchain: why none of this was caught [verified]

This is the root-cause section. Every defect above is invisible to the current gates.

1. **`tsconfig.json` sets no `strict`, `noUnusedLocals`, `noUnusedParameters`, or
   `noImplicitAny`.** `npx tsc --noEmit` returns **exit 0 with zero diagnostics** on a
   codebase containing dead imports (`groundCandidateWithSiteProbe` at `judgeStage.ts:24`,
   `executeJudgeStage` at `discoveryEngine.ts:174`, `APEX_SYSTEM_PROMPT` at
   `discoveryEngine.ts:72`) and dead exports. `npm run lint` is therefore structurally
   incapable of catching the single most common defect class in this audit.
2. **49 of 93 test files are referenced by no grouped npm script; only 44 are.**
   `test:lead-engine` runs 28 of 93. The named scripts give false confidence — only
   `npm test` runs everything.
3. **No type-check in the default workflow.** `test` uses `tsx` (type-stripping) and `build`
   uses `vite` + `esbuild` (no typecheck). A type error passes both.
4. **No CI and no gating hook.** No `.github/`; hooks only run a memory indexer. Nothing
   blocks a broken commit.
5. **The suite has no end-to-end wiring test.** `executeDiscoverySession`
   (`discoveryEngine.ts:376`) — the only place the 7 stages are wired together — is never
   called by any test. Every stage test hand-constructs its input to match what the function
   expects, so the test author supplies the correct cache key, the correct config value, and
   the correct call order **by hand**. That is precisely why a never-called function, a
   mismatched cache key, and a hardcoded-instead-of-read concurrency value all survive.

### Named weak assertions [reported]

- `safetyNetPromotion.test.ts:18-23` — defines `safetyNetFilter` inside the test, never
  imports the engine, then asserts its own lambda.
- `outbound_grounding.test.ts:28-39` — asserts the mock's own strings; the real prompt
  builder is never called.
- `engineFixesVerification.test.ts:82-98` — re-implements `shouldStopEarly` inline and
  asserts the local lambda, not `discoveryEngine`.
- `engineFixesVerification.test.ts:103-162` — exercises only `SignalStore.getUniqueCompanyNames()`;
  `planStage` is never invoked, so the claimed fix is unverified.
- `verifiedBugfixes.test.ts:172-182` — asserts `sourceProvider === 'tavily'` after the test
  itself set `sourceProvider: 'tavily'`.

---

## Part 8 — Documentation drift

| Claim | Source | Status | Actual |
|---|---|---|---|
| Pre-judge role triage runs in 0ms | README §10, ADR-0005 §4, CONTEXT.md | **FALSE** [verified] | `executeJudgeStage` never called |
| Pre-judge context grounding (~250ms) | README §10, ADR-0005 §3, CONTEXT.md | **FALSE** [verified] | `groundCandidateWithSiteProbe` has zero call sites |
| Speculative stage overlap | README §2 | **FALSE** [reported] | `executePlanStage` awaited inline per round |
| Enrichment deferred until *after* Pareto | README §9, ADR-0004 §3 | **FALSE** [verified] | Phase 4/5 run before `selectDiversifiedLeads` |
| Judge evidence window 5 items / 800 chars | ADR-0003 §4 | **FALSE** [verified] | 3 items / 500 chars (`finalistJudge.ts:177-188`) |
| Judge pool ≤1.35x, default batch 8 | ADR-0004 §4 | **FALSE** [reported] | 1.35x/default-6 exist only in the dead path; live micro-batch is 4 |
| Bounded recursion `attemptDepth<1` | ADR-0005 §4 | **FALSE** [reported] | Live path recurses `depth<2` |
| Temporal freshness decay on Phase 5 post intent | README §6, ADR-0001 | **FALSE** [reported] | Decay lives only in `intentSignals.ts:72` |
| "180 tests across 12 suites" | README Verification | **FALSE** [verified] | 93 files, ~633 declarations; `test:lead-engine` covers 28 files |
| "264 tests" in `test/` | README Project Structure | **FALSE** [verified] | 93 files, ~633 declarations |
| Per-suite counts 4 / 3 / 7 / 24 / 10 | README Verification | **FALSE** [reported] | 5 / 11 / 17 / 33 / 20 |
| CODEBASE_INDEX: schema v20, 90 files, 601 tests | CODEBASE_INDEX §2/§8/§9 | **FALSE** [verified] | v21 (`db.ts:29`), 93 files, ~633 |
| `DiscoverySessionEngine` is an exported interface | ADR-0001 | **PARTIAL** [reported] | It is a class (`discoveryEngine.ts:2418`) |
| Boot sweep marks sessions `resumable: true` | ADR-0002 §2 | **PARTIAL** [reported] | Sets `status='interrupted'`; resumability is derived |
| "Session-scoped IDF corpus weighting" | README §6 | **PARTIAL** [verified] | Corpus is shared, but computed per-company → order-dependent (2.1) |
| Token diet "~65%", waste "70%+", "~250ms", "28-53min→1-3min" | README §9/§10, ADR-0004/0005 | **UNVERIFIABLE** | Mechanisms exist; no measurement artifact in the repo |
| "45 core tests / 5 suites" | README badge, ADR-0005 | **UNVERIFIABLE** | No 5-suite set reconciles to 45 |

Confirmed accurate: two-wave parallel retrieval with the `<5` Wave-2 trigger; durable
checkpoints and resume with HTTP 202; B2 revision conflict dialog; `useSyncExternalStore`
trace store; MAB λ=0.95 and domain clustering; DCR partner/modern-title fix; site signal
extraction; lean capacity 1.15/1.20/1.25; decoupled early exit; Stage 2.5 pre-filter; CRM
`exclude_domains` and metro `>=15`; strict sequential LLM invariant; schema v21.

---

## Part 9 — Inert configuration and dead code [verified unless noted]

- `featureFlags.ts` — 6 of 14 flags are never called: `taxonomy`, `distributedQuery`,
  `semanticGrouping`, `enhancedDiagnostics`, `transientNegativeCache`,
  `proactiveTokenRegulator`. Live: `fuzzyQuoteGrounding`, `evidenceAware`,
  `progressiveQualification`, `classAwareScheduler`, `safeSlugProbe`,
  `companyEntityRegistry`, `anchoredFlywheel`, `fullJitterRetry`.
- `llm.ts:265-273` — in litellm mode `getConfiguredLLMProviders()` filters out
  `provider.id !== "primary"`, so **Byesu (`primary`) is excluded** despite being the
  documented primary. `BYESU_API_KEY` is inert in gateway mode.
- `llm.ts:136-138` — hard-coded Token Harbor expiry `2026-09-19`; after that the provider
  silently vanishes. [reported]
- `llm.ts:906-908` — no `seed` pinned; temperature 0.1 (0 on retry). [reported]
- `llm.ts:854` — the chain throws a fresh concatenated `Error`, dropping original objects
  and `status`, so callers cannot classify failures. [reported]
- `llm.ts:877` — Groq capped at 950 output tokens against a 4000 request → truncation →
  parse failure → full re-send. [reported]
- `langfuse.ts:104` — ingestion `fetch` has no timeout and is only invoked when
  `provider.id !== "litellm"`, i.e. the primary path is never traced. [reported]
- Dead exports/inputs: `collectionRefinementForRound` + `RETRIEVAL_REFINEMENTS`
  (`collectionCapacity.ts:14-37`), `getQueryExecutionCeiling`, `queryExecutionCeiling`,
  `requestedJudgePool`, `requiredRounds`, `candidateStableId` (`discoveryEngine.ts:280`),
  `enrichStage.ts:70-72`, `judgeStage.ts:311`, `:890`, `discoveryEngine.ts:72`. [reported]
- `searchSpec.ts:23,137` + `prospectContract.ts:1533-1562` — `employeeRange` is parsed but
  referenced nowhere else; `company_size` never reaches `SearchSpec`. [reported]
- `searchSpec.ts:520-549` — `exploredMetros` are bare names while `eligibleMetros` are
  country-suffixed, compared with `===`, so explored non-US metros are re-recommended. [reported]

---

## Suggested order of work

**Stage 0 — make the toolchain able to see (cheap, unblocks everything)**
Enable `strict`, `noUnusedLocals`, `noUnusedParameters` in `tsconfig.json`. Fix what falls
out. Add a `typecheck` step to the build script and a single `test:all` script. This alone
would have flagged 1.1, 1.2, 1.5 and the whole of Part 9.

**Stage 1 — decide, then fix (needs your call)**
1.1, 1.2, 1.3, 1.4, 1.5 are all "the docs describe a system that isn't running". Each needs
a decision: restore the feature, or correct the documentation. Do not silently re-enable
1.2 — the site probe has a broken cache key (2.9) and a poisoned negative cache.

**Stage 2 — ranking integrity**
2.1 (TF-IDF ordering) and 2.2 (`1 → 10`) are small, contained, and currently corrupt output
every session. Then 2.5 (persist `judgmentInsight`), which re-arms three dead filters.

**Stage 3 — latency and spend**
4.1–4.4. These cause the intermittent multi-minute stalls, and 4.2's in-queue sleep
amplifies every other call.

**Stage 4 — persistence and frontend**
5.1–5.3 are cheap and risk-free. Part 6.1–6.4 are the visible UI freezes.

**Stage 5 — the eval harness**
Land the harness proposed in `docs/adr/0006-prospect-quality-grounding.md` before tuning
anything. Findings 2.1, 2.4, 2.7, 2.8 and 3.9 are *ranking* defects that no unit test can
see — they require a scripted end-to-end run asserting observable output (final lead set,
stop reason, per-stage counters) with mocked provider ports.
