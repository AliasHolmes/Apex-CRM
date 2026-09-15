# Audit Verification & Session Performance Review

Date: 2026-09-15
Subject: commit `4c385da` — "feat(engine): comprehensive audit hardening and reliability upgrades across Parts 1-9"
Reference: `docs/ENGINE-AUDIT-2026-09-13.md` (revision 2)
Data source: `.apex-data/apex-crm.sqlite` (read-only)

---

## Part A — Was the audit fixed properly?

Method: read the current source for every finding in the audit and classify it. A finding
counts as **FIXED** only if the mechanism now runs on the live path — not merely if the
compiler stopped complaining.

### Verdict summary

| Status | Count |
| --- | --- |
| Fixed properly | 18 |
| Partial | 3 |
| Not fixed | 2 |

### Fixed properly

| Audit item | Fix | Evidence |
| --- | --- | --- |
| **Stage 0** toolchain | `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters` all enabled; `prebuild` → `typecheck`; `test:all` added | `tsconfig.json`; `package.json` scripts |
| **1.1** role triage never ran | Triage extracted to `filterNonDecisionMakers()` and now called on the **live** path | `judgeStage.ts:57` (def), `:843` (live), `:199` (dead path) |
| **1.2** context grounding dead | Resolved by **relocation + doc correction**, not restoration: consolidated into `enrichStage`, `CONTEXT.md` term rewritten, README diagram updated | `CONTEXT.md` diff; README §10 |
| **1.3** speculative overlap | **Doc corrected** to "Synchronous State-Bounded Planning" — honest description of what the code does | README §2 diff |
| **1.4** enrichment before Pareto | `selectDiversifiedLeads` moved to `:61`, ahead of Phase 4 (`:63`) and Phase 5 (`:109`) | `stages/selectStage.ts` |
| **1.5** enrichment mode mismatch | Default changed `"on_demand"` → `"post_filter"`, matching the only branch | `discoveryEngine.ts:786`, `enrichStage.ts:139` |
| **1.6** yield history empty | `runs: 1` now passed | `stages/selectStage.ts:152` |
| **2.1** TF-IDF order-dependent | Genuine two-pass: Pass 1 registers during scrape, `runProviderQueue` awaited, Pass 2 rescoring over the complete corpus | `intentEnrichment.ts:106-224` (pass 1), `:226-238` (pass 2) |
| **2.2** `1 → 10` score inflation | Guard tightened to `num < 1.0` | `finalistJudge.ts:63` |
| **2.4** citation guard asymmetric | Now opt-in strict via `ENFORCE_CITATION_QUOTES`; a `pass` with no quote is only accepted when that env is unset | `finalistJudge.ts:368-374` |
| **2.5** `judgmentInsight` never persisted | Now assigned on the live path | `judgeStage.ts:858`, `:931` |
| **2.9** site-probe cache key mismatch | Write now uses `host`, matching the read | `siteProbe.ts:560` vs `:589`, `:600` |
| **4.1** Tavily had no timeout | Search gets a 30s `AbortController`; extract bounded 1–120s (default 30s); both compose with the caller signal | `llm.ts:1247-1253`, `:1330-1335` |
| **4.2** `LLM_MAX_RETRIES=0` ignored | `effectiveMaxRetries = maxRetries` — the `Math.max(…, 2)` override is gone | `llm.ts:382` |
| **4.3** cooldown never applied | `0` → `5_000` when `LLM_MAX_RETRIES === "0"` | `llm.ts:836` |
| **4.4** Bright Data cooldown clamped | `Math.min` → `Math.max`, so the 30s/60s/300s ladder is honoured | `brightdata.ts:284-292` |
| **5.2** `ORDER BY score` vs index | Index is now `(score DESC, created_at DESC)` | `db.ts:829` |
| **5.3** backups never pruned | Keeps the 3 newest pre-migration backups, unlinks the rest | `db.ts:316-334` |
| **keyRotator** permanent exhaustion | Recovery condition now includes `exhausted` when `cooldownUntil` has elapsed | `keyRotator.ts:305` |

### Partial

**5.1 — Resumable-session poll still parses full checkpoints.** The `SELECT *` was replaced
with an explicit column list, but that list still includes `checkpoint_json`
(`db.ts:3609`), and `toMiningSessionRecord` still parses it (`db.ts:3572-3575`). The cost —
up to 20 checkpoints at ≤512KB each, parsed on every 15s poll — is unchanged. This is a
cosmetic fix. The real fix is to stop selecting the blob:

```sql
SELECT id, status, prompt, requested_limit, started_at, completed_at,
       cancellation_requested_at, error_message, stats_json, trace_summary_json,
       updated_at, json_extract(checkpoint_json,'$.round') AS checkpoint_round
FROM mining_sessions ...
```

**2.6 — Hard requirements still silently dropped.** A `console.warn` was added
(`prospectContract.ts:1113`), which is genuine improvement, but the requirement is still
discarded rather than re-derived, and no counter reaches the session report. Visibility
exists only in the server console.

**4.3 — Cooldown is now 5s rather than the 30s default.** Defensible given retries are
disabled, but it is an undocumented second code path for the same env var.

### Not fixed

**2.7 — Location auto-passes from the search query.** `evidenceSelection.ts:79-83` is
byte-for-byte unchanged. A candidate surfaced by a query containing "New York" still
auto-passes `person_location` when the profile has no location field. This is a
false-positive source in the hard-requirement gate and was not addressed.

**api.ts:349 — `runs: 0` remains** on the single-lead verification path. Minor: because
`runs` decays as `ROUND(runs * 0.95 + excluded.runs)`, this write now slightly *reduces*
the history that 1.6 just started accumulating.

### Assessment

The commit is a serious, mostly correct response. The three structural problems the audit
identified are genuinely resolved: the toolchain can now see dead code, ranking inputs are
order-independent, and the docs no longer describe a system that doesn't exist. Two
findings were fixed only on the surface (5.1, 2.6) and one was skipped (2.7).

One caveat worth stating plainly: **the audit's headline defect class was dead code, and
this commit removed the dead code rather than reviving the features.** That is a legitimate
choice — but it means 1.2's capability (site grounding before judging) no longer exists
anywhere in the pipeline. It was consolidated into `enrichStage`, which runs *after*
selection, so candidates are now judged without the commercial-context grounding that
ADR-0005 §3 was written to provide. That is a capability regression relative to the ADR's
intent, even though the documentation is now accurate.

---

## Part B — Last session performance

### Critical caveat

**No session has run since the fix commit.** The most recent session is
`10331776-f9ed-4a29-a79e-e98dab5a73ea`, started 2026-09-13 20:14:37 UTC and completed
20:52:16 UTC. The fix commit is dated 2026-09-14 01:45. A query for sessions started on or
after 2026-09-14 returns an empty set.

So what follows is a **pre-fix baseline**, not a post-update measurement. It is the right
thing to compare against once a new session runs, but it cannot tell you whether the fixes
worked.

### Session summary

| Metric | Value |
| --- | --- |
| Target | 30 prospects |
| Returned | **26** (86.7%) |
| Wall clock | **2,259s (37.6 min)** |
| Rounds | **10**, stop reason `max_rounds` |
| Raw candidates retrieved | 2,167 |
| Yield | 26 / 2,167 = **1.2%** |
| CRM duplicates skipped | 62 |
| Total tokens | 292,668 (247,462 in / 45,206 out) |
| Tokens per accepted lead | 11,256 |
| LLM calls | 93 |
| LLM failures | **37 (39.8%)** |
| Fallback uses | **41 (44%)** |

### Where the time went

Total LLM latency was 1,780s of 2,259s — **79% of wall clock**. The remaining 21% is
network retrieval and processing.

| Stage | Calls | Total | Avg per call |
| --- | --- | --- | --- |
| `extraction` | 22 | 831s | **37.8s** |
| `candidate_processing` | 61 | 719s | 11.8s |
| `strategy` | 10 | 230s | 23.0s |

By provider:

| Provider / model | Calls | Total | Avg |
| --- | --- | --- | --- |
| Byesu `gpt-5.5` | 50 | 1,408s | 28.2s |
| Groq `qwen/qwen3.8-27b` | 4 | 370s | **92.6s** |
| `devstral-2512` | 35 | 2.1s | 0.06s |

Per round, the first two dominate: round 1 = 333s, round 2 = 368s — **701s, or 39% of all
LLM time, spent before round 3**.

### Findings

**1. The bottleneck is LLM latency, not the pipeline.** 79% of wall clock is model
response time. Every efficiency gain in ADR-0001→0005 targeted the other 21%. This is why
another waste-cutting round would yield little.

**2. A 39.8% LLM failure rate with 44% fallback usage is the dominant reliability signal.**
This is the single most important number in the dataset. Note that fixes 4.2 and 4.3 change
behaviour here in opposite directions: retries are now genuinely disabled
(`LLM_MAX_RETRIES=0` is honoured), so a transient 429 falls through immediately, while the
new 5s cooldown means a failing provider is skipped rather than retried first. The net
effect on the 40% failure rate is genuinely uncertain and must be measured.

**3. Groq is a latency trap at 92.6s per call.** Four calls consumed 370s — 16% of total
wall clock for 4% of calls. `llm.ts:877` caps Groq at 950 output tokens, which forces
truncation and parse-retry cycles. If Groq is retained as a fallback it needs a hard
latency ceiling, not just a token ceiling.

**4. `extraction` at 37.8s per call is the top optimisation target.** 831s across 22 calls.
This is the stage where prompt-dieting, evidence pre-truncation, and (critically) a
completion cache would pay off — the audit found no completion cache exists.

**5. Ten rounds against a documented cap of three.** `collectionCapacity.ts:117` sets
`defaultMaxRoundsCap = 3` for targets ≤30, but `.env` line 74 sets
`LEAD_SEARCH_MAX_ROUNDS="6"`, which overrides it — and the session still ran **10**. The
`CONTEXT.md` glossary claim of "tight maximum round bounds (2–4 rounds)" is violated twice
over. Worth investigating how the run reached 10.

**6. Deep enrichment contributed nothing.** `brightData.profileScrapesAttempted: 0`,
`companyScrapesAttempted: 0`, `batchScrapesAttempted: 0`. This confirms finding 1.5 in
production: the enrichment block never executed. Fix 1.5 will now *enable* it — which means
future sessions should be expected to take **longer**, not shorter. This is a correctness
gain traded against wall clock, and it should be measured deliberately rather than
discovered as a regression.

**7. Three phases ended in `error` status** (`strategy`, `extraction`,
`candidate_processing`) while the session overall reported `success`. Worth clarifying
whether those error statuses are expected partial-failure signalling or a reporting bug.

**8. Rejection distribution shows the pre-filter is doing real work:** 164
`missing_linkedin_profile`, 62 `duplicate_existing_lead`, 15 `not_decision_maker`, 12
`missing_company_entity`, 8 `score_below_minimum`, 6 `missing_role_context`, 1
`llm_extraction_empty`. The 15 `not_decision_maker` rejections are exactly what fix 1.1 now
handles in 0ms instead of via the paid LLM judge.

---

## Recommended next steps

1. **Run one session and re-measure.** Everything in Part B is a baseline. The 1.2% yield,
   79% LLM share, and 39.8% failure rate are the numbers to beat.
2. **Instrument the failure rate specifically.** 37 failures across 93 calls is the highest
   -leverage defect in the system and it was not in the original audit. Log per-call failure
   reason and provider so the next session can attribute it.
3. **Fix 5.1 properly** (stop selecting and parsing `checkpoint_json` in the resumable
   poll) and **2.7** (stop auto-passing location from the search query) — both are small.
4. **Add a completion cache before touching prompts.** Extraction is 37.8s per call; the
   strategist and extraction prompts repeat substantially across rounds.
5. **Reconcile the round cap.** Decide whether 10 rounds is intended; if not, `.env`'s
   `LEAD_SEARCH_MAX_ROUNDS` override and the `CONTEXT.md` claim both need correcting.
6. **Expect and measure the enrichment cost** introduced by fix 1.5. Compare the next
   session's wall clock against this baseline before concluding the fixes made things faster.
