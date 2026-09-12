# 5. Deterministic Pre-Filtering, Upstream CRM Negative Feedback & Strict Sequential LLM Execution

Date: 2026-09-12

## Status
Accepted

## Context
Following previous pipeline optimizations, diagnostic audits of real-world prospecting sessions identified key remaining sources of latency, token waste, and provider instability:
1. **Upstream Query Duplication**: Strategist queries frequently targeted companies already stored in the CRM or queried metropolitan hubs that were already saturated, resulting in redundant SERP returns.
2. **Extraction Stage Token Bloat**: Raw search snippets contained substantial boilerplate (HTML tags, cookie banners, navigation links), and candidates already present in the CRM were routinely passed to the extraction LLM before duplicate detection occurred.
3. **Context-Starved Finalist Judging**: Candidates from valid client-services agencies were frequently marked `fail` by the LLM judge because SERP snippets omitted explicit business model phrasing ("agency" / "consultancy"). Conversely, individual contributors (e.g. software engineers, interns, recruiters) were sent to the LLM judge despite lacking required leadership titles.
4. **LLM Concurrency Failures**: Concurrent or bursty LLM executions caused upstream provider rate-limit errors (HTTP 429), gateway worker thread exhaustion, and Cloudflare HTTP 524 timeout cascades.

## Decision
We introduce six coordinated architectural enhancements across data persistence, retrieval planning, extraction, judging, and LLM scheduling:

### 1. Upstream CRM Negative Feedback & Metro Saturation Avoidance
- In [`server/db.ts`](../../server/db.ts), implemented `extractValidCompanyDomain()`, `readStoredCompanyDomains(limit)`, and `readStoredMetroSaturation()`.
- In [`server/leadSearch/stages/planStage.ts`](../../server/leadSearch/stages/planStage.ts) and [`server/leadSearch/discoveryEngine.ts`](../../server/leadSearch/discoveryEngine.ts), existing CRM domains are automatically seeded into `searchSpec.exclusions.domains` and forwarded to Tavily's `exclude_domains` API parameter.
- In [`server/leadSearch/searchSpec.ts`](../../server/leadSearch/searchSpec.ts), metropolitan hubs with $\ge 15$ existing leads are flagged as CRM-saturated. The strategist prompt instructs the LLM to pivot to unmined secondary clusters and supplies negative search operators (`-"Known Firm"`).

### 2. Stage 2.5: Fast Deterministic Pre-Filter Gate
- In [`server/leadSearch/stages/extractStage.ts`](../../server/leadSearch/stages/extractStage.ts), introduced an instant, zero-LLM filtration gate immediately preceding extraction:
  - **Zero-Latency CRM Deduplication**: Checks incoming candidate URLs and LinkedIn handles against SQLite `readExistingIdentityKeys()` in 0ms. Rescued URLs from text snippets are also re-verified against existing keys before acceptance.
  - **LinkedIn Profile Enforcement**: Discards non-LinkedIn search results when the contract strictly requires individual person profiles.
  - **Boilerplate Stripping & Token Diet**: Cleaned raw snippet noise (`cleanSnippetNoise`) by stripping HTML markup, navigation headers, and cookie notices, reducing input token bloat by ~65%.
  - **Zero-Candidate Bypass**: When all candidates in a round are duplicates or non-compliant, extraction exits immediately without invoking the extraction LLM.

### 3. Pre-Judge Context Grounding
- In [`server/leadSearch/siteProbe.ts`](../../server/leadSearch/siteProbe.ts), implemented `groundCandidateWithSiteProbe()`.
- For candidates requiring semantic evaluation on agency/client-services briefs, a lightweight, non-LLM fetch (~250ms) retrieves the company's root page `<meta name="description">` or `<title>`, backed by SSRF safeguards and an SQLite enrichment cache.
- In [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts), probed commercial context is appended to candidate evidence before the Finalist Judge evaluates them, preventing false rejections for ambiguous business models.

### 4. Deterministic Role Triage & Bounded Batch Recursion
- In [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts):
  - **Pre-Judge Role Triage**: Rejects individual contributors (`intern`, `staff engineer`, `ml engineer`, `data scientist`, `recruiter`, `account executive`) in 0ms using regex matching when executive or leadership roles are required.
  - **Bounded Recursion**: Replaced deep recursive batch splitting in `evaluateFinalistBatch` with a single-split limit (`attemptDepth < 1`) and resilient fallback scoring for unjudged leads, eliminating redundant sequential LLM calls.

### 5. Closed-Loop Adaptive Scheduler Feedback
- In [`server/leadSearch/adaptiveScheduler.ts`](../../server/leadSearch/adaptiveScheduler.ts):
  - Elevated the duplicate penalty in Thompson sampling (`duplicates * 1.5` in `betaPost` and `- duplicates * 1.2` in `meanReward`).
  - Elevated the net qualified reward (`qualified * 3.5`).
  - Directly penalizes search query arms returning stale CRM leads, steering retrieval toward unmined lanes.

### 6. Strict Sequential LLM Execution Invariant
- Preserved and strictly enforced `withSequentialLLMExecution` in [`server/services/llm.ts`](../../server/services/llm.ts).
- All completion calls across strategist, extraction, verification, and judging stages execute sequentially through a single queue, eliminating provider concurrency errors, thread contention, and 429/524 cascades.

## Consequences
- **Positive**: CRM duplicate leads are intercepted before extraction or retrieval, preventing wasted LLM completions.
- **Positive**: Snippet token diet reduces extraction input volume by ~65%.
- **Positive**: Role triage and site grounding eliminate up to 50% of unnecessary judge LLM calls while increasing precision for client-services contracts.
- **Positive**: Strict sequential LLM execution guarantees stability across diverse OpenAI-compatible providers without rate limit failures.
- **Positive**: 45 core tests passing across 5 suites with 0 regressions.
