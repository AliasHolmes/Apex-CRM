import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCoveredRequirementIds,
  enforceContractQueries,
  normalizeProspectContract,
  type ProspectRequirement,
  type ProspectContract
} from '../server/leadSearch/prospectContract.js';

describe('Coverage Telemetry & Contract Pipeline Integrity', () => {
  const sampleRequirements: ProspectRequirement[] = [
    {
      id: 'person_role-1',
      scope: 'person_role',
      importance: 'hard',
      evidenceModality: 'structured_profile',
      description: 'owner or founder',
      sourcePhrase: 'owner',
      acceptableTerms: ['owner', 'founder', 'ceo'],
      queryable: true
    },
    {
      id: 'person_location-1',
      scope: 'person_location',
      importance: 'hard',
      evidenceModality: 'structured_profile',
      description: 'United States',
      sourcePhrase: 'United States',
      acceptableTerms: ['United States', 'USA', 'US'],
      queryable: true
    },
    {
      id: 'company_type-1',
      scope: 'company_type',
      importance: 'hard',
      evidenceModality: 'structured_profile',
      description: 'marketing agency',
      sourcePhrase: 'marketing agency',
      acceptableTerms: ['marketing agency', 'digital agency', 'agency'],
      queryable: true
    },
    {
      id: 'signal-1',
      scope: 'signal',
      importance: 'soft',
      evidenceModality: 'open_web_signal',
      description: 'hiring for n8n',
      sourcePhrase: 'n8n',
      acceptableTerms: ['n8n', 'workflow automation'],
      queryable: true
    }
  ];

  describe('computeCoveredRequirementIds()', () => {
    it('only claims coverage for requirements whose terms are actually in the query', () => {
      // Query with only role and location terms
      const query1 = 'site:linkedin.com/in/ founder USA';
      const covered1 = computeCoveredRequirementIds(query1, sampleRequirements, false);

      assert.ok(covered1.includes('person_role-1'), 'should cover role');
      assert.ok(covered1.includes('person_location-1'), 'should cover location');
      assert.ok(!covered1.includes('company_type-1'), 'MUST NOT cover company_type when missing from query');
    });

    it('recognizes metro locations as covering the parent country requirement', () => {
      const queryWithMetro = 'site:linkedin.com/in/ "marketing agency" owner "San Francisco"';
      const covered = computeCoveredRequirementIds(queryWithMetro, sampleRequirements, false);

      assert.ok(covered.includes('person_role-1'), 'should cover role (owner)');
      assert.ok(covered.includes('company_type-1'), 'should cover company_type (marketing agency)');
      assert.ok(covered.includes('person_location-1'), 'San Francisco should cover United States requirement via metro mapping');
    });

    it('returns empty coverage array when a query matches none of the hard requirements', () => {
      const unrelatedQuery = 'site:linkedin.com/in/ software developer Germany';
      const covered = computeCoveredRequirementIds(unrelatedQuery, sampleRequirements, false);
      assert.deepEqual(covered, []);
    });

    it('maps signal requirements for signal-lane queries', () => {
      const signalQuery = 'n8n workflow automation hiring OR "looking for"';
      const covered = computeCoveredRequirementIds(signalQuery, sampleRequirements, true);
      assert.ok(covered.includes('signal-1'), 'should cover signal-1 for matching n8n query');
    });
  });

  describe('enforceContractQueries()', () => {
    it('preserves provider-legal search negatives in fallback queries instead of stripping them', () => {
      const baseContract: ProspectContract = {
        version: 1,
        policyVersion: 'evidence-contract-v8',
        brief: 'Digital marketing agency owners in London',
        authorityRequired: true,
        exclusions: ['software', 'SaaS', 'Microsoft', 'Google'],
        requirements: [
          {
            id: 'person_role-1',
            scope: 'person_role',
            importance: 'hard',
            evidenceModality: 'structured_profile',
            description: 'owner',
            sourcePhrase: 'owner',
            acceptableTerms: ['owner', 'founder'],
            queryable: true
          },
          {
            id: 'company_type-1',
            scope: 'company_type',
            importance: 'hard',
            evidenceModality: 'structured_profile',
            description: 'agency',
            sourcePhrase: 'agency',
            acceptableTerms: ['agency', 'consultancy'],
            queryable: true
          }
        ],
        initialQueries: [] // Empty to trigger fallback query generation
      };

      const result = enforceContractQueries([], baseContract);
      assert.ok(result.length >= 4, 'should produce at least 4 queries');

      // Check that agency fallback queries retain -software -platform -SaaS negatives
      const agencyQueriesWithNegatives = result.filter(q =>
        q.query.includes('-software') || q.query.includes('-SaaS') || q.query.includes('-platform')
      );
      assert.ok(
        agencyQueriesWithNegatives.length > 0,
        'Fallback agency queries should preserve -software -platform -SaaS negatives'
      );
    });
  });

  describe('normalizeProspectContract() theme-merge', () => {
    it('merges overflow soft requirements by scope instead of discarding nuance', () => {
      const dummyFallback: ProspectContract = {
        version: 1,
        policyVersion: 'evidence-contract-v8',
        brief: 'Agency owners using n8n',
        authorityRequired: true,
        exclusions: [],
        requirements: [],
        initialQueries: []
      };

      // Raw input with 8 soft signal requirements
      const rawInput = {
        requirements: [
          { scope: 'person_role', importance: 'hard', sourcePhrase: 'owner', acceptableTerms: ['owner'] },
          { scope: 'company_type', importance: 'hard', sourcePhrase: 'agency', acceptableTerms: ['agency'] },
          { scope: 'signal', importance: 'soft', sourcePhrase: 'n8n', acceptableTerms: ['n8n'] },
          { scope: 'signal', importance: 'soft', sourcePhrase: 'zapier', acceptableTerms: ['zapier'] },
          { scope: 'signal', importance: 'soft', sourcePhrase: 'make', acceptableTerms: ['make'] },
          { scope: 'signal', importance: 'soft', sourcePhrase: 'hiring', acceptableTerms: ['hiring'] },
          { scope: 'signal', importance: 'soft', sourcePhrase: 'scaling', acceptableTerms: ['scaling'] },
          { scope: 'signal', importance: 'soft', sourcePhrase: 'bottlenecks', acceptableTerms: ['bottlenecks'] },
          { scope: 'signal', importance: 'soft', sourcePhrase: 'automation', acceptableTerms: ['automation'] },
          { scope: 'signal', importance: 'soft', sourcePhrase: 'api integrations', acceptableTerms: ['api integrations'] },
        ]
      };

      const normalized = normalizeProspectContract(rawInput, 'Agency owners using n8n', dummyFallback);
      const softReqs = normalized.requirements.filter(r => r.importance === 'soft');

      // Soft cap is 7
      assert.ok(softReqs.length <= 7, `Soft requirements should be capped at 7, got ${softReqs.length}`);

      // All acceptable terms from overflow requirements should be merged into existing soft requirements
      const allSoftTerms = softReqs.flatMap(r => r.acceptableTerms);
      assert.ok(allSoftTerms.includes('n8n'), 'should contain n8n');
      assert.ok(allSoftTerms.includes('api integrations') || allSoftTerms.includes('automation'),
        'overflow terms should be merged into existing soft requirements'
      );
    });
  });
});
