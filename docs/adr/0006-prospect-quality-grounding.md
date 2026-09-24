# 6. Prospect-Collection Quality Grounding

Date: 2026-09-13

## Status

Proposed

## Scope

This ADR covers the **prospect collection engine only**: brief → retrieval → extraction →
verification → enrichment → judging → persisted prospect. In CRM terms that is the
`SCRAPED` / `ENRICHED` portion of `LEAD_STAGES` (`src/types.ts:168`).

### Non-goals (explicit)

- Outreach generation, sequences, and reply tracking.
- `REPLIED`, `MEETING BOOKED`, `NEGOTIATING`, `CONVERTED`, `LOST`, `NURTURE` stages.

These are excluded by design. Downstream outcomes measure *message and timing quality*
as much as collection quality, they arrive weeks late, and they are sparse enough that
folding them into the reward signal would add more variance than information. Collection
quality must be judged on whether the right prospect was found — which the user already
decides at review time.

## Context

ADR-0001 through ADR-0005 are all the same bet: eliminate waste. Snippet token diet
(~65%), deferred enrichment (~70%), 0ms CRM dedupe (Stage 2.5), upstream
`exclude_domains`, and the strict sequential LLM invariant. That bet has largely paid
out. What remains in a session's wall-clock is irreducible — real network fetches and
serialized LLM calls. A sixth round of waste-cutting yields single-digit percentages.

The remaining structural gap is different in kind: **the engine has no ground truth.**

`scoreAdaptiveArm()` in `server/leadSearch/adaptiveScheduler.ts:174-188` computes:

```
alphaPost = 1.0 + qualified*3.5 + returned*2.5 + unique*0.1 + classBonus*0.5
betaPost  = 1.0 + rescued*1.25 + duplicates*1.5 + providerUnits*0.12 + latency*0.002
meanReward = qualified*3.5 + returned*2.5 + unique*0.1 - rescued*1.25
             - duplicates*1.2 - providerUnits*0.12 - latency*0.002 + classBonus
```

`qualified_candidates` is the number of candidates the **Finalist Judge itself passed**.
The dominant reward term is therefore the engine grading its own homework. A query arm
that produces plausible-looking but wrong prospects is rewarded identically to one that
prospects the user actually keeps. Nothing in `alphaPost`/`betaPost` observes what the
user did with the lead afterwards.

Critically, the correcting signal already exists and is already attributable:

| Signal | Location | Notes |
| --- | --- | --- |
| Human disposition | `leads.review_status` (`server/db.ts:1268`) | `UNREVIEWED` \| `KEEP` \| `MAYBE` \| `REJECT` (`src/types.ts:169`) |
| Query attribution | `LeadEvidence.sourceQuery`, `sourceRound`, `sourceProvider` (`src/types.ts:86-92`) | Already persisted per lead |
| Lane attribution | `Lead.discoveryLane` (`src/types.ts:214`) | Aligns with the `family\|lane\|provider` arm key |
| Judge self-assessment | `uncertainty` on the candidate (`src/types.ts:130`, `:164`, `:221`) | Available to compare against realized disposition |

The loop is unclosed, not unbuildable.

## Decision

Four coordinated changes, all inside the collection boundary.

### 1. Disposition is the label

The canonical collection-side label is the `review_status` transition
`UNREVIEWED → KEEP | MAYBE | REJECT`.

- Soft-delete / archive, and leads discarded by the user during triage, count as
  implicit `REJECT`.
- The label is timestamped so review latency and label staleness are measurable.
- `UNREVIEWED` carries **no** signal. It must be excluded from both numerator and
  denominator — otherwise absence of a complaint is silently read as success, which is
  the failure mode the current reward already has.

### 2. Credit assignment back to the query arm

- Persist per-arm disposition counters alongside `query_performance`, keyed by the same
  `family|lane|provider` arm key plus a hash of `sourceQuery`:
  `kept`, `maybe`, `rejected`, `unreviewed`, `last_label_at`.
- Attribution path: `lead.evidence.sourceQuery` + `discoveryLane` + `sourceProvider` →
  arm key.
- Leads with `sourceProvider` of `manual` or `import` are excluded — they carry no
  retrievable provenance and would dilute arm statistics.
- Label weights: `KEEP = +1.0`, `MAYBE = +0.3`, `REJECT = -1.0`.

### 3. Wire the label into scheduler and judge

- **Scheduler**: add `kept` and `rejected` terms to `alphaPost`/`betaPost`/`meanReward`.
  Once a real label stream exists, reduce the `qualified` weight from `3.5` — otherwise
  the self-referential term keeps dominating the grounded one. Apply the existing
  EMA time decay ($\lambda = 0.95$) to the disposition terms as well, since labels
  arrive after the fact.
- **Judge calibration**: record the judge's per-lead `uncertainty` at judge time, join it
  to the eventual disposition, and accumulate calibration buckets. Emit a reliability
  curve and Brier score. This is what turns "evidence-grounded" from a claim into a
  measured property: today a certainty of 0.8 has no known realized hit rate.
- **Contract reporting**: surface acceptance rate (`kept / reviewed`) per contract in the
  session report. A brief that produces nothing keepable is a *brief* defect and should be
  visible as one, not absorbed as an engine defect.

### 4. Evaluation harness (prerequisite, do first)

A replay suite: recorded briefs, frozen retrieval fixtures, and human-labeled
good/bad prospects. Metrics:

- precision@K against human labels
- cost per *kept* prospect (not per qualified prospect)
- wall clock per session, duplicate rate

This must land before the reward changes. The 2026-09-12 audit noted that **none** of its
17 findings were covered by the existing 597 tests; without a quality harness there is no
way to demonstrate that this ADR improved anything, only that it changed behaviour.

## Consequences

**Positive**

- Query arms are rewarded for prospects the user keeps, not prospects the judge approved.
- Judge certainty becomes a calibrated number with a published error profile.
- Bad briefs become diagnosable as brief defects.
- Every future engine change becomes measurable on precision and cost-per-keep.

**Negative**

- Additional write path on lead mutation; one more table to migrate and back up.
- Reward signal becomes noisy in early sessions until enough labels accumulate.

**Risks and mitigations**

| Risk | Mitigation |
| --- | --- |
| **Label sparsity** — users review only a subset of leads | Denominators count reviewed leads only; weight arms by review coverage so lightly-reviewed arms do not swing the posterior |
| **Selection bias** — `REJECT` is over-represented because people disproportionately review leads that look wrong | Model `unreviewed` explicitly rather than assuming it is neutral; report review coverage per arm |
| **Confounding** — a lead is rejected because the brief was wrong, not the query | Attribute within the existing domain-cluster partition (`b2b_agency`, `b2b_saas`, …) so cross-brief contamination is bounded |
| **Feedback delay** — labels arrive days after the run | Reuse the existing EMA decay; treat disposition as a lagged term, never as an in-session signal |
| **Judge learning to please** — tuning on keep-rate may push the judge conservative | Keep the deterministic pre-filter (Stage 2.5) and hard-requirement verification untuned; only the semantic tier is calibrated |

## Alternatives considered

- **Use pipeline stage (`REPLIED`, `CONVERTED`) as the reward.** Rejected: out of scope per
  this ADR, measures outreach quality as much as collection quality, and arrives too late
  and too sparsely to drive a bandit.
- **Add an inline thumbs-up/down on result rows.** Rejected: duplicates `review_status`
  and adds a second, competing label vocabulary.
- **Offline-tune judge thresholds against the current data.** Rejected: no ground truth
  exists to tune against — producing one is the substance of this ADR.
- **Leave `qualified` as the reward and only add cost penalties.** Rejected: cheaper to
  build, but keeps the self-reinforcement loop fully intact.

## Follow-ups

- ADR-0007 candidate: bounded per-key concurrency (2–3, adaptive on observed 429 rate)
  to replace blanket `withSequentialLLMExecution` serialization, which is now the
  throughput ceiling.
- Hygiene, worth folding into the same release: three of fourteen flags in
  `server/leadSearch/featureFlags.ts` are documented inert (notably
  `proactiveTokenRegulator`), `ProviderTrafficController` is dead code, and two divergent
  copies of the SSRF guard exist (`server/services/privateHosts.ts` vs
  `server/hostValidation.ts`).

## Addendum (2026-09-25)

Status update on the follow-ups and the core loop, measured against the current tree:

- **The disposition loop has partially landed.** `lead_outcomes` (binary
  `positive | negative`) is written from lead stage/review transitions
  (`server/routes/api.ts`) and read back by the scheduler as a global outcome rate
  (`adaptiveScheduler.ts:190`, G17). The richer `KEEP = +1.0 / MAYBE = +0.3 / REJECT = -1.0`
  weighting, per-arm disposition counters, and judge calibration (Brier score /
  reliability curve) from §3 are **not** implemented — the reward is still dominated by
  judge-passed `qualified` counts.
- **Inert flags:** resolved 2026-09-17 — the six graduated flags in `featureFlags.ts`
  are now permanent architectural invariants returning `true` unconditionally.
- **`ProviderTrafficController`:** still exported from `keyRotator.ts` but exercised
  only by `test/resilienceAndCacheHygiene.test.ts`; no production caller.
- **SSRF guard duplication:** resolved in substance — `privateHosts.ts` is the shared
  SSRF guard; `hostValidation.ts` is an HTTP `Host`-header parser (request validation),
  not a second SSRF implementation.
- The ADR-0007 concurrency candidate is partially de-risked by stage-lane sharding
  (`FEATURE_LLM_STAGE_QUEUES=true`), which is implemented but off by default.
