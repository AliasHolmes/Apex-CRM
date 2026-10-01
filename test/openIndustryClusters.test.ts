import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveContractDomainCluster, industrySlug } from '../server/leadSearch/adaptiveScheduler.js';
import { buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.js';

test('slugs industries without generic organization words', () => {
  assert.equal(industrySlug('Freight Forwarding Companies'), 'freight_forwarding');
  assert.equal(industrySlug('Oil & Gas firms'), 'oil_gas');
  assert.equal(industrySlug(''), '');
});

test('unknown industries get their own cluster instead of "global"', () => {
  const c = buildDeterministicProspectContract('Owners of freight forwarding companies in Nigeria');
  assert.equal(deriveContractDomainCluster(c, c.brief), 'freight_forwarding');
  assert.equal(deriveContractDomainCluster({ brief: 'x', identitySpec: { industries: ['Commercial Insurance'] } }), 'commercial_insurance');
});

test('known clusters and empty contracts are unchanged', () => {
  assert.equal(deriveContractDomainCluster({ brief: 'Fintech CTOs in London', identitySpec: { industries: ['fintech'] } }), 'b2b_saas');
  assert.equal(deriveContractDomainCluster({ brief: 'Find people' }), 'global');
});
