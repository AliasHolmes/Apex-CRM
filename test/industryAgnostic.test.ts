import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeterministicProspectContract, buildProspectContractPrompt } from '../server/leadSearch/prospectContract.js';
import { deriveContractDomainCluster } from '../server/leadSearch/adaptiveScheduler.js';
import { buildFinalistJudgePrompt, FINALIST_JUDGE_SYSTEM_PROMPT } from '../server/leadSearch/finalistJudge.js';

const LEAK = /agenc|n8n|zapier|-saas|-software|-platform|client-services/i;
const cases = [
  { brief: 'Procurement directors at hospitals in Germany', role: /procurement director/i, company: /hospital/i, location: /germany/i },
  { brief: 'Owners of freight forwarding companies in Nigeria', role: /owner/i, company: /freight forwarding/i, location: /nigeria/i },
  { brief: 'Partners at law firms in Toronto', role: /partner/i, company: /law firm/i, location: /toronto/i },
  { brief: 'Senior software engineers at fintech startups in Singapore', role: /software engineer/i, company: /fintech/i, location: /singapore/i },
  { brief: 'General managers of hotels in Dubai', role: /general manager/i, company: /hotel/i, location: /dubai/i },
  { brief: 'Principals of secondary schools in Kenya', role: /principal/i, company: /secondary school/i, location: /kenya/i },
];

const termsOf = (c: any, scope: string) =>
  c.requirements.filter((r: any) => r.scope === scope).flatMap((r: any) => r.acceptableTerms).join(' | ');

for (const { brief, role, company, location } of cases) {
  test(`industry-agnostic contract: ${brief}`, () => {
    const c: any = buildDeterministicProspectContract(brief);
    const queries = c.initialQueries.map((q: any) => q.query).join(' || ');
    assert.match(termsOf(c, 'person_role'), role);
    assert.match(termsOf(c, 'company_type'), company);
    assert.match(termsOf(c, 'person_location'), location);
    assert.match(queries, role);
    assert.equal(LEAK.test(`${JSON.stringify(c.requirements)} ${queries}`), false, (`${JSON.stringify(c.requirements)} ${queries}`.match(LEAK) || [])[0]);
    assert.notEqual(deriveContractDomainCluster(c, brief), 'b2b_agency');
    assert.equal(LEAK.test(buildFinalistJudgePrompt(c, [])), false);
    assert.equal(/agenc|n8n/i.test(buildProspectContractPrompt(brief)), false);
  });
}

test('school principals are not widened into founders or CEOs', () => {
  const c: any = buildDeterministicProspectContract('Principals of secondary schools in Kenya');
  assert.equal(/founder|\bceo\b|owner/i.test(termsOf(c, 'person_role')), false);
});

test('agency control brief keeps agency behavior', () => {
  const brief = 'Find AI agency owners in New York';
  const c: any = buildDeterministicProspectContract(brief);
  assert.match(termsOf(c, 'company_type'), /AI agency/);
  assert.equal(deriveContractDomainCluster(c, brief), 'b2b_agency');
  assert.ok(buildFinalistJudgePrompt(c, []).includes('CLIENT-SERVICES BRIEF'));
  assert.equal(/agenc|n8n/i.test(FINALIST_JUDGE_SYSTEM_PROMPT), false);
});
