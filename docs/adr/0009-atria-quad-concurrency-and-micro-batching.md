# 9. Atria Quad Concurrency (4 Slots) & Micro-Batching (2-3 Profiles)

Date: 2026-10-08

## Status

Accepted

## Scope

This ADR covers the architectural resolution of mining session latency bottlenecks across [`extractStage.ts`](../../server/leadSearch/stages/extractStage.ts), [`judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts), [`llm.ts`](../../server/services/llm.ts), and engine configuration validation ([`configValidation.ts`](../../server/configValidation.ts)).

---

## Context

Telemetry analysis of 987 live Atria calls from `llm_stage_logs` revealed that Atria generates tokens sequentially at **~36.9 tokens/sec** with an $R^2 = 0.94$ linear correlation between generated output tokens and call latency:
* **Micro-calls (<500 tokens)** executed ultra-fast in **14s–35s**.
* **Heavy calls (>2,000 tokens)** took **150s–300s**, inflating overall mining round durations to 4–5 minutes.

Two root architectural causes were identified:
1. **Monolithic Default Batch Sizing**:
   - `extractStage.ts` defaulted to `maxBlocksPerChunk = 6` evidence blocks per chunk.
   - `judgeStage.ts` defaulted to `configuredMaxBatchCandidates = 10` candidates per batch.
   - A single ambiguous candidate forced a 2,500+ token chain-of-thought deliberation loop, locking the entire monolithic batch for up to 5 minutes.
2. **Batch & Concurrency Mismatch**:
   - In past configurations, concurrency was set to 4 while batches remained monolithic (6–10 candidates).
   - This caused up to 32 candidates in flight generating ~8,000–12,000 output tokens simultaneously, causing vLLM KV-cache contention and stalls.
   - Large judge batches also prevented rolling pool early stopping, evaluating all 10 candidates even when the target quota was met by candidate #2.

---

## Decision

We introduce coordinated architectural updates across extraction, judging, and provider concurrency:

### 1. Atria Quad Concurrency (4 Slots)
- Configured Atria to handle up to 4 concurrent requests simultaneously:
  - `ATRIA_CONCURRENT_SLOTS=4`
  - `LEAD_EXTRACTION_CONCURRENCY=4`
  - `FINALIST_JUDGE_CONCURRENCY=4`
- Handled through `runProviderQueue` (extraction) and `runRollingPool` (judging).
- When a 5th request arrives while all 4 slots are occupied, it safely queues in `waitForProviderSlot` without leaking slots or crashing.

### 2. Micro-Batch Chunking (2–3 Profiles per Request)
- **Extraction Stage**:
  - Reduced default `maxBlocksPerChunk` in [`extractStage.ts`](../../server/leadSearch/stages/extractStage.ts) from `6` to `3`.
  - Tunable via `LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK=3`.
  - Output token payload per chunk capped at ~400–600 tokens, keeping individual extraction calls in the **~20s–35s** latency bracket.
- **Judge Stage**:
  - Reduced default `configuredMaxBatchCandidates` in [`judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts) from `10` to `2`.
  - Tunable via `FINALIST_JUDGE_MICRO_BATCH_SIZE=2`.
  - Keeps individual judge calls under ~500 tokens for clear candidates.
  - Preserves rolling-pool early stopping (`shouldStop: () => completedBatches > 0 && cushionReached()`), skipping remaining batches once the quota cushion is satisfied.

### 3. Startup Configuration Guardrails
- In [`configValidation.ts`](../../server/configValidation.ts), added validation checks for:
  - `ATRIA_CONCURRENT_SLOTS > 4` (warns against KV-cache saturation).
  - `LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK > 5` (warns against latency inflation).
  - `FINALIST_JUDGE_MICRO_BATCH_SIZE > 5` (warns against early-stopping loss).

---

## Consequences

- **Positive**: Mining session round latency reduced from **~220s–270s down to ~35s–50s**.
- **Positive**: 8–12 candidates in a round are extracted and judged in a single parallel wave of ~30–40 seconds.
- **Positive**: Small batches isolate ambiguous candidates, preventing a single borderline prospect from blocking sibling candidates.
- **Positive**: Full test suite passing across all unit, integration, and concurrency tests.
