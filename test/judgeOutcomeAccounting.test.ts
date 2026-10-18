import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateFinalistJudgments, type FinalistCandidate } from '../server/leadSearch/finalistJudge.ts';
import type { ProspectContract } from '../server/leadSearch/prospectContract.ts';

const testContract: ProspectContract = {
  version: 1,
  policyVersion: 'test-v1',
  brief: 'B2B SaaS Founder in Austin',
  authorityRequired: false,
  exclusions: [],
  initialQueries: [],
  requirements: [
    {
      id: 'req_role',
      description: 'Must be Founder',
      sourcePhrase: 'Founder',
      acceptableTerms: ['Founder'],
      queryable: true,
      evidenceModality: 'structured_profile',
      importance: 'hard',
      scope: 'person_role',
    },
    {
      id: 'req_company_type',
      description: 'Must be B2B SaaS',
      sourcePhrase: 'B2B SaaS',
      acceptableTerms: ['B2B SaaS'],
      queryable: true,
      evidenceModality: 'open_web_signal',
      importance: 'hard',
      scope: 'company_type',
    },
  ],
};

function createMockCandidate(id: string, name: string): FinalistCandidate {
  return {
    candidateId: id,
    lead: {
      id: `lead_${id}`,
      fullName: name,
      title: 'Founder',
      company: 'TechCorp',
    },
    evidence: [
      {
        id: 'ev_1',
        text: 'Founder at TechCorp',
      },
    ],
  };
}

describe('Work Package A: Judge Outcome Accounting and Deduplication', () => {
  it('A1: normalizes missing evidence fail to unknown and reflects in outcome requirements', () => {
    const candidate = createMockCandidate('cand_1', 'Alice Founder');
    // Raw judgment emits a fail because evidence is missing (not mentioned)
    const rawJudgments = {
      judgments: [
        {
          candidateId: 'cand_1',
          requirements: [
            {
              requirementId: 'req_role',
              status: 'pass',
              evidenceId: 'ev_1',
              evidenceQuote: 'Founder at TechCorp',
              reason: 'Verified founder',
            },
            {
              requirementId: 'req_company_type',
              status: 'fail',
              reason: 'Company business model is not explicitly mentioned in the snippet',
            },
          ],
        },
      ],
    };

    const validation = validateFinalistJudgments(rawJudgments, testContract, [candidate]);
    const outcome = validation.outcomes.get('cand_1');
    assert.ok(outcome, 'Outcome must exist');
    assert.ok(outcome.requirements, 'Outcome requirements must exist');

    // finalistJudge normalizes the company_type fail to unknown because reason indicates missing evidence
    const compReq = outcome.requirements.find((r) => r.requirementId === 'req_company_type');
    assert.ok(compReq, 'company_type assessment must exist');
    assert.equal(compReq.status, 'unknown', 'Missing evidence must normalize fail to unknown');

    // Verified: if code checks req.status === "fail", it will NOT include req_company_type
    const normalizedFails = outcome.requirements
      .filter((r) => r.status === 'fail')
      .map((r) => r.requirementId);
    assert.deepEqual(normalizedFails, [], 'Normalized fails must not include missing-evidence unknown');
  });

  it('A2: ignores duplicate candidate judgments, logs conflict, and clamps unjudged count to >= 0', () => {
    const candidate1 = createMockCandidate('cand_1', 'Alice Founder');
    const candidate2 = createMockCandidate('cand_2', 'Bob Founder');

    // LLM outputs cand_1 twice and cand_2 once
    const rawJudgments = {
      judgments: [
        {
          candidateId: 'cand_1',
          requirements: [
            {
              requirementId: 'req_role',
              status: 'pass',
              evidenceId: 'ev_1',
              evidenceQuote: 'Founder at TechCorp',
              reason: 'Verified founder',
            },
            {
              requirementId: 'req_company_type',
              status: 'pass',
              evidenceId: 'ev_1',
              evidenceQuote: 'Founder at TechCorp',
              reason: 'B2B SaaS',
            },
          ],
        },
        {
          candidateId: 'cand_1', // Duplicate!
          requirements: [
            {
              requirementId: 'req_role',
              status: 'fail',
              reason: 'Contradictory second judgment',
            },
          ],
        },
        {
          candidateId: 'cand_hallucinated', // Non-existent candidate!
          requirements: [
            {
              requirementId: 'req_role',
              status: 'pass',
            },
          ],
        },
      ],
    };

    const validation = validateFinalistJudgments(rawJudgments, testContract, [candidate1, candidate2]);

    assert.equal(validation.validJudgmentCount, 1, 'Only one valid unique candidate judgment should be counted');
    assert.equal(validation.counts.duplicate, 1, 'Duplicate counter should record 1 duplicate');
    assert.equal(validation.counts.hallucinated, 1, 'Hallucinated counter should record 1 unknown candidate');

    // cand_1 should retain its first judgment, not the overwritten duplicate
    const outcome1 = validation.outcomes.get('cand_1');
    assert.ok(outcome1);
    assert.equal(outcome1.status, 'qualified', 'First valid judgment must win and not be overwritten');

    // unjudged count should be 2 candidates - 1 judged = 1 (never negative)
    assert.equal(validation.counts.unjudged, 1, 'Unjudged count should be exactly 1');
  });
});
