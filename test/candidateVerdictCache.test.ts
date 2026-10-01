import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateVerdictKey, candidateVerdictKeyForUrl, isCacheableFingerprint } from '../server/leadSearch/candidateVerdicts.js';
import { computeRequirementsFingerprint, getCandidateVerdict } from '../server/db.js';
import { evaluateIncrementalJudgeBatches } from '../server/leadSearch/stages/judgeStage.js';
import { installMockLlm, makeFounderContract, makeJudgeContext } from './helpers/mockLlm.js';

test('normalizes LinkedIn URL variants to one key', () => {
  const expected = 'linkedin:jane-doe';
  assert.equal(candidateVerdictKeyForUrl('https://www.linkedin.com/in/jane-doe'), expected);
  assert.equal(candidateVerdictKeyForUrl('https://uk.linkedin.com/in/Jane-Doe/?trk=public'), expected);
  assert.equal(candidateVerdictKey({ contactDetails: { linkedinUrl: 'linkedin.com/in/jane-doe/' } }), expected);
  assert.equal(candidateVerdictKey({ profile: { contactDetails: { linkedinUrl: 'https://linkedin.com/in/jane-doe' } } }), expected);
  assert.equal(candidateVerdictKey({ contactDetails: { linkedinUrl: '' } }), '');
});

test('never caches under the default fingerprint', () => {
  assert.equal(isCacheableFingerprint('default'), false);
  assert.equal(isCacheableFingerprint(''), false);
  assert.equal(isCacheableFingerprint(computeRequirementsFingerprint(makeFounderContract().requirements as any)), true);
});

test('records LLM hard-fails and skips deterministic triage rejections', async () => {
  const contract = makeFounderContract();
  const mock = installMockLlm(() => ({
    judgments: [{
      candidateId: 'cand-growth',
      requirements: [{ requirementId: 'req-role', status: 'fail', evidenceId: 'e1', evidenceQuote: 'Head of Growth at Nimbus Labs', reason: 'Not a founder' }],
      semanticFit: 2, authorityFit: 3, evidenceConfidence: 8, reason: 'Head of Growth, not a founder',
    }],
  }));
  try {
  const llmJudged = {
    candidateId: 'cand-growth',
    lead: { fullName: 'Jane Roe', currentTitle: 'Head of Growth', currentCompany: 'Nimbus Labs', contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/jane-roe' } },
    evidence: [{ id: 'e1', text: 'Jane Roe is Head of Growth at Nimbus Labs and was not a founder of the company' }],
  };
  const triaged = {
    candidateId: 'cand-intern',
    lead: { fullName: 'Sam Poe', currentTitle: 'Marketing Intern', currentCompany: 'Acme', contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/sam-poe' } },
    evidence: [{ id: 'e1', text: 'Sam Poe is a Marketing Intern at Acme' }],
  };

  const { ctx } = makeJudgeContext(contract);
  await evaluateIncrementalJudgeBatches(ctx, { candidates: [llmJudged, triaged] as any, contract, stats: { rounds: 1, rerank: {} }, round: 1 } as any);

  const fp = computeRequirementsFingerprint(contract.requirements as any);
  assert.equal(getCandidateVerdict('linkedin:jane-roe', fp)?.verdict, 'hard_fail');
  assert.equal(getCandidateVerdict('linkedin:sam-poe', fp), null, 'deterministic triage verdicts are not cached');
  } finally {
    mock.restore();
  }
});
