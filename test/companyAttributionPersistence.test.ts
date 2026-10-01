import test from 'node:test';
import assert from 'node:assert/strict';
import { runGatedCompanyAttribution, COMPANY_ATTRIBUTION_SYSTEM_PROMPT } from '../server/leadSearch/companyAttribution.js';

const sourceText = '[COMPANY SITE: nimbus.io] Nimbus is a SaaS platform that sells scheduling software to dentists across the UK.';
const candidate = () => ({
  candidateId: 'c1',
  lead: { fullName: 'Jane Doe', currentTitle: 'Founder', currentCompany: 'Nimbus', contactDetails: { website: 'https://nimbus.io' } } as any,
  evidence: [{ id: 'e1', text: sourceText }],
});
const contract = (brief: string, terms: string[]): any => ({
  brief, policyVersion: 'p1',
  requirements: [{ id: 'r_type', scope: 'company_type', importance: 'hard', description: brief, acceptableTerms: terms }],
});
const dentalClinics = contract('Owners of dental clinics in the UK', ['dental clinic']);
const agencies = contract('AI automation agencies', ['ai agency']);
const logistics = contract('CFOs at logistics companies', ['logistics company']);

let llmCalls = 0;
const structured = async () => {
  llmCalls++;
  return { attributions: [{
    companyKey: 'nimbus.io', businessModel: 'software_product', industry: 'dental scheduling software',
    primaryOffering: 'Scheduling software for dentists', queryAlignment: 'contradicts',
    verbatimEvidenceQuote: 'Nimbus is a SaaS platform that sells scheduling software',
    verdict: 'disqualifying_contradiction', reason: 'Sells software to dental clinics; is not a clinic',
  }] };
};
const run = (c: any) => {
  const cand = candidate();
  return runGatedCompanyAttribution([cand] as any, c, { openAIStructured: structured, persistentCache: true }).then(() => cand);
};

test('the attribution prompt is industry neutral', () => {
  assert.equal(/agenc|n8n|digital agencies/i.test(COMPANY_ATTRIBUTION_SYSTEM_PROMPT.split('BUSINESS MODEL')[0]), false);
  for (const model of ['b2b_services', 'software_product', 'healthcare_provider', 'public_education_nonprofit']) {
    assert.ok(COMPANY_ATTRIBUTION_SYSTEM_PROMPT.includes(model), model);
  }
});

test('reapplies a same-brief verdict and turns stored facts into judge evidence for other briefs', async () => {
  const first = await run(dentalClinics);
  assert.equal(llmCalls, 1);
  assert.equal(first.lead._autoFailed, true, 'the LLM said this contradicts a dental-clinic brief');

  const sameBrief = await run(dentalClinics);
  assert.equal(llmCalls, 1, 'same requirements reuse the stored verdict');
  assert.equal(sameBrief.lead._autoFailed, true);

  for (const other of [agencies, logistics]) {
    const reused = await run(other);
    assert.equal(llmCalls, 1, `${other.brief}: stored company facts are reused`);
    assert.equal(reused.lead._autoFailed, undefined, `${other.brief}: the judge decides fit`);
    assert.ok(reused.evidence[0].text.includes('Business Model: software_product'));
    assert.ok(reused.evidence[0].text.includes('Industry: dental scheduling software'));
  }
});
