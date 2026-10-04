# 7. Industry-Agnostic Pipeline Generalization, Schema v24-v26 Persistence, and Provider-Affinity Dual Concurrency

Date: 2026-10-02

## Status

Accepted

## Context

Following the implementation of strict evidence citation grounding (ADR-0006) and deterministic pre-filtering (ADR-0005), two major operational constraints emerged in production:

1. **Domain Bias & Hardcoded Agency/SaaS Taxonomies**: The engine's query strategist, role extraction, and judge prompt contained hardcoded assumptions centered on B2B software agencies and SaaS companies. Briefs for non-tech industries (e.g. healthcare, legal, manufacturing, renewable energy) suffered from inappropriate qualification rules and synthetic US-metro biases.
2. **Provider Concurrency Limits & Upstream Latency Timeouts**: Most OpenAI-compatible LLM endpoints (specifically local/vLLM endpoints such as Atria) enforce a strict concurrency limit of 1 in-flight request. Deep reasoning chain-of-thought models (Atria) have intentional, extended deliberation times (often 100s–150s) that previously exceeded static proxy timeout ceilings, causing timeouts that were misdiagnosed as rate limits and unnecessarily pushed overflow to fallback providers.
3. **Repeated Evaluation Token Waste**: In multi-round searches, candidate profiles already judged in round 1 were repeatedly submitted to LLM judging in later rounds, wasting provider tokens and increasing session latency.

## Decision

We introduce three coordinated architectural improvements across retrieval, persistence, and LLM scheduling:

### 1. Industry-Agnostic Pipeline Generalization
- **Open-Ended Industry Clusters**: In [`server/leadSearch/adaptiveScheduler.ts`](../../server/leadSearch/adaptiveScheduler.ts), the multi-armed bandit (MAB) dynamically creates domain clusters for any business vertical, isolating Thompson-sampling performance scopes without polluting unrelated industries.
- **Dynamic Role Extraction & Synonyms**: In [`server/leadSearch/defaultRoles.ts`](../../server/leadSearch/defaultRoles.ts) and [`server/leadSearch/prospectContract.ts`](../../server/leadSearch/prospectContract.ts), role titles and business functions are extracted dynamically from the brief. Synonym expansion is strictly bounded to the stated term.
- **Universal ISO Country Resolution**: In [`server/leadSearch/geo.ts`](../../server/leadSearch/geo.ts), integrated ECMAScript `Intl.DisplayNames` to recognize all 249 ISO 3166-1 alpha-2 countries and regions while guarding against English two-letter pronoun collisions (`us`, `in`, `me`, `am`, `at`).
- **Brief-Gated Decision-Maker Weighting**: In [`server/leadSearch/scoring.ts`](../../server/leadSearch/scoring.ts), authority weighting is applied conditionally only when the user's brief explicitly requests authority or executive leadership.

### 2. SQLite Schema v24–v26 Persistence
- **Schema v24**: Added `lead_outcomes.scope_key` to attribute closed-loop user disposition feedback directly to the brief's domain cluster.
- **Schema v25 & v26**:
  - `candidate_verdicts`: Persists LLM pass and hard-fail evaluations indexed by canonical LinkedIn identity key (`identity_key`), requirement hash (`requirement_hash`), and evidence hash (`evidence_hash`). Repeat candidate evaluations are served in 0ms without re-invoking the LLM judge.
  - `company_profiles` & `company_attribution_verdicts`: Persists normalized company taxonomy, business models, primary offerings, verified evidence quotes, and per-brief company verdicts.
  - `retrievalCache.ts`: Caches raw search engine results in `search_cache` by query hash, preventing repeat web queries across identical rounds.

### 3. Provider-Affinity Dual Concurrency & Atria Reasoning Headroom
- **Provider-Affinity Concurrency Limits**: In [`server/services/llm.ts`](../../server/services/llm.ts), configured independent 1-slot limits per provider (`ATRIA_CONCURRENT_SLOTS=1`, `BYESU_CONCURRENT_SLOTS=1`).
- **Priority Routing with Safe Parallel Overflow**:
  - In `withProviderFallback`, Atria (primary model) is prioritized whenever idle (`activeSlots === 0`).
  - If Atria is active processing a request, incoming concurrent tasks overflow in parallel to Byesu (secondary model) without blocking or colliding on Atria.
  - If all slots are occupied, tasks wait on `waitForProviderSlot` and immediately attempt Atria first when a slot frees up.
  - Slot acquisition and release are guaranteed via strict `try / finally` blocks and `AbortSignal` listeners.
- **10-Minute Dynamic Reasoning Headroom**:
  - Raised `ATRIA_MAX_TIMEOUT_MS` to `600_000ms` (10 minutes) with a `120_000ms` floor.
  - Enhanced `computeAtriaDynamicTimeoutMs` with scaled token coefficients (`12ms/tok` input, `15ms/tok` max output) to give deep reasoning models ample headroom to complete reasoning chains without timeout aborts.

## Consequences

- **Positive**: The discovery engine works seamlessly across any industry vertical without agency/SaaS hardcoding.
- **Positive**: Atria remains the primary model without suffering 429 rate limits or reasoning timeouts.
- **Positive**: True parallel 2-request concurrency is achieved safely by splitting load across Atria and Byesu rather than overloading a single provider.
- **Positive**: Candidate and company verdict caches eliminate redundant LLM calls across rounds.
- **Positive**: Full test suite passing across all unit, integration, and evaluation suites with 0 regressions.
