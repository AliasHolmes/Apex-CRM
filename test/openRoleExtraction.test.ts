import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.js';
import { singularizeRole } from '../server/leadSearch/defaultRoles.js';

const role = (c: any) => c.requirements.find((r: any) => r.scope === 'person_role');
const company = (c: any): string[] =>
  c.requirements.filter((r: any) => r.scope === 'company_type').flatMap((r: any) => r.acceptableTerms.map((t: string) => t.toLowerCase()));
const queries = (c: any) => c.initialQueries.map((q: any) => q.query).join(' || ');

test('extracts roles outside the leadership vocabulary and searches for them', () => {
  const c = buildDeterministicProspectContract('Senior software engineers at fintech startups in Singapore');
  assert.ok(role(c), 'a person_role requirement must exist');
  assert.ok(role(c).acceptableTerms.map((t: string) => t.toLowerCase()).includes('senior software engineer'));
  assert.ok(company(c).includes('fintech startups'), company(c).join(','));
  assert.ok(/software engineer/i.test(queries(c)), queries(c));
  assert.equal(/\b(founder|ceo|owner|managing director)\b/i.test(queries(c)), false, queries(c));
  assert.equal(c.authorityRequired, false);
});

test('keeps a business function attached to the role, not the company type', () => {
  const c = buildDeterministicProspectContract('Procurement directors at hospitals in Germany');
  assert.equal(role(c).sourcePhrase.toLowerCase(), 'procurement directors');
  assert.equal(company(c).includes('procurement'), false);
  assert.ok(company(c).some(t => t.startsWith('hospital')));
});

test('handles "<role> of <organizations>" for any industry', () => {
  const hotels = buildDeterministicProspectContract('General managers of hotels in Dubai');
  assert.equal(role(hotels).sourcePhrase, 'General managers');
  assert.ok(company(hotels).includes('hotels'));
  assert.equal(company(hotels).some(t => t.startsWith('general manager')), false);
  const schools = buildDeterministicProspectContract('Principals of secondary schools in Kenya');
  assert.equal(role(schools).sourcePhrase, 'Principals');
  assert.ok(company(schools).includes('secondary schools'));
});

test('singularizes role phrases', () => {
  assert.equal(singularizeRole('Senior software engineers'), 'Senior software engineer');
  assert.equal(singularizeRole('Procurement directors'), 'Procurement director');
  assert.equal(singularizeRole('CFOs'), 'CFO');
  assert.equal(singularizeRole('Treasury'), 'Treasury');
});
