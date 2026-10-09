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
A contextual Thompson-sampling and UCB scheduler that ranks and throttles query plan arms (`family|lane|provider`) partitioned by business domain cluster (e.g. `b2b_agency`, `b2b_saas`, `executive_coaching`) with exponential moving average time decay ($\lambda = 0.95$), binary outcome rate boosting (`lead_outcomes`), and explicit penalties for hard-failed candidates.

### Dynamic Semantic Query Expansion
A non-colliding fallback query planner that synthesizes multi-attribute candidate search queries using domain synonyms, tooling keywords, and pain signals from the prospect contract rather than rigid Cartesian permutation loops.

### Career Trajectory Discounted Cumulative Relevance (DCR)
An exponential recency decay and domain authority scoring model that evaluates past and current leadership roles across modern executive titles (Founders, C-Suite, Fractional CXOs, Practice Leads, RevOps/GTM Heads, and Principal Consultants).

### Site Probe Buying Signal Extraction
A multi-tier extraction engine that inspects target company root websites and deep subpaths (`/about`, `/team`, `/pricing`, `/case-studies`, `/careers`) to extract high-fidelity commercial signals (pricing models, customer case studies, tech stack badges, and active hiring roles).

### Global Corporate Entity Resolution
An alias-matching and normalization system that strips global corporate entity forms (`S.R.L.`, `S.A.S.`, `S.L.`, `AG`, `Pte Ltd`, `Sdn Bhd`, `Sp. z o.o.`, `ApS`, `Pty Ltd`) and regional branch designations (`EMEA`, `APAC`, `Global`, `Holdings`) to prevent company profile duplicates.

### Lean Adaptive Collection Capacity
A dynamic candidate sizing policy that sets search pool targets proportional to requested output limits (1.15x-1.25x cushion) with dynamic batch scaling (15-40 leads/round). Round budgets are derived by target size (default cap of 3 rounds for targets up to 30, 4 up to 50, 6 above), bounded by a hard ceiling of `MAX_COLLECTION_ROUNDS = 24`, and overridden by `LEAD_SEARCH_MAX_ROUNDS` when that is set (6 in the shipped configuration). Dynamic recovery extension (`discoveryEngine.ts`) can push round budgets up to `min(10, collectionCapacity.maxRounds + 2)` (or `LEAD_SEARCH_MAX_ROUNDS_EXTENDED_CEILING`) when late rounds actively produce candidates but effective qualified leads remain below the target cushion.

### Decoupled Early Shortlist Termination
A high-selectivity discovery exit check that terminates search rounds immediately when verified candidate volume satisfies target limits, decoupled from literal keyword substring heuristics.

### Two-Tier Intent & Site Enrichment
Pre-selection intent probing (Phase 4 company website intent and Phase 5 LinkedIn post intent) evaluates the top candidate pool ($\lceil \text{targetLimit} \times 1.5 \rceil$ by effective score) so all 4 Pareto dimensions (role fit, company match, seniority authority, intent signal) are fully informed during selection. Post-selection full company site probing (`enrichStage.ts`) runs strictly on the final selected leads to extract deep buying signals without duplicate external calls.

### Deterministic Pre-Filter Gate (Stage 2.5)
A zero-latency, non-LLM filtration boundary positioned immediately after SERP retrieval and observation fusion. It drops known CRM duplicates (via SQLite identity keys in 0ms), filters out non-LinkedIn items when individual profiles are required, strips HTML boilerplate and cookie banners from snippets, and safely bypasses the extraction LLM when zero viable items remain.

### Upstream CRM Negative Feedback & Metro Saturation Avoidance
A closed-loop query optimization mechanism that extracts existing company domains from the CRM database and injects them directly into Tavily's `exclude_domains` parameter. It also monitors metropolitan saturation ($\ge 15$ leads in CRM, including JSON-extracted `profile.location` and `profile.city` fields) and seeds cross-session `discovered_companies` to steer query generation toward unmined secondary tech clusters while equipping the LLM strategist with negative search operators (`-"Known Agency"`).

### Consolidated Site Probing
Target company website inspection is consolidated in `enrichStage` (following Pareto candidate selection) with normalized bare-host caching. In ~250ms per company, it fetches root page meta description or title to inject verified business context and commercial signals into candidate profiles without duplicate network calls.

### Deterministic Role Triage
An instant 0ms pre-judge classification that identifies and discards individual contributors (`intern`, `staff engineer`, `ml engineer`, `data scientist`, `recruiter`, `account executive`) from finalist judging when the contract strictly demands executive, founder, or partner-level decision makers. Title acronyms (`MD`, `VP`, `CTO`, `CRO`) are expanded to canonical forms before matching so abbreviated executive titles are not mis-triaged.

### Provider-Affinity Routing & Queue Policy (ADR-0011)
The core routing and concurrency invariant governing all LLM interactions in the discovery engine (`server/services/llm.ts`). The primary tier is an **ordered chain**: Atria is primary and serves every default-tier stage (contract, extraction, judge, enrichment) up to `ATRIA_CONCURRENT_SLOTS` concurrent requests (8 by default, stress-tested safe up to 10), and Byesu is **second priority** (`BYESU_CONCURRENT_SLOTS=10`) - it takes any call Atria cannot serve, whether because Atria's attempt failed (5xx, timeout, truncation, parse failure) or its slots are saturated (the call spills instead of queueing), plus the fast tier, where the query strategist passes an explicit tier order (`["primary","atria","openrouter"]` from `resolvePlannerProviderOrder`) so planning runs on the low-latency router. Groq and OpenRouter/Mistral remain the failsafe tier, invoked in sequence only when Atria and Byesu are both out (fatal authentication failure, exhausted quota HTTP 429 code 1300, or consecutive circuit-breaker trips). Stage-level concurrency must be able to fill the slots: `LEAD_EXTRACTION_CONCURRENCY=8` and `FINALIST_JUDGE_CONCURRENCY=6` (the heaviest reasoning stage is capped below the slot ceiling to avoid KV-cache contention). Variable reasoning effort is assigned based on task complexity: extraction, retrieval, strategist, intent, attribution, and enrichment use `low`, while finalist judge and contract extraction use `medium`. Slot utilization is observable via `/api/llm-health` (`activeSlots`/`slotLimit`) and per-stage queue sums in the round critical-path telemetry.

### Query Understanding Layer (`queryUnderstanding.ts`)
A deterministic complexity classifier that labels each brief `vague | standard | rich` with an ambiguity score and missing-slot list (`role`, `geo`, `industry`, `seniority`, `signal`). It drives vagueness-aware retrieval depth, task sizing, and the interactive (`needs_clarification`) vs headless (expander fallback) clarification gate. Long briefs are salience-compressed before prompt injection instead of mid-phrase truncation.

### Zero Default-Invention Rule (`resolveGeo`)
When a brief specifies no geography, the engine returns `geo=open_global` with no `countryAnchor` and no metro hubs. Two-character ISO country codes colliding with English pronouns or prepositions (`us`, `me`, `am`, `in`, `is`, `at`, etc.) require explicit prepositional context, uppercase casing, or metro cues before anchoring geography. City-only geographies (`London`, `Berlin`) resolve to their parent country and metro anchor without allowing the vertical slot to equal the location.

### Alias-First Matching (`aliasMap.ts`)
A zero-network, synchronous normalization map (roles, ISO geographies/regions, company types, tools) used in hot loops (`fuseStage`, `evidenceSelection`, `finalistJudge`) and contract grounding (`sourceAppearsInBrief`). `aliasIncludes` performs symmetrical bidirectional token and phrase normalization (`MD` <-> `managing director`, `US` <-> `united states`, `CEO` <-> `chief executive officer`, `UK` <-> `united kingdom`) with 0ms latency, while contract role matchers accept plural persona forms (`CEOs`, `Presidents`, `VPs`) without leaking roles into `company_type`.

### Complexity-Aware Query Rewriter (`queryRewriter.ts`)
A bounded (max 3) zero-yield recovery policy that replaces single-retry ablation as the second chance: `vague` and `standard` briefs broaden by dropping low-signal tokens while skipping Tier-1 immutable identity anchors (`person_role`, `company_type`, `industry`), and `rich` briefs relax the lowest-salience covered non-Tier-1 hard requirement (preferring `person_location` before `company_type`). Rewritten queries dispatch on both credit-reservation and standard execution paths, threading `demotedRequirementId` into coverage tracking.

### Quantized Semantic Centroids (MAB)
The domain-clustered MAB pools Thompson-sampling priors by 24 persistent deterministic buckets (`centroid_<cluster>_<00-23>`, FNV-1a over the normalized brief) instead of raw embedding vectors, so repeated brief shapes converge instead of permanent cold-start. `contract_guard` tasks are treated as non-optional correctness constraints: only non-guard tasks are trimmed by the `maxTasks+2` cap, ensuring 100% hard-requirement coverage survives pruning.

### Contract-Aware Ranking (`rankLeadForFinalSelection`)
Final selection scoring takes the contract into account: hard-requirement coverage dominates with a `1.2x` spread and soft-signal coverage actively boosts (`0.4x`), replacing the previous hard-only rank where soft nuance was invisible.

### LLM Completion Cache (`llm_completion_cache`)
A durable, prompt-hash-keyed cache in front of the LLM gateway (`server/services/llm.ts`). Repeat completions (strategist rounds, identical extraction chunks) are served from SQLite instead of the provider, with per-entry `expires_at` TTL and periodic `purgeLlmCacheExpired` sweeps. It targets the dominant share of session wall clock previously lost to repeated LLM latency.

### Gated Company Attribution (`companyAttribution.ts`)
A bounded LLM attribution step that verifies a discovered company actually fits the brief before prospects are attributed to it. It classifies the company's business model (`client_services_agency`, `software_saas`, `e_commerce`, ...), checks query alignment (`matches_brief | adjacent | contradicts`), and emits `verified_fit | unverified | disqualifying_contradiction` verdicts grounded in a verbatim evidence quote. Business-model contradictions gate candidates out before judge tokens are spent.

### Deterministic Profile Quality Gates (`profileQuality.ts`)
Zero-LLM quality gates shared by dataset-dossier and SERP candidates: social-proof parsing (followers/connections/influencer), company-page and ghost-profile detection, and wrong-vertical agency detection. Single source of truth for `checkStrictContradiction` in the Finalist Judge (with `b2b_saas` contradictions scoped to company and industry fields so past-career bio mentions do not false-fail) so both candidate origins face identical gates at zero token cost.

### Strict Evidence Citation Grounding (`EVIDENCE_GROUNDING_MODE`)
The verification rule governing finalist judging (`strict` by default). Every LLM `pass` verdict on a contract requirement must cite a resolvable evidence passage whose quote matches via exact, alias-normalized, or polarity-guarded fuzzy matching (`0.7 * windowOverlap + 0.3 * setOverlap`, rejecting windows with stray negators such as `not`, `no`, `never`, `former`, `ex-`). Passes without grounded citations degrade to `unknown` (`fabricatedPass`), while explicit hard-requirement failures (`identityFails > 0 || contextFails > 0`) always take precedence as `hard_fail`.

### Location Provenance Separation (`_locationProvenance`)
The provenance boundary distinguishing a prospect's personal location from a company headquarters address scraped during website probing (`_locationProvenance = 'company_site'`). Company-derived locations are provided to the semantic judge as context but are excluded from `hasStrictStructuredMatch` for `person_location` hard requirements. Evidence-extracted URLs (`evidence_url`) must share a meaningful token with the company name before site probing to prevent press domains (e.g. TechCrunch) from being scraped as company sites.

### Annotate-Only Post-Intent Enrichment
The execution model for Phase 5 LinkedIn post SERP research (`linkedinPostIntent.ts`): enrichment annotates selected finalists in map order without re-sorting or cutting the finalist list. Snippet recency parsing supports both full and abbreviated markers (`2d ago`, `1w ago`, `3mo ago`, `1y ago`, `2h ago`), and undated snippets default to a neutral 45-day age (`UNKNOWN_AGE_DAYS = 45`) so undated text never receives a synthetic recency boost.

### CRM Workflow Field Preservation
The persistence rule in `upsertLeadInExistingTransaction` (`server/db.ts`) that protects human-managed CRM state (`stage`, `reviewStatus`, `nextAction`, `notes`) during engine re-persistence. When a discovery session re-encounters an existing lead, objective profile and score fields are refreshed while human workflow fields remain untouched unless `forceOverwrite: true` is explicitly supplied.

### Binary Outcome Feedback (`lead_outcomes`)
The closed-loop disposition table (schema v23/v24 with `scope_key` attribution) recording `positive` (`KEEP`, `VERIFIED`, `CONVERTED`, `CLOSED_WON`, `MEETING BOOKED`, `REPLIED`) and `negative` (`REJECT`, `REJECTED`, `LOST`, `UNQUALIFIED`) transitions. Outcome events update both the global outcome rate boost in `scoreAdaptiveArm` and cluster-scoped `query_performance` counters via top-level `discoveryFamily` and `discoveryLane` attribution.

### Provider-Affinity Concurrency (Atria-Primary, Byesu Second-Priority)
The provider concurrency model implemented in `withProviderFallback` (`server/services/llm.ts`). It enforces independent request concurrency limits per provider (`ATRIA_CONCURRENT_SLOTS=8` and `BYESU_CONCURRENT_SLOTS=10`) over an ordered primary chain: Atria first, Byesu second. While Atria has free slots, default-tier calls dispatch to it up to its full slot count; when its slots are saturated the calls **spill over to Byesu** rather than queue, and a failed Atria attempt (5xx, timeout, truncation, parse failure) **cascades to Byesu immediately** as the second-priority provider. The fast-tier strategist calls reorder the same pair (Byesu first, Atria second). Groq/Mistral serve only when both primaries are out - this is the second-priority policy of ADR-0011, which raised the provider ceiling from 4 to 8 slots after live sessions measured only 1.36x LLM overlap (max 4 simultaneous Atria calls).

### Dynamic Atria Reasoning Headroom
The dynamic timeout calculation (`computeAtriaDynamicTimeoutMs`) designed for chain-of-thought models. It elevates the maximum timeout ceiling to 600,000ms (10 minutes) with a 120,000ms floor, scaling dynamically based on input token length (`12ms/tok`) and requested reasoning budget (`15ms/tok`). This prevents complex evaluation prompts from aborting prematurely while the model is thinking.

### Industry-Agnostic Engine
The generalized discovery architecture (`prospectContract.ts`, `defaultRoles.ts`, `geo.ts`, `scoring.ts`, `adaptiveScheduler.ts`) that removes hardcoded client-services/agency/SaaS constraints. Roles, seniority levels, and business domains are extracted dynamically for any vertical (e.g. healthcare, legal, manufacturing, biotechnology). Agency-specific qualification rules and executive authority scoring apply only when explicitly requested in the user's brief.

### Universal ISO Country Resolution (`geo.ts`)
The standardized geographic coordinate system utilizing ECMAScript's native `Intl.DisplayNames`. It automatically recognizes and normalizes all 249 ISO 3166-1 alpha-2 countries and regions while guarding against English two-letter pronoun collisions (`us`, `in`, `me`, `am`, `at`), ensuring global brief coverage without synthetic US anchor invention.

### Candidate Verdict Cache (`candidate_verdicts`)
The persistent SQLite Schema v26 cache storing LLM pass and hard-fail evaluations indexed by canonical LinkedIn identity key (`identity_key`), requirement hash (`requirement_hash`), and evidence hash (`evidence_hash`). When a prospect candidate is re-encountered in subsequent rounds with identical qualification evidence, previous judge determinations are reused in 0ms without re-invoking the judge LLM.

### Company Profile & Attribution Persistence (`company_profiles`, `company_attribution_verdicts`)
The persistent company taxonomy tables in SQLite Schema v26. `company_profiles` stores verified business models, industry classifications, offerings, and verified evidence quotes for scraped company domains. `company_attribution_verdicts` stores per-brief qualification verdicts, eliminating duplicate LLM company-fit evaluations across multiple candidates from the same organization.

### Cross-Round Retrieval Cache (`retrievalCache.ts`)
A query-hash-keyed cache layer built on `search_cache` with configurable TTL (`LEAD_RETRIEVAL_CACHE_TTL_DAYS`, default 3 days). Identical search queries (e.g. initial persona or location searches) are retrieved in 0ms from SQLite rather than consuming external search provider credits or network latency.

### Multi-Tier Company Entity Resolution (`verifyStage.ts`)
A 4-tier resolution engine that prevents `missing_company_entity` rejections for verified business owners and partners who write value-proposition headlines (e.g. "Founder & CEO | Helping B2B companies scale with AI"). Tier 1 parses explicit headline delimiters (`at`, `@`, `|`, `-`); Tier 2 extracts website domain stems from verified personal links; Tier 3 parses semantic brand names from vanity LinkedIn URLs; and Tier 4 applies an **Independent Practice Designation** for verified owners offering client services.

### Independent Practice Designation (`isProvisionalEntity`)
A provisional entity attribution (`[FullName] (Independent Practice)`) assigned to verified decision makers (owners, founders, managing partners) whose headlines confirm client services/advisory/solutions when no explicit corporate brand can be extracted. Prevents false-negative discards at the verification gate while queuing the prospect for downstream domain discovery.

### Probabilistic Market Saturation & Soft Repulsion (`querySignature.ts`, `planStage.ts`)
A continuous saturation index ($S_{market} \ge 0.60$) based on duplicate rates recorded in SQLite per query signature and geography. For geographically flexible briefs (e.g. "in USA, Canada"), the strategist applies soft repulsion to saturated Tier-1 metros and boosts unvisited secondary hubs. For locked single-metro briefs (e.g. "in Toronto only"), it preserves the target city and pivots dynamically into vertical sub-niche specialization (e.g. "healthcare AI", "legal automation firm") to break the duplicate wall without violating user intent.

### First-Class Checkpoint Segregation (`discoveryEngine.ts`, `server/db.ts`)
The post-judging checkpoint architecture that cleanly segregates verified results: `acceptedLeads` strictly holds 100% qualified prospects (`verdict === 'qualified' | 'qualified_partial'`), while `disqualifiedCandidates` captures deterministic pre-triage drops, LLM hard fails, and unjudged candidates with exact failure reasons and scores. This ensures CRM views display clean leads while session audit tools retain full funnel visibility.

### Dual-Channel Company Signal Ingestion (`extractStage.ts`)
An ingestion pathway that routes non-person search results containing rich organizational intelligence directly into `signalStore.addCompanySignal(...)` instead of discarding them. Discovered companies and client contexts are preserved in the cross-session knowledge graph to fuel downstream account-level discovery and reverse flywheels.

### Mining-Feedback-Driven Development (MFDD) (ADR-0008)
The empirical engineering methodology where pipeline architecture, pre-filter gates, and LLM model routing are derived directly from live discovery session telemetry, rejection reason distributions, and real candidate payloads rather than theoretical assumptions or isolated mocks. Demonstrated by the elimination of headline company entity drops via multi-tier resolution and the 12x reduction in query planning latency.

### Non-Destructive Server Duplicate Consolidation
The CRM lead deduplication mechanism (`handleServerMergeLead` via `/api/leads/:winnerId/merge/:duplicateId`) that combines winner and duplicate records into a single canonical entry. Merges tags, appends notes, migrates activity audit trails and outreach drafts, and archives or resolves duplicate identity records in SQLite without discarding historical CRM data.

### Lead Activity Audit Timeline
The append-only chronological activity log (`lead_activities` table and `GET /api/leads/:id/activities`) recording life-cycle events including lead creation, discovery session ingestion, manual edits, stage movements, deduplication merges, and outreach generation. Surfaced in the Lead Drawer with relative timestamps and event-specific metadata.

### Persistent Job Tab Lifecycle (`mountedJobTabs`)
The client-side tab mounting strategy in `App.tsx` that maintains long-running or stateful workspaces (e.g. `outreach`, `workspace`, `inventory`) mounted in the DOM using CSS visibility (`hidden={activeTab !== tab}`) rather than unmounting them on tab switches. Protects in-flight LLM generations, drafted copy, and unsaved form modifications from being aborted or lost when navigating between CRM views.

### Atria Quad Concurrency & Micro-Batching (ADR-0009, superseded slots by ADR-0011)
The discovery mining latency optimization across extraction (`extractStage.ts`) and evaluation (`judgeStage.ts`). Based on empirical analysis of 987 Atria LLM calls demonstrating ~36.9 tokens/sec sequential generation and $R^2 = 0.94$ token-to-latency scaling:
1. **Atria Concurrency**: Concurrent provider slots with in-memory request pooling and queue backpressure. Quad concurrency (4 slots) was superseded by ADR-0011: `ATRIA_CONCURRENT_SLOTS=8`, `LEAD_EXTRACTION_CONCURRENCY=8`, `FINALIST_JUDGE_CONCURRENCY=6`, with Atria as the sole default-tier provider (see Provider-Affinity Routing & Queue Policy above).
2. **Micro-Batching**: Micro-chunks extraction blocks to $\le 3$ profiles (`LEAD_EXTRACTION_MAX_BLOCKS_PER_CHUNK=3`) and finalist judging to $\le 2$ candidates per batch (`FINALIST_JUDGE_MICRO_BATCH_SIZE=2`). This prevents large candidate prompts from generating thousands of sequential tokens and stalling vLLM KV-cache memory, keeping individual calls in the 20s-35s envelope while preserving rolling-pool early stopping.
3. **Guardrails**: Integrated configuration validation (`configValidation.ts`) checking concurrency and micro-batch bounds at server startup.



### Dev-Server HMR Reload Containment (ADR-0010)
The development-mode guarantee that unprompted full-page reloads cannot detach an active discovery session. Vite's browser client calls location.reload() unconditionally on HMR websocket drops and on ull-reload broadcasts for non-graph watched files, and the inline hmr: { server } in server.ts overrides ite.config.ts (which made DISABLE_HMR inert). The containment strategy: (1) server.ts gates both ws and hmr on DISABLE_HMR so the kill switch is real; (2) ite.config.ts watch.ignored covers runtime writes (**/*.sqlite*, **/*.log, **/*.tmp, **/*.bak, **/scratch/**) since Vite force-reloads when a changed watched file maps to zero modules; (3) HMR socket upgrades/closes are logged on the shared listener; and (4) any residual forced reload is made lossless - ScrapeWorkspace.tsx marks the running session id in sessionStorage (pex-active-mining-session-id) and App.tsx force-mounts the workspace (plus persisted pex-mounted-job-tabs) so the existing mount effect re-attaches to the live server-side session. Guards live in 	est/hmrReloadGuard.test.ts; client-side ite:beforeFullReload listeners are provably ineffective (Vite discards listener return values).

### Streaming Enrichment-Judge Seam (ADR-0012)
The round-pipeline overlap that removes the enrichment phase barrier from the critical path. nrichStage fires an onTargetsReady(leads) hook at each enrichment completion point (unselected targets upfront, pro-waterfall per target, batch scrape per batch, retry per target, unenriched remainder); discoveryEngine submits those leads to a live rolling pool (liveRollingPool.ts, one group at a time, each group parallelized at judge concurrency) that runs valuateIncrementalJudgeBatches per group while the remaining enrichment continues. The seam is quality-preserving because the judge prompt never contains site-probe signals (videnceSelection reads only evidence blocks and snippets) and the primary admission gate reads judge verdicts and company attribution, so pre-probe verdicts are identical to post-probe ones; a drain-time survivedEnrichment re-check prevents committing leads that enrichment later rejected. Gated by LEAD_PIPELINE_STREAMING_JUDGE (default on; alse restores the wholesale post-enrichment judge path).

### Evidence Signature Hash & Market-Slice Caches (ADR-0012)
The cross-session cache leverage layer. computeEvidenceHash (candidateVerdicts.ts) hashes evidence ids plus normalized lengths rather than full text, so a re-scraped profile's re-worded evidence block reuses the prior candidate_verdicts row instead of re-judging. uildRetrievalSignatureKey (etrievalCache.ts) keys SERP results at the market-slice grain (role class, org class, geo anchor, top topic tokens) alongside the exact-query key, so near-duplicate queries across rounds and sessions share results. The in-memory planCache.ts (LRU, 64 entries, 6h TTL) skips the strategist LLM call when the domain cluster, search spec, target, task sizing, metro-saturation, signal companies, known entities, prior query count, and missing-requirement state all match a previously generated plan - gated to non-speculative, non-recovery, post-first, non-stall rounds, with the existing dedupe/signature-exhaustion filters still applied downstream.

### CRM Saturation Response & Reverse-Flywheel Injection (ADR-0012)
The saturated-market escape in planStage. The share of the previous round's rejections that were duplicate_existing_lead is computed each round; at 50% or more (and not metro-locked) the task boost rises to 2.0x, the saturated-metro threshold tightens from 20 to 10 CRM leads, a CRM-saturation directive is injected into the strategist prompt, and 1-3 account-lane flywheel queries (uildAccountFlywheelItems) are appended targeting decision-makers at companies discovered with hiring/tooling signals in the signal store, instead of re-mining the same persona surface.

### Adaptive Judge Concurrency
The judge-stage sizing rule (judgeStage.ts): min(8, max(FINALIST_JUDGE_CONCURRENCY, freeAtriaSlots)), where free slots come from the live provider slot maps. The first judge wave packs micro-batches of 3 candidates (provider capacity permitting; an explicitly configured FINALIST_JUDGE_MICRO_BATCH_SIZE stays authoritative for every wave) to amortize prefill, later waves keep 2 to preserve rolling-pool early-stop granularity.
