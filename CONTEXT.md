# Apex CRM Domain Glossary

This document defines the core domain language used throughout the Apex CRM codebase.

---

### Discovery Session
A bounded execution run that locates, evaluates, enriches, and qualifies prospects matching a user's natural language prospecting brief.

### Prospect Contract
A deterministic or LLM-compiled specification derived from a prospecting brief. It defines strict hard requirements, soft signals, modality types, acceptable terms, and the decomposition mode.

### Identity Plane (Stream A)
The discovery dimension focused exclusively on persona and firmographic coordinates: job titles/roles, company types/names, and geographic locations. Used to generate high-recall LinkedIn profile queries.

### Intent Plane (Stream B)
The research dimension focused on real-world buying signals, hiring triggers, active tooling usage, and operational pain points on the open web, company websites, and LinkedIn post activity.

### Candidate Lead
An unverified or raw public profile observation discovered from web retrieval before formal evaluation.

### Qualified Prospect
A candidate that has satisfied all required contract criteria and decision-maker checks, backed by cited proof snippets.

### Finalist Judge
A multi-tier evaluation system that verifies candidate evidence against contract requirements using fast-path exact checks or bounded LLM judging.

### Pareto Frontier (Skyline)
A non-dominated subset of candidate leads that excel across multi-objective dimensions (authority, fit, intent, and evidence quality), reserved to prevent dilution by single-metric scoring.

### Reverse Flywheel
The feedback loop where open-web signal searches discover active hiring/tooling accounts, and dynamically generate targeted executive profile queries for decision-makers at those specific accounts.

### Domain-Clustered Multi-Armed Bandit (MAB)
A contextual Thompson-sampling and UCB scheduler that ranks and throttles query plan arms (`family|lane|provider`) partitioned by business domain cluster (e.g. `b2b_agency`, `b2b_saas`, `executive_coaching`) with exponential moving average time decay ($\lambda = 0.95$).

### Dynamic Semantic Query Expansion
A non-colliding fallback query planner that synthesizes multi-attribute candidate search queries using domain synonyms, tooling keywords, and pain signals from the prospect contract rather than rigid Cartesian permutation loops.

### Career Trajectory Discounted Cumulative Relevance (DCR)
An exponential recency decay and domain authority scoring model that evaluates past and current leadership roles across modern executive titles (Founders, C-Suite, Fractional CXOs, Practice Leads, RevOps/GTM Heads, and Principal Consultants).

### Site Probe Buying Signal Extraction
A multi-tier extraction engine that inspects target company root websites and deep subpaths (`/about`, `/team`, `/pricing`, `/case-studies`, `/careers`) to extract high-fidelity commercial signals (pricing models, customer case studies, tech stack badges, and active hiring roles).

### Global Corporate Entity Resolution
An alias-matching and normalization system that strips global corporate entity forms (`S.R.L.`, `S.A.S.`, `S.L.`, `AG`, `Pte Ltd`, `Sdn Bhd`, `Sp. z o.o.`, `ApS`, `Pty Ltd`) and regional branch designations (`EMEA`, `APAC`, `Global`, `Holdings`) to prevent company profile duplicates.

### Lean Adaptive Collection Capacity
A dynamic candidate sizing policy that sets search pool targets proportional to requested output limits (1.15x–1.25x cushion) with dynamic batch scaling (15–40 leads/round). Round budgets are derived by target size (default cap of 3 rounds for targets up to 30, 4 up to 50, 6 above), bounded by a hard ceiling of `MAX_COLLECTION_ROUNDS = 24`, and overridden by `LEAD_SEARCH_MAX_ROUNDS` when that is set (6 in the shipped configuration).

### Decoupled Early Shortlist Termination
A high-selectivity discovery exit check that terminates search rounds immediately when verified candidate volume satisfies target limits, decoupled from literal keyword substring heuristics.

### Targeted Post-Selection Enrichment
A pipeline execution order that defers intensive Phase 4 company website probing and Phase 5 LinkedIn post intent SERP lookups until after the Finalist Judge and Pareto diversification have selected the top $K$ prospect finalists.

### Deterministic Pre-Filter Gate (Stage 2.5)
A zero-latency, non-LLM filtration boundary positioned immediately after SERP retrieval and observation fusion. It drops known CRM duplicates (via SQLite identity keys in 0ms), filters out non-LinkedIn items when individual profiles are required, strips HTML boilerplate and cookie banners from snippets, and safely bypasses the extraction LLM when zero viable items remain.

### Upstream CRM Negative Feedback & Metro Saturation Avoidance
A closed-loop query optimization mechanism that extracts existing company domains from the CRM database and injects them directly into Tavily's `exclude_domains` parameter. It also monitors metropolitan saturation ($\ge 15$ leads in CRM) to steer query generation toward unmined secondary tech clusters while equipping the LLM strategist with negative search operators (`-"Known Agency"`).

### Consolidated Site Probing
Target company website inspection is consolidated in `enrichStage` (following Pareto candidate selection) with normalized bare-host caching. In ~250ms per company, it fetches root page meta description or title to inject verified business context and commercial signals into candidate profiles without duplicate network calls.

### Deterministic Role Triage
An instant 0ms pre-judge classification that identifies and discards individual contributors (`intern`, `staff engineer`, `ml engineer`, `data scientist`, `recruiter`, `account executive`) from finalist judging when the contract strictly demands executive, founder, or partner-level decision makers. Title acronyms (`MD`, `VP`, `CTO`, `CRO`) are expanded to canonical forms before matching so abbreviated executive titles are not mis-triaged.

### Strict Sequential LLM Invariant (`withSequentialLLMExecution`)
The core concurrency invariant governing all LLM interactions in the discovery engine. By default all completion calls across strategist, extraction, verification, and judging stages are serialized through a single execution queue to prevent rate limit collisions, gateway thread starvation, and upstream provider 429/524 errors. Behind `FEATURE_LLM_STAGE_QUEUES=true` the queue shards into independent stage lanes (`strategist | extraction | judge | general`, max 2 each, global cap 4) with per-provider 429/524 backoff preserved.

### Query Understanding Layer (`queryUnderstanding.ts`)
A deterministic complexity classifier that labels each brief `vague | standard | rich` with an ambiguity score and missing-slot list (`role`, `geo`, `industry`, `seniority`, `signal`). It drives vagueness-aware retrieval depth, task sizing, and the interactive (`needs_clarification`) vs headless (expander fallback) clarification gate. Long briefs are salience-compressed before prompt injection instead of mid-phrase truncation.

### Zero Default-Invention Rule (`resolveGeo`)
When a brief specifies no geography, the engine returns `geo=open_global` with no `countryAnchor` and no metro hubs. Fallback query builders (`searchSpec.ts`, `prospectContract.ts`, `planStage.ts`) emit global queries without synthetic `USA`/US-metro tokens.

### Alias-First Matching (`aliasMap.ts`)
A zero-network, synchronous normalization map (roles, ISO geographies/regions, company types, tools) used in hot loops (`fuseStage`, `evidenceSelection`, `finalistJudge`) and contract grounding (`sourceAppearsInBrief`). `MD` matches `managing director`, `US` matches `united states`, `VP` matches `vice president` with 0ms latency.

### Complexity-Aware Query Rewriter (`queryRewriter.ts`)
A bounded (max 3) zero-yield recovery policy that replaces single-retry ablation as the second chance: `vague` briefs broaden (drop 1 constraint + synonym swap), `rich` briefs relax the lowest-salience covered hard requirement. Coverage IDs are recomputed for the planner.

### Quantized Semantic Centroids (MAB)
The domain-clustered MAB pools Thompson-sampling priors by 24 persistent deterministic buckets (`centroid_<cluster>_<00-23>`, FNV-1a over the normalized brief) instead of raw embedding vectors, so repeated brief shapes converge instead of permanent cold-start. `contract_guard` selection is hard-capped at `maxTasks+2`.

### Contract-Aware Ranking (`rankLeadForFinalSelection`)
Final selection scoring takes the contract into account: hard-requirement coverage dominates with a `1.2x` spread and soft-signal coverage actively boosts (`0.4x`), replacing the previous hard-only rank where soft nuance was invisible.

