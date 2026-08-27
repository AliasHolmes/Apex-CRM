/**
 * Phase 1: Requirement Taxonomy Enhancement - Regression Tests
 * 
 * Tests for:
 * - classifyRequirement() determinism
 * - assignQueryHardness() correctness
 * - buildDeterministicProspectContract() field population
 * - normalizeProspectContract() backward compatibility and normalization
 * - Schema validation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeterministicProspectContract,
  classifyRequirement,
  assignQueryHardness,
  normalizeProspectContract,
  PROSPECT_CONTRACT_POLICY_VERSION,
  type ProspectRequirement,
  type RequirementClass,
  type QueryHardness,
  type ProspectContract
} from '../server/leadSearch/prospectContract.js';
import type { SearchSpec } from '../server/leadSearch/searchSpec.js';

// Minimal SearchSpec for testing
const minimalSpec: SearchSpec = {
  version: 1,
  mode: 'person_first',
  person: {
    includeTitles: [],
    excludeTitles: [],
    seniorities: [],
    locations: []
  },
  company: {
    industries: [],
    keywords: [],
    locations: []
  },
  signals: {
    include: []
  },
  exclusions: {
    companies: [],
    domains: []
  },
  maxPerCompany: 10
};

describe('Phase 1: Requirement Taxonomy', () => {
  describe('classifyRequirement()', () => {
    it('classifies soft requirements as ranking_signal', () => {
      const cls = classifyRequirement('person_location', 'soft', 'nice to have');
      assert.equal(cls, 'ranking_signal');
    });

    it('classifies person_role hard as identity_hard', () => {
      const cls = classifyRequirement('person_role', 'hard', 'owner');
      assert.equal(cls, 'identity_hard');
    });

    it('classifies location hard as context_hard', () => {
      const cls = classifyRequirement('person_location', 'hard', 'USA');
      assert.equal(cls, 'context_hard');
    });

    it('classifies company_industry hard as context_hard', () => {
      const cls = classifyRequirement('company_industry', 'hard', 'tech');
      assert.equal(cls, 'context_hard');
    });

    it('classifies company_type hard as context_hard', () => {
      const cls = classifyRequirement('company_type', 'hard', 'SaaS');
      assert.equal(cls, 'context_hard');
    });

    it('classifies company_size hard as evidence_required', () => {
      const cls = classifyRequirement('company_size', 'hard', '100–500');
      assert.equal(cls, 'evidence_required');
    });

    it('classifies signal scope with URL pattern as system_invariant', () => {
      const cls = classifyRequirement('signal', 'hard', 'linkedin profile url must be valid');
      assert.equal(cls, 'system_invariant');
    });

    it('classifies signal scope with "valid url" as system_invariant', () => {
      const cls = classifyRequirement('signal', 'hard', 'valid url exists');
      assert.equal(cls, 'system_invariant');
    });

    it('classifies signal scope with "duplicate" as system_invariant', () => {
      const cls = classifyRequirement('signal', 'hard', 'duplicate record');
      assert.equal(cls, 'system_invariant');
    });

    it('classifies unmatched hard requirement as context_hard (default)', () => {
      const cls = classifyRequirement('person_location', 'hard', 'unknown scope');
      assert.equal(cls, 'context_hard');
    });
  });

  describe('assignQueryHardness()', () => {
    it('returns required_in_every_query for identity_hard', () => {
      const hardness = assignQueryHardness('identity_hard');
      assert.equal(hardness, 'required_in_every_query');
    });

    it('returns distributed_across_queries for context_hard', () => {
      const hardness = assignQueryHardness('context_hard');
      assert.equal(hardness, 'distributed_across_queries');
    });

    it('returns distributed_across_queries for evidence_required', () => {
      const hardness = assignQueryHardness('evidence_required');
      assert.equal(hardness, 'distributed_across_queries');
    });

    it('returns optional_for_queries for system_invariant', () => {
      const hardness = assignQueryHardness('system_invariant');
      assert.equal(hardness, 'optional_for_queries');
    });

    it('returns optional_for_queries for ranking_signal', () => {
      const hardness = assignQueryHardness('ranking_signal');
      assert.equal(hardness, 'optional_for_queries');
    });
  });

  describe('buildDeterministicProspectContract()', () => {
    it('populates requirementClass on all requirements', () => {
      const brief = 'Find AI agency owners in New York';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      
      for (const req of contract.requirements) {
        assert.ok(req.requirementClass, `Requirement ${req.id} missing requirementClass`);
        const validClasses: RequirementClass[] = ['system_invariant', 'identity_hard', 'context_hard', 'evidence_required', 'ranking_signal'];
        assert.ok(validClasses.includes(req.requirementClass));
      }
    });

    it('populates queryHardness on all requirements', () => {
      const brief = 'Find AI agency owners in New York';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      
      for (const req of contract.requirements) {
        assert.ok(req.queryHardness, `Requirement ${req.id} missing queryHardness`);
        const validHardness: QueryHardness[] = ['required_in_every_query', 'distributed_across_queries', 'optional_for_queries'];
        assert.ok(validHardness.includes(req.queryHardness));
      }
    });

    it('sets queryable=false for system_invariant requirements', () => {
      const brief = 'Find AI agency owners with valid LinkedIn URL';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      const systemInvariants = contract.requirements.filter(r => r.requirementClass === 'system_invariant');
      
      for (const req of systemInvariants) {
        assert.equal(req.queryable, false, `System invariant ${req.id} should not be queryable`);
      }
    });

    it('initializes acceptableEvidenceSources as empty array', () => {
      const brief = 'Find owners';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      
      for (const req of contract.requirements) {
        assert.ok(Array.isArray(req.acceptableEvidenceSources), `Requirement ${req.id} missing acceptableEvidenceSources array`);
        assert.equal(req.acceptableEvidenceSources?.length || 0, 0, 'acceptableEvidenceSources should start empty');
      }
    });

    it('uses policy version v7', () => {
      const brief = 'Find owners';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      assert.equal(contract.policyVersion, 'evidence-contract-v7');
    });

    it('identity_hard requirements have queryHardness=required_in_every_query', () => {
      const brief = 'Find AI agency owners in New York';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      
      const identityHards = contract.requirements.filter(r => r.requirementClass === 'identity_hard');
      assert.ok(identityHards.length > 0, 'Should have at least one identity_hard requirement');
      
      for (const req of identityHards) {
        assert.equal(req.queryHardness, 'required_in_every_query');
      }
    });

    it('context_hard requirements have queryHardness=distributed_across_queries', () => {
      const brief = 'Find AI agency owners in New York';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      
      const contextHards = contract.requirements.filter(r => r.requirementClass === 'context_hard');
      for (const req of contextHards) {
        assert.equal(req.queryHardness, 'distributed_across_queries');
      }
    });
  });

  describe('normalizeProspectContract()', () => {
    const fallbackBrief = 'Find owners';
    const fallbackContract = buildDeterministicProspectContract(fallbackBrief, minimalSpec)

    it('classifies old v5/v6 contracts on load', () => {
      const oldContract: any = {
        version: 1,
        policyVersion: 'evidence-contract-v5',
        brief: 'Find AI owners',
        requirements: [
          {
            id: 'req-1',
            scope: 'person_role' as const,
            importance: 'hard' as const,
            sourcePhrase: 'owner',
            acceptableTerms: ['owner', 'founder'],
            description: 'owner or founder',
            queryable: true,
            evidenceModality: 'structured_profile' as const,
            // Missing: requirementClass, queryHardness
          }
        ],
        exclusions: []
      };

      const normalized = normalizeProspectContract(oldContract, fallbackBrief, fallbackContract);
      assert.equal(normalized.policyVersion, 'evidence-contract-v7', 'Should bump to v7');
      assert.ok(normalized.requirements[0].requirementClass, 'Should populate requirementClass');
      assert.equal(normalized.requirements[0].requirementClass, 'identity_hard');
      assert.ok(normalized.requirements[0].queryHardness, 'Should populate queryHardness');
      assert.equal(normalized.requirements[0].queryHardness, 'required_in_every_query');
    });

    it('overrides queryable to false for system_invariant', () => {
      const brief = 'Find owners with valid linkedin profile url';
      const contract: any = {
        version: 1,
        policyVersion: 'evidence-contract-v7',
        brief,
        requirements: [
          {
            id: 'req-1',
            scope: 'signal' as const,
            importance: 'hard' as const,
            sourcePhrase: 'valid linkedin profile url',
            acceptableTerms: ['linkedin url', 'profile url'],
            description: 'valid linkedin url',
            queryable: true,  // LLM mistakenly set to true
            evidenceModality: 'open_web_signal' as const,
            requirementClass: 'system_invariant',
            queryHardness: 'optional_for_queries'
          }
        ],
        exclusions: []
      };

      const fallback = buildDeterministicProspectContract(brief, minimalSpec);
      const normalized = normalizeProspectContract(contract, brief, fallback);
      const invariantReq = normalized.requirements.find(r => r.requirementClass === 'system_invariant');
      assert.ok(invariantReq, 'Should contain system_invariant requirement');
      assert.equal(
        invariantReq.queryable,
        false,
        'System invariant should be forced queryable=false'
      );
    });

    it('leaves requirements unchanged when already v7', () => {
      const contract: any = {
        version: 1,
        policyVersion: 'evidence-contract-v7',
        brief: 'Find owners',
        requirements: [
          {
            id: 'req-1',
            scope: 'person_role' as const,
            importance: 'hard' as const,
            sourcePhrase: 'owner',
            acceptableTerms: ['owner'],
            description: 'owner',
            queryable: true,
            evidenceModality: 'structured_profile' as const,
            requirementClass: 'identity_hard',
            queryHardness: 'required_in_every_query'
          }
        ],
        exclusions: []
      };

      const normalized = normalizeProspectContract(contract, fallbackBrief, fallbackContract);
      assert.equal(normalized.policyVersion, 'evidence-contract-v7');
      assert.equal(normalized.requirements[0].requirementClass, 'identity_hard');
    });

    it('defaults acceptableEvidenceSources to empty array', () => {
      const contract: any = {
        version: 1,
        policyVersion: 'evidence-contract-v7',
        brief: 'Find owners',
        requirements: [
          {
            id: 'req-1',
            scope: 'person_role' as const,
            importance: 'hard' as const,
            sourcePhrase: 'owner',
            acceptableTerms: ['owner'],
            description: 'owner',
            queryable: true,
            evidenceModality: 'structured_profile' as const,
            requirementClass: 'identity_hard',
            queryHardness: 'required_in_every_query'
            // Missing: acceptableEvidenceSources
          }
        ],
        exclusions: []
      };

      const normalized = normalizeProspectContract(contract, fallbackBrief, fallbackContract);
      assert.ok(
        Array.isArray(normalized.requirements[0].acceptableEvidenceSources),
        'Should initialize acceptableEvidenceSources'
      );
      assert.equal(
        normalized.requirements[0].acceptableEvidenceSources?.length || 0,
        0,
        'Should be empty array'
      );
    });

    it('classifies missing requirementClass deterministically', () => {
      const brief = 'Find AI owners in New York';
      const fallback = buildDeterministicProspectContract(brief, minimalSpec);
      const contract: any = {
        version: 1,
        policyVersion: 'evidence-contract-v5',
        brief,
        requirements: [
          {
            id: 'req-1',
            scope: 'person_location' as const,
            importance: 'hard' as const,
            sourcePhrase: 'New York',
            acceptableTerms: ['New York', 'NY'],
            description: 'New York',
            queryable: true,
            evidenceModality: 'structured_profile' as const
            // Missing: requirementClass
          }
        ],
        exclusions: []
      };

      const normalized = normalizeProspectContract(contract, brief, fallback);
      const locationReq = normalized.requirements.find(r => r.scope === 'person_location');
      assert.ok(locationReq, 'Should have location requirement');
      assert.equal(
        locationReq.requirementClass,
        'context_hard',
        'Location should be classified as context_hard'
      );
    });
  });

  describe('Backward compatibility', () => {
    it('deterministic contract always has new fields', () => {
      const brief = 'Find AI agency owners';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      
      // All requirements should have Phase 1 fields populated
      for (const req of contract.requirements) {
        assert.ok(req.requirementClass, 'Every requirement must have requirementClass');
        assert.ok(req.queryHardness, 'Every requirement must have queryHardness');
        assert.ok(Array.isArray(req.acceptableEvidenceSources), 'Every requirement must have acceptableEvidenceSources');
      }
    });

    it('normalized contract always has new fields', () => {
      const modelOutput: any = {
        version: 1,
        policyVersion: 'evidence-contract-v5',
        brief: 'Find AI owners',
        requirements: [
          {
            id: 'req-1',
            scope: 'person_role' as const,
            importance: 'hard' as const,
            sourcePhrase: 'owner',
            acceptableTerms: ['owner'],
            description: 'owner',
            queryable: true,
            evidenceModality: 'structured_profile' as const
          }
        ],
        exclusions: [],
        initialQueries: []
      };

      const fallback = buildDeterministicProspectContract('Find owners', {});
      const normalized = normalizeProspectContract(modelOutput, 'Find AI owners', fallback);
      
      for (const req of normalized.requirements) {
        assert.ok(req.requirementClass, 'Normalized requirement must have requirementClass');
        assert.ok(req.queryHardness, 'Normalized requirement must have queryHardness');
        assert.ok(Array.isArray(req.acceptableEvidenceSources), 'Normalized requirement must have acceptableEvidenceSources');
      }
    });
  });

  describe('Policy version consistency', () => {
    it('PROSPECT_CONTRACT_POLICY_VERSION constant is v7', () => {
      assert.equal(PROSPECT_CONTRACT_POLICY_VERSION, 'evidence-contract-v7');
    });

    it('buildDeterministicProspectContract uses current policy version', () => {
      const contract = buildDeterministicProspectContract('Find owners', {});
      assert.equal(contract.policyVersion, PROSPECT_CONTRACT_POLICY_VERSION);
    });

    it('normalizeProspectContract bumps old contracts to v7', () => {
      const oldContract: any = {
        version: 1,
        policyVersion: 'evidence-contract-v5',
        brief: 'Find owners',
        requirements: [],
        exclusions: []
      };

      const fallback = buildDeterministicProspectContract('Find owners', {});
      const normalized = normalizeProspectContract(oldContract, 'Find owners', fallback);
      assert.equal(normalized.policyVersion, 'evidence-contract-v7');
    });
  });

  describe('Requirement class determinism', () => {
    it('same brief produces same classes across runs', () => {
      const brief = 'Find AI agency owners in San Francisco hiring';
      
      const contract1 = buildDeterministicProspectContract(brief, minimalSpec);
      const contract2 = buildDeterministicProspectContract(brief, minimalSpec);
      
      // Requirements should have identical classes (may differ in order)
      const sortById = (reqs: ProspectRequirement[]) => 
        [...reqs].sort((a, b) => a.id.localeCompare(b.id));
      
      const req1 = sortById(contract1.requirements);
      const req2 = sortById(contract2.requirements);
      
      assert.equal(req1.length, req2.length, 'Same brief should produce same number of requirements');
      
      for (let i = 0; i < req1.length; i++) {
        assert.equal(
          req1[i].requirementClass,
          req2[i].requirementClass,
          `Requirement ${i} should have same class in both runs`
        );
      }
    });
  });
});
