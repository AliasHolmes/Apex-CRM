import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dataDirectory = mkdtempSync(path.join(tmpdir(), 'apex-lead-persistence-'));
process.env.APEX_DB_PATH = path.join(dataDirectory, 'leads.sqlite');

const {
  deleteLead,
  getLeadsDb,
  LeadNotFoundError,
  LeadRevisionConflictError,
  readStoredLeadById,
  readQueryPerformance,
  recordQueryPerformance,
  upsertLead,
  upsertLeads,
} = await import('../server/db.ts');

const createLead = (id: string) => ({
  id,
  profile: { id: `profile-${id}`, fullName: 'Persistence Test' },
  stage: 'SCRAPED',
  notes: '',
  tags: [],
  createdAt: new Date().toISOString(),
});

after(() => {
  getLeadsDb().close();
  rmSync(dataDirectory, { recursive: true, force: true });
});

test('existing-only writes cannot recreate a deleted lead', () => {
  const stored = upsertLead(createLead('guarded-lead'));
  assert.equal(stored.revision, 1);

  deleteLead(stored.id);
  assert.throws(
    () => upsertLead({ ...stored, stage: 'ENRICHED' }, { requireExisting: true }),
    LeadNotFoundError,
  );
  assert.equal(readStoredLeadById(stored.id), null);
});

test('revision conflicts expose the current canonical lead', () => {
  const first = upsertLead(createLead('revision-lead'));
  const second = upsertLead({ ...first, stage: 'ENRICHED' }, { requireExisting: true });
  assert.equal(second.revision, 2);

  assert.throws(
    () => upsertLead({ ...first, notes: 'stale write' }, { requireExisting: true }),
    (error: unknown) => {
      assert.ok(error instanceof LeadRevisionConflictError);
      assert.equal(error.currentLead.revision, 2);
      assert.equal(error.currentLead.stage, 'ENRICHED');
      return true;
    },
  );
});

test('existing-only bulk writes roll back atomically when any lead is missing', () => {
  const existing = upsertLead(createLead('bulk-existing'));
  const missing = createLead('bulk-missing');

  assert.throws(
    () => upsertLeads(
      [
        { ...existing, stage: 'ENRICHED' },
        { ...missing, stage: 'ENRICHED' },
      ],
      { requireExisting: true },
    ),
    LeadNotFoundError,
  );

  const unchanged = readStoredLeadById(existing.id);
  assert.equal(unchanged?.revision, 1);
  assert.equal(unchanged?.stage, 'SCRAPED');
  assert.equal(readStoredLeadById(missing.id), null);
});

test('query performance stores provisional work separately from finalist outcomes', () => {
  recordQueryPerformance({
    family: 'persona_title', lane: 'person', provider: 'tavily',
    rawCandidates: 10, uniqueCandidates: 6, acceptedCandidates: 3,
    searchLatencyMs: 900, providerUnits: 1
  });
  recordQueryPerformance({
    family: 'persona_title', lane: 'person', provider: 'tavily',
    runs: 0, outcomeRuns: 1, qualifiedCandidates: 2, rescuedCandidates: 1, returnedCandidates: 2
  });

  const row = readQueryPerformance().find(row => row.scope_key === 'persona_title|person|tavily');
  assert.equal(row.runs, 1);
  assert.equal(row.outcome_runs, 1);
  assert.equal(row.accepted_candidates, 3);
  assert.equal(row.qualified_candidates, 2);
  assert.equal(row.rescued_candidates, 1);
  assert.equal(row.returned_candidates, 2);
  assert.equal(row.search_latency_ms, 900);
  assert.equal(row.provider_units, 1);
});
