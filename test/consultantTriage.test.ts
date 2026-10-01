import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTitle } from '../server/leadSearch/titleTriage.js';
import { filterNonDecisionMakers } from '../server/leadSearch/stages/judgeStage.js';
import { verifyDecisionMakerFromEvidence } from '../server/leadSearch/verification.js';

const ownerContract: any = {
  brief: 'Owners or founders of AI automation agencies in the UK', policyVersion: 'x',
  requirements: [{ id: 'r_role', scope: 'person_role', importance: 'hard', description: 'agency owner or founder', acceptableTerms: ['founder', 'owner', 'ceo'] }],
};
const triage = (title: string) =>
  filterNonDecisionMakers([{ candidateId: 'c1', lead: { currentTitle: title }, evidence: [] } as any], ownerContract);

test('sends ambiguous consultant and specialist titles to the judge', () => {
  for (const title of ['AI Automation Consultant | n8n Expert', 'Independent AI Consultant', 'Make.com Specialist - helping agencies automate']) {
    assert.equal(triage(title).rejected.length, 0, title);
    assert.equal(classifyTitle(title, ownerContract).isIC, false, title);
  }
});

test('still rejects clear individual-contributor titles', () => {
  for (const title of ['Customer Success Specialist', 'Support Specialist', 'Marketing Intern', 'Software Engineer II']) {
    assert.equal(triage(title).rejected.length, 1, title);
  }
});

test('recognizes owner-operators with words between the qualifier and the role', () => {
  const c = classifyTitle('Independent AI Automation Consultant');
  assert.equal(c.isExecutive, true);
});

test('verification does not flag an ambiguous consultant title as ignored', () => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'AI agency owners in the UK', fullName: 'Jane Doe', currentTitle: 'AI Automation Consultant',
    currentCompany: 'Nimbus', headline: 'AI Automation Consultant', seniorityLevel: '', evidenceText: '',
  } as any);
  assert.equal(result.ignoredTitle, false);
});
