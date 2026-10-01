import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIncrementalJudgeBatches } from '../server/leadSearch/stages/judgeStage.js';
import { installMockLlm, makeFounderContract, makeJudgeContext } from './helpers/mockLlm.js';

const contract = makeFounderContract();
const QUOTE = 'Founder and CEO of Nimbus Automation';
const mock = installMockLlm(() => ({
  judgments: [{
    candidateId: 'cand-1',
    requirements: [{ requirementId: 'req-role', status: 'pass', evidenceId: 'e1', evidenceQuote: QUOTE }],
    semanticFit: 9, authorityFit: 9, evidenceConfidence: 9, reason: 'Founder of an AI agency',
  }],
}));
after(() => mock.restore());

const candidate = (evidenceText: string) => ({
  candidateId: 'cand-1',
  lead: { fullName: 'Jane Doe', currentTitle: 'Founder', currentCompany: 'Nimbus Automation', contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/jane-doe-pass' } },
  evidence: [{ id: 'e1', text: evidenceText }],
});
const judge = async (evidenceText: string) => {
  const { ctx, logs } = makeJudgeContext(contract);
  const out = await evaluateIncrementalJudgeBatches(ctx, { candidates: [candidate(evidenceText)] as any, contract, stats: { rounds: 1, rerank: {} }, round: 1 } as any);
  return { out, logs };
};

test('reuses a stored qualification when evidence is unchanged and re-judges when it changes', async () => {
  const evidence = `Jane Doe is the ${QUOTE}, an AI agency in London`;
  const first = await judge(evidence);
  assert.equal(first.out.qualifiedCandidates.length, 1, first.logs.join('\n'));
  assert.equal(mock.calls.length, 1);

  const second = await judge(evidence);
  assert.equal(mock.calls.length, 1, 'unchanged evidence must not call the LLM');
  assert.equal(second.out.qualifiedCandidates.length, 1);
  assert.equal(
    second.out.qualifiedCandidates[0].qualification?.verdict,
    first.out.qualifiedCandidates[0].qualification?.verdict,
  );

  await judge(`Jane Doe is the ${QUOTE}, now also advising two SaaS startups`);
  assert.equal(mock.calls.length, 2, 'changed evidence is judged again');
});
