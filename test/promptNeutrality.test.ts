import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProspectContractPrompt, buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.js';
import { buildStrategistPrompt } from '../server/leadSearch/searchSpec.js';
import { STRATEGIST_SYSTEM_PROMPT } from '../server/services/llm.js';

const HOSPITAL = 'Procurement directors at hospitals in Germany';
const LEAK = /agenc|n8n|zapier|make\.com|AI consulting|client services|Austin, Denver|Rotate executive variants|co-founder"/i;

test('contract prompt is neutral for non-agency briefs and keeps the agency rule for agency briefs', () => {
  assert.equal(LEAK.test(buildProspectContractPrompt(HOSPITAL)), false);
  assert.ok(buildProspectContractPrompt('Founders of AI automation agencies').includes('client-services'));
});

test('planner prompt (including recovery) is neutral for non-agency briefs', () => {
  const prompt = buildStrategistPrompt({
    query: HOSPITAL, round: 2, maxRounds: 4, remaining: 5, previousQueries: [], previousRoundSummary: {},
    contract: buildDeterministicProspectContract(HOSPITAL), isRecovery: true, recoveryAttempt: 1,
  });
  assert.equal(LEAK.test(prompt), false, (prompt.match(LEAK) || [])[0]);
});

test('strategist system prompt uses a neutral example', () => {
  assert.equal(/agenc/i.test(STRATEGIST_SYSTEM_PROMPT), false);
});
