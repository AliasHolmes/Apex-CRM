import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTitle } from '../server/leadSearch/titleTriage.js';
import { triPartitionCandidatesByEvidence, finalistCandidateFromLead } from '../server/leadSearch/finalistJudge.js';

const contract: any = {
  brief: 'CEOs of logistics companies in the UK', policyVersion: 'p1', requirements: [
    { id: 'r_role', scope: 'person_role', importance: 'hard', description: 'CEO', acceptableTerms: ['ceo', 'chief executive'] },
    { id: 'r_loc', scope: 'person_location', importance: 'hard', description: 'United Kingdom', acceptableTerms: ['uk', 'united kingdom', 'england', 'manchester'] },
  ],
};
const lead = (title: string) => ({
  fullName: 'Jane Doe', currentTitle: title, headline: title, currentCompany: 'Acme Freight',
  location: 'Manchester, England', contactDetails: { linkedinUrl: 'https://linkedin.com/in/jane-doe' },
});
const triage = (title: string) => {
  const candidate = finalistCandidateFromLead('c', lead(title), `TITLE: Jane Doe - ${title} - Acme Freight`, contract);
  return triPartitionCandidatesByEvidence([candidate], contract);
};

test('classifies assistants and chiefs of staff to an executive as non-decision-makers', () => {
  for (const title of ['Executive Assistant to the CEO', 'EA to the Founder', 'Chief of Staff to the CEO', 'Office of the CEO']) {
    const c = classifyTitle(title);
    assert.equal(c.isIC, true, title);
    assert.equal(c.isExecutive, false, title);
  }
  assert.equal(classifyTitle('CEO').isExecutive, true);
});

test('does not auto-qualify a subordinate title that mentions the target role', () => {
  assert.equal(triage('Executive Assistant to the CEO').autoQualified.length, 0);
  assert.equal(triage('CEO').autoQualified.length, 1);
});
