import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINALIST_JUDGE_SYSTEM_PROMPT,
  buildFinalistJudgePrompt,
  validateFinalistJudgments,
} from '../server/leadSearch/finalistJudge.js';
import { getProviderConcurrencyLimit } from '../server/services/llm.js';

const EVIDENCE =
  'Jane Doe is the Founder and CEO of Nimbus Automation, an AI automation agency based in London that builds workflow systems for clients.';

const contract: any = {
  version: 1,
  policyVersion: 'test-policy',
  brief: 'Founders of AI automation agencies',
  authorityRequired: true,
  exclusions: [],
  requirements: [
    {
      id: 'req-role', description: 'Founder', sourcePhrase: 'founder', acceptableTerms: ['founder'],
      scope: 'person_role', importance: 'hard', evidenceModality: 'structured_profile',
    },
    {
      id: 'req-type', description: 'AI automation agency', sourcePhrase: 'agency', acceptableTerms: ['agency'],
      scope: 'company_type', importance: 'hard', evidenceModality: 'structured_profile',
    },
  ],
};

const candidate: any = {
  candidateId: 'cand-1',
  lead: { fullName: 'Jane Doe', currentTitle: 'Founder', currentCompany: 'Nimbus Automation' },
  evidence: [{ id: 'e1', text: EVIDENCE }],
};

const judgment = (requirements: any[], reason = 'Founder of an AI automation agency.') => ({
  judgments: [{
    candidateId: 'cand-1',
    requirements,
    semanticFit: 9, authorityFit: 9, evidenceConfidence: 9,
    reason,
  }],
});

const passWithQuote = (requirementId: string, quote: string) =>
  ({ requirementId, status: 'pass', evidenceId: 'e1', evidenceQuote: quote });

const savedMode = process.env.EVIDENCE_GROUNDING_MODE;
beforeEach(() => {
  process.env.EVIDENCE_GROUNDING_MODE = 'strict';
});
afterEach(() => {
  if (savedMode === undefined) delete process.env.EVIDENCE_GROUNDING_MODE;
  else process.env.EVIDENCE_GROUNDING_MODE = savedMode;
});

const validate = (raw: unknown) => validateFinalistJudgments(raw, contract, [candidate]);

test('compact output: short quotes and no per-requirement reason on passes still qualify', () => {
  const result = validate(judgment([
    passWithQuote('req-role', 'Founder and CEO of Nimbus Automation'),
    passWithQuote('req-type', 'an AI automation agency based in London'),
  ]));
  const outcome = result.outcomes.get('cand-1')!;
  assert.equal(outcome.status, 'qualified');
  assert.ok(outcome.requirements!.every((r) => r.status === 'pass'));
  assert.ok(outcome.requirements!.every((r) => r.reason === undefined), 'passes carry no prose');
  assert.ok(outcome.requirements!.every((r) => r.evidenceQuote), 'passes keep their verified quote');
});

test('a 5-15 word quote is accepted', () => {
  const quote = 'Jane Doe is the Founder and CEO of Nimbus Automation, an AI'; // 12 words
  assert.ok(quote.split(/\s+/).length >= 5 && quote.split(/\s+/).length <= 15);
  const result = validate(judgment([
    passWithQuote('req-role', quote),
    passWithQuote('req-type', 'an AI automation agency'),
  ]));
  assert.equal(result.outcomes.get('cand-1')!.status, 'qualified');
});

test('a fabricated quote is still rejected: the quote is the grounding check', () => {
  const result = validate(judgment([
    passWithQuote('req-role', 'Co-founder of Google DeepMind and Tesla'),
    passWithQuote('req-type', 'an AI automation agency'),
  ]));
  const outcome = result.outcomes.get('cand-1')!;
  const role = outcome.requirements!.find((r) => r.requirementId === 'req-role')!;
  assert.equal(role.fabricatedPass, true);
  assert.equal(role.status, 'unknown');
  assert.notEqual(outcome.status, 'qualified');
  assert.notEqual(outcome.status, 'qualified_partial');
});

test('a hard pass with no quote is not filled in from the evidence id (strict mode)', () => {
  const result = validate(judgment([
    { requirementId: 'req-role', status: 'pass', evidenceId: 'e1' },
    passWithQuote('req-type', 'an AI automation agency'),
  ]));
  const outcome = result.outcomes.get('cand-1')!;
  const role = outcome.requirements!.find((r) => r.requirementId === 'req-role')!;
  assert.equal(role.status, 'unknown', 'citing an id alone must not verify a hard pass');
  assert.notEqual(outcome.status, 'qualified');
});

test('a fail that only reports missing evidence is downgraded to unknown (needs its reason)', () => {
  const result = validate(judgment([
    passWithQuote('req-role', 'Founder and CEO of Nimbus Automation'),
    { requirementId: 'req-type', status: 'fail', reason: 'The evidence does not mention what the company does.' },
  ]));
  const outcome = result.outcomes.get('cand-1')!;
  const type = outcome.requirements!.find((r) => r.requirementId === 'req-type')!;
  assert.equal(type.status, 'unknown');
  assert.notEqual(outcome.status, 'hard_fail');
});

test('an explicit contradiction on a fail stays a hard fail', () => {
  const result = validate(judgment([
    passWithQuote('req-role', 'Founder and CEO of Nimbus Automation'),
    { requirementId: 'req-type', status: 'fail', reason: 'Nimbus sells a SaaS software product, not client services.' },
  ]));
  assert.equal(result.outcomes.get('cand-1')!.status, 'hard_fail');
});

test('the candidate-level reason flows to the qualification', () => {
  const result = validate(judgment(
    [
      passWithQuote('req-role', 'Founder and CEO of Nimbus Automation'),
      passWithQuote('req-type', 'an AI automation agency'),
    ],
    'Founder-run automation agency; direct match.',
  ));
  const qualification = result.qualifications.get('cand-1')!;
  assert.equal(qualification.reason, 'Founder-run automation agency; direct match.');
});

test('the judge prompts ask for compact output', () => {
  assert.match(FINALIST_JUDGE_SYSTEM_PROMPT, /5-15 words/);
  assert.doesNotMatch(FINALIST_JUDGE_SYSTEM_PROMPT, /5-40 words/);
  assert.match(FINALIST_JUDGE_SYSTEM_PROMPT, /omit (?:the )?(?:requirement )?reason/i);

  const prompt = buildFinalistJudgePrompt(contract, [candidate]);
  assert.match(prompt, /5-15 words/);
  assert.doesNotMatch(prompt, /5-40 words/);
});

test('the prompt keeps reasons for fail and unknown requirements', () => {
  assert.match(FINALIST_JUDGE_SYSTEM_PROMPT, /"fail" or "unknown"[^.]*reason/i);
});

test('provider slot limits honor 4 for both Atria and Byesu', () => {
  const saved = [process.env.ATRIA_CONCURRENT_SLOTS, process.env.BYESU_CONCURRENT_SLOTS];
  try {
    process.env.ATRIA_CONCURRENT_SLOTS = '4';
    process.env.BYESU_CONCURRENT_SLOTS = '4';
    assert.equal(getProviderConcurrencyLimit('atria'), 4);
    assert.equal(getProviderConcurrencyLimit('primary'), 4);
  } finally {
    for (const [key, value] of [
      ['ATRIA_CONCURRENT_SLOTS', saved[0]],
      ['BYESU_CONCURRENT_SLOTS', saved[1]],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
