# 19. Single-Candidate Timeout Headroom (210s) and Cross-Provider Judge Retry Escalation

Date: 2026-10-30

## Status

Accepted (amends ADR-0016, ADR-0017, and ADR-0018)

## Scope

This ADR covers architectural timeout calibration and cross-provider retry escalation following forensic telemetry analysis of mining session `ae1f471d`:
- Dynamic single-candidate timeout ceiling expansion from 180s to 210s (`210_000` ms) in [`server/services/llm.ts`](../../server/services/llm.ts)
- Single-candidate judge timeout floor elevation (180s standard / 210s dense Tier 3 profiles) in [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts)
- Cross-provider judge retry escalation (`resolveJudgeRetryProviderOrder`) in [`server/leadSearch/plannerRouting.ts`](../../server/leadSearch/plannerRouting.ts) and [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts)
- Strict adherence to explicit caller `tierProviderOrder` across all configured providers in [`server/services/llm.ts`](../../server/services/llm.ts)
- Environment variable documentation alignment in [`.env.example`](../../.env.example)

---

## Context

Forensic telemetry analysis of post-update session `ae1f471d` (**20/20 verified leads delivered** across 7 rounds over 51m 18s) demonstrated 100% target fulfillment and validated all ADR-0018 fixes (zero contract truncations across 6,329 tokens, zero extraction failures across 48 calls, and successful multi-anchor nuance preservation).

However, forensic inspection of the 5 LLM errors recorded in the session revealed two residual architectural bottlenecks:
1. **Gemini 3.8 Flash High Deliberation Latency Under Dense Dossiers**:
   Single-candidate finalist judging under `TASK_REASONING_EFFORT='high'` produces 4,000 to 11,000 tokens of internal reasoning traces and structured JSON. On complex dossiers (e.g., Paul Beard taking 166.5s, Ben Carden taking 172.4s), normal processing time is 150–175s. Setting the single-candidate HTTP timeout ceiling at 180s left virtually zero margin for network or upstream inference jitter, causing requests to be severed at 180.0s.
2. **Homogeneous Provider Retries on Timeout**:
   When an initial judge evaluation timed out on OmniRoute (`primary`), the retry was dispatched back to the exact same provider (`primary`). If OmniRoute was suffering from a stalled socket or upstream pod lag, the retry also timed out at 180s (as occurred with candidate Josh Kalms). Byesu (`gpt-6.1-sol`), a high-capability frontier model, was never invoked for the retry because `tierProviderOrder` was omitted from judge calls, preventing cross-provider escalation.

---

## Decision

### 1. Elevate Single-Candidate Timeout Ceiling to 210s

- In [`server/services/llm.ts`](../../server/services/llm.ts), `computeByesuDynamicTimeoutMs` now computes `defaultCeiling = isCloudflareBounded ? CLOUDFLARE_MAX_TIMEOUT_MS : 210_000;`. Non-Cloudflare endpoints (e.g. local OmniRoute) are allocated up to 210 seconds of deliberation headroom.
- In [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts), `singleTimeoutFloor` is calibrated:
  - Standard single candidate (`estimatedInputTokens <= 2000`): **180s floor** (was 150s).
  - Dense Tier 3 candidate (`estimatedInputTokens > 2000`): **210s floor** (was 180s).
- Cloudflare-bounded endpoints continue to be strictly protected at 115s (`CLOUDFLARE_MAX_TIMEOUT_MS`).

### 2. Cross-Provider Judge Retry Escalation

- In [`server/leadSearch/plannerRouting.ts`](../../server/leadSearch/plannerRouting.ts), added `resolveJudgeRetryProviderOrder(): string[]` which defaults to `["byesu", "primary", "openrouter", "groq"]` and supports environment override via `LEAD_JUDGE_RETRY_PROVIDER_ORDER`.
- In [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts), when a single candidate or split micro-batch encounters a transient timeout or failure, the retry passes `tierProviderOrder: resolveJudgeRetryProviderOrder()`.
- On retry, rather than sending the request back to the stalled primary provider, the engine immediately routes the candidate to Byesu (`gpt-6.1-sol`), providing diverse upstream infrastructure and completing evaluation in ~30–50s.

### 3. Strict Execution of Explicit `tierProviderOrder`

- In [`server/services/llm.ts`](../../server/services/llm.ts), `withProviderFallback` now detects explicit `tierProviderOrder` upfront. When an explicit order is provided, configured candidate providers are sorted strictly by their position in `tierProviderOrder` (e.g. trying Byesu first if specified before primary), guaranteeing that caller-specified routing policies are fully respected.

---

## Consequences

- Dense candidate profile evaluations now have a comfortable 35–45s safety buffer beyond normal 160–175s reasoning times, eliminating premature 180s cutoffs.
- If OmniRoute encounters an upstream stall, the retry immediately shifts to Byesu (`gpt-6.1-sol`), rescuing candidates without delay or unnecessary downgrades to `unverified`.
- Zero impact on standard calls: default extraction, attribution, and initial judging remain on the primary provider (`gemini-3.8-flash-high`).
