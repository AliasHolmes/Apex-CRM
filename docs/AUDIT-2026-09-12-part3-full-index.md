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
