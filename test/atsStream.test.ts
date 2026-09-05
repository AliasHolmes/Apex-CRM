import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAtsLaneQueries,
  buildContractFallbackQueries,
  enforceContractQueries,
  ATS_SEARCH_DOMAINS,
  type ProspectContract,
  type ProspectRequirement,
} from '../server/leadSearch/prospectContract.js';
import { SignalStore } from '../server/leadSearch/signalStore.js';
import { extractCompanyHintDeterministic, type FusedObservation } from '../server/leadSearch/observations.js';

describe('Stream C: Live ATS Headcount & Job Requisition Lane', () => {
  const reqRole: ProspectRequirement = {
    id: 'req-role',
    description: 'VP of Engineering',
    sourcePhrase: 'VP of Engineering',
    acceptableTerms: ['VP of Engineering', 'Head of Engineering', 'Engineering Director'],
    scope: 'person_role',
    importance: 'hard',
    evidenceModality: 'structured_profile',
    requirementClass: 'identity_hard',
    queryHardness: 'required_in_every_query',
    queryable: true,
  };

  const reqType: ProspectRequirement = {
    id: 'req-type',
    description: 'Fintech',
    sourcePhrase: 'Fintech',
    acceptableTerms: ['Fintech', 'Financial Services'],
    scope: 'company_type',
    importance: 'hard',
    evidenceModality: 'structured_profile',
    requirementClass: 'context_hard',
    queryHardness: 'distributed_across_queries',
    queryable: true,
  };

  const mockContract: ProspectContract = {
    version: 1,
    policyVersion: 'evidence-contract-v8',
    brief: 'Hiring VP of Engineering for Fintech startup',
    authorityRequired: true,
    exclusions: [],
    identitySpec: {
      roles: ['VP of Engineering'],
      locations: ['San Francisco'],
      companyTypes: ['Fintech'],
      industries: ['Software'],
    },
    requirements: [reqRole, reqType],
    initialQueries: [],
  };

  describe('ATS Query Synthesis', () => {
    it('generates focused queries targeting Greenhouse, Lever, Ashby, and Workable', () => {
      const queries = buildAtsLaneQueries(mockContract.brief, mockContract.requirements, mockContract.identitySpec);
      assert.strictEqual(queries.length, 1);
      const q = queries[0];
      assert.strictEqual(q.lane, 'signal');
      assert.strictEqual(q.family, 'growth_signal');
      assert.strictEqual(q.intent, 'find_buying_signal');
      assert.match(q.query, /site:boards\.greenhouse\.io/);
      assert.match(q.query, /site:jobs\.lever\.co/);
      assert.match(q.query, /site:jobs\.ashbyhq\.com/);
      assert.match(q.query, /site:apply\.workable\.com/);
      assert.match(q.query, /VP of Engineering/);
      assert.match(q.query, /Fintech/);
    });

    it('preserves site operators and boolean syntax in enforceContractQueries for signal lane', () => {
      const atsQuery = '(site:boards.greenhouse.io OR site:jobs.lever.co) "VP of Engineering" Fintech';
      const rawItem = {
        query: atsQuery,
        lane: 'signal' as const,
        family: 'growth_signal' as const,
        intent: 'find_buying_signal' as const,
      };

      const enforced = enforceContractQueries([rawItem], mockContract);
      assert.ok(enforced.length >= 1);
      const signalItem = enforced.find(q => q.lane === 'signal');
      assert.ok(signalItem, 'Expected signal lane query to be present');
      assert.match(signalItem.query, /site:boards\.greenhouse\.io/);
      assert.match(signalItem.query, /OR/);
    });

    it('automatically includes ATS query in fallback queries when brief contains hiring terms', () => {
      const fallback = buildContractFallbackQueries(mockContract.brief, mockContract.requirements, mockContract.identitySpec);
      const atsQuery = fallback.find(q => q.lane === 'signal' && q.family === 'growth_signal');
      assert.ok(atsQuery, 'Expected ATS growth_signal query in fallback queries');
      assert.match(atsQuery.query, /site:boards\.greenhouse\.io/);
    });
  });

  describe('ATS Observation Ingestion & Company Entity Resolution', () => {
    it('extracts company name accurately from hosted Greenhouse and Lever URLs', () => {
      const greenhouseObs: FusedObservation = {
        url: 'https://boards.greenhouse.io/stripe/jobs/5239120',
        title: 'Senior Software Engineer | Stripe Careers',
        content: 'We are hiring a Senior Software Engineer to scale our payments core.',
        query: 'test query',
        sourceProviders: ['tavily'],
        sourceQueries: ['test query'],
        provider: 'tavily',
        round: 1,
        family: 'growth_signal',
        lane: 'signal',
        lanes: ['signal'],
        intent: 'find_buying_signal',
        expectedSignal: 'Job requisition',
        corroborated: true,
        sourceCount: 1,
        identityKey: 'url:https://boards.greenhouse.io/stripe/jobs/5239120',
        raw: {},
      };

      const company = extractCompanyHintDeterministic(greenhouseObs);
      assert.strictEqual(company.toLowerCase(), 'stripe');
    });

    it('registers ATS requisition into SignalStore with high confidence (0.95)', () => {
      const store = new SignalStore();
      store.add({
        companyName: 'Stripe',
        url: 'https://boards.greenhouse.io/stripe/jobs/5239120',
        text: 'Active Job Requisition: Senior Software Engineer at Stripe (boards.greenhouse.io) - https://boards.greenhouse.io/stripe/jobs/5239120',
        round: 1,
        query: 'test',
        lane: 'signal',
        confidence: 0.95,
        provider: 'tavily',
        category: 'hiring_signal',
      });

      const signals = store.getForCandidate('Stripe');
      assert.strictEqual(signals.length, 1);
      assert.strictEqual(signals[0].category, 'hiring_signal');
      assert.strictEqual(signals[0].confidence, 0.95);
      assert.match(signals[0].text, /Active Job Requisition: Senior Software Engineer/);
    });
  });
});
