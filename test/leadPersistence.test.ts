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
