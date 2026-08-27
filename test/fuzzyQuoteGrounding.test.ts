import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyEvidencePassage,
  validateFinalistJudgments,
  type FinalistCandidate
} from '../server/leadSearch/finalistJudge.js';
import type { ProspectContract } from '../server/leadSearch/prospectContract.js';

describe('Optimization 1: Fuzzy Token-Aligned Quote Grounding', () => {
  const originalEnv = process.env.FUZZY_QUOTE_GROUNDING_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FUZZY_QUOTE_GROUNDING_ENABLED;
    } else {
      process.env.FUZZY_QUOTE_GROUNDING_ENABLED = originalEnv;
    }
  });

  const baseEvidence = 'Alex River is the Founder & CEO at Apex Studio, an AI consultancy based in Austin, TX.';

  describe('verifyEvidencePassage direct tests', () => {
    it('passes exact matches with 1.0 similarity', () => {
      const result = verifyEvidencePassage(baseEvidence, 'Founder & CEO at Apex Studio');
      assert.equal(result.valid, true);
      assert.equal(result.similarity, 1.0);
    });

    it('passes when quotes contain normalized smart quotes and whitespace', () => {
      const result = verifyEvidencePassage(
        baseEvidence,
        '“Alex River is the Founder & CEO at Apex Studio”'
      );
      assert.equal(result.valid, true);
      assert.ok(result.similarity >= 0.88);
    });

    it('passes when quote has trailing ellipses or slight token trimming', () => {
      const result = verifyEvidencePassage(
        baseEvidence,
        'Founder & CEO at Apex Studio, an AI consultancy...'
      );
      assert.equal(result.valid, true);
      assert.ok(result.similarity >= 0.88);
    });

    it('strictly rejects genuine hallucinations', () => {
      const result = verifyEvidencePassage(
        baseEvidence,
        'John Smith is the Chief Marketing Officer at Global Brands in London'
      );
      assert.equal(result.valid, false);
      assert.ok(result.similarity < 0.5);
    });
  });

  describe('validateFinalistJudgments integration', () => {
    const contract: ProspectContract = {
      version: 1,
      policyVersion: 'evidence-contract-v7',
      brief: 'Find founders',
      authorityRequired: false,
      exclusions: [],
      initialQueries: [],
      requirements: [
        {
          id: 'req-founder',
          scope: 'person_role',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          description: 'founder',
          sourcePhrase: 'founder',
          acceptableTerms: ['founder', 'ceo'],
          queryable: true,
          requirementClass: 'identity_hard',
          queryHardness: 'required_in_every_query'
        }
      ]
    };

    const candidate: FinalistCandidate = {
      candidateId: 'cand-1',
      lead: {
        fullName: 'Alex River',
        currentTitle: 'Founder & CEO',
        currentCompany: 'Apex Studio',
        scout: { corroborationScore: 8, criteriaCoverageScore: 8 }
      },
      evidence: [
        { id: 'e1', text: baseEvidence }
      ]
    };

    it('flags fabricatedPass in legacy mode when quote has slight punctuation diff', () => {
      process.env.FUZZY_QUOTE_GROUNDING_ENABLED = 'false';
      const judgments = [
        {
          candidateId: 'cand-1',
          requirements: [
            {
              requirementId: 'req-founder',
              status: 'pass',
              evidenceId: 'e1',
              evidenceQuote: '“Alex River is the Founder & CEO at Apex Studio”' // smart quotes fail legacy substring match
            }
          ],
          semanticFit: 9,
          authorityFit: 9,
          evidenceConfidence: 9,
          verdict: 'qualified',
          reason: 'Matches'
        }
      ];

      const { outcomes } = validateFinalistJudgments({ judgments }, contract, [candidate]);
      const outcome = outcomes.get('cand-1');
      assert.equal(outcome?.status, 'unknown', 'Legacy mode marks quote as fabricated because of smart quotes');
    });

    it('qualifies candidate when fuzzy quote grounding is enabled', () => {
      process.env.FUZZY_QUOTE_GROUNDING_ENABLED = 'true';
      const judgments = [
        {
          candidateId: 'cand-1',
          requirements: [
            {
              requirementId: 'req-founder',
              status: 'pass',
              evidenceId: 'e1',
              evidenceQuote: '“Alex River is the Founder & CEO at Apex Studio”'
            }
          ],
          semanticFit: 9,
          authorityFit: 9,
          evidenceConfidence: 9,
          verdict: 'qualified',
          reason: 'Matches'
        }
      ];

      const { outcomes } = validateFinalistJudgments({ judgments }, contract, [candidate]);
      const outcome = outcomes.get('cand-1');
      assert.equal(outcome?.status, 'qualified', 'Fuzzy grounding verifies normalized quote and qualifies candidate');
    });
  });
});
