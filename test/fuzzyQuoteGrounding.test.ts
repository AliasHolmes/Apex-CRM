import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyEvidencePassage,
  validateFinalistJudgments,
  type FinalistCandidate
} from '../server/leadSearch/finalistJudge.js';
import { type ProspectContract, PROSPECT_CONTRACT_POLICY_VERSION } from '../server/leadSearch/prospectContract.js';

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
        '\u201CAlex River is the Founder & CEO at Apex Studio\u201D'
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
      policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
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
              evidenceQuote: '\u201CAlex River is the Founder & CEO at Apex Studio\u201D' // smart quotes fail legacy substring match
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

    it('G1 strict: person_role pass with empty quote degrades to unknown', () => {
      process.env.FUZZY_QUOTE_GROUNDING_ENABLED = 'true';
      delete process.env.EVIDENCE_GROUNDING_MODE;
      const judgments = [
        {
          candidateId: 'cand-1',
          requirements: [{ requirementId: 'req-founder', status: 'pass', evidenceId: 'e1', evidenceQuote: '' }],
          semanticFit: 9, authorityFit: 9, evidenceConfidence: 9, verdict: 'qualified', reason: 'Matches'
        }
      ];
      const { outcomes } = validateFinalistJudgments({ judgments }, contract, [candidate]);
      assert.equal(outcomes.get('cand-1')?.status, 'unknown');
    });

    it('G1 legacy: empty quote preserves historical pass', () => {
      process.env.FUZZY_QUOTE_GROUNDING_ENABLED = 'true';
      process.env.EVIDENCE_GROUNDING_MODE = 'legacy';
      try {
        const judgments = [
          {
            candidateId: 'cand-1',
            requirements: [{ requirementId: 'req-founder', status: 'pass', evidenceId: 'e1', evidenceQuote: '' }],
            semanticFit: 9, authorityFit: 9, evidenceConfidence: 9, verdict: 'qualified', reason: 'Matches'
          }
        ];
        const { outcomes } = validateFinalistJudgments({ judgments }, contract, [candidate]);
        assert.equal(outcomes.get('cand-1')?.status, 'qualified');
      } finally {
        delete process.env.EVIDENCE_GROUNDING_MODE;
      }
    });

    it('G1 strict: quote matching no evidence item is rejected', () => {
      delete process.env.EVIDENCE_GROUNDING_MODE;
      const result = verifyEvidencePassage(baseEvidence, 'completely unrelated hallucinated claim about Mars');
      assert.equal(result.valid, false);
    });

    it('G9: negated evidence rejects the affirmative quote', () => {
      const result = verifyEvidencePassage('Acme is not hiring developers', 'Acme is hiring developers');
      assert.equal(result.valid, false);
    });

    it('G9: negated quote against negated evidence passes (no false rejection)', () => {
      const result = verifyEvidencePassage('Acme is not hiring right now', 'not hiring');
      assert.equal(result.valid, true);
    });

    it('G9: paraphrased quote with reordered words still passes', () => {
      const result = verifyEvidencePassage(
        'Alex River is the Founder and CEO at Apex Studio in Austin',
        'CEO and Founder Apex Studio'
      );
      assert.equal(result.valid, true);
    });

    it('G4: aliasIncludes grounds acronyms symmetrically', async () => {
      const { aliasIncludes } = await import('../server/leadSearch/aliasMap.js');
      assert.equal(aliasIncludes('US SaaS founder', 'United States'), true);
      assert.equal(aliasIncludes('... CEO', 'Chief Executive Officer'), true);
      assert.equal(aliasIncludes('UK founders', 'United Kingdom'), true);
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
              evidenceQuote: '\u201CAlex River is the Founder & CEO at Apex Studio\u201D'
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
