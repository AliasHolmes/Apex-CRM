# 11. Atria-Primary Engine with Byesu Second-Priority Chain

Date: 2026-10-09

## Status

Accepted (supersedes the secondary-go-to variant of this ADR, which was rejected in review)

## Scope

This ADR covers the provider routing and concurrency policy of the LLM gateway ([`server/services/llm.ts`](../../server/services/llm.ts)), the fast-tier strategist order ([`server/leadSearch/stages/planStage.ts`](../../server/leadSearch/stages/planStage.ts)), boot-time configuration guardrails ([`configValidation.ts`](../../server/configValidation.ts)), slot-utilization observability ([`server/routes/api.ts`](../../server/routes/api.ts)), the `.env` defaults, and the routing regression suites (`test/atriaConcurrency.test.ts`, `test/atriaProvider.test.ts`, `test/optimalConcurrencyAndMicroBatching.test.ts`, `test/llmUntrustedMessage.test.ts`, `test/llmRoutingPolicy.test.ts`, `test/compactJudgeGrounding.test.ts`, `test/plannerRoutingOverride.test.ts`).

---

## Context

Under ADR-0007/ADR-0009 the primary tier ran **Atria and Byesu as a pair with 4 slots each**: every default-tier call went to Atria while it had free slots and **spilled to Byesu once Atria's 4 slots filled**.

Telemetry from live sessions (October 2026) showed two problems:

1. **Measured overlap of only 1.36x** in session `dd203cd8` (34.4m of LLM call time inside a 25.2m session). Round 3 proved 4 Atria extraction calls can launch in the same second (2.74x local overlap), so the pipeline supports more parallelism than the 4-slot ceiling allowed.
2. **Byesu burned long reasoning payloads**: `dd203cd8` round 1 ran two Byesu judge calls at **4.9 minutes each** - the slowest calls in the session. The provider stress test (October 9, 2026) separates the two providers cleanly: Atria sustained **8 concurrent requests with 100% success and zero 429s (~88.8 tok/s)**, while Byesu sustained **500 concurrent requests at 99.88% success at ~3-5s per 500-token prompt** - its strength is burst volume on small prompts, not multi-minute reasoning payloads.
3. **The slot ceiling could never bind**: stage-level concurrency (`LEAD_EXTRACTION_CONCURRENCY=4`, `FINALIST_JUDGE_CONCURRENCY=4`) matched the provider slot count, and `configValidation.ts` warned above `ATRIA_CONCURRENT_SLOTS=4`.
4. **The strategist had no engine fallback**: `resolvePlannerProviderOrder()` returned `["primary", "openrouter"]`, skipping the engine provider entirely on a planner failure.

A first iteration of this ADR made Byesu a **"secondary-go-to"** - in the chain only when Atria is OUT. Review rejected that: it silently removed the per-call second attempt that the pair design provided, so a single Atria 524 / parse failure / truncation failed the chunk outright. The correct model is an **ordered chain where Byesu is second priority on every call**.

## Decision

### 1. Ordered primary chain (`withProviderFallback`, `llm.ts`)

The primary tier is an ordered chain, not an outage-only gate:

- **Default tier** (contract, extraction, judge, enrichment, intent): chain = `[atria, primary]`. A call's first attempt goes to the first free, non-cooling chain member - Atria while it has free slots; **when Atria's slots are saturated, the call spills to Byesu instead of queueing**. If the Atria *attempt fails* (5xx, timeout, truncation, parse failure), the call **cascades to Byesu immediately** - no OUT transition required.
- **Fast tier** (query strategist, `planStage.ts` passes `["primary", "atria", "openrouter"]`): the same pair reordered so planning runs on the low-latency router, with Atria as its second choice.
- **Failsafe unchanged**: Groq then OpenRouter/Mistral serve only when Atria *and* Byesu are both out.
- **Cooldown/OUT filtering** still applies inside the chain (a cooling-down or OUT member is skipped, never charged a slot), and the in-pair retry, both-timeout handling, budget, and queue machinery are unchanged.

### 2. Slot and stage concurrency

| Setting | Old | New | Rationale |
| :-- | :-- | :-- | :-- |
| `ATRIA_CONCURRENT_SLOTS` | 4 | **8** | Stress-tested: 8 concurrent = 100% success, ~88.8 tok/s, zero 429s. 10 is documented headroom; a 6-slot KV-cache swap blip in the stress test is why the heaviest stage stays below 8. |
| `BYESU_CONCURRENT_SLOTS` | 4 | **10** | Second priority means Byesu now absorbs real overflow; the stress test sustained 50+, so 10 is conservative headroom for spill + fast tier + outage windows. |
| `LEAD_EXTRACTION_CONCURRENCY` | 4 | **8** | Stage concurrency must be able to fill provider slots; extraction prompts are light. |
| `FINALIST_JUDGE_CONCURRENCY` | 4 | **6** | Heaviest reasoning stage; kept below the Atria ceiling to stay clear of observed KV-cache contention. |

`configValidation.ts` guardrails: warn above `ATRIA_CONCURRENT_SLOTS=10`, above `BYESU_CONCURRENT_SLOTS=16` (newly validated), `LEAD_EXTRACTION_CONCURRENCY` maximum raised to 8.

### 3. Fast-tier strategist order

`resolvePlannerProviderOrder()` returns `["primary", "atria", "openrouter"]` (env override `LEAD_PLANNER_PROVIDER_ORDER` still wins): Byesu for low-latency planning, Atria as the engine's second choice, Mistral behind - which also un-breaks `plannerRoutingOverride.test.ts`.

### 4. Slot utilization observability

`/api/llm-health` reports `activeSlots` and `slotLimit` per provider (sourced from the live slot maps), so saturation is visible next to the existing per-stage `Queue sum` in the round critical-path telemetry.

## Consequences

- **Positive**: Atria at 8 slots with judge 6 and extraction 8 fills the primary model - the measured ceiling (4 concurrent Atria calls, 1.36x overlap) is doubled on the provider axis.
- **Positive**: No single-call hedge is lost - an Atria timeout, 524, truncation, or parse failure still gets an immediate Byesu attempt before the stage sees any error.
- **Positive**: Spill at 10 Byesu slots keeps waves draining when extraction (8) plus judge (6) plus intent calls exceed Atria's 8 slots.
- **Negative / accepted**: with spill restored, Byesu can again receive heavy judge work when waves exceed 8 concurrent calls - bounded by `FINALIST_JUDGE_CONCURRENCY=6` and observable via the new slot telemetry.
- **Operational note**: raise `ATRIA_CONCURRENT_SLOTS` only up to the stress-tested envelope; beyond 10 the startup guardrail warns.
- **Verification**: full LLM suites green; runtime canary must confirm >=6 simultaneous Atria calls and near-zero queue sums on a non-saturated session.
