import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.js';
import { deriveContractDomainCluster } from '../server/leadSearch/adaptiveScheduler.js';

const terms = (c: any, scope: string): string[] =>
  c.requirements.filter((r: any) => r.scope === scope).flatMap((r: any) => r.acceptableTerms.map((t: string) => t.toLowerCase()));
const queries = (c: any) => c.initialQueries.map((q: any) => q.query).join(' || ');

test('law firm briefs never inherit agency synonyms, other professions, or software negatives', () => {
  const c = buildDeterministicProspectContract('Partners at law firms in Toronto');
  const company = terms(c, 'company_type');
  assert.ok(company.some(t => t.startsWith('law firm')), company.join(','));
  for (const t of ['agency', 'agencies', 'consultancy', 'consulting firm', 'accounting firm', 'advisory firm']) {
    assert.equal(company.includes(t), false, t);
  }
  assert.equal(/-software|-saas|-platform/i.test(queries(c)), false, queries(c));
  assert.equal(terms(c, 'person_role').includes('founder'), false, 'partner is not a founder synonym');
});

test('owner roles outside agencies do not become agency owners', () => {
  const c = buildDeterministicProspectContract('Owners of freight forwarding companies in Nigeria');
  assert.equal(terms(c, 'person_role').includes('agency owner'), false);
  assert.notEqual(deriveContractDomainCluster(c, c.brief), 'b2b_agency');
});

test('hospitals and contractors only expand to their own synonyms', () => {
  const h = buildDeterministicProspectContract('Directors of hospitals in Germany');
  assert.equal(terms(h, 'company_type').includes('clinic'), false);
  const k = buildDeterministicProspectContract('Owners of roofing contractors in Texas');
  assert.equal(terms(k, 'company_type').some(t => t === 'clinic' || t === 'dental practice'), false);
});

test('agency briefs keep their agency expansions', () => {
  const c = buildDeterministicProspectContract('Find AI agency owners in New York');
  assert.ok(terms(c, 'person_role').includes('agency owner'));
  assert.ok(terms(c, 'company_type').includes('ai agency'));
});
