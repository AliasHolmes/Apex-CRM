import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAblationTier,
  ablateQueryTask,
  ABLATION_TIERS,
  createAblationTracker,
} from '../server/leadSearch/constraintAblation.js';
import type { ProspectContract, ProspectRequirement } from '../server/leadSearch/prospectContract.js';
import {
  triPartitionCandidatesByEvidence,
  type FinalistCandidate,
} from '../server/leadSearch/finalistJudge.js';

describe('Hierarchical Algorithmic Constraint Ablation', () => {
  const reqRole: ProspectRequirement = {
    id: 'req-role',
    description: 'VP of Sales',
    sourcePhrase: 'VP of Sales',
    acceptableTerms: ['VP of Sales', 'Vice President of Sales', 'Head of Sales'],
    scope: 'person_role',
    importance: 'hard',
    evidenceModality: 'structured_profile',
    requirementClass: 'identity_hard',
    queryHardness: 'required_in_every_query',
    queryable: true,
  };

  const reqLoc: ProspectRequirement = {
    id: 'req-loc',
    description: 'San Francisco',
    sourcePhrase: 'San Francisco',
    acceptableTerms: ['San Francisco', 'SF Bay Area', 'SF'],
    scope: 'person_location',
    importance: 'hard',
    evidenceModality: 'structured_profile',
    requirementClass: 'context_hard',
    queryHardness: 'distributed_across_queries',
    queryable: true,
  };

  const reqIndustry: ProspectRequirement = {
    id: 'req-ind',
    description: 'B2B SaaS',
    sourcePhrase: 'B2B SaaS',
    acceptableTerms: ['B2B SaaS', 'SaaS', 'Enterprise Software'],
    scope: 'company_industry',
    importance: 'hard',
    evidenceModality: 'structured_profile',
    requirementClass: 'context_hard',
    queryHardness: 'distributed_across_queries',
    queryable: true,
  };

  const reqStack: ProspectRequirement = {
    id: 'req-stack',
    description: 'Snowflake stack',
    sourcePhrase: 'Snowflake',
    acceptableTerms: ['Snowflake', 'Snowflake Data Cloud'],
    scope: 'company_type',
    importance: 'hard',
    evidenceModality: 'structured_profile',
    requirementClass: 'context_hard',
    queryHardness: 'distributed_across_queries',
    queryable: true,
  };

  const reqAgency: ProspectRequirement = {
    id: 'req-agency',
    description: 'AI agency',
    sourcePhrase: 'AI agency',
    acceptableTerms: ['AI agency', 'AI studio', 'AI consultancy'],
    scope: 'company_type',
    importance: 'hard',
    evidenceModality: 'structured_profile',
    requirementClass: 'context_hard',
    queryHardness: 'required_in_every_query',
    queryable: true,
  };

  const reqSize: ProspectRequirement = {
    id: 'req-size',
    description: '10 to 50 employees',
    sourcePhrase: '10 to 50 employees',
    acceptableTerms: ['10 to 50 employees', '10-50 employees'],
    scope: 'company_size',
    importance: 'hard',
    evidenceModality: 'inferred',
    requirementClass: 'context_hard',
    queryHardness: 'distributed_across_queries',
    queryable: true,
  };

  const mockContract: ProspectContract = {
    version: 1,
    policyVersion: 'evidence-contract-v8',
    brief: 'VP of Sales at B2B SaaS in SF using Snowflake',
    authorityRequired: true,
    exclusions: [],
    identitySpec: { roles: ['VP of Sales'], locations: ['San Francisco'], companyTypes: [], industries: ['B2B SaaS'] },
    requirements: [reqRole, reqLoc, reqIndustry, reqStack, reqSize],
    initialQueries: [],
  };

  const agencyContract: ProspectContract = {
    version: 1,
    policyVersion: 'evidence-contract-v8',
    brief: 'AI agency founder in San Francisco',
    authorityRequired: true,
    exclusions: [],
    identitySpec: { roles: ['founder'], locations: ['San Francisco'], companyTypes: ['AI agency'], industries: [] },
    requirements: [reqRole, reqLoc, reqAgency],
    initialQueries: [],
  };

  describe('Taxonomy Tier Classification', () => {
    it('classifies role / identity_hard as Tier 1 (Immutable Core)', () => {
      assert.strictEqual(classifyAblationTier(reqRole), ABLATION_TIERS.TIER_1_IMMUTABLE_CORE);
    });

    it('classifies company_industry and company_type as Tier 1 (Immutable Core Firmographics)', () => {
      assert.strictEqual(classifyAblationTier(reqIndustry), ABLATION_TIERS.TIER_1_IMMUTABLE_CORE);
      assert.strictEqual(classifyAblationTier(reqAgency), ABLATION_TIERS.TIER_1_IMMUTABLE_CORE);
    });

    it('classifies location as Tier 2 (Location Anchor)', () => {
      assert.strictEqual(classifyAblationTier(reqLoc), ABLATION_TIERS.TIER_2_LOCATION_ANCHOR);
    });

    it('classifies company size as Tier 3 (Domain Qualifier)', () => {
      assert.strictEqual(classifyAblationTier(reqSize), ABLATION_TIERS.TIER_3_DOMAIN_QUALIFIER);
    });

    it('classifies volatile context / tech stack as Tier 4 (Volatile Context)', () => {
      assert.strictEqual(classifyAblationTier(reqStack), ABLATION_TIERS.TIER_4_VOLATILE_CONTEXT);
    });
  });

  describe('Algorithmic Query Relaxation (ablateQueryTask)', () => {
    it('ablates Tier 4 (volatile context / Snowflake) first when present', () => {
      const query = 'VP of Sales B2B SaaS Snowflake San Francisco';
      const result = ablateQueryTask(query, mockContract);
      assert.ok(result);
      assert.strictEqual(result.tier, ABLATION_TIERS.TIER_4_VOLATILE_CONTEXT);
      assert.strictEqual(result.ablatedRequirementId, 'req-stack');
      assert.strictEqual(result.ablatedTerm, 'Snowflake');
      assert.strictEqual(result.ablatedQuery, 'VP of Sales B2B SaaS San Francisco');
    });

    it('ablates Tier 2 (location) when Tier 4 is absent, preserving Tier 1 Immutable Core (B2B SaaS)', () => {
      const query = 'VP of Sales B2B SaaS San Francisco';
      const result = ablateQueryTask(query, mockContract);
      assert.ok(result);
      assert.strictEqual(result.tier, ABLATION_TIERS.TIER_2_LOCATION_ANCHOR);
      assert.strictEqual(result.ablatedRequirementId, 'req-loc');
      assert.strictEqual(result.ablatedTerm, 'San Francisco');
      assert.strictEqual(result.ablatedQuery, 'VP of Sales B2B SaaS');
    });

    it('never ablates Tier 1 Immutable Core (role + core firmographic), returns null when only core terms remain', () => {
      const query = 'VP of Sales B2B SaaS';
      const result = ablateQueryTask(query, mockContract);
      assert.strictEqual(result, null, 'Core vertical B2B SaaS must never be ablated');
    });

    it('never ablates core vertical "AI agency", preventing relaxation into generic plumbers/dentists', () => {
      const query = '"AI agency" founder San Francisco';
      const result = ablateQueryTask(query, agencyContract);
      assert.ok(result);
      assert.strictEqual(result.ablatedQuery, '"AI agency" founder');

      const secondResult = ablateQueryTask('"AI agency" founder', agencyContract);
      assert.strictEqual(secondResult, null, 'Core vertical "AI agency" must NEVER be ablated');
    });

    it('never ablates Tier 1 (identity_hard / role), returns null when only role remains', () => {
      const query = 'VP of Sales';
      const result = ablateQueryTask(query, mockContract);
      assert.strictEqual(result, null, 'Tier 1 identity requirement must never be ablated');
    });

    it('handles terms enclosed in quotes cleanly', () => {
      const query = 'VP of Sales "Snowflake" "San Francisco"';
      const result = ablateQueryTask(query, mockContract);
      assert.ok(result);
      assert.strictEqual(result.ablatedRequirementId, 'req-stack');
      assert.strictEqual(result.ablatedQuery, 'VP of Sales "San Francisco"');
    });

    it('respects coveredRequirementIds filter if provided', () => {
      const query = 'VP of Sales B2B SaaS Snowflake San Francisco';
      // Only req-role and req-loc covered in this task
      const result = ablateQueryTask(query, mockContract, ['req-role', 'req-loc']);
      assert.ok(result);
      assert.strictEqual(result.ablatedRequirementId, 'req-loc');
      assert.strictEqual(result.ablatedQuery, 'VP of Sales B2B SaaS Snowflake');
    });

    it('falls back to non-identity contract requirements if coveredRequirementIds yields no match', () => {
      const query = 'VP of Sales Snowflake San Francisco';
      // planner provided only req-role in coveredRequirementIds, but query has Snowflake
      const result = ablateQueryTask(query, mockContract, ['req-role']);
      assert.ok(result);
      assert.strictEqual(result.ablatedRequirementId, 'req-stack');
      assert.strictEqual(result.ablatedQuery, 'VP of Sales San Francisco');
    });

    it('cleans up orphaned or unbalanced quotes cleanly', () => {
      const query = 'VP of Sales "Snowflake" "San Francisco"';
      const result = ablateQueryTask(query, mockContract);
      assert.ok(result);
      assert.strictEqual(result.ablatedQuery, 'VP of Sales "San Francisco"');
      const quoteCount = (result.ablatedQuery.match(/"/g) || []).length;
      assert.strictEqual(quoteCount % 2, 0);
    });
  });

  describe('Ablation Tracker Budget Safety', () => {
    it('enforces round limits on ablation tasks', () => {
      const tracker = createAblationTracker(2);
      assert.strictEqual(tracker.maxAblatedPerRound, 2);
      assert.strictEqual(tracker.attemptsCount, 0);

      tracker.attemptsCount++;
      tracker.ablatedTasks.add('task-1');
      assert.strictEqual(tracker.attemptsCount, 1);
      assert.ok(tracker.ablatedTasks.has('task-1'));
    });
  });

  describe('Post-Retrieval Verification of Ablated Constraints', () => {
    it('routes candidates with _ablatedRequirementId to needsJudge rather than autoQualified', () => {
      const candidate: FinalistCandidate = {
        candidateId: 'c1',
        lead: {
          id: 'lead-1',
          profile: { fullName: 'Jane Doe', currentTitle: 'VP of Sales', location: 'San Francisco' },
          currentTitle: 'VP of Sales',
          location: 'San Francisco',
          _ablatedRequirementId: 'req-stack',
          _ablatedTerm: 'Snowflake',
        },
        evidence: [{ id: 'e1', text: 'Jane Doe is VP of Sales based in San Francisco.' }],
      };

      const triage = triPartitionCandidatesByEvidence([candidate], mockContract);
      assert.strictEqual(triage.autoQualified.length, 0);
      assert.strictEqual(triage.needsJudge.length, 1);
      assert.strictEqual(triage.needsJudge[0].candidateId, 'c1');
    });
  });
});
