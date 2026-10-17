# Architecture Hardening: Seam Typing, Grounded Writes, Identity Canonicalization, Replay Gate

> For the implementing agent. Read this whole file before touching code. Work in phases,
> in order; each phase is independently shippable and ends with green tests.

## Status (2026-10-17)

IMPLEMENTED by a separate agent on top of `10c384b`; the work sits **uncommitted** in the
working tree. Verified after the fact: typecheck 0 errors; `npm test` 1,287 pass / 0 fail
across 194 suites. Disposition of notable items:

- All phases (0-7) landed, including the replay gate + `test/fixtures/replay/` corpus and
  `npm run test:replay`.
- ADR numbering shifted: the operator's ADR-0014 (Byesu primary, Atria decommissioned) took
  the slot, so the grounded engine-write invariant is **ADR-0015**; the `db.ts` comment, the
  test-suite describe line, and the Phase 4 bullet above were corrected to match.
- Provider surface changed under ADR-0014 after this plan was frozen: Atria env/config removed
  (`atriaConcurrency` / `atriaProvider` tests deleted and replaced by `byesu*`), Byesu slots
  8 (code fallback now 8 to match), planner order `["primary", "openrouter", "groq"]`.
- The Agent Brain overlay was **committed** at `10c384b` (rather than deleted) and its writes
  now flow through the ADR-0015 grounded gate.
- Streaming seams graduated as planned (flags + wholesale fallbacks deleted; only
  `LEAD_STREAMING_JUDGE_BATCH_TARGET` / `LEAD_STREAMING_JUDGE_FLUSH_MS` remain).

## Context

Index re-pin on 2026-10-16 (`HEAD 425f567` + Agent Brain overlay) produced a free-improvement
shortlist for the engine (`server/leadSearch/`). The operator accepted these items and issued
two directives:

- **DROP the typed runtime-config module.** No new config layers/files; the 134-key env
  surface stays as-is.
- **The god files (`server/db.ts`, `server/services/llm.ts`, `server/discoveryEngine.ts`)
  are intentional.** No file splits — improvements must route through existing module
  boundaries.

Accepted work, in the operator-chosen scope:

| # | Work | One-line goal |
|---|------|---------------|
| W1 | Seam typing | `Lead`-typed checkpoint, session state, and streaming callbacks |
| W2 | Grounded-write invariant | Engine writes without verdict/evidence persist as `UNREVIEWED`, never `KEEP` |
| W3 | Canonical LinkedIn identity | One helper replaces ~9 hand-rolled `linkedin:<slug>` constructions |
| W4 | Golden replay corpus | Real-session checkpoints replayed as a regression gate (MFDD, made mechanical) |
| W5 | Cleanup batch | Graduate the 2 streaming seams; judge-purity guard; prompt versions; primitives audit |

## Findings (measured 2026-10-16; do not re-derive, re-check only if line numbers drifted)

| # | Finding | Where |
|---|---|---|
| F1 | `PipelineSessionState.acceptedLeads/qualifiedLeads/finalLeads: any[]`, `brightDataStats: any`, `debugLogs: any[]`; `MiningSessionCheckpoint` lead arrays `any[]` | `pipelineTypes.ts` L85–110, L122–156 |
| F2 | Streaming callbacks untyped: `onQuerySettled(batch: {...})` returns `any`-typed items; `onTargetsReady(readyLeads: any[])` | `discoveryEngine.ts` L1473, L2131 |
| F3 | `Lead` domain type already exists (id, profile, stage, scores, evidence, postIntentEvidence, tier, …) but engine seams don't use it | `src/types.ts` L181–224 |
| F4 | `linkedin:<handle>` identity keys are hand-built in ≥9 files, each deriving the handle differently (regex vs extractLinkedInUsername vs normalizeCandidateKey); checkpoint resume correctness depends on these agreeing | `pipelineTypes.ts` L175, `fuseStage.ts` L245–247, `extractStage.ts` L330/L390/L528/L607/L966/L1005–1009/L1178, `verifyStage.ts` L114–129, `retrieveStage.ts` L187, `persistStage.ts` L220, `sessionHelpers.ts` L116/L241, `observations.ts` L32, client `src/utils/leadDedupe.ts` L149 |
| F5 | `upsertLeadsWithIdentity(..., { isEngineWrite })` is the single engine write choke point; writes carry `qualification?: Record<string, any>` (verdict + requirement quotes) as an existing field | `db.ts` L2209, L2569, L2758 |
| F6 | Review-status neutral value is already a schema default: `review_status TEXT NOT NULL DEFAULT 'UNREVIEWED'`; `REVIEW_STATUSES` set normalizes incoming values | `db.ts` L137–163, L836 |
| F7 | Streaming seam gates exist and default on: `LEAD_STREAMING_EXTRACTION` (`!== "false"`, L1425), `LEAD_PIPELINE_STREAMING_JUDGE` (`!== "false"`, L2035), coalescing (`BATCH_TARGET||3` L2059, `FLUSH_MS||120` L2063). Neither `.env` nor `.env.example` sets any of the four keys | `discoveryEngine.ts` |
| F8 | Judge-purity invariant is prose, not a pinned test: "the judge prompt never contains site-probe signals (evidenceSelection reads only evidence blocks and snippets)" | `CONTEXT.md` (ADR-0012 entry), `evidenceSelection.ts` |
| F9 | Two judge-pool primitives: `runRollingPool` (`rollingPool.ts`, 42 lines; non-stream) vs `createLiveRollingPool` (`liveRollingPool.ts`, 108 lines; stream). `providerQueue.ts` wraps `p-queue` and powers 5 call sites (retrieve L156/L510, extract L1328, enrich L818/L923, intentEnrichment L222, linkedinPostIntent L767/L793) | stage imports |
| F10 | `Prompt` builders don't record versions; `llm_stage_logs` has no prompt-version column (adding one would be a schema bump — not planned) | stage files, `telemetry.ts` |
| F11 | Replay mechanics exist: `test/targetFulfillmentReplay.test.ts` + `MiningSessionCheckpoint` delta serialization — a corpus needs curation, not invention | `test/` |

## Hard constraints (from the operator and the repo)

- **No god-file splits.** `db.ts`, `llm.ts`, `discoveryEngine.ts` keep their current shape;
  invariants get enforced *inside* them at existing choke points. New small modules (e.g.
  `leadDomain.ts`, identity helper lives in an existing service) are fine; new *config*
  machinery is not.
- **No config-module.** Do not parse/centralize the 134 env keys. Exceptions: deleting the
  two seam flags (W5) and syncing `.env.example`'s stale 4/4 slot values to the actual
  runtime 8/10 (doc-level fix of an existing file, not a config system).
- **Do not use `npx`.** Run tests with `.\node_modules\.bin\tsx.cmd --test <files>` and
  typecheck with `.\node_modules\.bin\tsc.cmd --noEmit`.
- **Do not add Claude attribution/co-author trailers.** Commit only when the operator asks.
- **Industry-agnostic engine (ADR-0007).** No AI-specific titles/verticals/hardcoded vocab
  anywhere in code or prompts; absorbed logic from any bypass path must be generalized.
- Match surrounding style; terse comments only where the *why* is non-obvious.
- End every phase green: typecheck 0 errors + full `tsx --test` pass (or an explicit,
  justified exception recorded here).

---

## Phase 0 — Tree state, decisions, baseline (no engine code; ~45 min)

1. **Commit the doc sync** (README v27 claims + `docs/CODEBASE_INDEX.md` refresh) as its own
   commit before any code work mixes into the tree.
2. **DECISION GATE (operator): Agent Brain disposition.** Recommendation: absorb the useful
   deterministic logic (title triage regexes already have tested siblings in
   `titleTriage.ts`; entity filters overlap `profileQuality.ts`) into those modules with
   industry-agnostic vocab, then delete `agentBrainRunner.ts`, `scripts/agent-brain.ts`, the
   `/find-leads` branch, and the two npm scripts. Alternative: keep the overlay, fix its
   ASCII bytes (`✅`/`⚠️`/`❌` → `PASS`/`WARN`/`FAIL`; U+2013 → `-`), and document it as a
   mode under ADR — W2 will make its writes demote to `UNREVIEWED` either way.
3. Baseline: record full-suite counts (currently **1,281 pass / 1 fail** caused solely by
   the overlay's ASCII bytes) at the top of this file.
4. Fixture harvesting for Phase 7: export 2–3 real, recent `mining_sessions.checkpoint_json`
   rows from `.apex-data` into `test/fixtures/replay/` (sanitized of any tokens; leads stay —
   it is a local-first app).

## Phase 1 — Canonical LinkedIn identity (W3; small, pure, warms up the touch-points)

Goal: one canonical constructor; zero behavioral drift.

1. Add `canonicalLinkedInIdentity(input: string): string` to the existing
   `server/services/linkedinEvidence.ts` (next to `extractLinkedInUsername` /
   `normalizeLinkedInUrl` — no new service file). Accepts full URLs, `linkedin:slug` keys,
   and bare slugs; normalizes casing, trailing `/`, query strings, `/in/<locale>/` prefixes;
   returns `''` on unparseable input (call sites keep their current empty-key semantics).
2. Replace the F4 sites in the order: `pipelineTypes.ts` (checkpoint-critical) →
   `extractStage.ts` → `fuseStage.ts` → `verifyStage.ts` → `persistStage.ts` →
   `sessionHelpers.ts` → `observations.ts` → `retrieveStage.ts`.
3. **Wire-format invariant:** output stays byte-identical (`linkedin:<lowercase-slug>`) —
   no data migration, existing DB keys unchanged.
4. New `test/identityCanonicalization.test.ts`: fixtures covering the current grep-observed
   shapes (uppercase, slash, query, locale prefix, pronoun-slug edge cases) asserting exact
   key output for every replaced site's input shape.
5. Client (`src/utils/leadDedupe.ts`): leave as-is this phase; add a line to `CONTEXT.md`
   documenting the canonical format (the client reads it, only the server writes it).
   Revisit only if a mismatch is ever observed.

Validation: identity/ledger suites (`leadDedupe`, `leadIdentityMigration`, `identityKeysHarmonization`,
`leadHash`, `sessionPersistenceAndResume`) + full suite.

## Phase 2 — Seam typing (W1; compiler-led, no runtime behavior change)

Goal: the two hot seams (checkpoint round-trip, streaming callbacks) become type-checked.

1. New `server/leadSearch/leadDomain.ts` exporting `EngineLead`: `import type { Lead }` from
   `../../src/types.js` (type-only, erased at runtime — runtime-safe under tsx/esbuild)
   intersected with engine-only extras used on the wire: `candidateId`, `_locationProvenance`,
   `qualification`, `isProvisionalEntity`, minus never-present-with-engine fields as needed.
   Converge with `FinalistCandidate` over phases; start from what compiles.
2. Type in `pipelineTypes.ts`: the four checkpoint lead arrays, the three
   `PipelineSessionState` lead arrays, `ParkedCandidate.recheck` payload → `EngineLead[]`.
3. Type the streaming callbacks in `discoveryEngine.ts`: `onQuerySettled` items and
   `onTargetsReady(readyLeads: EngineLead[])`; thread through `liveRollingPool`/`rollingPool`
   generics.
4. Where a payload is truly opaque (`stats`, `brightDataStats`, `debugLogs`), tighten from
   `any` to a minimal structural type or `unknown` — no invented taxonomies.
5. `tsc --noEmit` drives the cleanup loop; `noUnusedLocals`/`noUnusedParameters` stay on.
   Do NOT silence errors with `as any` at the seams being fixed.

Validation: full suite (checkpoint/resume suites are the canary: `checkpointBudget`,
`sessionPersistenceAndResume`, `schemaV26`, `schemaV27QueueWait`, `engineRemediationWiring*`).

## Phase 3 — Judge-purity regression guard (W5; tiny, do before refactor waves)

1. New test in `test/compactJudgeGrounding.test.ts` (or a sibling `judgePromptPurity.test.ts`):
   build a candidate whose enrichment carried site-probe-only fields (site pricing/case
   studies/hiring roles, `_locationProvenance = 'company_site'` values), call
   `evaluateIncrementalJudgeBatches` with a spy provider capturing the request payload, and
   assert the serialized prompt contains none of the site-probe-only field markers (exact
   names pulled from `siteProbe.ts`'s result shape) while still containing the lead's
   evidence blocks and snippets.
2. Run the same assertions through the coalescing buffer path (batch target 3 / flush 120ms)
   and the drain-time flush to guard the seam, not just the function.

This pins F8's prose invariant at source level (same pattern as the `<= 1.0` score guard).

## Phase 4 — Grounded-write invariant (W2; semantic, guarded by tests + ADR)

Goal: close the trust hole that lets bypass paths persist heuristic leads as `KEEP`.

1. In `db.ts` `upsertLeadsWithIdentity`: when `options.isEngineWrite` is true, require
   grounded qualification on the payload — non-empty `qualification` whose `verdict` is
   `qualified`/`qualified_partial` **and** at least one requirement entry carrying a verbatim
   quote, **or** a candidate-verdict-reuse marker (`sourceVerdict: 'candidate_verdicts'` set
   by the judge cache path). Missing both ⇒ demote `reviewStatus` to `'UNREVIEWED'`
   (F6's existing neutral default), strip `nextAction` to its neutral value, append a
   `[ungrounded-write]` note; never write `KEEP`/`CONNECT`/`TIER 1` heuristically.
2. Define `hasGroundedQualification` as a small exported pure helper in `db.ts` so tests hit
   it directly and stage code stays untouched.
3. Explicitly untouched: non-engine writes (CSV import, manual edits, merge flows) and
   `forceOverwrite` semantics.
4. New `test/groundedWriteInvariant.test.ts`: grounded passes through; heuristic payload
   demotes; verdict-cache reuse exempt; CSV/manual paths unaffected; demoted lead appears in
   `lead_activities` with the reason.
5. Write **ADR-0015 ("Grounded Engine-Write Invariant")** — one page: problem (Agent-Brain-style
   writes), rule, demotion behavior, test pin. Update `CONTEXT.md` + this index per
   `docs_sync` rule. (Numbering note: ADR-0014 was taken by the Byesu-primary decommissioning;
   the grounded invariant landed as ADR-0015.)
6. Optional later (NOT in scope): schema v28 `qualification_provenance` column if operators
   ever need to query provenance — the JSON gate suffices for now.

Validation: persistence suites (`leadPersistence`, `leadMutationContracts`, `groundedWriteInvariant`)
+ full suite.

## Phase 5 — Graduate the streaming seams + consolidate judge pools (W5)

Goal: one code path each for extraction and judging; env surface shrinks.

1. Delete the `LEAD_STREAMING_EXTRACTION` / `LEAD_PIPELINE_STREAMING_JUDGE` gates and the
   wholesale fallback loops (A4 precedent: graduated flags were deleted outright — F7 shows
   neither key is set anywhere, so nothing breaks). Keep the seam options object keys out of
   the stage call sites where the flag chose between two arguments.
2. Judge-pool consolidation, receipt-driven: `judgeStage.ts` imports `runRollingPool`
   (non-stream); the stream path runs `evaluateIncrementalJudgeBatches` via
   `createLiveRollingPool`. After (1), inspect which of the two remains reachable from the
   round loop; delete the orphaned one *and* its dedicated test files (A1 precedent: suite
   file counts drop when a path dies). If both remain live, delete nothing and record why.
3. `providerQueue`/`p-queue` audit outcome (recorded, no action): it powers 5 central call
   sites as a rate-shaped bounded queue — a genuinely different role from the judge pools.
   Keep it. Reconsider only if telemetry ever shows double-throttling against
   `providerActiveSlots`.
4. Sync `.env.example` slot values to the runtime 8/10 (and extraction/judge concurrency
   8/6) so the mirror stops lying; note in the sync commit that this is a doc fix, not a
   config system (per operator directive).
5. `docs_sync`: `CONTEXT.md`, `README.md`, `docs/CODEBASE_INDEX.md` lose the "default on /
   `false` restores" language for the two seams.

Validation: engine-remediation suites (`engineBottleneckRemediation`, `engineRemediationWiring*`,
`parallelRetrieval`, `liveRollingPool`, `rollingPool` — minus any deleted with a dead path),
`atriaConcurrency`, `llmStageQueue`, full suite.

## Phase 6 — Prompt version stamping (W5; no schema, no framework)

1. Declare `EXTRACT_PROMPT_VERSION` / `JUDGE_PROMPT_VERSION` / `STRATEGIST_PROMPT_VERSION`
   string consts beside their builders (stage files; a const per builder, incremented
   manually with each template change).
2. Stamp into existing telemetry: trace events (`telemetry.ts`), terminal log lines
   (`terminalLog.ts`), and the JSON payload columns already written (e.g.
   `llm_stage_logs` details via existing TEXT fields). **No DDL.**
3. Test: the version consts appear in emitted structured logs for each stage
   (extend `telemetry.test.ts` / `terminalLog.test.ts`).

## Phase 7 — Golden replay corpus (W4; last — baselines the canonical, graduated path)

Goal: make MFDD a regression gate, not a methodology memo.

1. Extend the `targetFulfillmentReplay` mechanics into `test/replayGate.test.ts`: for each
   fixture under `test/fixtures/replay/<sessionId>/` (checkpoint.json from Phase 0
   harvesting), replay `plan → retrieve → fuse → extract → verify → enrich → judge → select →
   persist` with deterministic mock ports (retrieval/LLM/scrape outputs seeded from the
   recorded session's query runs), then assert:
   funnel counts (`rawCandidates → qualified → selected`),
   verdict distribution, rejection-reason mix, round count,
   and token/cost envelope within tolerance.
2. Curate 2 fixtures to start (one spend-heavy multi-round stall case, one clean target-met
   case); grow to 5 as real sessions accumulate.
3. Add `test:replay` npm script; include it in `test:lead-engine`.
4. Any future engine change that perturbs replay outputs must either fix the regression or
   justify the diff in the ADR/commit that accepts it.

Validation: the gate itself; full suite; final typecheck.

---

## Sequencing rationale

Identity first (pure, touches the resume-critical paths while nothing else moves), typing
second (compiler-led; makes Phases 4–5 refactors safe), purity guard third (pins the
invariant the seams rely on *before* Phase 5 cuts the fallback path), grounded writes fourth
(semantics, needs ADR), graduation fifth (deletes paths — cleanest right after the guard
lands), prompts sixth (independent), replay last (baselines everything after graduation).

## Post-run

- Re-pin `docs/CODEBASE_INDEX.md` (counts, §9 notes, ADR list) per the `docs_sync` rule.
- Add a `memory` note for the grounded-write invariant + seam graduation so future sessions
  don't re-introduce bypass writes or wholesale paths.
