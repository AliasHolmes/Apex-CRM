# 18. LLM Error Elimination, Nuance Preservation, and Dynamic Timeout Hardening

Date: 2026-10-30

## Status

Accepted (amends ADR-0016 and ADR-0017)

## Scope

This ADR covers architectural resilience, contract compiler token headroom, and nuance-preserving evidence retention following telemetry analysis of mining session `7885bcac`:
- Contract compiler token headroom expansion (4,096 tokens base floor, $0.75\times$ prompt scale) in [`server/leadSearch/discoveryEngine.ts`](../../server/leadSearch/discoveryEngine.ts)
- Dynamic single-candidate judge timeout scaling (150s standard / 180s dense Tier 3 profiles) in [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts)
- Dual-layer timeout decoupling and Cloudflare edge boundary isolation in [`server/services/llm.ts`](../../server/services/llm.ts)
- Canonical transient error classification unification (`isTransientLLMError`) in [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts)
- Nuance-preserving multi-anchor evidence windowing (`extractNuancedEvidenceWindows`) and raw profile scan expansion (24,000 chars) in [`server/leadSearch/finalistJudge.ts`](../../server/leadSearch/finalistJudge.ts)
- Environment variable documentation alignment in [`.env.example`](../../.env.example)

---

## Context

Forensic telemetry analysis of mining session `7885bcac` (5-predicate B2B outbound agency brief) demonstrated high yield (**20/20 verified leads** delivered in 2 rounds over 20m 51s with an 80.9% drop in token burn to 4,505 tok/lead). However, the session recorded 5 LLM errors (1 compiler truncation + 4 incremental judge timeouts):

1. **Contract Compiler Output Truncation**:
   The prompt compiler ceiling was hardcoded at `Math.max(2500, Math.ceil(contractPrompt.length / 2))`. For multi-predicate briefs (e.g. founder title, 3–12 headcount, US/UK geo, Clay/Instantly/Smartlead stack, and high software task costs), Gemini 3.8 Flash High generating internal thinking tokens alongside an extensive schema exceeded 2,500 tokens, triggering OmniRoute `finish_reason: length`.
2. **Incremental Judge Single-Candidate Timeouts**:
   Bright Data Pro Tier 3 enrichment returned comprehensive LinkedIn profiles exceeding 15,000 characters. Single-candidate judging (`batch.length === 1`) under `TASK_REASONING_EFFORT='high'` required 130–145 seconds to cross-evaluate all 5 predicates. Because the single-candidate timeout floor was hardcoded at 120s, `AbortController` aborted the HTTP stream at exactly 120.1s.
3. **Dual-Layer Clamping Bug in `llm.ts`**:
   `computeByesuDynamicTimeoutMs` contained an independent `singleCeiling = Math.max(90_000, Number(process.env.SINGLE_CANDIDATE_TIMEOUT_MS || 120_000))` that clamped single-candidate calls back to 120s regardless of caller `requestedTimeoutMs`.
4. **Ad-Hoc Regex Defect in Judge Error Recovery**:
   `judgeStage.ts` used an ad-hoc regex `/timeout/i` that failed to match `"[OmniRoute] LLM request timed out after 120s"` due to the space in `"timed out"`, treating timeouts as non-retryable and marking candidates unverified within 36ms.
5. **Premature Evidence Slicing & Loss of Subtle Profile Signals**:
   In `finalistJudge.ts`, `clean(item.text, Math.max(2000, dynamicEvidenceChars + 200))` sliced raw profile text at 4,200 characters before any windowing occurred, silently discarding all text after char 4,200 (where client recommendations, certifications, and older roles lived). Furthermore, the windowing logic centered on the *first* matching term only, dropping subsequent terms deeper in the profile.

---

## Decision

### 1. Contract Compiler Headroom Expansion

- In `discoveryEngine.ts`, `contractMaxTokens` floor is raised from **2,500 to 4,096 tokens**, with dynamic scaling: `Math.max(4096, Math.ceil(contractPrompt.length * 0.75))`.
- Accommodates reasoning tokens plus exhaustive contract JSON, guaranteeing contracts are normalized, healed, and cached across 7-day windows without truncation.

### 2. Dynamic Single-Candidate Judge Timeout (150s–180s)

- In `judgeStage.ts`, single-candidate timeout floor scales dynamically:
  - Standard candidate prompts ($\le 2,000$ estimated tokens): **150,000ms (150s)**
  - Dense Tier 3 profile prompts ($> 2,000$ estimated tokens): **180,000ms (180s)**
- Overridable via `LLM_FINALIST_SINGLE_TIMEOUT_MS` or `SINGLE_CANDIDATE_TIMEOUT_MS`.

### 3. Dual-Layer Decoupling & Cloudflare Safety Isolation

- In `server/services/llm.ts` (`computeByesuDynamicTimeoutMs`), `singleCeiling` respects `Math.max(90_000, defaultCeiling, requestedTimeoutMs || 0)`.
- For non-Cloudflare targets (local OmniRoute), `defaultCeiling` is **180,000ms**.
- For Cloudflare targets (Byesu fallback), `CLOUDFLARE_MAX_TIMEOUT_MS` (**115,000ms**) remains strictly enforced to prevent unhandled 524 HTTP gateway cutoffs.

### 4. Canonical Transient Error Unification

- In `judgeStage.ts`, replaced ad-hoc regex with canonical [`isTransientLLMError(error)`](../../server/leadSearch/sessionHelpers.ts#L164-L168) from `sessionHelpers.ts`.
- Ensures `"timed out"` with spaces, socket hang-ups, and 5xx errors are correctly recognized as retryable.

### 5. Nuance-Preserving Multi-Anchor Evidence Windowing

- In `finalistJudge.ts`, `clean()` raw scan capacity is expanded from 4,200 to **24,000 characters**.
- Implemented `extractNuancedEvidenceWindows(rawText, terms, maxChars)`:
  - Preserves opening headline/summary and recent career roles.
  - Extracts contextual spans ($\pm 350$ chars) around **all distinct contract terms** across the entire text (e.g. founder title at char 200, Clay in experience at char 5,500, Smartlead in recommendations at char 11,200).
  - Merges overlapping windows and connects disjoint spans with `\n[...]\n`.
  - **Zero profile sections deleted**: Client recommendations, certifications, awards, and project histories remain fully searchable and preserved.
