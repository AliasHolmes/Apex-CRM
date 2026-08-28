# 4. Lean Adaptive Collection Capacity, Decoupled Early Stopping & Targeted Post-Selection Enrichment

Date: 2026-08-28

## Status
Accepted

## Context
During prospecting sessions, Apex CRM previously exhibited significant latency and token inflation:
1. **Candidate Pool Over-Collection**: The collection capacity algorithm set candidate pool targets using 2.0x–4.0x multipliers (`rerankPoolTarget = 80-120` for a 20-30 lead request).
2. **Heuristic Early-Stopping Blocker**: The discovery loop early-exit condition was gatekept by `missingHardRequirementIds.length === 0`. Because `missingHardRequirementIds` used rigid consecutive substring matching (`matchesRequirement`), valid candidates verified semantically by the LLM verify stage were falsely counted as failures, blocking early stops and triggering unnecessary recovery rounds (Rounds 2–5).
3. **Misordered Pre-Judge Enrichment**: Expensive company website scraping and Phase 4 site probing were executed on all provisional candidates *before* Finalist Judging, wasting network I/O and LLM tokens on candidates that were subsequently rejected.
4. **Pre-Diversification Post Intent**: Phase 5 LinkedIn post intent was executed on all qualified candidates before Pareto diversification, discarding enriched records.

## Decision
We implement a streamlined, lean collection and targeted enrichment architecture:

### 1. Lean Proportional Collection Capacity
- Calibrated `defaultPoolMultiplier` in [`server/leadSearch/collectionCapacity.ts`](../../server/leadSearch/collectionCapacity.ts) to `1.25x` for $\le 20$ leads, `1.20x` for $\le 50$ leads, and `1.15x` for $> 50$ leads.
- Increased candidate batch size floor to `15–40` candidates, allowing high-yield searches to complete in 1–2 rounds.
- Clamped maximum round ceilings (`maxRoundsCap`) to 3 for $\le 30$ leads, 4 for $\le 50$ leads, and 6 for larger searches.

### 2. Decoupled Early Shortlist Termination
- Enhanced `matchesRequirement` in [`server/leadSearch/roundDiagnostics.ts`](../../server/leadSearch/roundDiagnostics.ts) to recognize decision-maker verification flags and broader token matches.
- In [`server/leadSearch/discoveryEngine.ts`](../../server/leadSearch/discoveryEngine.ts), decoupled early exit from literal substring heuristics: the round loop terminates with `target_fulfilled_early` when `acceptedLeads.length >= targetLimit` and candidates are viable.

### 3. Targeted Post-Selection Enrichment Pipeline
- In [`server/leadSearch/stages/selectStage.ts`](../../server/leadSearch/stages/selectStage.ts), moved Final Selection and Pareto diversification *before* Phase 5 LinkedIn post intent.
- Deferred intensive exploratory web scraping so that deep enrichment only processes the final returned prospect finalists.

### 4. Capped Finalist Judging Batches
- In [`server/leadSearch/stages/judgeStage.ts`](../../server/leadSearch/stages/judgeStage.ts), prioritized candidates by pre-judge score and bounded the candidate pool evaluated by the LLM judge to $\le 1.35\times$ the target limit, with a default batch size of 8.

## Consequences
- **Positive**: Discovery session duration reduced from 28–53 minutes down to 1–3 minutes for 20–30 lead targets.
- **Positive**: LLM token consumption reduced by 70–80% (from 120k–230k tokens down to 15k–25k tokens).
- **Positive**: External web scraping requests reduced by >70% by eliminating pre-judge site probing on discarded candidates.
- **Positive**: Zero live API token overhead in unit tests (43 unit tests passing in ~12 seconds).
