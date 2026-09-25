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
  applyContractDelta,
  PROSPECT_CONTRACT_POLICY_VERSION,
  type ProspectRequirement,
  type RequirementClass,
  type QueryHardness
} from '../server/leadSearch/prospectContract.js';
import { tokenizeQuery, rewriteZeroYieldQuery } from '../server/leadSearch/queryRewriter.js';
import { parseSiteSignalsFromEvidenceBlock } from '../server/leadSearch/siteProbe.js';
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
      const cls = classifyRequirement('company_size', 'hard', '100-500');
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

    it('uses current policy version', () => {
      const brief = 'Find owners';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      assert.equal(contract.policyVersion, PROSPECT_CONTRACT_POLICY_VERSION);
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

    it('extracts all countries when buying intent and slashes are present in brief', () => {
      const brief = 'AI agency owner from USA/UK/Canada/Australia with hiring intent';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      const locReq = contract.requirements.find(r => r.scope === 'person_location');
      assert.ok(locReq, 'Should have person_location requirement');
      const terms = locReq.acceptableTerms.map(t => t.toLowerCase());
      assert.ok(terms.some(t => t.includes('usa') || t.includes('united states')), 'Should include USA');
      assert.ok(terms.some(t => t.includes('uk') || t.includes('united kingdom')), 'Should include UK');
      assert.ok(terms.some(t => t.includes('canada') || t.includes('canadian')), 'Should include Canada');
      assert.ok(terms.some(t => t.includes('australia') || t.includes('australian')), 'Should include Australia');
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
      assert.equal(normalized.policyVersion, PROSPECT_CONTRACT_POLICY_VERSION, 'Should bump to current version');
      assert.ok(normalized.requirements[0].requirementClass, 'Should populate requirementClass');
      assert.equal(normalized.requirements[0].requirementClass, 'identity_hard');
      assert.ok(normalized.requirements[0].queryHardness, 'Should populate queryHardness');
      assert.equal(normalized.requirements[0].queryHardness, 'required_in_every_query');
    });

    it('overrides queryable to false for system_invariant', () => {
      const brief = 'Find owners with valid linkedin profile url';
      const contract: any = {
        version: 1,
        policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
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

    it('leaves requirements unchanged when already current version', () => {
      const contract: any = {
        version: 1,
        policyVersion: PROSPECT_CONTRACT_POLICY_VERSION,
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
      assert.equal(normalized.policyVersion, PROSPECT_CONTRACT_POLICY_VERSION);
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
    it('PROSPECT_CONTRACT_POLICY_VERSION constant is defined and matches current version', () => {
      assert.equal(PROSPECT_CONTRACT_POLICY_VERSION, 'evidence-contract-v9');
    });

    it('buildDeterministicProspectContract uses current policy version', () => {
      const contract = buildDeterministicProspectContract('Find owners', {});
      assert.equal(contract.policyVersion, PROSPECT_CONTRACT_POLICY_VERSION);
    });

    it('normalizeProspectContract bumps old contracts to current version', () => {
      const oldContract: any = {
        version: 1,
        policyVersion: 'evidence-contract-v5',
        brief: 'Find owners',
        requirements: [],
        exclusions: []
      };

      const fallback = buildDeterministicProspectContract('Find owners', {});
      const normalized = normalizeProspectContract(oldContract, 'Find owners', fallback);
      assert.equal(normalized.policyVersion, PROSPECT_CONTRACT_POLICY_VERSION);
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

  describe('Workstream 4, 5, 6 Regression Tests', () => {
    it('Fix 4A: rawLocMatch captures the last location clause rather than greedy industry prefix', () => {
      const brief = 'Founders in B2B SaaS in Austin, TX';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      const locReq = contract.requirements.find(r => r.scope === 'person_location');
      assert.ok(locReq, 'Should have person_location requirement');
      assert.ok(
        !locReq.acceptableTerms.some(t => /b2b saas/i.test(t)),
        `person_location should not include industry prefix "B2B SaaS", got: ${JSON.stringify(locReq.acceptableTerms)}`
      );
      assert.ok(
        locReq.acceptableTerms.some(t => /austin/i.test(t)),
        'person_location should include Austin'
      );
    });

    it('Fix 4B: multi-city clause does not leak secondary cities into company_type', () => {
      const brief = 'AI agency founders in New York, London, or Toronto';
      const contract = buildDeterministicProspectContract(brief, minimalSpec);
      const companyReqs = contract.requirements.filter(r => r.scope === 'company_type' || r.scope === 'company_industry');
      for (const req of companyReqs) {
        assert.ok(
          !req.acceptableTerms.some(t => /^(london|toronto)$/i.test(t.trim())),
          `City name leaked into ${req.scope}: ${JSON.stringify(req.acceptableTerms)}`
        );
      }
    });

    it('Fix 4C: tokenizeQuery and rewriteZeroYieldQuery preserve quoted multi-word phrases and strip site: prefix', () => {
      const raw = 'site:linkedin.com/in/ "AI agency" founder Austin extraNoiseToken';
      const parsedTokens = tokenizeQuery(raw);
      assert.equal(parsedTokens.prefix, 'site:linkedin.com/in/');
      assert.deepEqual(parsedTokens.tokens, ['AI agency', 'founder', 'Austin', 'extraNoiseToken']);

      const contract = buildDeterministicProspectContract('Find AI agency founders in Austin', minimalSpec);
      const rewritten = rewriteZeroYieldQuery(raw, contract, 1);
      assert.ok(
        !rewritten.query.includes('""AI') && !rewritten.query.includes('agency""'),
        `Rewritten query should not split quoted phrase: ${rewritten.query}`
      );
      assert.ok(
        rewritten.query.includes('"AI agency"'),
        `Rewritten query should preserve "AI agency" intact: ${rewritten.query}`
      );
    });

    it('Fix 5C: parseSiteSignalsFromEvidenceBlock splits raw markdown excerpt on --- delimiter', async () => {
      const { applySiteProbe } = await import('../server/leadSearch/siteProbe.js');
      const cachedEvidence = 'Location: Austin, TX\nServices: AI Automation\n---\nWe help enterprise teams deploy custom LLM workflows and autonomous agents.';
      const parsed = parseSiteSignalsFromEvidenceBlock(cachedEvidence);
      assert.equal(parsed.location, 'Austin, TX');
      assert.equal(parsed.services, 'AI Automation');
      assert.equal(parsed.rawExcerpt, 'We help enterprise teams deploy custom LLM workflows and autonomous agents.');

      const target: any = {
        lead: { fullName: 'Jane Doe', currentCompany: 'Apex AI', evidence: { evidenceBlock: '', snippets: [] } },
        evidenceMeta: { evidenceBlock: '' },
      };
      applySiteProbe(target, { ...parsed, provenance: 'explicit' }, 'https://apexai.io');
      assert.ok(
        target.evidenceMeta.evidenceBlock.includes('We help enterprise teams deploy custom LLM workflows'),
        'applySiteProbe should append rawExcerpt to evidenceMeta.evidenceBlock',
      );
    });

    it('Fix 6B: applyContractDelta merges new requirements and exclusions from follow-up brief without polluting positive requirements', () => {
      const baseContract = buildDeterministicProspectContract('Find AI agency founders in New York', minimalSpec);
      const updated = applyContractDelta(baseContract, 'Also in London, exclude Accenture', minimalSpec);
      assert.ok(updated.brief.includes('Also in London'));
      assert.ok(updated.exclusions.some(e => /accenture/i.test(e)), 'Should merge exclusion from deltaBrief');
      const locReq = updated.requirements.find(r => r.scope === 'person_location');
      assert.ok(locReq?.acceptableTerms.some(t => /london/i.test(t)), 'Should merge London into person_location');

      // Pure exclusion delta with location/company terms must not overwrite positive location or add "Exclude ..." to company_type
      const exclusionOnly = applyContractDelta(baseContract, 'Exclude staffing agencies in London', minimalSpec);
      assert.ok(exclusionOnly.exclusions.some(e => /staffing agencies in london/i.test(e)));
      const locAfterExcl = exclusionOnly.requirements.find(r => r.scope === 'person_location');
      assert.ok(
        locAfterExcl?.acceptableTerms.some(t => /new york/i.test(t)) &&
          !locAfterExcl?.acceptableTerms.some(t => /london/i.test(t)),
        `Exclusion-only delta should keep New York and not overwrite with London, got: ${JSON.stringify(locAfterExcl?.acceptableTerms)}`,
      );
      const compTypeReqs = exclusionOnly.requirements.filter(r => r.scope === 'company_type');
      for (const req of compTypeReqs) {
        assert.ok(
          !req.acceptableTerms.some(t => /exclude|staffing/i.test(t)),
          `Exclusion term leaked into company_type: ${JSON.stringify(req.acceptableTerms)}`,
        );
      }
    });
  });
});

