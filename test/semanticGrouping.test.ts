import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateFinalistJudgments,
  type FinalistCandidate
} from '../server/leadSearch/finalistJudge.js';
import {
  normalizeProspectContract,
  buildDeterministicProspectContract,
  type ProspectContract
} from '../server/leadSearch/prospectContract.js';

describe('Phase 3: Semantic Grouping Support', () => {
  const originalEnv = process.env.SEMANTIC_GROUPING_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SEMANTIC_GROUPING_ENABLED;
    } else {
      process.env.SEMANTIC_GROUPING_ENABLED = originalEnv;
    }
  });

  const baseContract: ProspectContract = {
    version: 1,
    policyVersion: 'evidence-contract-v6',
    brief: 'Find owners in NY or SF',
    authorityRequired: false,
    exclusions: [],
    initialQueries: [],
    requirements: [
      {
        id: 'req-role',
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'owner or founder',
        sourcePhrase: 'owner',
        acceptableTerms: ['owner', 'founder'],
        queryable: true,
        requirementClass: 'identity_hard',
        queryHardness: 'required_in_every_query'
      },
      {
        id: 'req-loc-ny',
        scope: 'person_location',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'New York',
        sourcePhrase: 'New York',
        acceptableTerms: ['New York', 'NY'],
        queryable: true,
        requirementClass: 'context_hard',
        queryHardness: 'distributed_across_queries',
        groupId: 'loc-group',
        matchRule: 'any_of'
      },
      {
        id: 'req-loc-sf',
        scope: 'person_location',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'San Francisco',
        sourcePhrase: 'San Francisco',
        acceptableTerms: ['San Francisco', 'SF'],
        queryable: true,
        requirementClass: 'context_hard',
        queryHardness: 'distributed_across_queries',
        groupId: 'loc-group',
        matchRule: 'any_of'
      }
    ]
  };

  const candidate: FinalistCandidate = {
    candidateId: 'cand-1',
    lead: {
      fullName: 'Jane Doe',
      currentTitle: 'Founder',
      location: 'New York, NY',
      scout: { corroborationScore: 8, criteriaCoverageScore: 8 }
    },
    evidence: [
      { id: 'e1', text: 'Jane Doe is the Founder based in New York, NY.' }
    ]
  };

  describe('When flag is DISABLED (Legacy strict checking)', () => {
    beforeEach(() => {
      process.env.SEMANTIC_GROUPING_ENABLED = 'false';
    });

    it('hard-fails when any individual requirement fails even if in a group', () => {
      const judgments = [
        {
          candidateId: 'cand-1',
          requirements: [
            { requirementId: 'req-role', status: 'pass', evidenceId: 'e1', evidenceQuote: 'Founder' },
            { requirementId: 'req-loc-ny', status: 'pass', evidenceId: 'e1', evidenceQuote: 'New York' },
            { requirementId: 'req-loc-sf', status: 'fail', reason: 'Not in SF' }
          ],
          semanticFit: 9,
          authorityFit: 9,
          evidenceConfidence: 9,
          verdict: 'qualified',
          reason: 'Matches'
        }
      ];

      const { outcomes } = validateFinalistJudgments({ judgments }, baseContract, [candidate]);
      const outcome = outcomes.get('cand-1');
      assert.equal(outcome?.status, 'hard_fail', 'In legacy mode, failure on req-loc-sf causes hard_fail');
    });
  });

  describe('When flag is ENABLED (Semantic Grouping)', () => {
    beforeEach(() => {
      process.env.SEMANTIC_GROUPING_ENABLED = 'true';
    });

    it('qualifies candidate when 1 member of an any_of group passes', () => {
      const judgments = [
        {
          candidateId: 'cand-1',
          requirements: [
            { requirementId: 'req-role', status: 'pass', evidenceId: 'e1', evidenceQuote: 'Founder' },
            { requirementId: 'req-loc-ny', status: 'pass', evidenceId: 'e1', evidenceQuote: 'New York' },
            { requirementId: 'req-loc-sf', status: 'fail', reason: 'Not in SF' }
          ],
          semanticFit: 9,
          authorityFit: 9,
          evidenceConfidence: 9,
          verdict: 'qualified',
          reason: 'Matches'
        }
      ];

      const { outcomes } = validateFinalistJudgments({ judgments }, baseContract, [candidate]);
      const outcome = outcomes.get('cand-1');
      assert.equal(outcome?.status, 'qualified', 'Candidate should qualify because NY passed in any_of group');
    });

    it('hard-fails when all members of an any_of group fail', () => {
      const judgments = [
        {
          candidateId: 'cand-1',
          requirements: [
            { requirementId: 'req-role', status: 'pass', evidenceId: 'e1', evidenceQuote: 'Founder' },
            { requirementId: 'req-loc-ny', status: 'fail', reason: 'Not in NY' },
            { requirementId: 'req-loc-sf', status: 'fail', reason: 'Not in SF' }
          ],
          semanticFit: 8,
          authorityFit: 8,
          evidenceConfidence: 8,
          verdict: 'qualified',
          reason: 'Matches'
        }
      ];

      const { outcomes } = validateFinalistJudgments({ judgments }, baseContract, [candidate]);
      const outcome = outcomes.get('cand-1');
      assert.equal(outcome?.status, 'hard_fail', 'Candidate should hard_fail when all group members fail');
    });

    it('normalization preserves groupId and matchRule', () => {
      const raw = {
        requirements: [
          {
            id: 'r1',
            scope: 'company_type',
            importance: 'hard',
            sourcePhrase: 'AI Agency',
            acceptableTerms: ['AI Agency', 'AI Consultancy'],
            groupId: 'agency-group',
            matchRule: 'any_of'
          }
        ]
      };

      const fallback = buildDeterministicProspectContract('Find AI Agency', {});
      const normalized = normalizeProspectContract(raw, 'Find AI Agency', fallback);
      const req = normalized.requirements.find(r => r.id === 'r1' || r.sourcePhrase === 'AI Agency');
      assert.ok(req);
      assert.equal(req.groupId, 'agency-group');
      assert.equal(req.matchRule, 'any_of');
    });
  });
});
