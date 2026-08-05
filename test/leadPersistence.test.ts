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
  upsertLeadWithIdentity,
  upsertLeads,
  upsertLeadsWithIdentity,
} = await import('../server/db.ts');

const createLead = (id: string, linkedinUrl?: string) => ({
  id,
  profile: {
    id: `profile-${id}`,
    fullName: 'Persistence Test',
    currentTitle: 'Founder',
    currentCompany: 'Acme',
    contactDetails: linkedinUrl ? { linkedinUrl } : {},
  },
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

test('LinkedIn identity write guard returns the original lead instead of creating a second ID', () => {
  const first = upsertLeadWithIdentity(createLead('identity-first', 'https://www.linkedin.com/in/identity-person/'));
  const second = upsertLeadWithIdentity({
    ...createLead('identity-second', 'linkedin.com/in/IDENTITY-person?trk=public_profile'),
    profile: {
      ...createLead('identity-second', 'linkedin.com/in/IDENTITY-person?trk=public_profile').profile,
      fullName: 'Identity Person, Updated Title',
      currentTitle: 'Chief Executive Officer',
    },
  });

  assert.equal(first.disposition, 'created');
  assert.equal(second.disposition, 'duplicate');
  assert.equal(second.lead.id, 'identity-first');
  assert.equal(readStoredLeadById('identity-second'), null);
});

test('bulk writes dedupe candidates within the same transaction', () => {
  const results = upsertLeadsWithIdentity([
    createLead('identity-bulk-one', 'https://linkedin.com/in/bulk-person'),
    createLead('identity-bulk-two', 'https://www.linkedin.com/in/BULK-person/?source=share'),
  ]);

  assert.deepEqual(results.map(result => result.disposition), ['created', 'duplicate']);
  assert.equal(results[1].lead.id, 'identity-bulk-one');
  assert.equal(readStoredLeadById('identity-bulk-two'), null);
});

test('an update cannot take another lead LinkedIn identity, and deleting releases it', () => {
  const owner = upsertLeadWithIdentity(createLead('identity-owner', 'https://linkedin.com/in/identity-owner'));
  const other = upsertLeadWithIdentity(createLead('identity-other', 'https://linkedin.com/in/identity-other'));
  const collision = upsertLeadWithIdentity({
    ...other.lead,
    profile: {
      ...other.lead.profile,
      contactDetails: { linkedinUrl: 'https://linkedin.com/in/identity-owner/' },
    },
  }, { requireExisting: true });

  assert.equal(collision.disposition, 'duplicate');
  assert.equal(collision.lead.id, owner.lead.id);
  assert.equal(readStoredLeadById(other.lead.id)?.profile.contactDetails?.linkedinUrl, 'https://linkedin.com/in/identity-other');

  deleteLead(owner.lead.id);
  const replacement = upsertLeadWithIdentity(createLead('identity-replacement', 'https://linkedin.com/in/identity-owner'));
  assert.equal(replacement.disposition, 'created');
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
