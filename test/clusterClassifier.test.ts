import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDomainCluster } from '../server/leadSearch/adaptiveScheduler.js';
import {
  BUSINESS_ARCHETYPES,
  resolveBusinessArchetype
} from '../server/leadSearch/prospectContract.js';

describe('Scored Domain Cluster Classifier', () => {
  it('returns global for empty, null, or whitespace briefs', () => {
    assert.equal(deriveDomainCluster(''), 'global');
    assert.equal(deriveDomainCluster('   '), 'global');
    assert.equal(deriveDomainCluster(null as any), 'global');
    assert.equal(deriveDomainCluster(undefined as any), 'global');
  });

  it('correctly classifies each of the 8 domain clusters from unambiguous briefs', () => {
    assert.equal(deriveDomainCluster('digital marketing agency owners in London'), 'b2b_agency');
    assert.equal(deriveDomainCluster('executive coaches and leadership mentors in New York'), 'executive_coaching');
    assert.equal(deriveDomainCluster('B2B SaaS founders building cloud platforms and APIs'), 'b2b_saas');
    assert.equal(deriveDomainCluster('dental clinic owners and roofing contractors in Texas'), 'local_services');
    assert.equal(deriveDomainCluster('Shopify DTC ecommerce brand founders selling apparel'), 'ecommerce_retail');
    assert.equal(deriveDomainCluster('biotech clinical hospital directors and medical doctors'), 'healthcare_life_sciences');
    assert.equal(deriveDomainCluster('managing partners at corporate law firms and CPA tax firms'), 'professional_services');
    assert.equal(deriveDomainCluster('manufacturing plant managers and industrial fabrication factories'), 'manufacturing_industrial');
  });

  it('uses scored max-match to correctly resolve multi-signal briefs', () => {
    const coachingAgencyBrief = 'Executive coach running a leadership coaching agency for founders';
    assert.equal(deriveDomainCluster(coachingAgencyBrief), 'executive_coaching');

    const ecommerceBrief = 'Shopify ecommerce brand founders on a cloud platform';
    assert.equal(deriveDomainCluster(ecommerceBrief), 'ecommerce_retail');

    const agencyApisBrief = 'Agency owners in North America building custom n8n workflows and API integrations';
    assert.equal(deriveDomainCluster(agencyApisBrief), 'b2b_agency');
  });

  it('returns global when no known vertical keywords match', () => {
    assert.equal(deriveDomainCluster('people who love astronomy and stargazing'), 'global');
  });

  describe('resolveBusinessArchetype()', () => {
    it('resolves archetype for executive_coaching', () => {
      const arch = resolveBusinessArchetype('executive coaching for CEOs');
      assert.ok(arch, 'executive_coaching archetype should be resolved');
      assert.equal(arch.id, 'executive_coaching');
      assert.equal(arch.domainCluster, 'executive_coaching');
      assert.ok(arch.defaultRoles.includes('coach'));
      assert.ok(arch.defaultRoles.includes('executive coach'));
      assert.ok(arch.exclusions.includes('life coach'));
      assert.ok(arch.exclusions.includes('therapy'));
    });

    it('resolves archetype for ecommerce_retail', () => {
      const arch = resolveBusinessArchetype('Shopify store owners and DTC brand founders');
      assert.ok(arch, 'ecommerce_retail archetype should be resolved');
      assert.equal(arch.id, 'ecommerce_retail');
      assert.equal(arch.domainCluster, 'ecommerce_retail');
      assert.ok(arch.defaultRoles.includes('founder'));
      assert.ok(arch.companyTypeExpansions.includes('Shopify store'));
      assert.ok(arch.exclusions.includes('Amazon employee'));
    });

    it('resolves archetype for all 8 defined business clusters', () => {
      const allClusterIds = [
        'b2b_agency',
        'executive_coaching',
        'b2b_saas',
        'local_services',
        'ecommerce_retail',
        'healthcare_life_sciences',
        'professional_services',
        'manufacturing_industrial'
      ];
      for (const id of allClusterIds) {
        assert.ok(BUSINESS_ARCHETYPES[id], `BUSINESS_ARCHETYPES must define ${id}`);
        assert.equal(BUSINESS_ARCHETYPES[id].id, id);
        assert.ok(BUSINESS_ARCHETYPES[id].defaultRoles.length > 0);
        assert.ok(BUSINESS_ARCHETYPES[id].companyTypeExpansions.length > 0);
        assert.ok(BUSINESS_ARCHETYPES[id].exclusions.length > 0);
      }
    });
  });
});
