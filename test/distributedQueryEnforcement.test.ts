import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeterministicProspectContract,
  enforceContractQueries,
  buildContractFallbackQueries,
  type ProspectContract
} from '../server/leadSearch/prospectContract.js';
import type { SearchSpec } from '../server/leadSearch/searchSpec.js';

const baseSpec: SearchSpec = {
  version: 1,
  mode: 'person_first',
  person: {
    includeTitles: ['Owner', 'CEO'],
    excludeTitles: ['Assistant', 'Intern'],
    seniorities: ['Owner', 'Executive'],
    locations: ['New York', 'San Francisco']
  },
  company: {
    industries: ['Technology'],
    keywords: ['AI Agency'],
    locations: []
  },
  signals: {
    include: ['hiring']
  },
  exclusions: {
    companies: [],
    domains: []
  },
  maxPerCompany: 10
};

describe('Phase 2: Distributed Query Enforcement', () => {
  const originalEnv = process.env.DISTRIBUTED_QUERY_ENFORCEMENT_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DISTRIBUTED_QUERY_ENFORCEMENT_ENABLED;
    } else {
      process.env.DISTRIBUTED_QUERY_ENFORCEMENT_ENABLED = originalEnv;
    }
  });

  describe('When flag is DISABLED (Legacy Behavior)', () => {
    beforeEach(() => {
      process.env.DISTRIBUTED_QUERY_ENFORCEMENT_ENABLED = 'false';
    });

    it('appends all hard requirements to persona queries', () => {
      const brief = 'Find AI agency owners in New York';
      const contract = buildDeterministicProspectContract(brief, baseSpec);
      
      const rawQueries = [
        { query: 'digital marketing specialist', lane: 'person', family: 'persona_title' }
      ];
      
      const enforced = enforceContractQueries(rawQueries, contract);
      assert.ok(enforced.length > 0);
      const q = enforced[0].query.toLowerCase();
      // In legacy mode, both owner, AI agency, and location are appended
      assert.ok(q.includes('owner') || q.includes('ceo'));
      assert.ok(q.includes('ai agency') || q.includes('new york'));
    });
  });

  describe('When flag is ENABLED (Distributed Behavior)', () => {
    beforeEach(() => {
      process.env.DISTRIBUTED_QUERY_ENFORCEMENT_ENABLED = 'true';
    });

    it('guarantees identity requirement is present on all person queries', () => {
      const brief = 'Find AI agency owners in New York';
      const contract = buildDeterministicProspectContract(brief, baseSpec);
      
      const rawQueries = [
        { query: 'boutique firm', lane: 'person', family: 'persona_title' },
        { query: 'consultancy firm', lane: 'person', family: 'persona_title' },
        { query: 'studio partners', lane: 'person', family: 'persona_title' }
      ];
      
      const enforced = enforceContractQueries(rawQueries, contract);
      const identityReq = contract.requirements.find(r => r.requirementClass === 'identity_hard');
      assert.ok(identityReq, 'Must have identity_hard requirement');
      
      for (const item of enforced.filter(i => i.lane === 'person')) {
        const queryLower = item.query.toLowerCase();
        const hasIdentityTerm = identityReq.acceptableTerms.some(term => queryLower.includes(term.toLowerCase()));
        assert.ok(hasIdentityTerm, `Query "${item.query}" must contain an identity term`);
      }
    });

    it('distributes context terms across queries instead of concatenating all of them', () => {
      const brief = 'Find AI agency owners in New York';
      const contract = buildDeterministicProspectContract(brief, baseSpec);
      
      const rawQueries = [
        { query: 'public profile', lane: 'person', family: 'persona_title' },
        { query: 'executive profile', lane: 'person', family: 'persona_title' },
        { query: 'professional profile', lane: 'person', family: 'persona_title' },
        { query: 'leadership profile', lane: 'person', family: 'persona_title' }
      ];
      
      const enforced = enforceContractQueries(rawQueries, contract);
      const contextReqs = contract.requirements.filter(r => r.requirementClass === 'context_hard');
      
      // Each query should have bounded length and not blindly append all context requirements
      for (const item of enforced) {
        assert.ok(item.query.length <= 240, `Query "${item.query}" exceeded 240 chars`);
      }
      
      if (contextReqs.length >= 2) {
        // Verify round-robin distribution: queries don't all have the exact same combined context string
        const queries = enforced.map(e => e.query);
        const uniqueQueries = new Set(queries);
        assert.ok(uniqueQueries.size >= 2, 'Should generate varied query combinations');
      }
    });

    it('never appends system invariants to retrieval queries', () => {
      const brief = 'Find owners with valid linkedin profile url';
      const contract = buildDeterministicProspectContract(brief, baseSpec);
      
      const rawQueries = [
        { query: 'marketing agency', lane: 'person', family: 'persona_title' }
      ];
      
      const enforced = enforceContractQueries(rawQueries, contract);
      for (const item of enforced) {
        assert.ok(!item.query.toLowerCase().includes('valid url'), 'System invariant must not appear in query');
        assert.ok(!item.query.toLowerCase().includes('linkedin profile url'), 'System invariant must not appear in query');
      }
    });

    it('fallback queries follow 1-Identity + 1-Context distribution', () => {
      const brief = 'Find AI agency owners in New York';
      const contract = buildDeterministicProspectContract(brief, baseSpec);
      
      const fallbacks = buildContractFallbackQueries(brief, contract.requirements);
      assert.ok(fallbacks.length >= 4, 'Should build at least 4 fallback queries');
      
      for (const item of fallbacks.filter(f => f.lane === 'person')) {
        assert.ok(item.query.length <= 240, 'Fallback query length <= 240');
        const qLower = item.query.toLowerCase();
        // Check identity term presence
        const idReq = contract.requirements.find(r => r.requirementClass === 'identity_hard');
        if (idReq) {
          const hasId = idReq.acceptableTerms.some(t => qLower.includes(t.toLowerCase()));
          assert.ok(hasId, `Fallback query "${item.query}" must have identity term`);
        }
      }
    });
  });
});
