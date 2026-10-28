# 16. OmniRoute Primary Architecture with Gemini 3.8 Flash High & Unconstrained Reasoning

Date: 2026-10-24

## Status

Accepted (supersedes ADR-0014 as primary provider; amended by ADR-0017 for 1-candidate micro-splits and clausal isolation)

## Scope

This ADR covers the architectural transition to local OmniRoute (`gemini-3.8-flash-high`) as the Tier 1 primary LLM provider, relegating Byesu (`gpt-6.1-sol`) to secondary fallback, and dismantling legacy Cloudflare-era token, prompt, and concurrency constraints across the discovery engine:
- Primary and secondary provider routing in [`server/services/llm.ts`](../../server/services/llm.ts)
- Prompt instruction unsuppression (permitting native `<think>` deliberation in JSON mode) in [`server/services/llm.ts`](../../server/services/llm.ts)
- Global reasoning effort calibration (`TASK_REASONING_EFFORT` set to `"high"`) in [`server/services/llm.ts`](../../server/services/llm.ts), [`server/leadSearch/stages/planStage.ts`](../../server/leadSearch/stages/planStage.ts), and [`server/leadSearch/stages/extractStage.ts`](../../server/leadSearch/stages/extractStage.ts)
- Modernized token output limits (raising global cap from 16,384 to 65,536 tokens; retry cap to 32,768) in [`server/services/llm.ts`](../../server/services/llm.ts)
- Judge token and capacity synchronization (raising ceiling from 16,000 to 32,000; synchronizing reasoning buffer to 10,000) in [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts)
- Lead extraction chunk expansion and round ceiling unblocking in [`server/leadSearch/stages/extractStage.ts`](../../server/leadSearch/stages/extractStage.ts)
- Evidence budget expansion (from 2,800 to 8,000 chars; 1,500 char crops) in [`server/leadSearch/evidenceSelection.ts`](../../server/leadSearch/evidenceSelection.ts) and [`server/leadSearch/finalistJudge.ts`](../../server/leadSearch/finalistJudge.ts)
- Provider concurrency scaling (OmniRoute 6 slots, judge 4 workers, attribution 6 workers) in [`server/services/llm.ts`](../../server/services/llm.ts), [`server/leadSearch/discoveryEngine.ts`](../../server/leadSearch/discoveryEngine.ts), and [`server/leadSearch/companyAttribution.ts`](../../server/leadSearch/companyAttribution.ts)
- Timeout decoupling (raising planner hard timeout from 35s to 75s, health probe from 8s to 20s, and decoupling non-Byesu endpoints from Cloudflare 115s proxy cutoff) in [`server/leadSearch/plannerRouting.ts`](../../server/leadSearch/plannerRouting.ts), [`server/routes/api.ts`](../../server/routes/api.ts), and [`server/services/llm.ts`](../../server/services/llm.ts)
- Failsafe Groq output expansion (from 950 to 4,096 tokens) in [`server/services/llm.ts`](../../server/services/llm.ts)
- Environment templates in `.env` and `.env.example`

---

## Context

Apex CRM was previously configured around Byesu (`https://byesu.com/v1`) operating behind a strict 120s Cloudflare edge timeout with legacy 4k-8k token envelopes (ADR-0014). To operate within those boundaries:
1. Prompts explicitly banned `<think>` tags and reasoning blocks in JSON mode.
2. `TASK_REASONING_EFFORT` was throttled to `"low"` across almost all analytical stages.
3. Output tokens were clamped to 16,384 globally and 950 on Groq failsafe.
4. Candidate evidence was aggressively cropped (500 chars per sentence, 2,800 chars total budget), starving evaluations of career and company context despite modern LLM 1M-token context windows.
5. Extraction was micro-chunked to 3 blocks per chunk with a 120,000 round ceiling that silently skipped remaining evidence blocks without failure or repair.
6. Non-Byesu endpoints defaulted to 2 slots and judge concurrency was serialized to 1 worker.
7. Hard timeouts (35s for planner, 8s for health checks) caused timeouts during deep chain-of-thought deliberation.

With local OmniRoute (`http://localhost:20128/v1`) serving `gemini-3.8-flash-high` with native reasoning and a 1M token context, these legacy constraints caused false parse errors, low prospect yield, and severe throughput bottlenecks.

---

## Decision

### 1. OmniRoute Primary Provider Chain & Tier Topology

The direct provider candidate chain in [`server/services/llm.ts`](../../server/services/llm.ts) establishes:
- **Tier 1 (Primary)**: OmniRoute (`OPENAI_PROVIDER_NAME="OmniRoute"`, `OPENAI_BASE="http://localhost:20128/v1"`, `OPENAI_MODEL="gemini-3.8-flash-high"`, `OPENAI_CONCURRENT_SLOTS=8`).
- **Tier 2 (Secondary Fallback)**: Byesu (`gpt-6.1-sol`, `BYESU_CONCURRENT_SLOTS=8`), activated if primary fails.
- **Tier 3 (Failsafe Pair)**: Groq (`qwen/qwen3.8-27b`, output limit 4,096 tokens) and OpenRouter/Mistral (`devstral-2512`), engaged only during catastrophic failure or when both primaries are marked OUT.

### 2. Prompt Thinking Unsuppression & Reasoning Effort Calibration

- **`<think>` Ban Removal**: In `openAIStructured`, the JSON mode system prompt now permits `<think>...</think>` internal deliberation while requiring final output to be strictly valid JSON conforming to schema. Downstream regex parsers (`stripReasoningBlocks`, `cleanJSONString`) cleanly isolate and strip thought blocks.
- **Calibrated Reasoning Effort**: `TASK_REASONING_EFFORT` is calibrated by task complexity: `high` on finalist judging, `medium` on contract and strategist, and `low` on extraction, company attribution, and intent classification. This prevents entity parsing calls from burning 5,000+ hidden reasoning tokens, cutting extraction latency to ~10-15s while preserving deep deliberation for candidate qualification.

### 3. Token Budget Modernization (65k Output / 1M Context)

- **Global Output Ceiling**: For reasoning-capable models, `effectiveMaxTokens` is permitted up to **65,536 tokens** (was 16,384).
- **Structured Retry**: Reasoning retry token ceiling expanded to **32,768 tokens**.
- **Judge Token Ceiling**: `computeJudgeDynamicMaxTokens` ceiling raised from 16,000 to **32,000 tokens**. `computeJudgeBatchCapacity` reasoning overhead synchronized to **10,000 tokens** (matching dynamic token allocation).
- **Extraction Micro-Chunking**: Chunk size defaults to **8,000 chars** (max 16,000), provider budget defaults to **64,000 tokens**, blocks per chunk defaults to **3** (max 6), and round output ceiling to **250,000 tokens**. Multiplexing smaller chunks across 8 slots eliminates oversized payload timeouts.
- **Evidence Budgets**: Base evidence budget expanded from 2,800 to **8,000 chars**, sentence crops expanded from 500 to **1,500 chars**, and fallback crops expanded from 300 to **1,000 chars**. Finalist judge evidence expanded to **3,000-8,000 chars** with **8-16 items**.

### 4. Concurrency & Throughput Scaling

- `OPENAI_CONCURRENT_SLOTS`: Shipped default increased from 2 to **8 slots** (code fallback defaults to 8 matching Byesu parity).
- `FINALIST_JUDGE_CONCURRENCY` & `LEAD_EXTRACTION_CONCURRENCY`: Shipped default and code fallbacks increased to **8 workers**, fully consuming the 8 primary provider slots without idle serialization.
- `FINALIST_JUDGE_MICRO_BATCH_SIZE`: Configured to **2 candidates** per batch (later transitioned to **1-candidate micro-splits** under high reasoning in ADR-0017 to eliminate latency thrashing).
- `companyAttribution`: Concurrency clamp relaxed to **8 workers** (defaulting to 4).
- `GROQ_MAX_OUTPUT_TOKENS`: Increased from 950 to **4,096 tokens** to prevent immediate JSON truncation upon failsafe failover.

### 5. Timeout Decoupling & Calibration

- **Cloudflare Edge Decoupling**: Dynamic timeout calculation applies the 115s Cloudflare proxy ceiling strictly to Byesu targets (`isCloudflareTarget = /byesu/i.test(name + baseUrl)`). Local OmniRoute and non-Cloudflare targets scale dynamically up to a **300s** ceiling.
- **Planner Hard Timeout**: `PLANNER_PROVIDER_HARD_TIMEOUT_MS.primary` raised from 35s to **75s** to accommodate multi-step reasoning.
- **Health Check Probe**: `/api/llm-health` probe timeout increased from 8s to **20s** to prevent false-negative timeouts during cold reasoning starts.

---

## Consequences

- High-depth Gemini 3.8 Flash High chain-of-thought deliberation is fully preserved across structured JSON output tasks without token starvation or truncation.
- Search rounds complete with higher candidate yield, richer evidence grounding, and lower latency through 6-slot parallel execution.
- Byesu remains available as a seamless secondary fallback without data leakage to external models.
