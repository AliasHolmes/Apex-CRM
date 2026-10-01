import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getLeadsDb, LATEST_SCHEMA_VERSION, upsertCandidateVerdict, getCandidateVerdict,
  upsertCompanyProfile, getCompanyProfile, upsertCompanyAttributionVerdict, getCompanyAttributionVerdict,
} from '../server/db.js';

const later = new Date(Date.now() + 400 * 24 * 3600 * 1000);

test('creates the v26 tables and columns', () => {
  const db = getLeadsDb();
  assert.equal(LATEST_SCHEMA_VERSION, 26);
  assert.equal((db.prepare('PRAGMA user_version').get() as any).user_version, 26);
  for (const table of ['company_profiles', 'company_attribution_verdicts']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  }
  const cols = (db.prepare('PRAGMA table_info(candidate_verdicts)').all() as any[]).map(c => c.name);
  assert.ok(cols.includes('evidence_hash') && cols.includes('qualification_json'));
});

test('round-trips pass verdicts with evidence hash and qualification', () => {
  upsertCandidateVerdict({ identityKey: 'linkedin:pass-probe', requirementHash: 'fp-x', verdict: 'pass', evidenceHash: 'h1', qualification: { verdict: 'qualified', finalScore: 8 }, ttlDays: 14 });
  const v = getCandidateVerdict('linkedin:pass-probe', 'fp-x');
  assert.equal(v?.verdict, 'pass');
  assert.equal(v?.evidenceHash, 'h1');
  assert.deepEqual(v?.qualification, { verdict: 'qualified', finalScore: 8 });
});

test('round-trips company profiles and per-brief attribution verdicts', () => {
  upsertCompanyProfile({ companyKey: 'Nimbus.io', companyName: 'Nimbus', businessModel: 'software_product', industry: 'dental scheduling software', primaryOffering: 'Scheduling', evidenceQuote: 'Nimbus is a SaaS', quoteVerified: true, sourceLength: 120 });
  assert.equal(getCompanyProfile('nimbus.io')?.businessModel, 'software_product');
  assert.equal(getCompanyProfile('nimbus.io')?.industry, 'dental scheduling software');
  upsertCompanyAttributionVerdict('nimbus.io', 'fp-x', { verdict: 'disqualifying_contradiction' }, 120);
  assert.equal(getCompanyAttributionVerdict('NIMBUS.IO', 'fp-x')?.result.verdict, 'disqualifying_contradiction');
});

test('respects expiry for verdicts and company profiles', () => {
  assert.equal(getCandidateVerdict('linkedin:pass-probe', 'fp-x', later), null);
  assert.equal(getCompanyProfile('nimbus.io', later), null);
  assert.equal(getCompanyAttributionVerdict('nimbus.io', 'fp-x', later), null);
});
