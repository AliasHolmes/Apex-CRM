import test from 'node:test';
import assert from 'node:assert/strict';
import { readPastUserDecisions, upsertLeadWithIdentity } from '../server/db.js';
import { buildFinalistJudgePrompt } from '../server/leadSearch/finalistJudge.js';
import { makeFounderContract } from './helpers/mockLlm.js';

test('reads KEEP and REJECT decisions scoped by fingerprint, stripped of names and boilerplate notes', () => {
  const fp = 'fp-test-taste';
  upsertLeadWithIdentity({
    id: 'lead-1', name: 'Secret Person', currentTitle: 'Solo Founder', currentCompany: 'Nimbus', location: 'London',
    reviewStatus: 'KEEP', notes: 'Great candidate, met in person', discoveryRequirementsFingerprint: fp,
  } as any);
  upsertLeadWithIdentity({
    id: 'lead-2', name: 'Secret Person 2', currentTitle: 'Account Exec', currentCompany: 'Acme', location: 'Leeds',
    reviewStatus: 'REJECT', notes: 'Discovered via Tavily LinkedIn-indexed search.', discoveryRequirementsFingerprint: fp,
  } as any);

  const decisions = readPastUserDecisions({ requirementsFingerprint: fp, limit: 10 });
  assert.equal(decisions.length, 2);
  const keep = decisions.find(d => d.outcome === 'KEEP');
  const reject = decisions.find(d => d.outcome === 'REJECT');
  assert.ok(keep && reject);
  assert.equal((keep as any).name, undefined, 'names must not be stored in decisions');
  assert.equal(keep?.userNotes, 'Great candidate, met in person');
  assert.equal(reject?.userNotes, undefined, 'engine boilerplate notes must be stripped');
});

test('falls back to domainCluster when requirements fingerprint has no decisions', () => {
  const cluster = 'cluster-fallback-test';
  upsertLeadWithIdentity({
    id: 'lead-3', name: 'Jane Doe', currentTitle: 'CEO', currentCompany: 'Apex', location: 'London',
    reviewStatus: 'KEEP', domainCluster: cluster,
  } as any);

  const decisions = readPastUserDecisions({ requirementsFingerprint: 'fp-never-seen', domainCluster: cluster });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, 'KEEP');
});

test('tasteDemonstrations block in judge prompt includes decisions and omits names', () => {
  const contract = makeFounderContract();
  const prompt = buildFinalistJudgePrompt({
    candidates: [{ candidateId: 'c1', lead: { fullName: 'Candidate A', currentTitle: 'Founder', currentCompany: 'Apex' }, evidence: [{ id: 'e1', text: 'evidence' }] } as any],
    contract,
    pastDecisions: [{ outcome: 'KEEP', title: 'Founder & CEO', company: 'Nimbus', userNotes: 'strong match' }],
  });
  assert.ok(prompt.includes('PAST USER DECISIONS ON SIMILAR SEARCHES'));
  assert.ok(prompt.includes('Founder & CEO'));
  assert.ok(prompt.includes('strong match'));
  assert.ok(!prompt.includes('Candidate A in past decisions'), 'prompt should not claim candidate was in past decisions');
});
