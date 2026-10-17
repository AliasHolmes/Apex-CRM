# 15. Grounded Engine-Write Invariant

Date: 2026-10-17

## Status

Accepted

## Scope

This ADR covers the database-level persistence invariant for leads written by discovery engine processes:
- Invariant choke point in [`server/db.ts`](../../server/db.ts) (`upsertLeadsWithIdentity`, `hasGroundedQualification`)
- Lead persistence stage in [`server/leadSearch/stages/persistStage.ts`](../../server/leadSearch/stages/persistStage.ts)
- Activity audit logging in `lead_activities` table
- Pinned regression test suite in [`test/groundedWriteInvariant.test.ts`](../../test/groundedWriteInvariant.test.ts)

---

## Context

Prior to this decision, engine writes passed directly to `upsertLeadsWithIdentity` carrying arbitrary `reviewStatus`, `nextAction`, and `tier` attributes. 

While the standard pipeline evaluates candidates via `finalistJudge` and stamps verified requirement quotes into `lead.qualification`, alternative or experimental execution paths (such as `agentBrainRunner.ts`) could write ungrounded heuristic leads directly into SQLite marked as `reviewStatus: 'KEEP'`, `nextAction: 'CONNECT'`, and `tier: 'TIER 1: PRIORITY'`.

This created an architectural trust hole:
1. Heuristically scraped candidates bypassed the LLM judge and evidence selection gates.
2. Leads appeared in the CRM UI as pre-approved (`KEEP` / `PRIORITY`) without any verbatim quotes or evidentiary basis.
3. Operators had no mechanical guarantee that engine-originated `KEEP` records were genuinely qualified.

---

## Decision

### 1. The Grounded Qualification Requirement

We establish a mechanical invariant enforced at the database transaction layer (`server/db.ts` -> `upsertLeadInExistingTransaction`):

A lead payload is considered grounded if and only if `hasGroundedQualification(lead)` evaluates to `true`:
- `lead.qualification` exists as an object.
- **Either** `qualification.sourceVerdict === 'candidate_verdicts'` (valid cross-session judge cache reuse),
- **Or** `qualification.verdict` is `'qualified'` or `'qualified_partial'` **and** at least one entry in `qualification.requirements` carries a non-empty string in `quote` or `evidenceQuote`.

### 2. Automatic Demotion on Engine Writes

When `options.isEngineWrite === true`:
- If `!hasGroundedQualification(lead)`, the persistence layer automatically demotes workflow fields:
  - `reviewStatus` is set to `'UNREVIEWED'` (Apex CRM neutral default).
  - `nextAction` is set to `'NONE'`.
  - If `tier` was `'TIER 1: PRIORITY'`, it is demoted to `'TIER 3: WATCH'`.
  - Appends `[ungrounded-write]` marker to `notes`.
  - If the incoming payload attempted a positive heuristic status (`KEEP`, `CONNECT`, or `TIER 1`), an audit record is inserted into `lead_activities` with `type: 'ungrounded_write_demotion'`, `actor: 'engine'`, `from_value: originalStatus`, and `to_value: 'UNREVIEWED'`.

### 3. Non-Engine Writes Preserved

Non-engine operations (manual user edits, CSV file imports, lead merges) do not set `options.isEngineWrite === true`. These flows are completely unaffected and retain full authority to set any valid status without qualification requirements.

---

## Verification & Guard Rails

- Pinned unit and integration tests in `test/groundedWriteInvariant.test.ts`:
  - Pure helper evaluations of valid quotes, cached verdicts, and ungrounded payloads.
  - End-to-end database persistence verifying grounded pass-through vs. ungrounded demotion.
  - Activity log verification for demoted records.
  - Verification that CSV / manual import writes remain exempt.
