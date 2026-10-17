# 14. Byesu Primary Architecture with GPT-6.1 (Decommissioning Atria)

Date: 2026-10-16

## Status

Accepted (supersedes ADR-0011)

## Scope

This ADR covers the architectural transition to Byesu (`gpt-6.1-sol`) as the sole Tier 1 primary LLM provider across the entire Apex CRM engine:
- Provider configuration and registration in [`server/services/llm.ts`](../../server/services/llm.ts)
- Query strategist planner order in [`server/leadSearch/plannerRouting.ts`](../../server/leadSearch/plannerRouting.ts)
- Concurrency and slot sizing in [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts) and [`server/leadSearch/stages/extractStage.ts`](../../server/leadSearch/stages/extractStage.ts)
- Server boot-time configuration validation in [`server/configValidation.ts`](../../server/configValidation.ts)
- Environment templates in `.env` and `.env.example`
- Regression suites: [`test/byesuProvider.test.ts`](../../test/byesuProvider.test.ts) and [`test/byesuConcurrency.test.ts`](../../test/byesuConcurrency.test.ts)

---

## Context

Under ADR-0011, the engine operated an ordered primary chain consisting of Atria as the default-tier primary model and Byesu as the second-priority overflow and strategist provider. 

Following complete exhaustion of Atria API tokens, Atria was decommissioned. Retaining complex self-hosted vLLM workarounds, 10-minute dynamic reasoning timeouts, and HTTP 400 `reasoning_effort` refusal retries added unnecessary complexity.

Apex CRM required:
1. Complete removal of Atria provider registration, vLLM workarounds, and `ATRIA_*` environment variables.
2. Promoting Byesu to the sole Tier 1 primary default provider across all search and evaluation stages.
3. Locking the Byesu model exclusively to GPT-6.1 (`gpt-6.1-sol`) and replacing all legacy `gpt-5.5` references.
4. Retaining Groq and OpenRouter/Mistral as resilient Tier 2 failsafe fallback options.
5. Preserving strict failsafe gating: customer prospect data must never leak to external failsafes on simple parse failures or busy states.

---

## Decision

### 1. Byesu as Sole Tier 1 Primary Provider

Byesu is configured as the sole Tier 1 primary candidate:
- **Provider ID**: `primary`
- **Default Base URL**: `DEFAULT_PRIMARY_BASE = "https://byesu.com/v1"` (trailing slashes stripped via `cleanBaseUrl`)
- **Default Model**: `DEFAULT_PRIMARY_MODEL = "gpt-6.1-sol"` (overridable via `OPENAI_MODEL`)
- **API Key**: `OPENAI_API_KEY` or `BYESU_API_KEY`

All mining pipeline stages (contract compilation, query generation, profile extraction, finalist evaluation, LinkedIn post intent, and copilot chat) route to Byesu `gpt-6.1-sol`.

Deprecated Atria stubs (`isAtriaConfigured() => false`, `isAtriaPrimary() => false`, `resetAtriaReasoningEffortRefusal()`, `computeAtriaDynamicMaxTokens()`, `computeAtriaDynamicTimeoutMs()`) are preserved as inert functions to maintain backwards compatibility with external imports.

### 2. Strict Failsafe Gating Policy

The Tier 2 failsafe pair (Groq and OpenRouter/Mistral) is preserved strictly for disaster recovery:
- Failsafes only activate when Byesu is marked OUT:
  - HTTP 401 / 403 authentication failure
  - HTTP 429 quota exhaustion with error code 1300
  - Consecutive circuit-breaking fatal errors (500 connection failure, 524 Cloudflare gateway timeout) reaching the threshold (default: 4)
- When Byesu is merely busy (all slots occupied), subsequent requests wait cleanly in the in-memory `providerSlotWaitQueue`.
- An invalid JSON parse error on a healthy Byesu response throws directly to the stage rather than leaking customer data to external failsafes.

### 3. Dynamic Timeout Scaling (`computeByesuDynamicTimeoutMs`)

Byesu execution is bounded by Cloudflare proxy limits:
- **Minimum Floor**: 75,000ms (`BYESU_MIN_TIMEOUT_MS` can elevate this).
- **Hard Ceiling**: 115,000ms (`CLOUDFLARE_MAX_TIMEOUT_MS`).
- **Dynamic Workload Scaling**:
  `45_000 + Math.round(estimatedInputTokens * 6) + Math.round(effectiveMaxTokens * 6)`
- Small caller timeouts (< 1000ms) and explicit `hardTimeoutMs` are honored immediately.

### 4. Concurrency & Slot Sizing

| Setting | Default Value | Notes |
| :-- | :-- | :-- |
| `BYESU_CONCURRENT_SLOTS` | **8** | Configured via env; validated with warning if > 16. |
| `LEAD_EXTRACTION_CONCURRENCY` | **8** | Matches provider slot capacity. |
| `FINALIST_JUDGE_CONCURRENCY` | **6** | Capped below slot ceiling to prevent token contention. |

Note: the in-code fallback when `BYESU_CONCURRENT_SLOTS` is entirely unset remains **4**
(legacy of the dual-primary era, and load-bearing for judge-pool regression suites such as
`judgeRollingQueue`); the **8** above is the shipped default in `.env` / `.env.example`
and should always be configured explicitly in deployments.
| `LEAD_PLANNER_PROVIDER_ORDER` | `"primary,openrouter,groq"` | Low-latency query strategist order. |

### 5. Test Suite Modernization

The retired Atria test suites (`atriaProvider.test.ts` and `atriaConcurrency.test.ts`) have been replaced with dedicated Byesu suites:
- [`test/byesuProvider.test.ts`](../../test/byesuProvider.test.ts): Verifies Byesu primary registration, base URL clean-up, `gpt-6.1-sol` dispatch, JSON schema parsing, fence stripping, and failover gating policy.
- [`test/byesuConcurrency.test.ts`](../../test/byesuConcurrency.test.ts): Verifies `computeByesuDynamicTimeoutMs`, Cloudflare safety clamping (115s), `BYESU_CONCURRENT_SLOTS` slot tracking, slot wait queuing, and clean abort signal handling.
