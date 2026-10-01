import test from 'node:test';
import assert from 'node:assert/strict';
import { FINALIST_JUDGE_SYSTEM_PROMPT, buildFinalistJudgePrompt } from '../server/leadSearch/finalistJudge.js';

const contract = (brief: string, companyTerm: string): any => ({
  brief, policyVersion: 'p', requirements: [
    { id: 'r_role', scope: 'person_role', importance: 'hard', description: 'role', acceptableTerms: ['director'] },
    { id: 'r_type', scope: 'company_type', importance: 'hard', description: companyTerm, acceptableTerms: [companyTerm] },
  ],
});

test('the system prompt names no industry, tool, vendor or country', () => {
  assert.equal(/agenc|n8n|zapier|microsoft|openai|\bUSA\b|\bUK\b|london|san francisco|saas/i.test(FINALIST_JUDGE_SYSTEM_PROMPT), false);
});

test('agency guidance appears only for agency contracts', () => {
  const hospital = buildFinalistJudgePrompt(contract('Procurement directors at hospitals in Germany', 'hospital'), []);
  assert.equal(/agenc|client-services/i.test(hospital), false);
  const agency = buildFinalistJudgePrompt(contract('Founders of AI automation agencies', 'ai agency'), []);
  assert.ok(agency.includes('CLIENT-SERVICES BRIEF'));
});
