# Session 3 Follow-up: Market Depth, Fast Planner, Clean Execution — Implementation Plan

> For the implementing agent. Read this whole file before touching code. Work in phases, in order; each phase is independently shippable and ends with green tests.

## Context (what happened, what was verified)

Session `ad3b9625` (New Zealand AI consultancies, target 20): 9 leads in 1h23m. Rounds 1–3 produced all 9 (~35 min). Rounds 4–6 produced 0 and took ~48 min (~16 min each). Strategist planning on Atria took 145–274 s per round. Operator directive: **never give up early on a small pond — make the net wider and deeper; the planner should use Byesu first (Atria on error/outage), because it's faster.**

Findings verified against the code (do not re-derive; re-check only if a line number has drifted):

| # | Finding | Where |
|---|---|---|
| F1 | Query dedupe is exact lowercase text; synonym/near-duplicate queries pass. The deterministic fallback ladder only runs when *zero* plans survive, so it never ran. | `server/leadSearch/stages/planStage.ts` (~L496, ~L502) |
| F2 | `isRecovery` expires after 2 attempts (`recoveryAttempts < 2`); in R4–6 the planner got no pivot directive. | `planStage.ts` ~L158–161, `discoveryEngine.ts` ~L2054 |
| F3 | Strategist prompt rules fight expansion: max 2 city queries, 3–6 words, no `site:`. | `server/leadSearch/searchSpec.ts` ~L799–808 |
| F4 | `countryPool` falls back to **all** legacy countries when the brief's country isn't in `METRO_HUBS_BY_COUNTRY`, so NZ briefs get US/UK/CA/AU cities recommended. `countryLabel` only covers UK/Canada/Australia. | `searchSpec.ts` ~L559–575 |
| F5 | `COUNTRY_TO_METROS` (system of record) has NZ with only 3 cities. `Hamilton` is already in `EXTRA_KNOWN_METROS` as the Canadian city. City→country reverse inference exists in several places. | `prospectContract.ts` ~L303–370; `searchSpec.ts` ~L407; `queryUnderstanding.ts` ~L57–70 |
| F6 | `orderProvidersForTier` is a **no-op unless `routingTier === "fast"`**. `LLM_FAST_PROVIDER_IDS` is global; extract/judge already use `fast`. | `server/services/llm.ts` ~L280 |
| F7 | `timeoutMs` is a floor, not a cap: `computeByesuDynamicTimeoutMs` returns `max(minByesuTimeout, workloadTimeoutMs)` (workload ≥ 45 s + token terms). Atria has an equivalent dynamic function. `fetchWithRetry` defaults to 1 retry. | `llm.ts` ~L1627–1668, ~L415–445, ~L1699–1722 |
| F8 | Provider timeouts feed `recordProviderFailure` → shared health/circuit breaker; 3 consecutive fatal failures marks a provider OUT for 60 s **for all stages**. | `llm.ts` ~L1050–1121, `executeAttempt` ~L1283 |
| F9 | `aliasMap.ts` maps `co-founder→founder` but NOT `owner`/`ceo`/`managing director`→founder; it has no exported company/geo alias tables. A new synonym-class table is needed. | `server/leadSearch/aliasMap.ts` |
| F10 | `QueryFamily`/`QueryIntent` are **closed enums** (`company_type`, `local_market`, `archetype_exploration`, …; intents `recover_from_low_yield`, `reduce_duplicates`, `expand_surface_area`, …). `normalizeQueryPlanItems` passes `family`/`intent` through unvalidated, but do not invent new values. | `searchSpec.ts` ~L30–60 |
| F11 | `buildRetrievalTasks` applies `includeDomains: ["linkedin.com"]` to every non-signal lane. **Signal lane = open web** (no domain filter). | `searchSpec.ts` ~L328 |
| F12 | `extractPostSnippets` falls back to the top 3 results of *any* domain; fields are `title`/`url`/`content` (not `snippet`/`text`). Current whitelist: `linkedin.com/posts`, `/feed/update`, `/activity`, `/pulse`. An empty-snippet/short-context early skip already exists (~L692) and bumps `stats.llmSkipped`. | `server/leadSearch/linkedinPostIntent.ts` ~L172–195, ~L690–719 |
| F13 | A passing hard `person_role` judgment is guaranteed to carry a verbatim quote (validated against evidence) that contains a role word. | `finalistJudge.ts` ~L612–634 |
| F14 | `mapCandidateToPersistedLead` is the single mapping used by checkpoint persistence and `persistStage`. `applyQualification` in `judgeStage.ts` (~L335) runs at both judge paths (cached ~L482, fresh ~L703). Title fields: `currentTitle`, `title`, `headline`. | `leadMapping.ts` L34; `judgeStage.ts` |
| F15 | `enrichStage` already runs a company site probe (cap `LEAD_SITE_PROBE_MAX_PER_ROUND`, default 12, max 30), sorted only by `highValue`; positive/negative caches exist. Enrich runs **before** judge. | `stages/enrichStage.ts` ~L916–1030 |
| F16 | Company attribution runs inside judge micro-batches and needs `sourceText ≥ 30` chars. Admission gate withholds with `score: -1` at two sites. | `companyAttribution.ts` ~L358; `judgeStage.ts` ~L462–497, ~L689–700 |
| F17 | Per-round stage wall times already exist (`roundStageWallMs`, `formatRoundCriticalPath`) and `QueryRunStats` already has `rawCandidates`/`uniqueCandidates`. | `discoveryEngine.ts` ~L1246, ~L2104; `strategist.ts` |

## Hard constraints (from the operator and the repo)

- **Do not use `npx`.** Run tests with `.\node_modules\.bin\tsx.cmd --test <files>` and typecheck with `.\node_modules\.bin\tsc.cmd --noEmit`.
- **Do not add Claude attribution/co-author trailers** to commits, PR text, or notes. Commit only when the operator asks.
- **Industry-agnostic engine (ADR 0007, `test/industryAgnostic.test.ts`).** No AI-specific titles/verticals (e.g. "Head of AI", "AgriTech AI") anywhere in code or prompts. All role/vertical/company-type vocab comes from the contract (`requirements[scope=person_role].acceptableTerms`, `identitySpec.*`, `minedRefinementTerms`) or from generic seniority vocabulary.
- **Routing policy:** Atria is primary for all stages; Byesu overflow. The planner is the *one* sanctioned exception (Byesu first). After Phase 2 lands, update the memory note `llm-provider-routing-policy` to record this exception.
- **Never shorten a run to stop early.** Widening and deepening only.
- **Isolation:** the main working tree has ~49 uncommitted files (UI redesign). Do this work in a git worktree off `main` (or a dedicated branch) so server changes don't mix with it.
- Match surrounding style: terse comments only where the *why* is non-obvious.

---

## Phase 0 — Baseline (no code changes, ~30 min)

Goal: stop guessing where the 16 min/round went.

1. Locate Session 3 data (`ad3b9625`): the mining-session checkpoint/telemetry in the SQLite DB (`server/db.ts`) and/or saved terminal log. Find the `formatRoundCriticalPath` lines for rounds 1–6 (stage walls: plan / search / extract / enrich / judge).
2. Record in `docs/superpowers/plans/2026-10-05-session3-baseline.md`: per-round stage walls, per-query `rawCandidates` / `uniqueCandidates`, the query list for R1–R6, withheld-candidate count and reasons, the James McCombe lead's stored `profile` + `qualification` (for the Phase 1 fixture).
3. **Decision gate:** if `extract + enrich + judge` exceeds 50% of a zero-yield round, add a Phase 3F task ("zero-novelty fast path": skip enrich/judge work for candidates that add nothing) before Phase 4. If search dominates, Phase 3's dedupe is the main lever. If the data is unrecoverable, say so in the baseline file and use the Phase 6 measurement run as the baseline instead.

---

## Phase 1 — Isolated fixes (post-intent clean-up, title backfill)

### 1A. Post-intent snippet clean-up (`linkedinPostIntent.ts`)

- Add exported pure helpers:
  - `isLinkedInPostUrl(url)`: true for `linkedin.com/posts/`, `/pulse/`, `/feed/update/`, `/activity/`, and `/^…linkedin\.com\/in\/[^/]+\/recent-activity/`. **False** for bare `/in/<handle>` profile pages and every non-LinkedIn host.
  - `isSerpBoilerplate(text)`: true for search-engine UI strings — `Visual Search`, `Privacy Policy](#)`, `Open links in new tab`, `bing.com/ck/a?`, and similar. Make the list a named constant.
- `extractPostSnippets(results)`: filter by `isLinkedInPostUrl`; **delete the `(results).slice(0, 3)` fallback**; drop items whose `title`+`content` is boilerplate (use `item.title`, `item.url`, `item.content`). When nothing survives return `{ snippets: [], postContext: '', firstUrl: undefined }`.
- Do **not** add score logic: the existing empty path (~L692) already sets `quality: 'none'`, `enriched_none`, caches, and increments `stats.llmSkipped`. Do not add a new log line; `selectStage` already reports `llmSkipped`. Before finishing, confirm what the `quality: 'none'` evidence does to the lead score and make sure it does not penalize.
- Tests `test/postIntentSnippets.test.ts`: keeps `/posts/`, `/pulse/`, `/feed/update/`, `/activity/`, `/in/x/recent-activity`; rejects bare `/in/x`, `michaels.com`, Bing boilerplate; empty input; mixed list returns only genuine posts; existing `test/linkedinPostIntent.test.ts` still passes.

### 1B. Title backfill (new `server/leadSearch/titleResolution.ts`)

- Pure function `resolveTitleFromQualification({ lead, qualification, contract, evidence? })` → `{ title, source } | null`.
- Applies only when `lead.currentTitle`/`lead.title` is empty or equals `lead.fullName` (case-insensitive).
- Source: the passing `person_role` requirement's `evidenceQuote` (F13).
- **Attribution check** (reject quotes about someone else): pass if (a) the evidence block that holds the quote (found via `evidenceId` in `candidate.evidence`) carries a person-profile tag (`[PROFILE`, `[LINKEDIN`, `[CANDIDATE`, `[RESUME` — same tags `companyAttribution.ts` uses), or (b) the quote contains the candidate's first+last name. If `evidence` is not supplied (the persist backstop), only (b) applies.
- **Longest-span match** over: generic leadership vocabulary (`co-founder & ceo`, `co-founder and ceo`, `founder & ceo`, `co-founder`, `founder`, `managing director`, `managing partner`, `chief executive officer`, `ceo`, `owner`, `president`, `partner`, plus `chief … officer`) **plus the contract's `person_role` acceptable terms**. Pick the longest match, return it as written in the quote (preserve casing from the source).
- **Guards:** reject bare `director` and bare `principal` unless that exact word is a contract acceptable term; reject if the quote contains `former`, `ex-`, `past`, `previous`, `retired`, `advisor`, `adviser`, `board member`, `emeritus`.
- Wire-up:
  1. `judgeStage.ts` `applyQualification(lead, qualification, fallbackReason, candidateEvidence?)`: add the 4th param, pass `candidate.evidence` at both call sites (~L482, ~L703); on a result set `lead.currentTitle` and `lead.titleSource = "inferred_from_qualification"`. This makes the title visible to scoring/outreach before persist.
  2. `leadMapping.ts` `mapCandidateToPersistedLead`: backstop — same resolver, no `evidence`, so only name-in-quote attribution; only if the title is still empty.
- Never invent a title; no match → leave empty.
- Tests `test/leadTitleBackfill.test.ts`: McCombe fixture from the Phase 0 baseline (if unrecoverable, a synthetic fixture **labelled synthetic**); longest span ("Co-Founder & CEO" beats "CEO"; "Managing Director" beats "Director"); rejects bare "Director"/"Principal"; rejects "former founder", "advisor"; rejects a team-page quote naming a different person; no-op when a title already exists; persist backstop path; a non-AI contract (e.g. dental clinic owners) uses its own acceptable terms.

**Exit:** both test files + `linkedinPostIntent.test.ts` + `tsc --noEmit` green.

---

## Phase 2 — Fast planner with failure isolation (`llm.ts`, `planStage.ts`)

### Changes in `server/services/llm.ts`

1. Extend `LLMExecutionOptions`:
   - `tierProviderOrder?: string[]` — explicit order inside the primary tier for this call.
   - `providerHardTimeoutMs?: Partial<Record<string, number>>` — per-provider hard cap (ms), e.g. `{ primary: 35_000, atria: 90_000 }`.
2. In `withProviderFallback`: if `executionOptions.tierProviderOrder?.length`, order the primary tier with `orderProvidersForTier(primary, "fast", tierProviderOrder)` — i.e. **do not depend on `routingTier`** (F6). Failsafe tier ordering is unchanged and still only used when both primaries are OUT.
3. In `executeAttempt`, resolve `hardTimeoutMs = executionOptions.providerHardTimeoutMs?.[provider.id]` and pass it through `opts` to the operation. Trace `openAIStructured` → `sendChatCompletion` to confirm the field arrives (extend the `Pick<…>` type there).
4. In `sendChatCompletion` (~L1705): when `hardTimeoutMs > 0`, set `timeoutForCall = hardTimeoutMs` **before** the Atria/Byesu dynamic branches (the dynamic functions keep their current signatures; do not reorder their parameters).
5. **Health isolation:** in `executeAttempt`, when a `hardTimeoutMs` was applied **and** the failure `isTimeout`, skip `recordProviderFailure` and the breaker increment (log at debug level). Auth (401/403), quota, and non-timeout failures are still recorded normally. A planner latency miss must never push Byesu OUT for extract/judge.
6. No change to global `TASK_REASONING_EFFORT` (the same `strategist` stage is used for recovery); pass `reasoningEffort: "low"` per call instead.

### Changes in `server/leadSearch/stages/planStage.ts`

In the `openAIStructured` call (~L286) add:
```ts
tierProviderOrder: plannerProviderOrder,            // default ["primary","atria"]
providerHardTimeoutMs: { primary: 35_000, atria: 90_000 },
maxRetries: 0,                                       // no fetchWithRetry doubling
reasoningEffort: "low",
```
Make the order overridable via `LEAD_PLANNER_PROVIDER_ORDER` (comma list, default `primary,atria`; empty string → fall back to existing routing) and document it in `.env.example` next to `LLM_FAST_PROVIDER_IDS`. Keep the existing catch → deterministic-fallback behavior.

### Tests `test/plannerRoutingOverride.test.ts`
Reuse the harness style of `test/atriaConcurrency.test.ts` / `test/atriaProvider.test.ts`. Cases:
- With `tierProviderOrder: ["primary","atria"]` and **no** `routingTier`, Byesu is tried first; extract/judge calls without the option keep the configured order.
- Byesu OUT or erroring → Atria runs.
- Byesu exceeds its hard cap (use a tiny cap, e.g. 50 ms) → Atria runs; Byesu's provider health is unchanged afterwards (not cooling/OUT, breaker count unchanged).
- A 401 on Byesu under a hard cap **still** marks it OUT.
- Atria's cap is independent (a 35 s Byesu cap does not apply to Atria).
- `maxRetries: 0` → exactly one HTTP attempt per provider.

**Exit:** tests + `tsc` green. Then update the memory note `llm-provider-routing-policy` with the planner exception.

---

## Phase 3 — Query diversity, stall ladder, metros

### 3A. Query signature (new `server/leadSearch/querySignature.ts`, pure)

- `buildQuerySignature(query, { contract })` → `{ roleClass, orgClass, topicTokens: string[], geoAnchor }`.
- Generic synonym classes (static, industry-agnostic):
  - Role: owner-principal `{founder, co-founder, owner, proprietor, ceo, chief executive (officer), founder & ceo}`; partner `{managing partner, partner}`; director `{managing director, director, md}`; plus any contract acceptable terms mapped via `aliasMap.normalizeAliasTerm`.
  - Org: container words `{agency, consultancy, consulting, firm, studio, boutique, practice, company, startup}` → one class. Do **not** collapse substantive nouns (e.g. "clinic", "law firm" topic words stay topical).
- Geo anchor: metro if one is present (from the unified metro list), else canonical country, else `""`. Topic tokens = the remainder after stopwords/role/org/geo, lightly stemmed, sorted.
- `isNearDuplicateQuery(sig, historySigs)`: duplicate iff same `roleClass` + `orgClass` + `geoAnchor` and topic-token Jaccard ≥ `QUERY_DEDUPE_TOPIC_JACCARD` (default 0.5, constant in the module). Different geo anchors are distinct by design — a metro query is not a duplicate of the country-level query (Level 2 depends on this).
- `isSignatureExhausted(sig, exhaustedSigs)`: stricter, used only for signatures flagged exhausted by feedback (3B): blocks any query with the same `roleClass+orgClass+geoAnchor` regardless of topic.
- **Tune against real data:** put the Session 3 R1–R6 query list (from Phase 0) into a test fixture and assert the thresholds reject the same-geo repeats while keeping the legitimately distinct angles. Report what the pre-filter does *not* catch (cross-geo repeats) — those are handled by 3B.
- Apply in `planStage.ts` replacing the exact-text check in the `.filter` at ~L495, for LLM output, grid output, and the existing zero-plan fallback. Keep `seenQueryTexts` as a cheap first check. History = signatures of `generatedQueries`.

### 3B. Novelty feedback (reuse existing stats first)

- **First check** whether `QueryRunStats.uniqueCandidates / rawCandidates` already is the novelty rate (F17). Only add fields (`novelCandidates`) if it is not; keep any new field optional so old checkpoints load.
- Define `novelty = uniqueCandidates / max(rawCandidates, 1)` per query run. A run with `rawCandidates ≥ 5` and `novelty < 0.20` marks its signature **exhausted** (derived from `state.queryRuns` each round, so it survives checkpoint/resume without new persisted state).
- Round-level inputs for the ladder: `acceptedLeads`, total `novel` candidates, duplicate rate (`1 - unique/raw`).

### 3C. Stall ladder (new `server/leadSearch/stallLadder.ts`, pure)

- `computeStallLevel(roundHistory) → 0|1|2|3`, **never expires**, resets to 0 after a productive round:
  - 0: last round accepted ≥ 2.
  - 1: last round accepted = 1, or duplicate rate > 0.40.
  - 2: last round accepted = 0.
  - 3: ≥ 2 consecutive rounds with 0 accepted.
  - Thresholds in named constants. Confirm `previousRoundSummary.acceptedLeads` semantics (accepted vs qualified) before relying on it.
- `buildStrategistPrompt` gets `stallLevel` (keep `isRecovery` working untouched). Directive text is built from **contract data only**:
  - L1: rotate across *distinct role classes* present in `person_role` acceptable terms. If the contract has a single role class, skip straight to L2 behavior.
  - L2: allow all 4 queries to target distinct unvisited metros (relax the "max 2 cities" rule only at L≥2); combine with verticals from `identitySpec.industries`, `identitySpec.companyTypes`, `minedRefinementTerms`.
  - L3: add company/directory discovery tasks (see 3E).
- Widening the *role set itself* is the job of the existing `constraintAblation` mechanism; do not widen roles in the planner.
- Log the chosen level and directive summary through `logEvent` (same style as existing `[Strategist] Injected …` lines).

### 3D. Deterministic grid backfill (`planStage.ts` + helper)

- At stall level ≥ 2, after the LLM items pass `enforceContractQueries` and the signature filter, if fewer than `min(4, maxTasks)` survive (or the LLM failed), fill with `buildStallGridQueries(contract, state, round)`: one representative term per role class × unvisited metros (country-labelled) × industry/companyType terms, rotated by `round` so each round starts at a different offset.
- Items: `lane: "person"`, `family: "local_market"`, `intent: "recover_from_low_yield"` (existing enum values only).
- Every grid item **must pass `enforceContractQueries(items, contract)`** and the signature filter. Zero LLM tokens.
- Remember `scheduleAdaptiveRetrievalTasks` may defer tasks; grid items go through it like any others (log if deferred).

### 3E. Directory/company discovery at Level 3

- Use `lane: "signal"` (open web, no `includeDomains` per F11), `family: "company_type"`, `intent: "expand_surface_area"`. No new enum values. Query forms built from `identitySpec.companyTypes[0]` (not `contract.companyTypes`): `"list of <companyType> companies <country>"`, `"<companyType> directory <country>"`.
- **Verify before relying on it:** that signal-lane results can reach `discoveredCompanies` (path: `signalStore.getUniqueCompanyNames()` in `planStage.ts` ~L181, filtered by `looksLikeCompanyHint`). Directory pages yield company names, not persons. Add a test; if names don't flow, add a small deterministic extractor (result titles/headings → company hints, filtered by `looksLikeCompanyHint`) and say so in the PR.

### 3F. (Conditional on the Phase 0 decision gate) zero-novelty fast path
Only if Phase 0 shows enrich/judge dominating zero-yield rounds. Specify and get operator sign-off before building.

### 3G. Metro unification (`prospectContract.ts`, `searchSpec.ts`)

- Delete `METRO_HUBS_BY_COUNTRY` in `searchSpec.ts`; use `COUNTRY_TO_METROS` + `COUNTRY_CANONICAL_MAP`. Update all four uses (~L180, L426, L546, L563–575).
- Extend NZ (`"new zealand"`, `nz`) with Tauranga, Hamilton, Dunedin, Palmerston North, Nelson, Queenstown.
- **Ambiguity guard:** add `AMBIGUOUS_METRO_NAMES` (at least `Hamilton`, `Nelson`). Exclude them from every city→country **reverse inference** (`searchSpec.ts` ~L407–420, `prospectContract.ts` ~L1192, `queryUnderstanding.ts` ~L57–70) so "CEOs in Hamilton" does not silently become NZ; they remain valid when the country is already known. Always attach the country label when building queries with them.
- Add a `metroWithCountry(metro, countryCanonical)` helper replacing the 3-country `countryLabel` ternary.
- **Fix F4:** resolve the target country with `resolveGeo(brief)` / contract locations. If a country resolves, the metro pool is that country only. If none resolves (open_global), recommend **no** metros (matches the "zero default-invention" rule in `buildFallbackQueryPlan`) instead of the all-countries fallback.
- Existing tests assert exact metro lists for other countries (`test/architecturalImprovements.test.ts`); keep those lists unchanged.

### Tests (Phase 3)
- `test/queryNearDedupe.test.ts`: Session-3 fixture; same-geo synonym repeats rejected; distinct topic/geo kept; exhausted-signature blocking.
- `test/stallLadder.test.ts`: levels 0–3 escalate and do **not** expire after 2 attempts; reset after a productive round; **industry-agnostic**: run with a non-AI brief (dental clinic owners, Ohio) and assert no AI vocabulary appears in directives or grid queries; grid items survive `enforceContractQueries`; L1 skips when only one role class.
- `test/metroSystemOfRecord.test.ts`: NZ metros resolve; NZ brief never lists US/UK/CA/AU cities; open_global lists none; `Hamilton` alone does not infer a country; "Hamilton New Zealand" does; other countries' lists unchanged.
- Directory-lane test per 3E.

**Exit:** all Phase 3 tests + the existing suites touching `searchSpec`, `prospectContract`, `queryUnderstanding`, `geoCoverage`, `industryAgnostic` green; `tsc` green.

---

## Phase 4 — Withheld candidates: diagnose, probe smarter, park

### 4A. Diagnose first
- In `enrichStage.ts`, tag each probe-eligible target with why it did not get company evidence: `no_domain`, `probe_cap`, `negative_cache`, `probe_failed`, `thin_text` (< 100 chars), stored on `lead.evidence` (e.g. `companyProbeOutcome`).
- In `judgeStage.ts`, at both withhold sites (~L462, ~L689), read that tag and log one aggregate line: `Admission gate withheld N: no_domain=a probe_cap=b probe_failed=c thin_text=d`. Include it in round diagnostics if there's an obvious place. **Ship this first and read it on the Phase 6 run before building 4B–4D at full scope.**

### 4B. Probe ordering (`enrichStage.ts` ~L941)
Enrich runs before judge, so judge verdicts aren't available. Add a cheap deterministic `personaStrength(lead, contract)` (role term matches title/headline via `aliasIncludes`/`titleTriage` helpers; location matches contract geo) and sort `highValue` desc, then `personaStrength` desc. Test with a cap smaller than the target count.

### 4C. `no_domain` lookup (`enrichStage.ts`)
For targets with `personaStrength` above a threshold and no derivable domain: one basic Tavily search `"<company>" <metro|country> about`, budget via `state.freeTierBudget.reserveTavilySearch("basic")`, max `LEAD_COMPANY_DOMAIN_LOOKUP_MAX_PER_ROUND` (default 6), excluded hosts = social/linkedin/known directories. Accept a result only if the host or title strongly matches the normalized company name (a wrong domain would create a false `verified_fit`). Record provenance (`tavily_lookup`) alongside the derived domain; write negative results to the existing negative cache. Test with a mocked Tavily.

### 4D. Parked pool (behind `LEAD_PARK_WITHHELD`, default on only after Phase 6 passes)
- State: `state.parkedCandidates` (cap 20): `{ candidateKey, companyKey, parkedRound, cause, candidate }` where `candidate` is the `FinalistCandidate` (lead + trimmed evidence).
- Park when the admission gate withholds **solely** because `company_type` is unproven (not contradicted) and the `person_role` requirement passed.
- Re-entry (start of each round's enrich): for parked entries, spend **unused** probe budget (this round's cap minus what fresh targets used) probing their company; if new evidence appears (enrichment-cache hit with `evidenceBlock`), re-inject the candidate into this round's judge input. The verdict cache is keyed by `evidenceHash`, so new evidence naturally forces a re-judge. Drop entries after 3 failed re-checks or when the pool is full (oldest first).
- Persistence: add optional `parkedCandidates?` to `MiningSessionCheckpoint` (`pipelineTypes.ts`), write it in the checkpoint call (`discoveryEngine.ts` ~L2072), restore on resume. Missing field must load cleanly.
- Tests: parks only the right cause; re-entry on new evidence; cap/eviction; checkpoint round-trip; old checkpoints without the field.

**Exit:** tests + `tsc` green.

---

## Phase 5 — Verification, measurement, acceptance

Automated (all must pass):
```powershell
.\node_modules\.bin\tsx.cmd --test test/queryNearDedupe.test.ts test/stallLadder.test.ts test/plannerRoutingOverride.test.ts test/leadTitleBackfill.test.ts test/postIntentSnippets.test.ts test/metroSystemOfRecord.test.ts test/linkedinPostIntent.test.ts test/industryAgnostic.test.ts test/architecturalImprovements.test.ts test/primaryAdmission.test.ts test/titleTriage.test.ts test/companyHintHeuristics.test.ts test/leadDedupe.test.ts test/linkedinSerpParser.test.ts test/terminalLog.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
```
Then run the full `test/` suite once and report any pre-existing failures separately from new ones.

Live run (needs operator go-ahead because it spends provider budget): same brief as Session 3 (New Zealand AI consultancies, target 20). Collect, per round: planner latency and provider (from the `[LLM 200 OK] … [Strategist Planning]` line), the critical-path stage walls, rejected-by-signature count, stall level, withheld-cause line, `llmSkipped`. Compare with the Phase 0 baseline.

Targets (these are targets, not measured facts; the baseline file decides the exact numbers):

| Metric | Session 3 | Target |
|---|---|---|
| Planner latency per round | 135–274 s (Atria) | median ≤ 30 s on Byesu; no Byesu call > 35 s; no Atria fallback call > 90 s |
| Same-geo near-duplicate queries dispatched | most of R4–R6 | 0 |
| Distinct geo/vertical/role-class coverage in R4–R6 | none | every round introduces ≥ 1 unvisited metro or vertical while the contract has unvisited ones |
| Phase 5 LLM calls on Bing boilerplate | all in R4–R6 | 0 |
| Qualified leads saved with null title where the quote names a role | 1 | 0 |
| Wall-clock per zero-yield round | ~16 min | decide after Phase 0 (aim for ≥ 50% reduction) |
| Byesu marked OUT because of planner timeouts | n/a | 0 |

## Order of work and rollback

1. Phase 0 → 1 → 2 → 3 → 4 → 5, one PR/branch segment per phase.
2. Each phase is revertable on its own. Flags/env switches: `LEAD_PLANNER_PROVIDER_ORDER` (empty = old routing), `LEAD_PARK_WITHHELD`, `LEAD_COMPANY_DOMAIN_LOOKUP_MAX_PER_ROUND=0` disables 4C. The stall ladder falls back to level 0 behavior if the history is empty.
3. Do not commit unless the operator asks. When asked, no attribution trailers.

## Out of scope (explicitly)
Speculative next-round planning (overlapping planning with round N's judge); widening the contract's role set automatically; changing Atria-first routing for any stage other than the planner.
