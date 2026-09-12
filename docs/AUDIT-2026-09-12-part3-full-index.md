# Apex CRM — Full Codebase Index & Audit (Part 3)

Date: 2026-09-12 · Scope: **entire** first-party codebase — `server/` (28.7k LOC), `src/` (11.1k LOC),
`server.ts`, `test/` (86 files)

Baseline: `tsc --noEmit` **clean** · `npm test` **606 / 606 passing, 135 suites**

> Companion to `AUDIT-2026-09-12.md` (part 1: server/persistence/security) and
> `AUDIT-2026-09-12-part2-frontend-engine.md` (part 2: React + engine internals).
> **This pass reports only NEW findings.** Part 1/2 findings that are now fixed are tracked in
> [§6](#6-status-of-prior-audit-findings).

---

## 0. Working-tree state — read this first

The tree is **dirty with in-progress remediation**: 12 modified files + 2 new files, all uncommitted.

```
 M server.ts                                 M server/routes/api.ts
 M server/db.ts                              M server/services/brightdata.ts
 M server/leadSearch/discoveryEngine.ts      M src/context/LeadContext.tsx
 M server/leadSearch/llmBudget.ts            M src/lib/traceStore.ts
 M server/leadSearch/siteProbe.ts            M test/siteProbeSsrfGuard.test.ts
 M server/leadSearch/stages/fuseStage.ts     ?? server/services/privateHosts.ts   (new)
 M server/leadSearch/stages/judgeStage.ts    ?? test/apiLimits.test.ts            (new)
```

This is the part-1/part-2 fix batch landing. It has two immediate consequences:

1. **Nothing in this report is safe to act on until the tree is committed.** Several files were
   rewritten *during* this audit; one intermediate state broke the build
   (`siteProbe.ts:103` — duplicate export `isPrivateOrInternalHost`, caught as
   `TransformError` in `test/pillar2ExtractionJudging.test.ts`). It has since been resolved and
   606/606 pass, but the tree moved under the analysis.
2. **`new server/services/privateHosts.ts` correctly fixes H1/H2.** It replaces the regex blocklist
   with numeric range checks and unpacks IPv4-mapped IPv6. Verified coverage: `127/8`, `10/8`,
   `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, `198.18/15`, `0/8`, `::1`, `fc00::/7`,
   `fe80::/10`, `::ffff:0:0/96`. **Residual gap:** it is still a string-level check, so DNS
   rebinding (`evil.com` → `127.0.0.1`) is not covered; the audit note in part 1 stands.

---

## 1. Critical

### C1 — Live API key hardcoded in source
**`server/services/llm.ts:127-128`**

```ts
const DEFAULT_TOKEN_HARBOR_KEY =
  "thk_live_…";   // redacted here — full value is in the file
```

A `thk_live_*` production credential is committed as a source literal and used as the *default*
when no env var is set. Grep confirms it is the only occurrence, so it is not yet duplicated into
docs or tests — but it is in git history.

**Action:** rotate the key at the provider **now**, then move it to `.env` and make the default
`undefined` so an unconfigured install fails loudly instead of silently borrowing someone's quota.
Scrub history if this repo is ever shared or pushed.

### C2 — Auto-qualified leads bypass every downstream acceptance gate
**`server/leadSearch/discoveryEngine.ts:1723-1734`**

```ts
for (const { candidate, qualification } of triage.autoQualified) {
  candidate.lead.qualification = qualification;
  …
  if (!qualifiedLeads.some(ql => …)) qualifiedLeads.push(candidate.lead);   // committed here
}
```

Candidates that pass the deterministic pre-enrichment triage are pushed straight into
`qualifiedLeads`. They are **not** removed from the enrichment pool — `candidateLeadsForEnrichment`
(line 1757) only strips `_autoFailed` — so they still flow through `executeEnrichStage`, whose final
acceptance loop can reject them:

```ts
enrichStage.ts:870   if (finalDecisionMaker.ignoredTitle || finalDecisionMaker.confidence < 5) continue;
enrichStage.ts:897   if (!passesScore) continue;
```

**Failure mode:** a lead rejected as `not_decision_maker` or `score_below_minimum` is *already* in
`qualifiedLeads`, so it proceeds to `executeSelectStage` → `finalLeads` → `upsertLeadsWithIdentity`.
Unvetted prospects are persisted. Second-order: `roundEndEffectiveQualified` (line 1922) counts
them, so the `target_fulfilled_early` exit at :1943/:1951 can fire on phantom inventory and end
collection prematurely.

**Fix:** have `executeEnrichStage` return its rejections and remove them from `qualifiedLeads`
before the round closes, or defer the auto-qualified push until after enrichment accepts them.

### C3 — Circuit breaker trips on model-generated text, not on failures
**`server/services/llm.ts:1519-1522`, `:1553` + classification at `:560-568`**

```ts
throw new Error(
  `[${provider.name}] Failed to parse OpenAI-compatible JSON response (…): ${text.slice(0, 300)}`
);
```

300 characters of **verbatim model output** are embedded in the thrown error. The fallback layer
then classifies that message with regexes (`:560-568`):

```ts
/timed out|timeout|…|413|…|connection error|…/i.test(error.message)
```

Lead data routinely contains `413` (area code, "Suite 413"), "timeout", "connection error". A single
malformed response from an otherwise **healthy** provider therefore increments
`failuresForProvider`, applies a 30 s cooldown (`:730`), and after `failureThreshold` (default 4)
adds the provider to `disabledProviderIds` — **dead for the entire mining session**.

**Fix:** classify on a typed error (`LLMProviderError.status` / an explicit `kind`), never on a
message string that contains model output. Truncate echoed text to a debug-only field.

---

## 2. High

### H1 — One model saying "aborted" kills the whole fallback chain
**`server/services/llm.ts:643-649`**

```ts
if (executionOptions.signal?.aborted || normalized.name === "AbortError" ||
    normalized.message.includes("aborted")) {
  throw normalized;     // rethrown past every remaining provider
}
```

Same root cause as C3. One parse failure whose echoed text contains "aborted" aborts all remaining
providers instead of cascading. **Fix:** match `signal.aborted` / `DOMException` name only.

### H2 — Judge fabricates `qualified_partial` for candidates it never judged (incl. after cancel)
**`server/leadSearch/stages/judgeStage.ts:947`, `:967`, `fallbackResilientCandidates` `:726-766`**

```ts
if (batch.length > 1 && (isTokenOrSizeError || depth < 2)) { /* split & retry */ }
return fallbackResilientCandidates(batch, `incremental judge batch failed: …`);
```

`fallbackResilientCandidates` assigns `verdict: "qualified_partial"`, `finalScore: Math.max(60, …)`
and **hardcoded** `semanticFit: 7.5`, `evidenceConfidence: 7.0` to leads the LLM never saw. There is
no `signal.aborted` check in the catch, so a **cancelled** session recursively retries (depth 0→1→2)
and then auto-qualifies. Any LLM rate-limit or 413 does the same. Those leads enter `qualifiedLeads`
(discoveryEngine:1815) and count 0.75 toward early stop.

**Fix:** check `signal.aborted` first and return empty; otherwise cap the fallback at rescue-only
under an explicit env flag (a `UNVERIFIED_SAFETY_NET_PROMOTION`-style gate already exists elsewhere)
and mark them `unjudged` rather than scoring them 7.5/7.0.

### H3 — `Promise.all` discards every sibling result
**`server/leadSearch/providerQueue.ts:62`, `stages/retrieveStage.ts:633`**

```ts
return Promise.all(pending) as Promise<T[]>;
await Promise.all([executeTavilyLane(…), executeBrightDataLane(…)]);
```

Any single rejection throws away all other values. On cancel, p-queue rejects every queued-but-
unstarted task with `AbortError` → `Promise.all` rejects → `executeBrightDataLane` never reaches its
accumulator loop (`:582-600`), so **all** Bright Data results for that round are dropped even though
they succeeded and were already paid for. The per-task `try/catch` does not help — the aggregate
still rejects. **Fix:** `Promise.allSettled` + per-task catch.

### H4 — Cancellation does not stop Bright Data work
**`server/services/brightdata.ts:1240`, `:1337`, `:1526-1536`**

`scrapeAsMarkdown(url, timeoutMs)` and `scrapeBatchAsMarkdown(urls, timeoutMs)` accept **no signal**;
`BrightDataSearchOptions` has no `signal` field. `brightDataSearch` sleeps unconditionally first
(`:1748`, 500-1200 ms jitter, unabortable). Call sites pass no signal (`extractStage.ts:156`,
`enrichStage.ts:504`, `:655`).

**Failure mode:** cancelling mid-enrichment keeps burning **paid** Bright Data scrape/search credits
for the full batch plus retry waves (`enrichStage.ts:631-706`, up to 3 retries × 20 s). Only Tavily
and LLM calls are genuinely abortable. **Fix:** thread `AbortSignal` through and replace the bare
`setTimeout` with the existing `abortableSleep` helper (`brightdata.ts:432`).

### H5 — FTS triggers make every lead UPDATE/DELETE an O(N) full scan
**`server/db.ts:843-859`**

```sql
CREATE TRIGGER leads_au AFTER UPDATE ON leads BEGIN
  DELETE FROM leads_fts WHERE id = old.id;   -- id is UNINDEXED, not rowid → full scan
  INSERT INTO leads_fts(id, …) VALUES (new.id, …);
END;
```

`leads_fts` is a regular fts5 table; `id` is `UNINDEXED` and is not the rowid, so
`DELETE FROM leads_fts WHERE id = ?` has no index. Measured (50k leads, in-memory): 10 updates = 4 ms,
100 = 66 ms, **500 = 467 ms** — quadratic. Every `upsertLead*` that takes the
`ON CONFLICT DO UPDATE` branch (`db.ts:1830`) pays it, so persisting a 500-lead mining run into a
50k-lead DB spends ~0.5 s on FTS maintenance alone, degrading as the DB grows.

**Fix:** use `content=''` (contentless) + `delete` command semantics, or make `leads_fts` an
external-content table keyed on rowid so `old.rowid` is indexed.

### H6 — Unconsumed `Response` bodies on every retried 5xx/429
**`server/services/llm.ts:408-455`**

On a retryable status the previous `Response` is never consumed or cancelled (only `res.clone().text()`
for 429), and `lastResponse = res` holds it across the backoff sleep. undici will not recycle the
socket until the body is dumped → **socket/pool exhaustion** under sustained 5xx.
**Fix:** `await res.body?.cancel()` before retrying.

### H7 — No cap on concurrent discovery sessions; no rate limiting on any paid endpoint
**`server/routes/api.ts:1607-1651`**

`?mode=job` (or `Prefer: respond-async`) claims a slot per **supplied** `sessionId` and returns 202
immediately. `discoveryEngine.tryClaim` (`:2319-2324`) only rejects a *duplicate* id — there is no
global concurrency limit. N POSTs with distinct `session-…` ids spawn N parallel full
LLM + Tavily + Bright Data pipelines. No rate-limit middleware exists anywhere in `server.ts` for
`/generate-outbound`, `/chat`, `/scrape-url`, or `/leads/:id/enrich-profile`.

**Fix:** a bounded job semaphore (and a per-IP token bucket on paid routes).

### H8 — CSV import maps the wrong column to Full Name
**`src/components/LeadTable.tsx:1065-1076`**

```js
const matchingKey = Object.keys(row).find(k => keys.some(key => k.toLowerCase().includes(key)));
let fullName = getField(['full name', 'name', 'contact']);
```

Matching is by **substring** and `find` returns the first header in file order. Round-tripping this
app's own export (`ID, First Name, Last Name, Full Name, …`), `'first name'.includes('name')` is
true → `fullName = "John"`. The `if (!fullName && (fName || lName))` fallback never fires because
`fullName` is truthy. **Every imported record silently loses its surname.** Same flaw affects
`title` vs `Primary Title`. **Fix:** exact/alias matching with a priority list, not `includes`.

### H9 — Session watcher is not re-entrant: leaks interval + SSE, cross-talks `setLoading`
**`src/components/ScrapeWorkspace.tsx:350-356`, `:452-454`**

`attachActiveSessionWatcher` never clears a previously attached `watchTimer` nor calls
`disconnectStream()` / `controller.abort()` for the prior session — it just overwrites the ref. The
orphan's `cleanupDiscoveryUi()` (`:341-348`) later fires `setLoading(false)`, **killing the spinner
of the new, still-running discovery**, while an extra 3 s poll + `EventSource` stay alive.
Related: the poll body (`:374-449`) has no `disposed` guard, and `catch {}` + `if (!statusRes.ok) return;`
means a persistent 5xx silently retries ~800× (~40 min).

---

## 3. Medium (selected)

| Area | Location | Finding |
| --- | --- | --- |
| Engine | `discoveryEngine.ts:1066-1070`, `extractStage.ts:652`, `judgeStage.ts:485` | **Every concurrency tunable is clamped to 1** — `Math.min(…, 1)`. `LEAD_EXTRACTION_CONCURRENCY` / `FINALIST_JUDGE_CONCURRENCY` are inert. Judge "waves" are built by `judgeConcurrency` then awaited **sequentially** (`:977-983`) — zero parallelism by construction. |
| LLM | `llm.ts:339-348` | Global serial queue with **no chain-level deadline**: one logical call ≈ 4 providers × 90 s × outer retries ≈ 12 min of queue ownership; all other sessions block. |
| LLM | `llm.ts:1487/1508/1540`, `judgeStage.ts:266-268` | Up to **12 billed completions** per logical call; `onUsage` fires for discarded ones and is last-write-wins → reported cost both inflated and wrong. |
| API | `sessionStreamHub.ts:108-131` + `api.ts:1156-1176` | **SSE never terminates for a missing session**: the frame has `session: null`, so `frame.session?.status` is `undefined`, the terminal branch never runs, `res.end()` is never called — response hangs open forever holding a socket. |
| API | `api.ts:1130-1137` | `safeWrite` returns `res.write()`'s boolean but **every caller discards it** → unbounded server-side buffering for a client that never reads. |
| API | `api.ts:808-817` | `/llm-health` returns **HTTP 200 with `ok:false`** on failure — monitors see green while the LLM is down. |
| API | `api.ts:1502-1541` | `/lead-search/preview` has no outer try/catch and **no query length cap** (up to 10 MB → prompt); a throw leaks a stack trace in non-production mode (`server.ts:48-50`). |
| API | `api.ts:1684-1690` | `await` in `finally` **after** the response is sent — if it rejects, finalhandler destroys the socket, truncating an already-"successful" response. |
| DB | `db.ts:1623`, `api.ts:627` | Deletes orphan child rows: `DELETE FROM leads` wipes all leads but leaves `lead_activities` / `outreach_drafts` / `lead_identity_conflicts` (no FK, unlike `lead_identities`). `readOutreachDrafts` then serves drafts for dead leads. |
| DB | `db.ts:1358` / `:1386` | Count and page are **two autocommit snapshots** → `total` inconsistent with the page under concurrent writes. |
| DB | `db.ts:1944` | `!(db as any).inTransaction` — `node:sqlite` `DatabaseSync` has **no** `inTransaction` property, so the nested-txn guard is always `true`. Works today only because Node's error text matches exactly. |
| DB | `db.ts:407`/`:1174` vs `:2066`/`:2093` | Mixed timestamp formats (`YYYY-MM-DD HH:MM:SS` vs ISO `…Z`) → legacy cache rows expire up to ~24 h early. |
| Engine | `enrichStage.ts:907` + `fuseStage.ts:249-251` | Leads accepted *this session* are folded into `existingKeys`, so round N+1 reports re-sightings as `duplicate_existing_lead`. Inflates `duplicateCollisionRate` (`retrieveStage.ts:83-93`), which flips `isHighDuplication` → forces `maxResults=20` + page-2 fetch. **Telemetry error feeding back into paid retrieval.** |
| Engine | `discoveryEngine.ts:1892-1893`, `:2083-2084` | Checkpoint writes `slice(0, 240)` while `candidateCeiling` reaches 1600 → **resume silently drops leads past 240** (and their seen-keys), which are then re-extracted and re-charged. |
| Engine | `extractStage.ts:391-421` | `evidenceByUrl` grows unbounded (4-5 entries/candidate, ~8k/round × 6 rounds); truncation prunes only the array, never the Map. |
| Frontend | `OutreachStudio.tsx:490-502` | Any refinement macro blanks the composer **before** the fetch → a hand-edited draft is unrecoverable on failure. Line 502 also permanently overwrites the user's "Additional direction". |
| Frontend | `ResumableSessionsBanner.tsx:104-130` | Delete paths never check `res.ok` — a 500 leaves the session vanished from the UI but alive server-side. No sequence guard → slow poll can overwrite a newer one. |
| Frontend | `ScrapeWorkspace.tsx:1146` | `activeSessionId={activeDiscoveryRef.current?.sessionId}` — ref read during render; no re-render is scheduled, so the running session can stay in the "Interrupted" list and be **resumed twice**. |
| Frontend | `CrmPipeline.tsx:667-685` | `columnLimits` (`:149`) is never reset when filters change; after "Show all", every keystroke re-lays-out hundreds of `motion.article layout` nodes. |
| Frontend | `App.tsx:406-489` | Mounted tabs never unmount — their intervals keep firing (45 s health check, 15 s resumable poll). |

---

## 4. Efficiency & throughput opportunities

Ranked by (expected win × confidence) ÷ effort.

1. **Unpin concurrency — the single biggest throughput win.** The architecture advertises "Two-Wave
   Parallel Retrieval" and speculative stage overlap, but extraction and judging are hard-pinned to
   `1` (§3). Combined with the process-global serial LLM queue (`llm.ts:339-348`), the expensive
   middle of the pipeline is effectively single-threaded. Fixing the clamps plus giving the queue a
   per-session fairness/deadline policy is a small diff against a large wall-clock reduction.
2. **Fix the FTS trigger (H5).** Removes a quadratic cost from the single hottest write path.
3. **Stop paying for work you discard (H3, H4, H6).** `allSettled` preserves already-paid Bright Data
   results on cancel; threading `AbortSignal` stops spend *after* the user cancels; cancelling
   response bodies prevents socket exhaustion. This is direct cost, not just latency.
4. **Cap billed completions (§3).** 12 completions per logical call, all billed, most discarded.
   Fail fast on parse errors instead of escalating `maxTokens` across all four providers.
5. **Cache prepared statements** (`db.ts:31` `getCachedStatement` is used in ~6 places only).
   `recordQueryPerformance` re-parses ~2.5 KB SQL per executed query; the batch cache lookups build a
   fresh 200-placeholder statement per chunk.
6. **Stop round-tripping the 512 KB checkpoint.** `upsertMiningSession` (`db.ts:3471`) reads +
   parses + rewrites `checkpoint_json` on every status transition. Use `SELECT` without
   `checkpoint_json` for status-only writes.
7. **Wire up `ProviderTrafficController`** (part-1 M5) as a real cost governor — but give it an
   atomic `acquire()` reserving capacity, not the current racy check-then-act pair.
8. **Client trace store** (part-2 F3): keep a persistent seen-id `Set` and cap retained arrays.

---

## 5. Intelligence / quality opportunities

These are not bugs — they are places where the system's *reasoning* is weaker than its architecture
implies, and where a small change improves output quality more than any perf work.

1. **Make the judge honest instead of generous (H2, C2).** Two independent paths promote leads that
   were never actually evaluated — the judge fallback invents `semanticFit: 7.5` /
   `evidenceConfidence: 7.0`, and auto-qualified leads skip the gates that reject them. The product's
   core promise is *evidence-grounded* prospects; fabricated confidence scores directly contradict
   it, and they can be hard to spot in the UI because the numbers look plausible. Prefer
   `verdict: "unjudged"` + re-queue over a synthetic pass.
2. **Classify failures structurally, not lexically (C3, H1).** The fallback layer decides whether a
   provider is healthy by regex-matching text that contains model output and lead data. This is the
   root cause of both C3 and H1, and it will keep producing surprising behaviour as data changes.
   Typed errors with a `kind` field remove the whole class.
3. **Break the telemetry → retrieval feedback loop (§3).** Mislabelling in-session duplicates as
   `duplicate_existing_lead` inflates `duplicateCollisionRate`, which changes paid retrieval
   behaviour (`maxResults`, page-2 fetch). A metric bug is silently steering spend. Separate
   "seen this session" from "already in CRM".
4. **Make provider health session-scoped.** Cooldowns and `tokenHarborRetiredEarly` are
   process-global; `clearProviderCooldowns` is only called from tests. One 401 retires Token Harbor
   for the whole process, and a quota miss sets a **24 h** cooldown that outlives the session.
5. **Improve checkpoint fidelity (§3).** Resume truncates at 240 leads while the ceiling is 1600,
   so a resumed large session silently re-buys extraction for everything it lost. Restore
   `consecutiveStalledRounds` / `providerImpairedStallRounds` too.
6. **Cost observability.** `judgeStage.ts:266-268` is last-write-wins on usage; with 12 completions
   per call the reported number is neither total nor final. Accumulate instead of overwrite.

---

## 6. Status of prior audit findings

Verified against the current tree:

| ID | Finding | Status |
| --- | --- | --- |
| H1 | SSRF IPv4-mapped IPv6 bypass | **Fixed** — `privateHosts.ts` numeric ranges (residual: DNS rebinding) |
| H2 | Divergent SSRF guard copies | **Fixed** — single shared module |
| M1 | `?limit=abc` → 1 lead | **Fixed** — `parseBoundedLimit` (`api.ts:276`) |
| M2 | Non-numeric limit → 500 | **Partly** — `api.ts:962` still uses `Number(limit) \|\| 1` (clamped, no longer 500s) |
| M3 | Unclamped reader limits | **Open** |
| M4 | 6 inert feature flags | **Open** |
| M5 | `ProviderTrafficController` dead | **Open** |
| M6 | `suppressSocketError` no-op | **Fixed** — now logs non-benign (`server.ts:27-40`) |
| F1 | Conflict dialog deadlock | **Fixed** — orphans settled (`LeadContext.tsx:305-306`) |
| F2 | Impure `getSnapshot` | **Fixed** — pure + frozen default (`traceStore.ts:65-67`) |
| F3 | O(n²) trace dedupe | **Open** |
| F4–F6 | Broadcast dupes, refcount, fire-and-forget | **Open** |

---

## 7. Verified clean

Checked with no defects found:

- **SQL injection** — all dynamic fragments are internal constants or generated placeholder lists;
  values are bound. `orderBy` is a TS union (`db.ts:1295`).
- **Prototype pollution** — only object spread of user JSON (uses `CreateDataProperty`);
  `req.query` is null-prototype; `normalizeSearchSpec` whitelists and bounds every field.
- **Route ordering** — `/mining-sessions/resumable` and `/active` precede `/:sessionId`; no shadowing.
- **Migration mechanics** — single `BEGIN IMMEDIATE` with correct `ROLLBACK`; version gates
  (`currentVersion < N`) consistent; `batchedBackfill` SAVEPOINT handling sound.
- **JSON parse safety** — every read-path `JSON.parse` in `db.ts` is guarded; no unguarded parse of
  model text in `llm.ts` (`:1470` is inside try/catch).
- **N+1 in lead hydration** — one query; cache lookups explicitly batched.
- **Scoring internals** — score normalisation, TF-IDF, BM25+, Kalman fusion, sigmoid, Bayesian
  intent all guard their numeric edge cases (part 2 verified; re-confirmed).
- **WAL concurrency** — `busy_timeout=10000`, `synchronous=NORMAL`; no transaction held across
  network I/O anywhere in `discoveryEngine.ts`.
- **`CrmOverview.tsx`** — all derived work in one `useMemo`, sorts on copies, no stray effects.
- **Trace/log buffers** — server-side bounded (`telemetry.ts:426-430`, `sessionLogs` ≤1500).
- **SSE headers & compression bypass** — correct (`api.ts:1116-1120`, `server.ts:94-100`).

---

## 8. Suggested priority

1. **C1** — rotate the committed credential today.
2. **C2, H2** — stop persisting unvetted / never-judged leads; this is a data-quality defect that
   is invisible in the UI.
3. **C3, H1** — replace message-regex failure classification with typed errors (one fix, two bugs).
4. **H3, H4, H6** — stop paying for cancelled and discarded work; also fixes the dropped Bright Data
   results on cancel.
5. **Commit the working tree** before doing anything else — 12 modified files are uncommitted and
   the analysis above assumes their current contents.
6. **H5** + §4.1 — FTS trigger and the concurrency clamps: the two largest throughput wins.
7. **H7, H8, H9** — unbounded paid endpoints, silent CSV data corruption, frontend watcher leak.
8. **M4, M5, F3–F6** — finish the cleanup the first two audits started.

---

## 9. Remediation applied in this pass

Only files that were **committed and clean** were touched. The rest of the tree was being
concurrently edited (see §0), so C2, H2, H3, H4, H5 and H7 were deliberately left alone rather
than risk clobbering in-flight work.

| ID | File(s) | Change |
| --- | --- | --- |
| **C1** | `server/services/llm.ts` | Removed the hardcoded `thk_live_*` credential. It was **dead code** — the Token Harbor provider reads `process.env.TOKEN_HARBOR_API_KEY` (`:205`) and never referenced the constant — so removal has zero runtime effect. **The key still exists in git history and must be rotated at the provider.** |
| **C3 / H1** | `server/services/llm.ts` | Added `UNTRUSTED_MESSAGE` marking, `hasUntrustedMessage()`, and `buildParseFailureError()`. Parse failures now attach the completion as `rawExcerpt` instead of interpolating 300 chars into `message`. `isCircuitBreakingProviderFailure` and the transient-rate-limit check now trust only a typed `status` for such errors. The abort check no longer matches `message.includes("aborted")` — it uses `signal.aborted`, `name`, `cause.name`, or `code === "ABORT_ERR"`. **A second leak was found by the new tests and also fixed:** `JSON.parse` echoes a snippet of the offending text (`Unexpected token 'o', "not json at all" is not valid JSON`), so model output still reached the message via `parse_error=…`. Added `sanitizeParseError()` to redact quoted spans. |
| **H8** | `src/utils/csvFieldMapping.ts` (new), `src/components/LeadTable.tsx` | Extracted header resolution into a testable util: exact normalized match first, then a substring fallback gated to specific aliases, with per-row header claiming. `fullName` is resolved **after** every other field so it can never capture `Company Name`. |
| **H9** | `src/components/ScrapeWorkspace.tsx` | `attachActiveSessionWatcher` now tears down any previously attached watcher (interval + SSE + abort) before attaching a new one, and registers a `cleanup` on the ref. Added a `settled` guard so an in-flight poll cannot setState after unmount or after being replaced, and bounded persistent-failure retries to 10 polls instead of the silent 800 (~40 min). |
| **H2** | `server/leadSearch/stages/judgeStage.ts` | Added an abort guard to **both** fallback paths (`evaluateFinalistBatch` ~:448 and `evaluateSingleBatch` ~:946) — a cancelled session now discards unjudged candidates instead of recursively splitting and then auto-qualifying them. Removed the fabricated confidence numbers from **both** copies of `fallbackResilientCandidates` (there are two, at ~:192 and ~:739): `semanticFit: 7.5` / `evidenceConfidence: 7.0` / `authorityFit: 7.0` are now `0` = "not evaluated", and the invented `\|\| 75` score default is gone. See the note below on what was deliberately **not** changed. |
| **C2** | `server/leadSearch/discoveryEngine.ts` | Auto-qualified leads now have their qualification applied immediately but are **committed to `qualifiedLeads` only after enrichment**, and only if they survived it. `enrichStage` mutates the shared `acceptedLeads` array in place (`enrichStage.ts:908`), so membership there is the post-enrichment accept signal. Verified `qualifiedLeads` is in `state` but never read by `enrichStage`, so deferring is behaviour-neutral for that stage. Dropped leads are now logged. |

| **Concurrency clamps** (§3) | `discoveryEngine.ts:1080-1088`, `extractStage.ts:652`, `judgeStage.ts:496` | Every site was clamped with `Math.min(…, 1)`, pinning concurrency to 1 and making `LEAD_EXTRACTION_CONCURRENCY` / `FINALIST_JUDGE_CONCURRENCY` completely inert. Now clamped to **2**, the recommended maximum already documented in `configValidation.ts:33-34`. **Default stays 1, so no behaviour changes unless the operator opts in** — deliberately conservative, since raising it drives more concurrent LLM traffic. |
| **H4** (partial) | `server/services/brightdata.ts`, `stages/extractStage.ts`, `stages/retrieveStage.ts`, `discoveryEngine.ts` | Threaded `AbortSignal` through `scrapeAsMarkdown`, `scrapeBatchAsMarkdown`, `nativeHttpScrape` (combines with its existing deadline via `AbortSignal.any`) and `BrightDataSearchOptions`. Replaced the unabortable 500-1200 ms search jitter `setTimeout` with the existing `abortableSleep`. Wired the session signal at **six** paid call sites: the extract batch scrape, the `scrapeMarkdown`/`scrapeBatchMarkdown` pipeline ports, the Bright Data SERP call in `retrieveStage`, the site-probe domain scrape (which already had an unused `options.abortSignal` in scope), `checkCompanyIntent` (new optional `abortSignal`, wired from `intentEnrichment`), and `enrichLeadProfile` (new optional `abortSignal`; its only caller is the manual single-lead endpoint, so no session signal to pass yet). |

| **H5** | `server/db.ts` (schema v21) | The FTS triggers deleted via `DELETE FROM leads_fts WHERE id = old.id`, and `id` is `UNINDEXED` and is not the fts5 rowid, so every lead UPDATE/DELETE full-scanned the index. Added a `leads_fts_map(id -> fts_rowid)` table (backfilled from `leads_fts`), rewrote all three triggers to target `rowid`, and added a `WHEN` clause so updates that do not touch an indexed column skip FTS work entirely. Also updated `test/enrichmentCache.test.ts` for the new version. **Measured: 500 updates against 20k leads went from 13,289ms to 16ms (~830x).** |

| **H7** | `server/routes/api.ts`, `server/leadSearch/discoveryEngine.ts` | Added `DiscoverySessionEngine.getActiveCount()` and a cap on concurrent discovery runs (`APEX_MAX_CONCURRENT_SESSIONS`, default **2**, max 8) applied to **both** the async (`?mode=job`) and synchronous paths — previously N POSTs with distinct `sessionId`s spawned N parallel paid pipelines. Over-limit requests get a retryable **503** with `Retry-After` rather than queueing, so callers fail fast. Added a small fixed-window `paidRouteLimit` (default 30/min, `APEX_PAID_ROUTE_LIMIT_PER_MIN`) to the five other endpoints that spend money: `/scrape-url`, `/scrape-pasted`, `/leads/:id/enrich-profile`, `/generate-outbound`, `/chat`. |

> **What I deliberately did NOT change in H2 — and why.** I first also gated the fallback behind
> `ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION` (the codebase's existing "honest shortfall" convention).
> That broke `test/blueprintBlueprintCoverage.test.ts:177`, which explicitly codifies the opposite
> policy:
>
> ```ts
> // Split-and-retry must exhaust and apply fallback resilient qualification
> // so ZERO candidates are dropped!
> assert.strictEqual(output.qualifiedCandidates.length, 2, 'ZERO candidates must be dropped on upstream failures');
> assert.ok(lead.finalSelectionScore >= 60, 'Fallback score must be >= 60');
> ```
>
> "Never drop a candidate on an upstream LLM failure" is a deliberate, tested design decision, not
> an oversight — so I reverted the gate rather than override it. **The promotion policy is your
> call, not mine**; if you want honest shortfall instead, flip it and update that test. The
> fabricated *confidence numbers* were removed because no test asserts them and they are the part
> that actively misleads (an unjudged lead presenting `semanticFit 7.5` looks evaluated).

> **Important caveat on the throughput win (§4.1).** Unpinning the concurrency clamps will *not* by
> itself deliver the large wall-clock improvement the architecture implies. `llm.ts:339-348`
> serialises **all** LLM calls process-wide, so extraction and judging concurrency above 1 mostly
> queues rather than parallelises. The clamps are now correct, but the real bottleneck is that
> global serial queue — measure before raising these above 1.

**Regression coverage added:**

- `test/csvFieldMapping.test.ts` (6 tests) — these fail against the old logic: the first case
  resolves `Full Name` to `Ada` instead of `Ada Lovelace`, exactly the reported data-loss symptom.
- `test/llmUntrustedMessage.test.ts` (3 tests) — proves a malformed completion containing
  `"aborted"` still cascades to the next provider (previously it killed the whole chain), that one
  containing `"timeout"` no longer puts a healthy provider on a 30 s cooldown, and that model text
  never reaches an error message.

> **The new tests earned their keep immediately.** The third one failed on first run and exposed
> that my own C3 fix was incomplete: `JSON.parse` echoes a snippet of the input
> (`Unexpected token 'o', "not json at all" is not valid JSON`), so untrusted text still reached
> the classified message through `parse_error=…`. Caught and fixed with `sanitizeParseError()`.

**Verification:** `tsc --noEmit` clean; `npm test` **617/617 passing across 137 suites**
(606 before this audit; the 11 new tests are the CSV, LLM and provider-queue regressions).

---

### Manual verification pass - three further defects found

A deliberate file-by-file review of the finished change set (requested separately from the fixes
themselves). All three were introduced by fixes in this audit and none were caught by tests:

1. **`brightdata.ts` - `abortableSleep` rejects, it does not resolve.** I used it to replace the
   unabortable jitter `setTimeout`, assuming it resolves on abort. It actually rejects with
   `AbortError`, so an abort during the jitter wait propagated a rejection out of
   `brightDataSearch` instead of the intended clean `return []`. Wrapped in a try/catch that
   converts an abort into the documented empty result; other errors still propagate.
2. **`ScrapeWorkspace.tsx` - re-entrancy guard could switch the spinner off.** The guard called
   `cleanup()`, which does `setLoading(false)`. Callers call `setLoading(true)` *before*
   attaching, so replacing a watcher would immediately clear loading while the new discovery was
   still running. Split into `teardownWatcher()` (resources only - what the guard uses) and
   `cleanupDiscoveryUi()` (teardown + `setLoading(false)`).
3. **`db.ts` - `leads_ad` lacked the defensive sweep `leads_au` has.** If a row ever had no map
   entry, deleting by rowid alone would leave an orphaned FTS row behind. Added the same
   `NOT EXISTS` sweep before the map row is removed; it is a no-op in the normal mapped case.

Also confirmed clean during this pass: no `INSERT OR REPLACE INTO leads` anywhere (the one path
that could have produced the orphan state), `leads_fts_map` needs no entry in the hardcoded
cascade-delete lists because `leads_ad` handles it, and the full change set builds and runs.

**Note on flaky tests:** one run failed with `database is locked` on
`test/verifiedBugfixes.test.ts`. It passes 4/4 in isolation and the full suite is green on re-run.
This is lock contention between parallel test files sharing the real SQLite file - the same hazard
described below, and another reason to isolate the test database.

### Two defects found by reviewing my own changes

Recorded because both were introduced by fixes in this audit and only surfaced on a deliberate
second pass over the diff:

1. **Abort-listener leak in the new `runProviderQueue`** (`providerQueue.ts`). The abort race
   attached an `abort` listener to the session signal and never removed it when no abort occurred.
   `runProviderQueue` is called once per stage per round against a session-scoped signal, so those
   listeners accumulate for the whole session and would eventually trip
   `MaxListenersExceededWarning`. Fixed with `finally { removeEventListener(...) }`.
2. **Rate-limit default too tight** (`api.ts`). `paidRouteLimit` first shipped at 30/min, which
   would have blocked legitimate bulk enrichment. Raised to 120/min - still two orders of magnitude
   below a runaway retry loop, which fires at hundreds per second.

I also re-verified the C2 assumption instead of trusting it: `acceptedLeads` is written in exactly
two places (`discoveryEngine.ts:1193` resume restore, `enrichStage.ts:908` survivors) and
`roundFinalistCandidates` is built from pre-enrichment `postFilterLeads`, so the "did it survive
enrichment" check is meaningful - it is not silently always-true.

---

### H3 — fixed, but not with `allSettled`

The obvious `Promise.all` → `Promise.allSettled` swap is **wrong here**, and it is worth recording
why. `test/adaptiveScheduler.test.ts:116-152` aborts while task 1 is still pending and asserts
rejection *before* releasing it:

```ts
await didStart;
controller.abort();
await assert.rejects(queued, e => (e as Error).name === 'AbortError');
releaseFirst();          // <- only AFTER the assertion
```

`allSettled` waits for **every** task, including the still-pending one, so it deadlocks on that
assertion. The implemented fix keeps both properties:

1. Each task settles into its own slot (`results[index]` / `failures.push`), so **one failure no
   longer discards sibling results** — the actual bug. A single transient provider error used to
   throw away every other result in the batch, which for Tavily/Bright Data is paid work.
2. Cancellation is handled by racing the aggregate against an abort promise, so a cancelled run
   settles **immediately** without waiting for in-flight tasks. Abort still throws `AbortError`,
   preserving the existing contract for all 8 call sites.
3. If *nothing* succeeded, the original error is still thrown, so callers keep their error paths.

Regression tests added in `test/adaptiveScheduler.test.ts`: sibling results survive a single task
failure, and every-task-fails still surfaces the original error.

---

### Gotchas worth recording

- The repo enforces **ASCII-only source** via `test/encodingHygiene.test.ts`. Em dashes in two new
  comments broke the suite on the first run — use ASCII punctuation in `server/` and `src/`.
- `discoveryEngine.ts` was refactored upstream mid-session: the inline duplicate check at the
  auto-qualified site became a `tryAddQualifiedLead(lead)` helper that returns `boolean`. Re-read
  before editing; this file moves often.
- **The test suite writes to the real database.** Tests call `getLeadsDb()` directly, so `npm test`
  mutates `.apex-data/apex-crm.sqlite` (2,195 leads at the time of writing) rather than a temp
  file. There is an `APEX_DB_PATH` env var for pointing at a throwaway DB. Worth isolating — a
  failing test can leave real data behind.
- **Two SQLite facts that shaped the H5 fix** (both verified empirically against `node:sqlite`,
  neither is obvious):
  - You **cannot create triggers on a virtual table** (`cannot create triggers on virtual tables`),
    which rules out maintaining an id→rowid map from `leads_fts` itself. It has to be driven from
    the `leads` triggers.
  - `INSERT OR REPLACE` **does not work inside a trigger fired by `INSERT … ON CONFLICT DO UPDATE`**
    — it raises `UNIQUE constraint failed` instead of replacing. Use an explicit
    `ON CONFLICT(id) DO UPDATE SET …`. `last_insert_rowid()` *does* correctly reflect an fts5
    insert, which is what makes the rowid map possible.
