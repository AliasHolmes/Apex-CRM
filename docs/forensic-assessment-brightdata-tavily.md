# Forensic Assessment: Bright Data & Tavily Data Flow → LLM Utilization

Generated: 2026-09-18 · Scope: all first-party code under `server/`, `src/` (read-only assessment, no code changes)
Method: static trace of every call site, fallback chain, and LLM consumption boundary for both providers.

---

## 1. Executive summary

The integration architecture is **defense-in-depth and unusually disciplined**: every provider
call is classified (11 Bright Data reason codes + Tavily key-rotation errors), retried with
backoff where productive, key-rotated, circuit-broken with cooldown ladders, traced, and
credit-reserved at both session and monthly scope. Cancellation is threaded through every paid
boundary. However, the forensic trace found **one high-impact data-flow defect** (paid evidence
upgrades being ~72% truncated before the extraction LLM ever sees them), **one known
high-impact performance gap** (no LLM completion cache; 79% of wall clock is LLM latency), and
a handful of medium/low optimization opportunities detailed in §6.

**Top finding (F1):** `buildCleanEvidence` caps snippets at 500 chars, but the Bright Data
batch-upgrade and Tavily extract-upgrade paths deliberately write up to 1,800 chars into
`item.content` beforehand. The upgraded payload is truncated back to 500 chars at the
evidence-block boundary, so roughly 72% of every paid evidence upgrade never reaches the
extraction LLM — while `inferTavilyEvidenceQuality` simultaneously labels those items "good"
(raw length ≥ 700), meaning quality metadata and actual LLM-visible content disagree.

---

## 2. Provider integration inventory

### 2.1 Tavily (`server/services/llm.ts`)

| Aspect | Implementation |
|---|---|
| Transport | Direct REST `fetch` to `api.tavily.com/search` + `/extract` |
| Auth | Bearer header; `ApiKeyPool` with rotation, rate-limit cooldown (60s default), transient cooldown (15s after 3 consecutive) |
| Search surface | depth basic/fast/ultra-fast/advanced (validated), topic general/news, time_range, country (normalized against the official 195-entry enum + ISO/alias map → prevents 400s), include/exclude domains (normalized URL→host, deduped, cap 30), max_results 1–20, chunks_per_source 1–3 (advanced/fast only, matching API docs), include_raw_content (opt-in via env, default **off**) |
| Extract surface | 1–20 URLs, extract_depth basic/advanced, chunks_per_source 1–5, format markdown, per-call timeout 1–120s passed as body param |
| Timeouts | Search: hard 30s abort. Extract: configurable, default 30s |
| Callers | `retrieveStage` (Tavily lane), BD failure fallbacks (search + scrape), `extractStage` evidence upgrades, `siteProbe`, `linkedinPostIntent` fallback, `companyIntent` fallback, `/api/scrape-url`, `/api/search` |

### 2.2 Bright Data (`server/services/brightdata.ts`, 2,235 lines)

| Aspect | Implementation |
|---|---|
| Transport | **Dual**: hosted StreamableHTTP (`mcp.brightdata.com/mcp?token=…`) default for free tier; local stdio child (`node_modules/@brightdata/mcp/server.js`) default for Pro, with `BRIGHTDATA_MCP_TRANSPORT=auto|hosted|local` override |
| Auth | Key pool (`BRIGHTDATA_API_TOKEN`/`_TOKENS`/`API_TOKEN`) with per-key failure marking, generation-guarded client lifecycle, token fingerprint surfaced in status |
| Tools | `search_engine` (google default; bing/yandex; sticky-Bing after 2 Google challenges), `scrape_as_markdown`, `scrape_batch` (availability probed via `listTools`, 5-URL hard contract, chunked), `scrape_as_html`, `search_dataset` (Pro), LinkedIn `web_data_*` person/company/jobs/posts (Pro), free-tier capability gating via `freeTier.ts` |
| Error taxonomy | 11 reason codes (auth/quota/config/invalid/transport/transient-15s-lockout/blocked/rate-limit…) mapped to retryable / providerDisabled / clearClient decisions; SERP challenge & lockout responses deliberately non-retryable (BD enforces ≥15s per-query lockout; retry <15s is guaranteed rejected) |
| Resilience | Cooldown ladder 30s/60s/5min; empty-body SERP recovery (1 retry, 1.5s) for momentary 200-empty responses; `executeBrightDataSearchWithRetry` (exp backoff + jitter, cap 2); proactive recovery probe; stderr filter for known transient child-process noise |
| Health | `getBrightDataStatus()` health state machine (unconfigured/idle/ready/degraded/transport_reconnecting/provider_disabled) surfaced in traces and `/api/system-info` |

---

## 3. Data flow map (main discovery pipeline)

```
brief ──▶ prospectContract ──▶ [plan]  LLM strategist ──▶ query plan items
                                     ▲ (historical yield from SQLite query_performance)
                                     │
[retrieve] Wave 1 (parallel)  ──▶ Tavily lane (conc 3)  ──▶ items
             Tavily zero-SERP cliff ──▶ constraint ablation re-query (Tavily)
             BD lane "unconditional" (conc 2): search_engine google→bing(sticky)→ per-query
                 BD-fail ⇒ Tavily fallback
             BD dataset lane (Pro, 1 plan/round, gd_l1viktl72bvl7bjuj0, search_after cursor)
             Wave 2: conditional BD plans only if Tavily yield underdelivers
                                     │
[fuse]     identity-keyed corroboration fusion (LinkedIn username canonical) ──▶
             signal/account lanes → SignalStore; person lane → dedupe vs CRM + seen
             deterministic pre-rank (contract-term density, exec-role, corroboration)
                                     │
[extract]  Stage 2.5 pre-filter gate (0ms, no LLM): CRM dups, non-LinkedIn rescue from snippet
             thin pages (<420 chars):
               1) BD scrape_batch (≤8 URLs)          ← per-URL fallback → scrape_as_markdown
               2) leftovers → Tavily extract (basic, 1 chunk/source)
               both write item.content += markdown.slice(0,1800)
             evidence blocks = buildCleanEvidence → 500-CHAR CAP  (see F1)
             token-dieted chunks (~2k evidence tokens/chunk) →
             extraction LLM (openAIStructured, sequential global queue, circuit breaker,
               Atria dynamic timeouts 120–180s, chunk retries ≤2)
                                     │
[verify]   deterministic hard-requirement checks + borderline band
                                     │
[enrich]   post-filter: positive+negative enrichment caches (batched) ─▶
             authwalled: free tier → snippet grounding; Pro → 3-tier waterfall
               (dataset URL lookup <1s → live snapshot 20–60s → snippet grounding)
             public: BD scrape_batch → parseLinkedInEvidence → cache write (TTL)
             site probe (native fetch w/ SSRF guards → Tavily extract → BD scrape)
             Phase 5 LinkedIn post intent (BD search → Tavily fallback → LLM classifier)
             company intent (BD dataset/company profile + TF-IDF)
                                     │
[judge]    micro-batches of 4 → evidence-dieted prompt (≤3 items × 500 chars,
             term-anchored cropping) → LLM judge → validation, split-retry on omissions
                                     │
[select]   Pareto skyline + MMR  ──▶ [persist] SQLite + FTS + exclude-list
```

Auxiliary consumer paths outside the engine:

- `/api/scrape-url`: Tavily search → concatenated `text` → single structured LLM call
  (`singleProfileSchema`). The LLM here consumes the **raw un-truncated** Tavily text
  (contrast with the engine's 500-char diet).
- `/api/scrape-pasted`, `/api/chat`, outreach prompt generation: LLM-only, no provider data.
- `scrapeAsMarkdown` service (ScrapeWorkspace, siteProbe deep paths): BD → native HTTP scrape
  (manual redirects, SSRF re-validation per hop, JSON-LD + meta extraction) → Tavily extract
  fallback. Authwalled hosts (linkedin.com, x.com, facebook, instagram, tiktok) short-circuit
  to `null` before any network call.

---

## 4. How the LLM actually consumes provider data

| LLM consumer | Input it sees | Provider data visible | Diet |
|---|---|---|---|
| **Strategist** (`planStage`) | contract + historical yield + previous-round summary + discovered companies | **None raw** — only aggregate performance (DB `query_performance`: runs decayed 0.95, duplicates, requirement-fail digest) | ~800 output tokens, temp 0.1 |
| **Extraction** (`extractStage`) | evidence blocks: `SOURCE_PROVIDER` + LINK + TITLE + `[TAVILY SNIPPET]` + snippet | SERP snippets, BD batch-upgrade & Tavily-extract upgrades — **all truncated to 500 chars** | ~2k evidence tokens per chunk, 16–6 blocks (round-dependent), temp 0.0 |
| **Judge** (`judgeStage`) | per candidate: e0 (name/title/company, 400) + evidenceBlock + snippets | enriched evidence, dataset dossiers, site-probe signals | ≤3 items × 500 chars, term-anchored crop, temp 0 |
| **Post-intent classifier** (`linkedinPostIntent`) | post snippets joined, ≥50-char gate | BD/Tavily SERP post results | small, one call/lead |
| **Company-hint fallback** (`observations.ts`) | 400 chars of snippet | BD/Tavily SERP | maxTokens 40 |
| **`/api/scrape-url`** | full concatenated Tavily text | raw | un-dieted |

**Observations on utilization quality:**

1. **Provenance is preserved end-to-end** — `sourceProvider`, `sourceCount`, `corroborated`,
   `sourceQueries`, `lanes` flow from retrieval through fusion into evidence meta, scoring
   (corroboration and provider quality are scoring inputs), and the judge prompt header. This
   is the strongest part of the design: the LLM and the deterministic scorer see *where* each
   fact came from.
2. **The strategist never sees retrieval data — by design.** Its feedback loop is aggregate
   yield stats, which is cheap and closed-loop, but means query adaptation reacts to
   *counts*, not *content*. Failures like "all snippets were LinkedIn directory pages" are
   invisible to it unless they manifest as rejections.
3. **Evidence diets are aggressive but principled**: the judge diet preserves the first item,
   then term-matching items, and crops around the first acceptable-term match rather than
   blunt truncation. Good pattern.
4. **The `[TAVILY SNIPPET]` label is hardcoded** in `buildCleanEvidence` regardless of actual
   provider, while `SOURCE_PROVIDER:` above it is accurate. The extraction LLM is instructed
   to "Preserve SOURCE_PROVIDER" — the contradicting label is noise the model must reconcile
   (minor, but it's a provenance-integrity defect in the exact place provenance matters).

---

## 5. Resilience & correctness findings (what's working well)

- **Layered fallbacks, no naked calls**: engine-level wave 2 → query-level BD→Tavily →
  engine-level Google→Bing sticky → tool-level scrape BD→native→Tavily → cache-level
  positive/negative enrichment cache with TTL (0.25 days for login-walls). Every lane has a
  next step; total provider outage degrades to deterministic paths rather than failure.
- **SERP lockout physics respected**: challenge/lockout responses classified non-retryable →
  immediate Tavily fallback instead of a guaranteed-rejected <15s retry (documented rationale
  in code). Empty-200 transient is distinguished from challenge via "Response snippet"
  presence and retried exactly once — a correct split of two superficially identical errors.
- **Cancellation is honored at every paid boundary** (session abort signals threaded through
  searches, scrapes, batch retries, LLM queue, even jitter sleeps) — cancelled sessions stop
  spending credits.
- **Credit accounting is double-booked** (session free-tier budget + monthly SQLite
  reservation) with per-query-run `providerUnits` attribution that survives into
  `query_performance` for the strategist's closed loop.
- **SSRF hardening on all native fallbacks** (`privateHosts.ts`, per-hop re-validation,
  redirect cap 3).
- **Telemetry is forensic-grade**: per-operation traces (latency, counts, provider status,
  classified reason codes, LLM summaries via `summarizeLLM`, attempt chains), debug logs
  capped at 500, Langfuse traces, `brightDataStats` rejection taxonomies.

---

## 6. Findings & optimization opportunities (ranked by leverage)

### F1 — HIGH: Evidence upgrade truncation mismatch (`extractStage.ts`)
BD batch upgrade (line ~458) and Tavily extract upgrade (line ~555) both do
`item.content = [item.content, markdown.slice(0, 1800)].join("\n")`, and
`item.raw_content` receives the full markdown. But `buildCleanEvidence` then truncates the
cleaned snippet to **500 chars**, and it prefers `item.content` over `raw_content`.
Net effect: a paid upgrade that fetches a full page contributes at most
`500 − len(original snippet)` chars to the LLM prompt; the rest is discarded before any LLM
sees it, while `inferTavilyEvidenceQuality` (raw ≥ 700 ⇒ "good") tells the scorer the evidence
is rich. **Cost is paid at 1,800+ chars; value delivered is ≤500.**
*Fix direction:* gate the 500-char cap on whether the item was upgraded (e.g., cap at the
upgrade slice length or budget-aware per-block cap), or feed `raw_content` within the
existing chunk token budget — the chunker already handles long blocks gracefully
(`chunkEvidenceBlocksByTokenBudget` truncates pathological blocks at chunk size, not 500).

### F2 — HIGH (known, §9.4 of CODEBASE_INDEX): No LLM completion cache
79% of measured wall clock is LLM latency (extraction 37.8s/call, strategist repeating
across rounds). Cache keyed on provider+model+prompt-hash (contract + round context for the
strategist; evidence-chunk hash for extraction) with TTL would directly attack the dominant
cost. Still the single highest-leverage performance item; every finding below is smaller.

### F3 — MEDIUM-HIGH: Global sequential LLM queue serializes extraction chunks
`withSequentialLLMExecution` (llm.ts:371) serializes **every** completion HTTP call process-wide.
`LEAD_EXTRACTION_CONCURRENCY=2` therefore only parallelizes pre/post-LLM work — actual chunk
completions are strictly serial. With Atria's 120–180s per chunk, a 5-chunk round is 10–15
minutes of serialized latency. *Fix direction:* bounded multi-slot queue (2–3) with per-provider
rate-limit awareness, or per-stage queues — the invariant's goal (avoid 429/524 collisions)
doesn't require full serialization.

### F4 — MEDIUM: Tavily raw content disabled by default
`include_raw_content` defaults off; Tavily snippets are ~200–500 chars, which is why the
pipeline needs the upgrade pass at all (F1's subject). Selectively enabling raw content (or
`advanced` depth) for person-lane queries could fold discovery + evidence into one call for a
subset of queries, eliminating the second extract round-trip for those items. Trade-off:
higher per-query credit vs. fewer upgrade calls — worth measuring per lane via existing
telemetry.

### F5 — MEDIUM (structural, free tier): Authwalled design makes LinkedIn evidence = SERP snippet
`scrapeAsMarkdown` returns `null` for LinkedIn/X/Facebook/Instagram/TikTok before any network
call (correct — markdown scrapers can't pass authwalls). On the free tier, enrichStage grounds
authwalled targets on snippet evidence only. The CRM's *core entity* (a LinkedIn person) is
therefore judged on ≤500-char snippets on free tier, while Pro gets the 3-tier dataset
waterfall. If free tier is the operating mode, the highest-value data the LLM consumes is the
thinnest. *Direction:* the post-intent SERP lane already extracts public LinkedIn post
snippets — that pattern (SERP-visible public surface) is the only free source of LinkedIn
content and could be leaned on harder for profile enrichment.

### F6 — LOW-MEDIUM: Recovery probe produces a false "ready" signal
`probeBrightDataRecovery` treats a `HEAD https://api.brightdata.com` 200 as provider recovery
without exercising `search_engine` — SERP challenges (the most common degraded state) are
invisible to it. The fallback path does run a real search, but only when the HEAD fails.
*Direction:* probe should exercise the actual degraded tool.

### F7 — LOW: Possible double Tavily extract for the same URL in one round
`scrapeAsMarkdown`'s internal fallback chain ends with `tavilyExtractFallback` (single URL);
if that returns <50 chars and the item also lands in `remainingForTavilyExtract`, the outer
extractStage batch calls `tavilyExtract` again on the same URL. A per-round URL set would
deduplicate. Small credit leak, bounded by upgrade caps (≤8 URLs).

### F8 — LOW: Pro dataset lane limited to 1 plan/round
`retrieveStage` slices dataset plans to `.slice(0, 1)` and `enrichStage`'s Tier-2 lookup is
serial per target. On Pro, structured dataset discovery (the richest evidence source — it
skips the extraction LLM entirely for dossier candidates) is under-utilized relative to its
value. `search_dataset` is also clamped to size ≤10 per call, though `search_after` pagination
state is threaded.

### F9 — LOW: Token estimation is chars/4 everywhere
`estimateTokenCount` (llmBudget.ts) has no feedback loop from `onUsage` actuals (which are
already captured per call). JSON-heavy prompts and non-English content drift from the 4
chars/token assumption; the 400-token safety margin absorbs typical drift but adaptive
calibration (track measured inputTokens / prompt chars per provider-model) is nearly free
given the telemetry that already exists.

### F10 — INFO: `[TAVILY SNIPPET]` label hardcoded for all providers
`buildCleanEvidence` emits `[TAVILY SNIPPET]` even for Bright Data–sourced evidence; the
accurate `SOURCE_PROVIDER:` header sits directly above it. One-line provenance-integrity fix
in the exact payload the extraction LLM is told to trust for source attribution.

### F11 — INFO/SECURITY: Hosted MCP token in URL query string
`connectHostedClient` puts the API token in `mcp.brightdata.com/mcp?token=…` (Bright Data's
standard pattern) — tokens can persist in intermediary logs/proxies. If BD supports header
auth on the streamable endpoint, prefer it. Local stdio transport (Pro default) avoids this
entirely.

### F12 — INFO: `dynamicTavilyMaxResults` jumps to 20 on duplication pressure
Round >1 or ≥20% duplicate collision doubles the result window (10→20) — sensible, but it
also doubles the snippet mass flowing into the 500-char-dieted evidence blocks, which mostly
feeds the pre-filter's duplicate rejection. The marginal value of results 11–20 for
person-lane queries is worth a measured look (the rejection telemetry to evaluate this
already exists).

---

## 7. Recommended action order (no code changed — proposals only)

1. **F1 truncation fix** — smallest change, largest data-utilization gain; makes existing
   paid upgrades actually reach the LLM.
2. **F2 completion cache** — attacks the 79% LLM latency share (already the codebase index's
   #1 open item; this assessment concurs).
3. **F3 bounded LLM concurrency** — compounds with F2 for multi-chunk rounds.
4. **F10 label fix + query-context line in evidence blocks** — trivial provenance wins.
5. **F4 raw-content experiment** — one-lane A/B using existing trace telemetry to measure
   yield-per-credit.
6. F6, F7, F8, F9 as opportunistic hardening.

---

## 8. Verdict

The plumbing between Bright Data/Tavily and the LLM is among the most hardened parts of this
codebase — classification, rotation, circuit-breaking, cancellation, caching, and provenance
are all genuinely present and test-pinned. The weakness is not in *reliability* of the data
flow but in *throughput and yield*: the LLM sees provider data through a 500-char keyhole that
discards most of what the paid upgrade paths fetch (F1), pays full price again in serialized
LLM latency for identical work (F2/F3), and on free tier structurally cannot enrich its core
entity type (F5). Fixing F1 and F2 requires touching very little of what currently works.
