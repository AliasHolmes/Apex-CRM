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
  readMiningSessionById,
  readStoredLeadById,
  readQueryPerformance,
  reconcileOrphanedMiningSessions,
  recordQueryPerformance,
  upsertLead,
  upsertLeadWithIdentity,
  upsertLeads,
  upsertLeadsWithIdentity,
  upsertMiningSession,
} = await import('../server/db.ts');

const { mapCandidateToPersistedLead } = await import('../server/leadSearch/discoveryEngine.ts');

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

test('reconcileOrphanedMiningSessions cleans up running and cancellation_requested sessions on startup', () => {
  upsertMiningSession({
    id: 'crashed-session-1',
    status: 'running',
    prompt: 'AI Founders in NY',
    requestedLimit: 20,
    startedAt: new Date(Date.now() - 100000).toISOString(),
  });

  upsertMiningSession({
    id: 'crashed-session-2',
    status: 'cancellation_requested',
    prompt: 'B2B SaaS in Austin',
    requestedLimit: 15,
    startedAt: new Date(Date.now() - 50000).toISOString(),
  });

  upsertMiningSession({
    id: 'completed-session',
    status: 'success',
    prompt: 'Completed search',
    requestedLimit: 10,
    startedAt: new Date(Date.now() - 200000).toISOString(),
    completedAt: new Date(Date.now() - 150000).toISOString(),
  });

  const reconciledCount = reconcileOrphanedMiningSessions();
  assert.ok(reconciledCount >= 2);

  const s1 = readMiningSessionById('crashed-session-1');
  const s2 = readMiningSessionById('crashed-session-2');
  const s3 = readMiningSessionById('completed-session');

  assert.equal(s1?.status, 'interrupted');
  assert.ok(s1?.errorMessage?.includes('Session was active when server process stopped'));
  assert.ok(s1?.completedAt);

  assert.equal(s2?.status, 'interrupted');
  assert.ok(s2?.errorMessage?.includes('Session was active when server process stopped'));
  assert.ok(s2?.completedAt);

  assert.equal(s3?.status, 'success');
});

test('reconcileOrphanedMiningSessions accepts a custom interruption reason', () => {
  upsertMiningSession({
    id: 'crashed-session-3',
    status: 'running',
    prompt: 'Custom reason check',
    requestedLimit: 5,
    startedAt: new Date(Date.now() - 30000).toISOString(),
  });

  const reconciledCount = reconcileOrphanedMiningSessions('Server process exited (SIGTERM).');
  assert.ok(reconciledCount >= 1);

  const s = readMiningSessionById('crashed-session-3');
  assert.equal(s?.status, 'interrupted');
  assert.equal(s?.errorMessage, 'Server process exited (SIGTERM).');
  assert.ok(s?.completedAt);
});

test('multi-stage progressive checkpointing updates the same lead in-place with latest data', () => {
  const db = getLeadsDb();
  const candidate: Record<string, any> = {
    fullName: 'Progressive Candidate',
    currentTitle: 'Founder',
    currentCompany: 'FlowState AI',
    contactDetails: { linkedinUrl: 'https://linkedin.com/in/progressive-candidate-1' },
    scoreBreakdown: { fitScore: 6, intentScore: 6, timingScore: 6, finalScore: 6.0 }
  };

  // Stage 1: Round Checkpoint (initial candidate discovery)
  candidate.id = candidate.id || `lead-${Date.now()}-1`;
  const mapped1 = mapCandidateToPersistedLead(candidate);
  const res1 = upsertLeadsWithIdentity([mapped1]);
  assert.equal(res1.length, 1);
  assert.equal(res1[0].disposition, 'created');
  candidate.id = res1[0].lead.id;

  const stored1 = readStoredLeadById(candidate.id);
  assert.ok(stored1);
  assert.equal(stored1?.revision, 1);
  assert.equal(stored1?.profile?.scoreBreakdown?.finalScore, 6.0);
  assert.equal(stored1?.profile?.qualification, undefined);

  // Stage 2: Post-Judge Checkpoint (candidate scored & qualified by Finalist Judge)
  candidate.scoreBreakdown = { fitScore: 8.5, intentScore: 8.5, timingScore: 8.5, finalScore: 8.5 };
  candidate.finalSelectionScore = 8.5;
  candidate.qualification = { verdict: 'qualified', finalScore: 8.5, reason: 'Verified founder and agency match' };

  const mapped2 = mapCandidateToPersistedLead(candidate);
  const res2 = upsertLeadsWithIdentity([mapped2]);
  assert.equal(res2.length, 1);
  assert.equal(res2[0].disposition, 'updated');
  assert.equal(res2[0].lead.id, candidate.id);

  const stored2 = readStoredLeadById(candidate.id);
  assert.ok(stored2);
  assert.equal(stored2?.revision, 2);
  assert.equal(stored2?.profile?.scoreBreakdown?.finalScore, 8.5);
  assert.equal(stored2?.profile?.qualification?.verdict, 'qualified');

  // Stage 3: Post-Phase 5 Final Persistence (intent evidence and final boost)
  candidate.postIntentEvidence = {
    quality: 'strong',
    intentCategory: 'hiring',
    confidenceScore: 9,
    intentKeywords: ['hiring AI engineers']
  };
  candidate.scoreBreakdown = { fitScore: 8.5, intentScore: 8.5, timingScore: 8.5, finalScore: 9.2 };
  candidate.finalSelectionScore = 9.2;

  const mapped3 = mapCandidateToPersistedLead(candidate);
  const res3 = upsertLeadsWithIdentity([mapped3]);
  assert.equal(res3.length, 1);
  assert.equal(res3[0].disposition, 'updated');
  assert.equal(res3[0].lead.id, candidate.id);

  const stored3 = readStoredLeadById(candidate.id);
  assert.ok(stored3);
  assert.equal(stored3?.revision, 3);
  assert.equal(stored3?.profile?.scoreBreakdown?.finalScore, 9.2);
  assert.equal(stored3?.profile?.postIntentEvidence?.intentCategory, 'hiring');

  // Verify that only 1 single row exists in the database for this person
  const countRow = db.prepare("SELECT COUNT(*) as count FROM leads WHERE full_name = 'Progressive Candidate'").get() as { count: number };
  assert.equal(countRow.count, 1);
});
