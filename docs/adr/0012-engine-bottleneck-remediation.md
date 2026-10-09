# 12. Engine Bottleneck Remediation: Streaming Judge, Caching, and Bright Data Concurrency

Date: 2026-10-09

## Status

Accepted

## Scope

This ADR covers the post-ADR-0011 latency/quality remediation of the discovery engine: the streaming enrichment->judge seam ([`discoveryEngine.ts`](../../server/leadSearch/discoveryEngine.ts), [`enrichStage.ts`](../../server/leadSearch/stages/enrichStage.ts), [`liveRollingPool.ts`](../../server/leadSearch/liveRollingPool.ts)), cache leverage ([`candidateVerdicts.ts`](../../server/leadSearch/candidateVerdicts.ts), [`retrievalCache.ts`](../../server/leadSearch/retrievalCache.ts), [`planCache.ts`](../../server/leadSearch/planCache.ts)), fast-tier routing for the planning family ([`plannerRouting.ts`](../../server/leadSearch/plannerRouting.ts)), judge sizing and adaptive concurrency ([`judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts)), site-probe recovery ([`siteProbe.ts`](../../server/leadSearch/siteProbe.ts)), saturation response ([`planStage.ts`](../../server/leadSearch/stages/planStage.ts)), queue-wait telemetry (schema v27), and Bright Data concurrency (`.env`).

---

## Context

Telemetry from the October 8-9 sessions (notably `dd203cd8`: 25.2m wall, 1.36x LLM overlap; and the pre-0009 baseline: 71.6m median wall) isolated the remaining bottlenecks after the ADR-0011 provider overhaul:

1. **Enrichment was fully serial with judging.** Round 3 of `dd203cd8` ran extract 97.8s -> enrich gap 47s -> judge 308.9s = 454s of strictly serial work.
2. **`BRIGHTDATA_PROFILE_CONCURRENCY=1`** made profile scraping serial: 156-240s of measured scraping per session.
3. **Only `planStage` opted into the fast tier.** Three strategy-phase calls fell to Atria and errored at 45s with zero output (135s burned), while Byesu serves planning in 10-16s.
4. **Judges ran 2-candidate micro-batches at concurrency 6** with 1,892-token median inputs.
5. **Cache leverage was near zero**: `candidate_verdicts` 421 rows but 5-41 hits/session, because `computeEvidenceHash` hashed full evidence *text* - a re-scraped profile's re-worded block missed every time. `retrievalCacheHits` 1-33/session for the same reason at the query grain.
6. **Site probes succeeded only 37-60% of the time** (5/8, 18/50, 15/40) - thin roots skipped subpaths.
7. **Saturated markets collapsed**: `dd203cd8` returned 3/50 with `stopReason: exhausted` while 114 candidates died as CRM duplicates.
8. **Queue wait was invisible** post-hoc (`llm_stage_logs` had no such column), so slot starvation could not be separated from generation time.

## Decision

### 1. Streaming enrichment->judge seam (feature-flag default ON)

`enrichStage` gained an `onTargetsReady(leads)` hook fired at each enrichment completion point (unselected targets upfront, pro-waterfall per target, batch scrape per batch, retry per target, unenriched remainder). `discoveryEngine` submits those leads to a live rolling pool (`liveRollingPool.ts`, concurrency 1 group x 6-8 internal judge concurrency) that runs `evaluateIncrementalJudgeBatches` per group. Three properties make this quality-preserving:

- **The judge prompt never contains site-probe signals** (`evidenceSelection.sourceEvidencePieces` reads evidence blocks and snippets only), so pre-probe judging produces identical verdicts.
- **The primary admission gate reads judge verdicts and company attribution** (computed inside the judge call), not probe outcomes - `companyProbeOutcome` only labels withheld causes.
- **Drain re-checks enrichment acceptance** (`survivedEnrichment`) before committing qualified leads, mirroring the pre-existing deferred auto-qualified commit.

Rollback: `LEAD_PIPELINE_STREAMING_JUDGE=false` restores the wholesale post-enrichment judge path.

### 2. Bright Data concurrency (verified against official docs)

Bright Data's documented Scraper API ceilings are **1,500 concurrent sync `/scrape` requests, 100 per-scraper batch jobs, and 100 async `/trigger` jobs**, and their SERP API states "no limit to the concurrent requests" for funded accounts (unfunded: 1,000 req/min). `BRIGHTDATA_PROFILE_CONCURRENCY` 1->3 and `BRIGHTDATA_SEARCH_CONCURRENCY` 2->4 sit far inside those ceilings. The MCP `web_data_linkedin_person_profile` tool is single-URL, so concurrency (not input batching) is the only lever - URL batching was evaluated and dropped. The pro waterfall now uses the configured concurrency instead of a hardcoded 3. Provider 429s already cooldown 30s->60s->5min (more conservative than the docs' 2/4/8/16/32 ladder); `provider_rate_limit` errors now parse and log the applied limit from the message ("decrease your request rate to N/min").

### 3. Cache leverage

- **Evidence signature hash**: `computeEvidenceHash` now hashes evidence *ids + normalized lengths* instead of full text. Same profile, re-worded re-scrape -> cache hit; changed evidence shape -> miss. Tested for id/length sensitivity and company-attribution exclusion.
- **Market-slice retrieval cache**: `buildRetrievalSignatureKey` (role class, org class, geo anchor, top topic tokens) is written alongside the exact-query key and read as a fallback, so near-duplicate queries across rounds/sessions reuse SERP results.
- **Round plan cache**: in-memory LRU (64 entries, 6h TTL) keyed by domain cluster + search spec + target + maxTasks + saturated metros + signal companies + known entities + prior query count + missing requirements. Gated to non-speculative, non-recovery, post-first, non-stall rounds. Downstream dedupe/signature-exhaustion still apply, so a cached plan can never resurrect an exhausted query.

### 4. Fast tier for the planning family

`resolvePlannerProviderOrder` moved to a shared `plannerRouting.ts` (re-exported from `planStage` for compatibility) and is now passed by `intentSignals` and both `linkedinPostIntent` call sites in addition to the strategist, so low-latency planning never burns a 45s Atria timeout.

### 5. Judge sizing and adaptive concurrency

First judge wave packs batches of 3 (provider capacity permitting; an explicitly configured `FINALIST_JUDGE_MICRO_BATCH_SIZE` stays authoritative for every wave), later waves keep 2 for early-stop granularity. Judge concurrency adapts: `min(8, max(configured, freeAtriaSlots))`. Evidence window raised to 6 items / 1,800 chars via existing env clamps.

### 6. Site-probe recovery

Thin roots (< 400 chars or no signals) now probe `/about`, `/team`, `/services`, `/careers` instead of `/about`, `/team`. Missing roots on **verified** domains (non-slug-guess provenance) probe `/about` instead of being skipped entirely. Negative-cache keying/TTL were reviewed and are correct (host+domain keys, 0.25d TTL); the low `negativeHits` count is expected within a single session because each domain is probed once.

### 7. Saturation response

`planStage` computes the previous round's `duplicate_existing_lead` share. At >= 50% (and not metro-locked): task boost rises to 2.0x, the saturated-metro threshold tightens 20->10, a CRM-saturation directive is injected into the strategist prompt, and 1-3 account-flywheel queries are appended targeting decision-makers at signal-store companies (`buildAccountFlywheelItems`, account lane).

### 8. Queue-wait telemetry (schema v27)

`llm_stage_logs.queue_wait_ms` (migration + fresh-DB column + insert + read mapping) is populated from the summed `providerAttempts[].queueWaitMs`, making slot starvation vs generation time separable in analysis.

## Consequences

- **Positive**: the enrich phase effectively leaves the critical path for the first groups; expected LLM overlap 1.36x -> ~1.8x+ on non-saturated sessions.
- **Positive**: 156-240s of serial Bright Data scraping drops toward 3-4x faster; site-probe success moves off the 37-60% floor.
- **Positive**: verdict and retrieval caches start earning on re-mined markets (the dominant user pattern: 180 sessions across 3 briefs).
- **Negative / accepted**: streaming judges may judge a candidate that enrichment later rejects (bounded by the acceptance phase; the drain-time membership check prevents any wrong commit). Pre-probe verdicts intentionally exclude site signals, which were never in the judge prompt anyway.
- **Verification**: 13 new unit tests + 8 wiring guards green; full suite green; runtime canary must confirm judge calls overlapping the enrich wall (`Queue sum` near zero, `activeSlots` visible via `/api/llm-health`).
