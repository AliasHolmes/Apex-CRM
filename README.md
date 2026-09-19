<div align="center">
  <h1>Apex CRM</h1>
  <p><strong>Local-first, evidence-grounded prospect scouting and CRM for LinkedIn-first workflows</strong></p>

  <p>
    <img src="https://img.shields.io/badge/React-19.2-61DAFB?logo=react&logoColor=black" alt="React" />
    <img src="https://img.shields.io/badge/Vite-8.2-646CFF?logo=vite&logoColor=white" alt="Vite" />
    <img src="https://img.shields.io/badge/TailwindCSS-4.3-38B2AC?logo=tailwind-css&logoColor=white" alt="Tailwind CSS" />
    <img src="https://img.shields.io/badge/SQLite-Schema_v22-003B57?logo=sqlite&logoColor=white" alt="SQLite schema v22" />
    <img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
    <img src="https://img.shields.io/badge/Lead_Engine-Passing-10B981" alt="Lead Engine Tests" />
  </p>
</div>

---

## What Apex CRM is

Apex CRM is a single-user, local-first application for finding relevant prospects, collecting their LinkedIn profile links, reviewing verifiable evidence behind each match, and keeping the resulting list organized.

Its primary workflow is intentionally practical:

1. **Describe your search brief** in natural language (2-word vague to 100-word rich, any vertical, any geography).
2. **Query Understanding Layer** (`queryUnderstanding.ts`) classifies your brief:
   - `vague | standard | rich` with ambiguity score and missing-slot detection (`role`, `geo`, `industry`, `seniority`, `signal`).
   - **Zero default-invention**: briefs with no geography search globally — no synthetic `USA`/US-metro tokens are injected.
   - Simple persona briefs run direct high-recall discovery with zero LLM overhead.
   - Long-shot intent briefs decouple into **Stream A (Identity)** for 100% SERP recall and **Stream B (Intent Triggers)** for multi-channel open-web research.
3. **Stage-Pipelined High-Efficiency Engine**:
   - Executes **Two-Wave Parallel Retrieval** across Tavily and Bright Data simultaneously, with vagueness-aware depth (`vague: 20 + advanced recall`, `rich: precision-tuned`) and a bounded **complexity-aware query rewriter** (`queryRewriter.ts`) as second-chance zero-yield recovery.
   - Applies **Fast Deterministic Pre-Filter Gate** to discard CRM duplicates and non-compliant profiles in 0ms without invoking extraction LLMs.
   - Enforces **Sequential LLM Execution** (`withSequentialLLMExecution`) by default to eliminate concurrency errors and provider 429/524 timeouts; optionally shards into stage lanes (`strategist | extraction | judge`, max 2 each, global cap 4) behind `FEATURE_LLM_STAGE_QUEUES=true`.
   - Matches with **alias-first normalization** (`aliasMap.ts`): `MD`, `VP`, `US`/`USA`, ISO regions resolve in 0ms with no network calls.
4. **Signal-to-Company Reverse Flywheel**: Discovered hiring/tooling triggers on the open web immediately feed prioritized executive search queries.
5. **Multi-Source Intent Enrichment**: Analyzes company websites (**TF-IDF Intent**) and public prospect activity (**LinkedIn Post SERP Intent with Temporal Freshness Decay**).
6. **Durable Checkpoints & Resiliency**: Saves stage-boundary SQLite snapshots (`checkpoint_json`), allowing any interrupted search to be resumed with 1 click.
7. **Revision Conflict Resolution**: Interactive side-by-side conflict dialog protects lead edits from background task collisions.
8. **Review & Manual Outreach**: Review evidence-grounded matches, certainty scores, and contact details, then reach out manually on LinkedIn.

---

## Prospect Discovery Engine

```mermaid
flowchart TD
    Brief["Prospect Brief"] --> Classifier["Adaptive Prompt Intelligence"]
    Classifier -->|Simple Brief| StreamIdentity["Single-Stream Mode (Direct Persona)"]
    Classifier -->|Compound Brief| StreamDual["Dual-Stream Mode (Decoupled Specs)"]
    StreamDual --> StreamA["Stream A: Identity Plane (Role, Geo, Firm)"]
    StreamDual --> StreamB["Stream B: Intent Plane (Tools, Jobs, Pain)"]

    subgraph Stages ["Pipelined Intelligent Engine Architecture"]
        Plan["1. planStage (CRM Negative Domain Exclusions & Metro Avoidance)"]
        Retrieve["2. retrieveStage (Two-Wave Parallel Lanes)"]
        Fuse["3. fuseStage (Corroboration Fusion)"]
        PreFilter["Stage 2.5: Fast Deterministic Pre-Filter Gate (0ms CRM Dedupe & Noise Stripping)"]
        Extract["4. extractStage (Token-Diet Budgeted LLM Extraction)"]
        Verify["5. verifyStage (Hard Requirement Verification)"]
        Enrich["6. enrichStage (TF-IDF & Post-Intent Decay)"]
        PreJudge["Pre-Judge: Role Triage (0ms IC Drop)"]
        Judge["7. judgeStage (Strict-Evidence Evaluation & Bounded Batches)"]

        Plan --> Retrieve --> Fuse --> PreFilter --> Extract --> Verify --> Enrich --> PreJudge --> Judge
    end

    StreamIdentity --> Plan
    StreamA --> Plan
    StreamB --> Plan

    Judge --> Checkpoint[("Durable SQLite Checkpoint (Schema v21)")]
    Judge --> Inventory["Local Prospect Inventory"]
```

### Key Architectural Capabilities

#### 1. Two-Wave Concurrent Parallel Retrieval Lanes

- **Wave 1 (Parallel Dispatch)**: Executes all unconditional Tavily and Bright Data queries concurrently via `Promise.all([executeTavilyLane(), executeBrightDataLane()])`.
- **Wave 2 (Conditional Supplemental)**: Settle Wave 1, evaluates Tavily yield, and triggers supplemental Bright Data fallback searches only when Tavily yield is low (`< 5`), preserving 100% of hybrid-mode credit policies.
- **Safety & Error Isolation**: Shared abort signals, race-free in-task credit reservations, and per-task error containment.

#### 2. Synchronous State-Bounded Planning

- Search planning is evaluated synchronously at each round boundary with verified knowledge of current lead yield and candidate counts.
- `planStage` stays pure and deterministic: queries and stats are committed to session state strictly at round boundaries, preventing state pollution on early exits.

#### 3. Durable Checkpoints & Session Resumption (ADR-0002)

- **Stage Boundaries**: Persists a compact Tier-A snapshot (`MiningSessionCheckpoint`) to SQLite `checkpoint_json` after each round's enrichment stage and before judging.
- **Boot Sweep**: Automatically reconciles orphaned sessions on server restart into `resumable` status.
- **One-Click Recovery UI**: `ResumableSessionsBanner` in the UI alerts users of interrupted searches and resumes them from checkpoint with zero duplicate queries.
- **Dual-Mode HTTP**: Supports synchronous HTTP 200 execution or immediate HTTP 202 Accepted (`?mode=job` / `Prefer: respond-async`) with SSE stream URLs.

#### 4. Interactive Lead Revision Conflict Resolution (B2 Dialog)

- **Revision Locking**: Optimistic concurrency on `leads.revision`.
- **Side-by-Side Diff Modal**: Caught `LeadPatchConflictError` (HTTP 409) prompts the user with an interactive diff comparing local edits vs. server updates.
- **Three Resolution Pathways**:
  - _Overwrite With My Changes_: Applies local edits with the current server revision.
  - _Accept Server Version_: Discards local dirty state and syncs server canonical.
  - _Smart Merge_: Field-level union of changes and tags.

#### 5. High-Frequency Streaming Trace Store

- Built on React 18/19's `useSyncExternalStore` (`miningTraceStore`).
- Telemetry events and terminal logs stream into an isolated `<TraceTerminal>` outside React's render tree, eliminating layout shifts and typing lag during fast search rounds.

#### 6. Multi-Source Intent Research & Freshness Decay

- **Phase 4 (Company Website TF-IDF)**: Scrapes company websites against categorized intent dictionaries with session-scoped IDF corpus weighting.
- **Phase 5 (LinkedIn Post SERP Intent)**: Queries Google for indexed prospect post snippets (`site:linkedin.com/posts <handle>`), classifies intent categories (`hiring`, `evaluating_tools`, `pain_signal`, `growth_signal`), and renders "Why Now" badges.
- **Temporal Freshness Decay**: Parses SERP snippet recency markers (`"2 days ago"`, `"3 weeks ago"`) and applies exponential half-life decay ($e^{-0.02 \times \text{days}}$) so newly published intent triggers receive full boost.

#### 7. Domain-Clustered Multi-Armed Bandit & Dynamic Search Strategy (ADR-0003)

- **Domain Clustering**: Partitions cross-session MAB query performance by domain cluster (`b2b_agency`, `b2b_saas`, `executive_coaching`, `local_services`, `healthcare_life_sciences`) so agency learning does not pollute SaaS searches.
- **Exponential Moving Average Decay ($\lambda = 0.95$)**: Automatically downweights stale historical query metrics on every conflict update, allowing newly adapted strategies to emerge.
- **Dynamic Semantic Query Fallback**: Synthesizes non-colliding fallback queries using domain synonyms, tooling keywords, and pain signals directly from the compiled contract.
- **Intent-Density Pre-Ranking**: Sorts incoming search hits by contract requirement term density and executive role markers rather than raw character length.

#### 8. Entity Intelligence & High-Fidelity Site Probing (ADR-0003)

- **Career Trajectory DCR Fix & Modern Leadership**: Fully models Partners, Fractional CXOs, Practice Leads, RevOps/GTM Heads, and Principal Consultants with exponential role recency decay.
- **Commercial Signal Extraction**: Multi-tier site probe scans root domains and subpaths (`/pricing`, `/case-studies`, `/careers`, `/integrations`) to extract pricing models, customer proof, tech stacks, and active hiring roles.
- **Multi-Evidence Fallback Grounding**: The Finalist Judge scans all candidate evidence passages before flagging ungrounded verdicts, eliminating false-positive fabrication rejections.
- **Global Corporate Form Normalization**: Strips international corporate suffixes (`S.R.L.`, `S.A.S.`, `S.L.`, `AG`, `Pte Ltd`, `Sdn Bhd`, `Sp. z o.o.`, `ApS`, `Pty Ltd`) and regional branch designations (`EMEA`, `APAC`, `Global`, `Holdings`).

#### 9. Lean Adaptive Collection & Targeted Post-Selection Enrichment (ADR-0004)

- **Proportional Collection Capacity**: Calibrates candidate pool targets with a tight 1.15x-1.25x cushion (e.g. 25 candidates for a 20-lead target instead of 80-120).
- **Decoupled Early Exit**: Automatically terminates discovery rounds when verified candidate volume satisfies target limits, eliminating false-recovery round loops caused by keyword heuristics.
- **Targeted Post-Selection Enrichment**: Defers heavy company site probing (Phase 4) and LinkedIn post SERP intent (Phase 5) until after Finalist Judging and Pareto diversification, eliminating 70%+ of wasted network and LLM token overhead.
#### 10. Intelligent Low-Waste Filtering & Strict Sequential LLM Invariant (ADR-0005)

- **Stage 2.5 Fast Deterministic Pre-Filter Gate**: Immediately filters out known CRM duplicate leads using SQLite identity keys (`readExistingIdentityKeys`) in 0ms before extraction tokens are spent. Enforces personal LinkedIn anchors when the brief requires people, and strips ~65% of noise (HTML tags, cookie banners, navigation boilerplate) from snippets. If all retrieved candidates are duplicates or non-compliant, extraction exits in 0ms without invoking the LLM.
- **Upstream CRM Feedback & Metro Saturation**: Reads existing company domains and metro saturation counts from the CRM database. Passes known domains directly into Tavily's `exclude_domains` parameter and directs the query strategist to pivot away from saturated hubs ($\ge 15$ leads) with negative search operators.
- **Deterministic Pre-Judge Role Triage**: Discards individual contributors (`intern`, `staff engineer`, `ml engineer`, `data scientist`, `recruiter`, `account executive`) in 0ms when the contract specifies leadership roles. Acronyms (`MD`, `VP`, `CTO`, `CRO`) are expanded before matching.
- **Pre-Judge Context Grounding**: Executes a lightweight, non-LLM site probe (~250ms) to fetch the root `<meta name="description">` or `<title>` for ambiguous accounts, appending verified business context before semantic evaluation.
- **Strict Sequential LLM Invariant**: All LLM calls are serialized via `withSequentialLLMExecution` by default, eliminating concurrency errors, rate-limit storms, and gateway timeouts. Stage-lane sharding (`FEATURE_LLM_STAGE_QUEUES=true`) allows bounded concurrency with per-provider backoff preserved.
- **Contract-Aware Calibrated Judging**: `rankLeadForFinalSelection` weights hard-requirement coverage (`1.2x` spread) with active soft-signal boost (`0.4x`); evidence quote checks are alias-aware (`MD` == `managing director`).
- **Quantized Adaptive Controller**: MAB priors pool by 24 deterministic brief centroids (`centroid_<cluster>_<00-23>`) with `contract_guard` capped at `maxTasks+2`; `requirement_fail_digest` aggregates across sessions and the plan cache refreshes every round.

---


## System Architecture

```mermaid
graph TD
    UI["React Client (127.0.0.1:3000)"] --> API["Express 5 REST API"]
    API --> DB[("SQLite Database (node:sqlite, Schema v21, WAL mode)")]

    API --> Direct["Direct OpenAI-Compatible Provider Chain"]
    Direct --> Primary["Atria / Byesu Provider"]
    Direct --> OpenRouter["OpenRouter"]
    Direct --> Groq["Groq"]

    API --> KeyRotator["Key Rotation Pool"]
    KeyRotator --> Tavily["Tavily Search & Extract"]
    KeyRotator --> MCP["Bright Data MCP"]
    MCP --> BDSearch["search_engine"]
    MCP --> BDScrape["scrape_as_markdown"]
```

### Technology Stack

- **Frontend**: React 19, Vite 6, Tailwind CSS 4, Motion, Radix UI, Lucide React, `useSyncExternalStore`.
- **Backend**: Node.js 24+, TypeScript 5.9, Express 5, `p-queue` rate limiting.
- **Persistence**: Built-in `node:sqlite` in WAL mode with transactional schema migrations (schema **v21**), optimistic revision locking, durable checkpoints, and automatic WAL-safe backups.
- **LLM Routing**: Direct OpenAI-compatible provider chain with automatic fallback (Atria / Byesu -> OpenRouter -> Groq), session circuit breaker, and retry logic.
- **Retrieval**: Multi-key rotating Tavily Search/Extract and Bright Data MCP (`search_engine`, `scrape_as_markdown`).

---

## Getting Started

### Prerequisites

- Node.js 24 or newer (for native `node:sqlite`).
- At least one OpenAI-compatible LLM endpoint/key.
- At least one search provider: Tavily or Bright Data (both recommended for hybrid discovery).

### Installation

```bash
npm install
```

Copy the configuration template:

```bash
cp .env.example .env
```

### Environment Configuration

A minimal `.env` setup:

```env
# Primary LLM Provider: Atria or Byesu/OpenAI-compatible
ATRIA_API_KEY="your_atria_api_key"
ATRIA_PRIORITY="primary"

# Secondary/Fallback OpenAI-compatible endpoint:
OPENAI_API_KEY="your_byesu_or_openai_key"
OPENAI_BASE="https://byesu.com/v1"
OPENAI_MODEL="gpt-5.5"
OPENAI_PROVIDER_NAME="Byesu"

TAVILY_API_KEYS='["tavily_key_1", "tavily_key_2"]'
TAVILY_API_KEY="tavily_key_3"

BRIGHTDATA_API_TOKENS='["brightdata_token_1", "brightdata_token_2"]'
BRIGHTDATA_API_TOKEN="brightdata_token_3"

DISCOVERY_PROVIDER_MODE="hybrid"
BRIGHTDATA_MCP_TRANSPORT="local"
```

### Running Locally

```bash
# Start Vite frontend and Express backend concurrently
npm run dev

# Or start only the backend server
npm run dev:server
```

Open `http://127.0.0.1:3000` in your browser.

### Production Build

```bash
npm run build
npm run start
```

---

## API Reference

All API routes are mounted under `/api`:

| Group               | Method & Route                            | Description                                                                                    |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Health & Status** | `GET /health`                             | Application status and uptime                                                                  |
|                     | `GET /llm-health`                         | LLM gateway and provider latency status                                                        |
|                     | `GET /key-rotation-status`                | Sanitized provider key pool health                                                             |
|                     | `GET /provider-capabilities`              | Supported scraper and search features                                                          |
|                     | `GET /engine-metrics`                     | Aggregate engine health, stop reasons, and LLM stage latency                                   |
| **Discovery**       | `POST /lead-search/preview`               | Preview compiled contract and query plan                                                       |
|                     | `POST /find-leads`                        | Execute discovery session (supports synchronous HTTP 200 or async HTTP 202 via `?mode=job`)    |
|                     | `POST /scrape-url`                        | Scrape public web page markdown                                                                |
|                     | `POST /scrape-pasted`                     | Parse raw pasted text into prospect leads                                                      |
| **Mining Sessions** | `GET /mining-sessions`                    | List historical mining sessions                                                                |
|                     | `GET /mining-sessions/active`             | Get currently active mining session details                                                    |
|                     | `GET /mining-sessions/resumable`          | List interrupted sessions available for 1-click resumption                                     |
|                     | `DELETE /mining-sessions/resumable`       | Clear all interrupted resumable session checkpoints                                            |
|                     | `GET /mining-sessions/:sessionId`         | Get specific mining session details                                                            |
|                     | `DELETE /mining-sessions/:sessionId`      | Delete mining session record                                                                   |
|                     | `GET /mining-sessions/:sessionId/stream`  | High-frequency SSE execution trace and logs                                                    |
|                     | `GET /mining-sessions/:sessionId/trace`   | Telemetry trace events for session                                                             |
|                     | `GET /mining-sessions/:sessionId/token-stats` | Aggregate token consumption and costs                                                       |
|                     | `POST /mining-sessions/:sessionId/resume` | Resume interrupted mining session from checkpoint                                              |
|                     | `POST /mining-sessions/:sessionId/cancel` | Cancel active mining run                                                                       |
| **Search Logs**     | `GET /search-logs`                        | Query performance and cost summaries                                                           |
|                     | `GET /search-logs/:id`                    | Retrieve individual search log by ID                                                           |
|                     | `GET /search-logs/:id/live`               | Live log stream for active search                                                              |
| **Prospects & CRM** | `GET /leads`                              | List stored prospects with filtering, pagination, and fast summary path                        |
|                     | `GET /leads/stats`                        | Total lead counts and stage distribution metrics                                               |
|                     | `PUT /leads`                              | Atomic replacement of stored leads collection                                                  |
|                     | `POST /leads/bulk`                        | Bulk insert or update prospect records with per-item revision conflict detection               |
|                     | `PATCH /leads/:id`                        | Update lead stage, review status, or notes (requires revision integer; returns 409 on conflict) |
|                     | `DELETE /leads/:id`                       | Soft-delete or archive prospect                                                                |
|                     | `DELETE /leads`                           | Clear all stored leads and identities                                                          |
|                     | `POST /leads/:id/merge`                   | Merge duplicate prospect into primary lead with conflict resolution and relation reassignment  |
|                     | `POST /leads/:id/enrich-profile`          | Enrich specific lead via Bright Data profile unlock                                            |
|                     | `GET /leads/:id/activities`               | Audit trail activities for prospect                                                            |
| **Saved Searches**  | `GET /saved-searches`                     | List saved search specifications                                                               |
|                     | `POST /saved-searches`                    | Create or update saved search                                                                  |
|                     | `DELETE /saved-searches/:id`              | Delete saved search                                                                            |
| **Outreach**        | `GET /outreach-drafts`                    | List stored outreach drafts                                                                    |
|                     | `POST /outreach-drafts`                   | Create or update outreach draft                                                                |
|                     | `DELETE /outreach-drafts/:id`             | Delete outreach draft                                                                          |
|                     | `POST /generate-outbound`                 | Generate contextual outreach message                                                           |
|                     | `POST /chat`                              | CRM conversational assistant                                                                   |

---

## Database & Schema (v22)

The default database is `.apex-data/apex-crm.sqlite`. SQLite runs in WAL mode with foreign keys enabled and busy timeouts configured.

### Schema Capabilities:

- **`leads`**: Core prospect records, LinkedIn canonical identities, matched criteria, postIntentEvidence, uncertainty scores, and revision locks.
- **`mining_sessions`**: Durable execution sessions, target progress, phase summaries, and stage-boundary **`checkpoint_json`** snapshots.
- **`search_logs` / `llm_stage_logs`**: Granular event streams and per-stage LLM telemetry for real-time observability.
- **`query_performance`**: Historical yield, latency, and provider unit accounting per query family and lane.
- **`prospect_contract_cache`**: Versioned requirement contracts, decomposition modes, and compilation metadata.
- **`enrichment_cache`**: Positive and negative profile scraping caches (incl. intent fingerprints).
- **`saved_searches`**: Reusable prospecting configurations.
- **`lead_activities` & `outreach_drafts`**: Audit trails and draft messaging.

Automated backups are created under `.apex-data/backups/` before schema migrations run.

---

## Verification & Testing

Apex CRM maintains an extensive test suite (127 test files, run via `tsx --test`), including the Phase 0 intelligence eval harness (`test/queryIntelligence.eval.ts`, 30 gold briefs) and stage-queue concurrency tests (`test/llmStageQueue.test.ts`):

```bash
# Typecheck (0 errors)
npm run lint

# Full test suite (100% pass)
npm test

# Full Lead Engine Suite (293 tests across 32 suites)
npm run test:lead-engine

# Audit Invariants & Engine Resilience Suite (11 tests across 8 suites)
npx tsx --test test/auditFixesResilience.test.ts

# Two-Wave Parallel Retrieval & Planner Derivation (4 tests)
npx tsx --test test/parallelRetrieval.test.ts

# Durable Session Checkpoints & Resumption (3 tests)
npx tsx --test test/sessionPersistenceAndResume.test.ts

# UI Contracts, Navigation & Trace Store (7 tests)
npm run test:ui

# Adaptive Decomposition & Multi-Source Intent Suite (24 tests)
npm run test:intent-engine

# Persistence, Identity Deduplication & Revisions (10 tests)
npm run test:dedupe
```

---

## Project Structure

```text
docs/
  adr/                       Architecture Decision Records (e.g. ADR-0002 Durable Checkpoints)
src/
  components/                React UI components, modals, tables, badges
    ConflictDialog.tsx       Interactive B2 lead revision conflict resolution dialog
    ResumableSessionsBanner  1-click interrupted mining session recovery banner
    TraceTerminal.tsx        Decoupled 60fps streaming telemetry terminal
  context/                   React context providers (leads, toasts)
  lib/
    traceStore.ts            useSyncExternalStore reactive SSE trace and log store
    leadMutations.ts         Optimistic rebase and canonical preference utilities
  types.ts                   Shared TypeScript types and contract definitions
  utils/                     Deduplication, normalization, and UI formatting
server/
  routes/
    api.ts                   REST API endpoints, dual-mode HTTP 202, and resume routes
  services/
    llm.ts                   LLM gateway, fallbacks, JSON schemas, and Tavily search/extract
    brightData.ts            Bright Data MCP client, search, and scraper
    keyRotator.ts            Provider key pool and rate-limit manager
    linkedinEvidence.ts      LinkedIn profile evidence extraction
    privateHosts.ts          Shared SSRF guard for private/internal hosts
    sessionStreamHub.ts      Fan-out hub for SSE session streams
  leadSearch/
    stages/                  Decoupled 7-stage pipeline engine
      planStage.ts           Adaptive planner task derivation & query planning (resolveGeo, per-round cache refresh)
      retrieveStage.ts       Two-Wave parallel retrieval execution (vagueness-aware depth + queryRewriter rescue)
      fuseStage.ts           Observation normalizer & corroboration fusion (alias-aware scoring)
      extractStage.ts        Budget-capped LLM extraction & profile parsing
      verifyStage.ts         Deterministic requirement verification
      enrichStage.ts         TF-IDF company intent & LinkedIn post research
      judgeStage.ts          3-Tier Finalist Judge & Pareto skyline
    discoveryEngine.ts       Discovery Session Engine orchestrator & stage pipelining (parentSessionId/deltaBrief/interactive)
    prospectContract.ts      Contract schema, prompt intelligence & decomposition (alias-aware grounding, no geo invention)
    queryUnderstanding.ts    Complexity classifier (vague/standard/rich), resolveGeo, salience compression
    aliasMap.ts              Zero-network role/geo/company/tool alias normalization for hot loops
    queryRewriter.ts         Bounded complexity-aware zero-yield rewriter (broaden/relax, max 3)
    intentSignals.ts         Dynamic signal compiler, categories & freshness decay
    companyIntent.ts         Phase 4 company website TF-IDF intent scoring
    linkedinPostIntent.ts    Phase 5 LinkedIn post SERP intent research
    collectionCapacity.ts    Candidate batch sizing and target-scaled ceilings
    scoring.ts               Composite scoring, freshness decay & MMR diversity
    telemetry.ts             Cost, token, and execution logging
  db.ts                      SQLite v22 schema (with leads_fts virtual table + leads_fts_map rowid index), migrations, checkpoint CRUD & startup sweeps
test/                        Automated unit, integration, and replay test suites (120 test files via tsx --test)
scripts/                     Dev orchestrator and server runners
.env.example                 Configuration variables and default settings
```

---

<div align="center">
  <i>Built for careful, evidence-grounded prospect research.</i>
</div>
