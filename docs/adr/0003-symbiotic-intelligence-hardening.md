# 3. Symbiotic Intelligence Hardening: Domain MAB, Dynamic Query Strategy, DCR Scoring & Entity Resolution

Date: 2026-08-28

## Status
Accepted

## Context
Across discovery sessions, Apex CRM previously operated under several heuristic constraints:
1. **Unpartitioned Multi-Armed Bandit (MAB)**: Query performance history in `query_performance` aggregated all searches into flat scope keys (`family|lane|provider`). Agency discovery metrics polluted SaaS and coaching discovery runs, and historical counts lacked time decay to phase out obsolete query performance.
2. **Brittle Permutation Fallbacks**: When LLM strategist outputs collided or exhausted candidates, fallback query planning relied on naive Cartesian product loops across roles, company types, and locations.
3. **Decision-Maker Verification Gaps**: Career Trajectory DCR contained a label bug where `partner` was checked against `managing partner`, missing standard equity and advisory partners. Modern leadership structures (Fractional CXOs, Practice Leads, Head of RevOps/GTM, Principal Consultants) were dropped by strict regex matches.
4. **Finalist Judge Evidence Truncation**: Evidence window caps (3 items / 400 characters) severed multi-attribute proof, causing false-positive fabrication rejections when cited quotes spanned adjacent candidate passages.
5. **Shallow Site Probing & Entity Drift**: Company website probing extracted only basic location/headcount lines, ignoring commercial buying signals (pricing models, case studies, tech stack integrations, and hiring roles). International legal entity forms (`S.R.L.`, `S.A.S.`, `AG`, `Pte Ltd`, `Sp. z o.o.`) created duplicate records for multinational companies.

## Decision
We implement a comprehensive symbiotic intelligence hardening across Pillars 1 and 2:

### 1. Domain-Clustered MAB with Exponential Time Decay ($\lambda = 0.95$)
- SQLite Schema v19 adds `domain_cluster` to `query_performance` (partitioned across `b2b_agency`, `b2b_saas`, `executive_coaching`, `local_services`, `healthcare_life_sciences`, `professional_services`, and `global`).
- On every conflict update, historical runs, candidate counts, and latencies decay by factor 0.95 ($C_{new} = \text{round}(C_{old} \times 0.95 + C_{delta})$).
- The adaptive scheduler looks up domain-specific historical yield before falling back to global performance.

### 2. Dynamic Semantic Query Expansion & Enriched Diagnostics
- Fallback queries dynamically synthesize domain synonyms, contract tooling keywords, and pain signals.
- Round diagnostics track `observedNonMatchingAttributes` (geographic and role distributions from candidate rejects) to steer strategist counter-queries.
- Recovery query prompts inject observed non-matching patterns and semantic synonym allowances.

### 3. Career Trajectory DCR & Modern Leadership Verification
- Fixed partner label check in `computeCareerTrajectoryDCR`.
- Added recognition and authority weighting for Fractional CXOs, Practice Leads, RevOps/GTM Heads, and Principal Consultants.

### 4. Resilient Finalist Judging & Multi-Passage Grounding
- Expanded default evidence window to 5 items / 800 characters (`FINALIST_JUDGE_MAX_EVIDENCE_ITEMS` and `FINALIST_JUDGE_EVIDENCE_CHARS`).
- Added multi-evidence fallback scanning in `normalizeAssessment` to verify quotes across all candidate evidence before assigning `fabricatedPass`.

### 5. High-Fidelity Site Probing & Global Entity Resolution
- Expanded `SiteSignals` schema to capture `pricingModel`, `caseStudies`, `techStack`, and `openRoles`.
- Multi-tier site probe scans subpaths (`/about`, `/team`, `/pricing`, `/case-studies`, `/careers`, `/integrations`).
- `normalizeCompanyName` normalizes global entity suffixes and regional branches (`S.R.L.`, `S.A.S.`, `S.L.`, `AG`, `Pte Ltd`, `Sdn Bhd`, `Sp. z o.o.`, `ApS`, `Pty Ltd`, `EMEA`, `APAC`, `Global`, `Holdings`).

## Consequences
- **Positive**: Cross-session learning is isolated by domain cluster, preventing cross-industry performance pollution.
- **Positive**: Exponential time decay prevents stagnant query performance scores from locking in suboptimal search strategies.
- **Positive**: Increased recall for modern executive titles without sacrificing precision.
- **Positive**: Zero live API token overhead in unit tests with 100% deterministic in-memory mocking.
- **Neutral**: Database schema bumped to version 19 with automated idempotent SQLite migration.
