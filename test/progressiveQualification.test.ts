import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isFlagEnabled } from '../server/leadSearch/featureFlags.js';
import {
  triPartitionCandidatesByEvidence,
  checkStrictContradiction,
  buildFinalistJudgePrompt,
  finalistCandidateFromLead,
  type FinalistCandidate,
} from '../server/leadSearch/finalistJudge.js';
import {
  type ProspectContract,
  PROSPECT_CONTRACT_POLICY_VERSION,
} from '../server/leadSearch/prospectContract.js';
import { buildRoundDiagnostics } from '../server/leadSearch/roundDiagnostics.js';

describe('PIQ-BOS: Progressive Interleaved Qualification', () => {
  const originalEnv = process.env.PROGRESSIVE_QUALIFICATION_ENABLED;

  beforeEach(() => {
    process.env.PROGRESSIVE_QUALIFICATION_ENABLED = 'true';
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PROGRESSIVE_QUALIFICATION_ENABLED;
    } else {
      process.env.PROGRESSIVE_QUALIFICATION_ENABLED = originalEnv;
    }
  });

  const sampleContract: ProspectContract = {
    version: 1,
    policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
    brief: 'Find agency founders in the United States',
    authorityRequired: true,
    exclusions: ['Salesforce', 'Recruiter', 'Student'],
    initialQueries: [],
    requirements: [
      {
        id: 'req-role',
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'founder or owner',
        sourcePhrase: 'founder',
        acceptableTerms: ['founder', 'co-founder', 'owner'],
        queryable: true,
      },
      {
        id: 'req-loc',
        scope: 'person_location',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'United States',
        sourcePhrase: 'United States',
        acceptableTerms: ['United States', 'US', 'USA'],
        queryable: true,
      },
      {
        id: 'req-soft',
        scope: 'signal',
        importance: 'soft',
        evidenceModality: 'inferred',
        description: 'has 50+ employees',
        sourcePhrase: 'growing team',
        acceptableTerms: ['50+', 'mid-size'],
        queryable: false,
      },
    ],
  };

  describe('Feature Flag', () => {
    it('isFlagEnabled.progressiveQualification returns true when env is true', () => {
      process.env.PROGRESSIVE_QUALIFICATION_ENABLED = 'true';
      assert.strictEqual(isFlagEnabled.progressiveQualification(), true);
    });

    it('isFlagEnabled.progressiveQualification returns false when env is false', () => {
      process.env.PROGRESSIVE_QUALIFICATION_ENABLED = 'false';
      assert.strictEqual(isFlagEnabled.progressiveQualification(), false);
    });
  });

  describe('Deterministic Two-Way Triage Gate', () => {
    it('auto-qualifies candidate meeting all hard requirements with zero LLM tokens', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'c1',
        lead: {
          fullName: 'Alice Founder',
          currentTitle: 'Founder & CEO',
          location: 'New York, United States',
          decisionMakerVerification: { confidence: 9, titleMatched: true },
        },
        evidence: [{ id: 'e0', text: 'Founder in New York, US' }],
      };

      const result = triPartitionCandidatesByEvidence([candidate], sampleContract);
      assert.strictEqual(result.autoQualified.length, 1);
      assert.strictEqual(result.autoFailed.length, 0);
      assert.strictEqual(result.needsJudge.length, 0);
      assert.strictEqual(result.autoQualified[0].qualification.verdict, 'qualified');
      assert.strictEqual(result.autoQualified[0].qualification.qualificationSource, 'deterministic');
      assert.strictEqual(result.autoQualified[0].qualification.semanticFit, 10);
    });

    it('auto-fails candidate matching an exclusion', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'c2',
        lead: {
          fullName: 'Bob Recruiter',
          currentTitle: 'Executive Recruiter',
          location: 'San Francisco, US',
        },
        evidence: [],
      };

      const result = triPartitionCandidatesByEvidence([candidate], sampleContract);
      assert.strictEqual(result.autoFailed.length, 1);
      assert.strictEqual(result.autoQualified.length, 0);
      assert.strictEqual(result.needsJudge.length, 0);
      assert.strictEqual(result.autoFailed[0].failedRequirementId, 'exclusion');
      assert.match(result.autoFailed[0].reason, /Matches contract exclusion/);
    });

    it('auto-fails negative seniority candidate when authority is required', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'c3',
        lead: {
          fullName: 'Charlie Intern',
          currentTitle: 'Marketing Intern',
          location: 'Austin, US',
          decisionMakerVerification: {
            ignoredTitle: true,
            confidence: 1,
            reason: 'intern role',
          },
        },
        evidence: [],
      };

      const result = triPartitionCandidatesByEvidence([candidate], sampleContract);
      assert.strictEqual(result.autoFailed.length, 1);
      assert.strictEqual(result.autoFailed[0].failedRequirementId, 'authority');
    });

    it('auto-fails foreign location without remote indicator when contract requires US', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'c4',
        lead: {
          fullName: 'David Londoner',
          currentTitle: 'Founder',
          location: 'London, United Kingdom',
        },
        evidence: [],
      };

      const result = triPartitionCandidatesByEvidence([candidate], sampleContract);
      assert.strictEqual(result.autoFailed.length, 1);
      assert.strictEqual(result.autoFailed[0].failedRequirementId, 'req-loc');
      assert.match(result.autoFailed[0].reason, /explicitly contradicts target/);
    });

    it('does NOT auto-fail foreign location if remote tag is present', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'c5',
        lead: {
          fullName: 'Elena Global',
          currentTitle: 'Founder',
          location: 'London, UK (Remote Worldwide)',
        },
        evidence: [],
      };

      const result = triPartitionCandidatesByEvidence([candidate], sampleContract);
      assert.strictEqual(result.autoFailed.length, 0);
      assert.strictEqual(result.needsJudge.length, 1);
    });

    it('routes ambiguous candidate to needsJudge', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'c6',
        lead: {
          fullName: 'Fiona VP',
          currentTitle: 'VP of Growth', // Not explicitly "founder" or "owner"
          location: 'Chicago, United States',
        },
        evidence: [],
      };

      const result = triPartitionCandidatesByEvidence([candidate], sampleContract);
      assert.strictEqual(result.autoQualified.length, 0);
      assert.strictEqual(result.autoFailed.length, 0);
      assert.strictEqual(result.needsJudge.length, 1);
    });
  });

  describe('Prompt Diet++ (Pruning Soft Requirements)', () => {
    it('prunes soft requirements from prompt when progressiveQualification is ON', () => {
      process.env.PROGRESSIVE_QUALIFICATION_ENABLED = 'true';
      const candidate: FinalistCandidate = {
        candidateId: 'c1',
        lead: { fullName: 'Test', currentTitle: 'CEO', location: 'USA' },
        evidence: [],
      };
      const prompt = buildFinalistJudgePrompt(sampleContract, [candidate]);
      assert.match(prompt, /req-role/);
      assert.match(prompt, /req-loc/);
      assert.doesNotMatch(prompt, /req-soft/);
    });

    it('retains all requirements in prompt when progressiveQualification is OFF', () => {
      process.env.PROGRESSIVE_QUALIFICATION_ENABLED = 'false';
      const candidate: FinalistCandidate = {
        candidateId: 'c1',
        lead: { fullName: 'Test', currentTitle: 'CEO', location: 'USA' },
        evidence: [],
      };
      const prompt = buildFinalistJudgePrompt(sampleContract, [candidate]);
      assert.match(prompt, /req-role/);
      assert.match(prompt, /req-loc/);
      assert.match(prompt, /req-soft/);
    });
  });

  describe('Round Diagnostics Viability Alignment', () => {
    it('counts viable candidates using live judge qualification verdict under PIQ-BOS', () => {
      process.env.PROGRESSIVE_QUALIFICATION_ENABLED = 'true';
      const leads = [
        {
          id: 'l1',
          fullName: 'Qualified Lead',
          qualification: { verdict: 'qualified' },
        },
        {
          id: 'l2',
          fullName: 'Partial Lead',
          qualification: { verdict: 'qualified_partial' },
        },
        {
          id: 'l3',
          fullName: 'Failed Lead',
          qualification: { verdict: 'hard_fail' },
        },
        {
          id: 'l4',
          fullName: 'Unjudged Lead',
        },
      ];

      const diag = buildRoundDiagnostics({
        round: 1,
        rawCandidates: 4,
        extractedCandidates: 4,
        leads,
        contract: sampleContract,
        targetLimit: 10,
      });

      // Under PIQ-BOS, only qualified and qualified_partial count as viable (2 leads)
      assert.strictEqual(diag.viableCandidates, 2);
    });
  });
});
