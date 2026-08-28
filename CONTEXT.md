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
