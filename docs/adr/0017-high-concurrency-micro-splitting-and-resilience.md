# 17. High-Concurrency Micro-Splitting, Clausal Intent Isolation, and Cooldown Resilience

Date: 2026-10-28

## Status

Accepted (amends ADR-0016)

## Scope

This ADR covers resilience, throughput, and accuracy upgrades to the discovery engine under OmniRoute Gemini 3.8 Flash High primary execution:
- 1-candidate micro-batching for finalist judging (`FINALIST_JUDGE_MICRO_BATCH_SIZE=1`) across 8 parallel slots in [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts)
- Dynamic judge timeout scaling (120s floor for 1 candidate, scaling with candidate count) in [`server/services/llm.ts`](../../server/services/llm.ts)
- Clausal intent tail isolation and automatic soft signal extraction in [`server/leadSearch/prospectContract.ts`](../../server/leadSearch/prospectContract.ts)
- Prepositional company extraction disambiguation (`[Role] of [Function]` vs `at [Company]`) in [`server/leadSearch/prospectContract.ts`](../../server/leadSearch/prospectContract.ts)
- Enterprise admission gate protection in [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts)
- OmniRoute 429 cooldown backoff tracking (`model_cooldown` and `reset_seconds` parsing) in [`server/services/llm.ts`](../../server/services/llm.ts)
- Domain extension rejection and LinkedIn vanity handle sanitization in [`src/utils/leadDedupe.ts`](../../src/utils/leadDedupe.ts) and [`server/leadSearch/stages/extractStage.ts`](../../server/leadSearch/stages/extractStage.ts)

---

## Context

Following the transition to OmniRoute proxying `gemini-3.8-flash-high` with unconstrained reasoning (`TASK_REASONING_EFFORT='high'`) across 8 concurrent slots (ADR-0016), live discovery sessions on complex, non-agency briefs revealed several operational bottlenecks and accuracy edge-cases:

1. **Reasoning Thrashing on Multi-Candidate Micro-Batches**:
   With `TASK_REASONING_EFFORT='high'`, Gemini 3.8 Flash High produces 8,000 to 15,000 reasoning tokens per prompt. In batches of 2 or 3 candidates, the combinatorial evaluation of multiple candidate careers against complex contracts pushed single-call durations to 120-180 seconds, risking provider timeouts and stalling the rolling pool early-stop mechanism.
2. **Clausal Intent Contamination**:
   Briefs containing conversational intent phrases (e.g. *"Heads of People at Series B SaaS companies who post about compensation benchmarks"*) had the trailing clause (*"who post about compensation benchmarks"*) appended to the target company name or industry slot during deterministic contract compilation. This produced corrupted search queries (`site:linkedin.com/in "Series B SaaS companies who post about"`) and caused downstream company attribution to fail.
3. **Prepositional Company Extraction Confusion**:
   Syntactic extraction of company names using naive prepositional anchors frequently matched *"Head of Sales"*, *"Director of Engineering"*, or *"VP of Product"*, misidentifying *"Sales"*, *"Engineering"*, and *"Product"* as target company names.
4. **Admission Gate Enterprise Withholding**:
   The primary admission gate (`evaluatePrimaryAdmission`) in `judgeStage.ts` withheld candidates whose attributed companies were not verified agencies. While appropriate for agency-specific briefs, this caused false-positive withholding for enterprise corporate briefs where the prospect contract did not require an agency business model.
5. **OmniRoute 429 Cascades**:
   When OmniRoute returned HTTP 429 with specific cooldown bodies (e.g. `{"error": "model_cooldown", "reset_seconds": 15}`), immediate retries across 8 concurrent workers triggered cascading 429 loops and rapid slot starvation.
6. **Domain Handle False-Flags**:
   Public search snippets containing website domains in LinkedIn profile URL paths (e.g. `https://linkedin.com/in/humanintheloopservices.com`) were accepted as personal LinkedIn handles, creating ghost CRM records and broken profile links.

---

## Decision

### 1. 1-Candidate Micro-Splits for Finalist Judging

- In `judgeStage.ts`, the default micro-batch size is set to **1 candidate** (`FINALIST_JUDGE_MICRO_BATCH_SIZE=1` when unset or configured).
- Workloads multiplex across the 8 parallel provider slots (`FINALIST_JUDGE_CONCURRENCY=8`).
- Evaluating a single candidate under high reasoning isolates the chain-of-thought deliberation to that candidate alone, dropping latency to ~30-45 seconds per call.
- The rolling pool can halt immediately upon satisfying the target cushion without discarding in-flight multi-candidate evaluations.
- Dynamic timeout in `llm.ts` scales to 120s for 1 candidate, scaling proportionally for larger batches if explicitly overridden.

### 2. Clausal Intent Tail Isolation & Soft Intent Routing

- In `prospectContract.ts`, clausal intent tails introduced by markers such as `who post about`, `interested in`, `focused on`, `specializing in`, `offering`, `scaling with`, `building`, and `using` are isolated before company and industry segmentation.
- Extracted clausal topics are removed from firmographic name slots and routed into soft `signal` requirements via `addWithAlternatives('signal', ...)`.
- Search query generation remains clean, while the extracted intent signals inform candidate ranking and MMR scoring.

### 3. Prepositional Company Extraction Disambiguation

- `prospectContract.ts` introduces `FUNCTION_ALT` expansion and `roleOfMatches` disambiguation.
- Prepositional phrases matching `[Role] of [Discipline/Function]` (e.g. *Head of People*, *Director of Engineering*, *VP of Design*) are recognized as functional role qualifiers and prevented from leaking into `company_name` or `company_type`.
- Company extraction strictly targets genuine employment prepositions (`at [Company]`, `with [Company]`) or recognized organizational delimiters.

### 4. Admission Gate Enterprise Protection

- In `judgeStage.ts`, `evaluatePrimaryAdmission` now inspects contract requirements and archetypes via `isAgencyContract(contract)`.
- If the brief does not mandate an agency business model, enterprise corporate candidates are protected from false-positive withholding. Corporate decision-makers at legitimate companies pass the admission gate directly into selection.

### 5. OmniRoute 429 Cooldown & Reset Tracking

- `server/services/llm.ts` introduces `providerRateLimitBackoffUntil` tracking keyed by provider name.
- When an HTTP 429 response contains `reset_seconds`, `retry-after`, or a `model_cooldown` error payload, the engine records the exact resume timestamp.
- In-flight request queues for that provider pause dispatch until the cooldown window elapses, preventing retry storms and avoiding downstream rate limit exhaustion.

### 6. Domain Handle Rejection & Sanitization

- `src/utils/leadDedupe.ts`: `isValidLinkedInHandle` rejects any handle containing domain extensions (`.com`, `.ai`, `.org`, `.io`, `.net`, `.co`, `.co.uk`, etc.).
- `extractStage.ts`: When an extracted profile URL or vanity slug matches a corporate domain or company entity rather than an individual person, the handle is discarded and the domain is rescued to `contactDetails.website`.
- The negative extraction prompt in `extractStage.ts` explicitly instructs the model to omit corporate entity URLs from individual candidate extractions.

---

## Consequences

- Finalist judging runs reliably across 8 slots in ~30-45s per candidate, completely eliminating high-reasoning timeout stalls.
- Brief compilation produces clean company and industry requirements, eliminating corrupted query generation.
- Enterprise leads are appropriately qualified without false-positive admission drops.
- Provider rate limits are managed cleanly with dynamic cooldown backoffs.
- Zero ghost domain profiles or broken LinkedIn URLs are committed to the CRM.
