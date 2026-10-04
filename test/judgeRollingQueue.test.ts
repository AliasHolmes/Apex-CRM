import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIncrementalJudgeBatches } from '../server/leadSearch/stages/judgeStage.js';
import { installMockLlm, makeFounderContract, makeJudgeContext } from './helpers/mockLlm.js';

const contract = makeFounderContract();
const QUOTE = 'Founder and CEO of Nimbus Automation';
const runId = Math.random().toString(36).slice(2, 10);

// One candidate per micro-batch, so batch count == candidate count.
const mock = installMockLlm((body) => {
  const prompt = JSON.stringify(body);
  const candidateId = /### (cand-[a-z0-9-]+)/.exec(prompt)?.[1] ?? 'unknown';
  return {
    judgments: [{
      candidateId,
      requirements: [{ requirementId: 'req-role', status: 'pass', evidenceId: 'e1', evidenceQuote: QUOTE }],
      semanticFit: 9, authorityFit: 9, evidenceConfidence: 9, reason: 'Founder of an AI agency',
    }],
  };
});
after(() => mock.restore());

const ENV_KEYS = ['FINALIST_JUDGE_MICRO_BATCH_SIZE', 'FINALIST_JUDGE_CONCURRENCY'] as const;
const envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  process.env.FINALIST_JUDGE_MICRO_BATCH_SIZE = '1';
  process.env.FINALIST_JUDGE_CONCURRENCY = '2';
  mock.calls.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

const makeCandidates = (count: number, tag: string) =>
  Array.from({ length: count }, (_, i) => ({
    candidateId: `cand-${tag}-${i}`,
    lead: {
      fullName: `Jane Doe ${i}`,
      currentTitle: 'Founder',
      currentCompany: 'Nimbus Automation',
      contactDetails: { linkedinUrl: `https://www.linkedin.com/in/jane-doe-${runId}-${tag}-${i}` },
    },
    evidence: [{ id: 'e1', text: `Jane Doe ${i} is the ${QUOTE}, an AI agency in London` }],
  }));

const judge = (count: number, tag: string, extra: Record<string, unknown> = {}) => {
  const { ctx, logs } = makeJudgeContext(contract);
  return evaluateIncrementalJudgeBatches(ctx, {
    candidates: makeCandidates(count, tag) as any,
    contract,
    stats: { rounds: 1, rerank: {} },
    round: 1,
    ...extra,
  } as any).then((out) => ({ out, logs }));
};

test('without a cushion every micro-batch is judged', async () => {
  const { out } = await judge(6, 'all');
  assert.equal(mock.calls.length, 6);
  assert.equal(out.qualifiedCandidates.length, 6);
});

test('stops dequeuing once the cushion is met, and lets in-flight batches finish', async () => {
  const { out, logs } = await judge(6, 'cushion', { targetCushion: 2, currentQualifiedCount: 0 });
  assert.ok(mock.calls.length < 6, `expected remaining batches to be skipped, got ${mock.calls.length} calls`);
  assert.ok(mock.calls.length >= 2, 'the first concurrency-worth of batches always runs');
  assert.ok(out.qualifiedCandidates.length >= 2, 'in-flight batches must still be collected');
  assert.ok(
    logs.some((line) => /reached target cushion/.test(line)),
    `expected a cushion log line:\n${logs.join('\n')}`,
  );
});

test('a cushion already met by earlier rounds still judges the first batches', async () => {
  const { out } = await judge(6, 'prefilled', { targetCushion: 2, currentQualifiedCount: 10 });
  assert.equal(mock.calls.length >= 2, true, 'must not skip judging entirely');
  assert.ok(mock.calls.length < 6);
  assert.ok(out.qualifiedCandidates.length >= 2);
});

test('qualified candidates are returned in batch order, not completion order', async () => {
  const { out } = await judge(5, 'order');
  const ids = out.qualifiedCandidates.map((lead: any) => lead.fullName);
  assert.deepEqual(ids, ['Jane Doe 0', 'Jane Doe 1', 'Jane Doe 2', 'Jane Doe 3', 'Jane Doe 4']);
});
