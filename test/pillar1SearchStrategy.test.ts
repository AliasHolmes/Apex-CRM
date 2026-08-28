import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveDomainCluster,
  adaptiveScopeKey,
  scheduleAdaptiveRetrievalTasks,
  scoreAdaptiveArm
} from '../server/leadSearch/adaptiveScheduler.ts';
import {
  buildRoundDiagnostics
} from '../server/leadSearch/roundDiagnostics.ts';
import {
  buildRecoveryQueryPrompt,
  type ProspectContract
} from '../server/leadSearch/prospectContract.ts';
import type { RetrievalTask } from '../server/leadSearch/searchSpec.ts';

const mockTask = (
  query: string,
  family: RetrievalTask['family'],
  lane: RetrievalTask['lane'],
  providerPreference: RetrievalTask['providerPreference'],
  priority: number,
  domainCluster = 'global'
): RetrievalTask => ({
  id: query,
  query,
  family,
  lane,
  providerPreference,
  priority,
  domainCluster,
  tavily: {
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 10,
    minimumScore: 0.35
  }
});

describe('Pillar 1: Search Strategy & Multi-Armed Bandit Intelligence', () => {
  describe('Domain Clustering (deriveDomainCluster)', () => {
    it('correctly classifies agency and lead-gen briefs', () => {
      assert.equal(deriveDomainCluster('B2B lead gen agency founders in London'), 'b2b_agency');
      assert.equal(deriveDomainCluster('Creative digital marketing agency Austin'), 'b2b_agency');
    });

    it('correctly classifies SaaS and software platform briefs', () => {
      assert.equal(deriveDomainCluster('B2B SaaS founders and VP of Sales'), 'b2b_saas');
      assert.equal(deriveDomainCluster('Fintech software platform CTOs'), 'b2b_saas');
    });

    it('correctly classifies coaching and consulting briefs', () => {
      assert.equal(deriveDomainCluster('Executive coach and leadership mastermind'), 'executive_coaching');
      assert.equal(deriveDomainCluster('Boutique management consulting partners'), 'executive_coaching');
    });

    it('correctly classifies local services and healthcare', () => {
      assert.equal(deriveDomainCluster('Dental clinic practice owner Chicago'), 'local_services');
      assert.equal(deriveDomainCluster('Biotech and pharma clinical directors'), 'healthcare_life_sciences');
    });

    it('falls back to global for ambiguous or empty briefs', () => {
      assert.equal(deriveDomainCluster(''), 'global');
      assert.equal(deriveDomainCluster('High growth enterprise leaders'), 'global');
    });
  });

  describe('Adaptive Scope Key with Domain Clustering', () => {
    it('formats scope keys with domain cluster prefix for non-global domains', () => {
      const taskAgency = mockTask('agency query', 'persona_title', 'person', 'tavily', 1, 'b2b_agency');
      assert.equal(adaptiveScopeKey(taskAgency), 'b2b_agency|persona_title|person|tavily');

      const taskGlobal = mockTask('global query', 'persona_title', 'person', 'tavily', 1, 'global');
      assert.equal(adaptiveScopeKey(taskGlobal), 'persona_title|person|tavily');
    });

    it('falls back to global performance rows when domain cluster row has no history', () => {
      const tasks = [
        mockTask('agency query 1', 'persona_title', 'person', 'tavily', 1, 'b2b_agency'),
        mockTask('agency query 2', 'local_market', 'account', 'brightdata', 2, 'b2b_agency'),
      ];

      const globalRows = [
        { family: 'persona_title', lane: 'person', provider: 'tavily', outcome_runs: 10, qualified_candidates: 8, returned_candidates: 8 },
        { family: 'local_market', lane: 'account', provider: 'brightdata', outcome_runs: 10, qualified_candidates: 0, returned_candidates: 0, provider_units: 10 }
      ];

      const schedule = scheduleAdaptiveRetrievalTasks(tasks, globalRows as any, { maxTasks: 1, minOutcomeRuns: 5 });
      assert.equal(schedule.active, true);
      assert.equal(schedule.tasks[0].query, 'agency query 1');
    });
  });

  describe('Round Diagnostics Enriched Attribute Tracking', () => {
    const mockContract: ProspectContract = {
      version: 1,
      brief: 'London agency owners',
      requirements: [
        {
          id: 'req_role',
          description: 'Agency owner or founder',
          scope: 'person_role',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          sourcePhrase: 'agency owner',
          queryable: true,
          acceptableTerms: ['founder', 'owner', 'ceo']
        },
        {
          id: 'req_loc',
          description: 'Located in London',
          scope: 'person_location',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          sourcePhrase: 'London',
          queryable: true,
          acceptableTerms: ['london', 'uk']
        }
      ],
      exclusions: []
    } as unknown as ProspectContract;

    it('tracks observed non-matching locations and candidate titles to guide recovery', () => {
      const leads = [
        { fullName: 'Alice Smith', currentTitle: 'VP Marketing', location: 'New York, USA' },
        { fullName: 'Bob Jones', currentTitle: 'Senior Recruiter', location: 'San Francisco, CA' },
        { fullName: 'Charlie Brown', currentTitle: 'Owner', location: 'Manchester, UK' }
      ];

      const diag = buildRoundDiagnostics({
        round: 1,
        rawCandidates: 20,
        extractedCandidates: 3,
        leads,
        contract: mockContract,
        targetLimit: 10
      });

      assert.equal(diag.shouldRecover, true);
      assert.ok(diag.observedNonMatchingAttributes?.locations?.includes('New York, USA'));
      assert.ok(diag.observedNonMatchingAttributes?.locations?.includes('San Francisco, CA'));
      assert.ok(diag.observedNonMatchingAttributes?.roles?.includes('VP Marketing'));
      assert.ok(diag.observedNonMatchingAttributes?.roles?.includes('Senior Recruiter'));
    });
  });

  describe('Recovery Query Prompt with Semantic Guidance', () => {
    const mockContract = {
      version: 1,
      brief: 'Dental clinic owners in Austin',
      requirements: [
        {
          id: 'req_role',
          description: 'Practice owner or dentist',
          scope: 'person_role',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          sourcePhrase: 'dentist',
          queryable: true,
          acceptableTerms: ['dentist', 'practice owner']
        }
      ],
      exclusions: []
    } as unknown as ProspectContract;

    it('injects bottleneck guidance and observed non-matching context into recovery prompt', () => {
      const prompt = buildRecoveryQueryPrompt(mockContract, {
        missingHardRequirementIds: ['req_role'],
        viableCandidates: 0,
        classSummary: { bottleneckClass: 'identity_hard' },
        observedNonMatchingAttributes: {
          roles: ['Dental Assistant', 'Office Coordinator'],
          locations: ['Dallas, TX']
        }
      });

      assert.ok(prompt.includes('Identity Hard (Role/Seniority)'));
      assert.ok(prompt.includes('Dental Assistant'));
      assert.ok(prompt.includes('Dallas, TX'));
      assert.ok(prompt.includes('semantic synonyms'));
    });
  });
});
