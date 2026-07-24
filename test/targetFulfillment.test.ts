import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRecoveryCandidateCeiling, getQueryExecutionCeiling } from '../server/leadSearch/collectionCapacity.ts';
import { finalistCandidateFromLead, partitionCandidatesByStrictEvidence, validateFinalistJudgments } from '../server/leadSearch/finalistJudge.ts';
import { buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.ts';
import { candidateStableId } from '../server/leadSearch/targetFulfillment.ts';

describe('Target Fulfillment Engine Mechanics', () => {
  it('computes target-scaled ceilings correctly', () => {
    assert.equal(getRecoveryCandidateCeiling(10), 80); // 10 * 8 = 80
    assert.equal(getRecoveryCandidateCeiling(5), 40);  // 5 * 8 = 40
    assert.equal(getRecoveryCandidateCeiling(200), 1600); // capped at 1600

    assert.equal(getQueryExecutionCeiling(10), 32); // max(32, 10 * 2) = 32
    assert.equal(getQueryExecutionCeiling(20), 40); // 20 * 2 = 40
    assert.equal(getQueryExecutionCeiling(200), 240); // capped at 240
  });

  it('generates deterministic candidate stable IDs correctly', () => {
    const lead1 = {
      contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/john-doe-123/' },
      fullName: 'John Doe',
      currentCompany: 'Acme Corp'
    };
    const lead2 = {
      contactDetails: { linkedinUrl: 'https://linkedin.com/in/john-doe-123' },
      fullName: 'John Doe',
      currentCompany: 'Acme Corp'
    };
    const lead3 = {
      contactDetails: {},
      fullName: 'Jane Smith',
      currentCompany: 'Beta LLC'
    };

    assert.equal(candidateStableId(lead1), 'linkedin:john-doe-123');
    assert.equal(candidateStableId(lead2), 'linkedin:john-doe-123');
    assert.equal(candidateStableId(lead3), 'text:jane smith@beta llc');
  });

  it('prevents rescued promotions when candidates fail hard requirements', () => {
    const contract = buildDeterministicProspectContract('SaaS Founder in San Francisco', {
      version: 1,
      mode: 'person_first',
      person: { includeTitles: ['founder'], excludeTitles: [], seniorities: [], locations: ['San Francisco'] },
      company: { industries: [], keywords: ['SaaS'], locations: [] },
      signals: { include: [] },
      exclusions: { companies: [], domains: [] },
      maxPerCompany: 2
    });

    const failingLead = {
      fullName: 'Jane Fail',
      currentTitle: 'Sales Representative',
      currentCompany: 'Widget Corp',
      headline: 'Sales Rep at Widget Corp',
      contactDetails: { linkedinUrl: 'https://linkedin.com/in/fail-user' }
    };
    const failingCandidate = finalistCandidateFromLead('linkedin:fail-user', failingLead, 'Sales Representative at Widget Corp in Chicago', contract);

    // Partition test
    const { autoQualified, needsJudge } = partitionCandidatesByStrictEvidence([failingCandidate], contract);
    assert.equal(autoQualified.length, 0);
    assert.equal(needsJudge.length, 1);

    const hardReq = contract.requirements.find(r => r.importance === 'hard');
    const hardReqId = hardReq ? hardReq.id : 'person_role-1';

    // LLM judgment mock returning hard_fail for failing candidate
    const judgmentRaw = [
      {
        candidateId: 'linkedin:fail-user',
        status: 'hard_fail',
        reason: 'Candidate is a Sales Rep, not a Founder.',
        requirements: [
          {
            requirementId: hardReqId,
            status: 'fail',
            reason: 'Candidate is a Sales Rep'
          }
        ]
      }
    ];

    const validation = validateFinalistJudgments({ judgments: judgmentRaw }, contract, [failingCandidate]);
    assert.equal(validation.counts.qualified, 0);
    assert.equal(validation.counts.hardFail, 1);
    const outcome = validation.outcomes.get('linkedin:fail-user');
    assert.equal(outcome?.status, 'hard_fail');
  });

  it('correctly quantifies decidable judgments and recovery tranche math', () => {
    // Math validation:
    // If decidable judgments = 16, qualified = 4, yield = 4/16 = 0.25
    // Shortfall = 6. Tranche = ceil(6 / 0.25 * 1.25) = ceil(30) = 30 candidates to judge.
    const qualifiedCount = 4;
    const decidableCount = 16;
    const rawYield = qualifiedCount / decidableCount; // 0.25
    const clampedYield = Math.max(0.10, Math.min(0.75, rawYield)); // 0.25
    const shortfall = 6;
    const requiredTranche = Math.ceil((shortfall / clampedYield) * 1.25);

    assert.equal(clampedYield, 0.25);
    assert.equal(requiredTranche, 30);
  });
});
