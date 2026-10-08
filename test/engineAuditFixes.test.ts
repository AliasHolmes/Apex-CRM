import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-engine-audit-'));
process.env.APEX_DB_PATH = path.join(tmpDir, 'apex.sqlite');
process.env.SEARCH_LOG_RETENTION_LIMIT = '10';

const db = await import('../server/db.ts');
const { checkStrictContradiction, isBigTechEmployerName } = await import('../server/leadSearch/finalistJudge.ts');
const { resolveGeo } = await import('../server/leadSearch/queryUnderstanding.ts');

const checkpoint = (round: number) =>
  ({ round, stage: 'enrich', acceptedLeads: [], qualifiedLeads: [], updatedAt: new Date().toISOString() }) as any;

test('search-log retention never clears a resumable (error/cancelled/interrupted) checkpoint', () => {
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  for (const [id, status] of [
    ['resumable-error', 'error'],
    ['resumable-cancelled', 'cancelled'],
    ['resumable-interrupted', 'interrupted'],
    ['finished-success', 'success'],
  ] as const) {
    db.upsertMiningSession({ id, status, prompt: id, requestedLimit: 5, checkpoint: checkpoint(2), updatedAt: old } as any);
  }
  // Push all four out of the newest-10 window.
  for (let i = 0; i < 12; i++) {
    db.upsertMiningSession({ id: `newer-${i}`, status: 'success', prompt: 'p', requestedLimit: 5 } as any);
  }
  db.insertSearchLog({
    id: 'log-1',
    timestamp: new Date().toISOString(),
    prompt: 'p',
    generatedQueries: [],
    status: 'success',
    rawResultsCount: 0,
    leadsFound: 0,
    schemaVersion: 1,
  });

  assert.ok(db.readMiningSessionCheckpoint('resumable-error'), 'error checkpoint must survive');
  assert.ok(db.readMiningSessionCheckpoint('resumable-cancelled'), 'cancelled checkpoint must survive');
  assert.ok(db.readMiningSessionCheckpoint('resumable-interrupted'), 'interrupted checkpoint must survive');
  assert.equal(db.readMiningSessionCheckpoint('finished-success'), null, 'finished checkpoints follow retention');
});

test('resumable checkpoints past the age horizon are cleared', () => {
  const ancient = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
  db.upsertMiningSession({ id: 'ancient-error', status: 'error', prompt: 'p', requestedLimit: 5, checkpoint: checkpoint(1), updatedAt: ancient } as any);
  db.insertSearchLog({ id: 'log-2', timestamp: new Date().toISOString(), prompt: 'p', generatedQueries: [], status: 'success', rawResultsCount: 0, leadsFound: 0, schemaVersion: 1 });
  assert.equal(db.readMiningSessionCheckpoint('ancient-error'), null);
});

test('a same-name same-company lead with a different LinkedIn does not take the other lead\'s identity key', () => {
  const first = db.upsertLeadWithIdentity({
    id: 'lead-jane-1',
    fullName: 'Jane Smith',
    currentCompany: 'Acme Studio',
    linkedinUrl: 'https://www.linkedin.com/in/jane-smith-acme',
  });
  assert.equal(first.disposition === 'duplicate', false);
  const second = db.upsertLeadWithIdentity({
    id: 'lead-jane-2',
    fullName: 'Jane Smith',
    currentCompany: 'Acme Studio',
    linkedinUrl: 'https://www.linkedin.com/in/jane-smith-other',
  });
  assert.equal(second.disposition === 'duplicate', false, 'different LinkedIn = different person');

  const owner = db
    .getLeadsDb()
    .prepare("SELECT lead_id FROM lead_identities WHERE identity_key LIKE 'name_company:%'")
    .all() as Array<{ lead_id: string }>;
  assert.deepEqual(owner.map((r) => r.lead_id), ['lead-jane-1'], 'the name_company key stays with its first owner');

  // A third record without a LinkedIn URL still dedupes onto the original owner.
  const third = db.upsertLeadWithIdentity({ id: 'lead-jane-3', fullName: 'Jane Smith', currentCompany: 'Acme Studio' });
  assert.equal(third.disposition, 'duplicate');
  assert.equal(third.lead.id, 'lead-jane-1');
});

test('big-tech employer filter fails the employer, not agencies named after a platform', () => {
  const agencyContract = {
    brief: 'Founders of marketing agencies',
    requirements: [{ id: 'req_1', scope: 'company_type', importance: 'hard', description: 'marketing agency' }],
    exclusions: [],
  } as any;
  const agencyLead = { fullName: 'Ana', currentTitle: 'Founder', currentCompany: 'Amazon Growth Agency' };
  const result = checkStrictContradiction(agencyLead, agencyContract);
  assert.equal(result, null, 'Amazon Growth Agency is an agency named after a platform and must not be failed by the big-tech employer filter');

  const brand = /\b(microsoft|google|meta|apple|amazon|aws|azure)\b/i;
  assert.equal(isBigTechEmployerName('amazon web services', brand), true);
  assert.equal(isBigTechEmployerName('google llc', brand), true);
  assert.equal(isBigTechEmployerName('meta platforms, inc.', brand), true);
  assert.equal(isBigTechEmployerName('microsoft azure', brand), true);
  assert.equal(isBigTechEmployerName('amazon growth agency', brand), false);
  assert.equal(isBigTechEmployerName('meta digital partners', brand), false);
});

test('pronouns that collide with country codes do not anchor geography', () => {
  assert.equal(resolveGeo('Find agency founders who can help us scale outbound').countryAnchor, null);
  assert.equal(resolveGeo('Agency founders based in US').countryAnchor !== null, true);
});
