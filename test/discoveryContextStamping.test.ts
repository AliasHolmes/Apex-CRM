import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCandidateToPersistedLead, stampDiscoveryContext } from '../server/leadSearch/leadMapping.js';

test('stamps fingerprint and cluster so the scope key carries the cluster', () => {
  const lead: any = { fullName: 'Jane Doe', discoveryFamily: 'role', discoveryLane: 'person', sourceProvider: 'tavily' };
  stampDiscoveryContext([lead], { requirementsFingerprint: 'fp-123', domainCluster: 'b2b_agency' });
  const mapped = mapCandidateToPersistedLead(lead, 'lead-1');
  assert.equal(mapped.discoveryRequirementsFingerprint, 'fp-123');
  assert.equal(mapped.domainCluster, 'b2b_agency');
  assert.ok(String(mapped.discoveryScopeKey).startsWith('b2b_agency|'), mapped.discoveryScopeKey);
});

test('keeps an existing specific cluster and fingerprint', () => {
  const lead: any = { domainCluster: 'b2b_saas', discoveryRequirementsFingerprint: 'fp-old' };
  stampDiscoveryContext([lead], { requirementsFingerprint: 'fp-new', domainCluster: 'b2b_agency' });
  assert.equal(lead.domainCluster, 'b2b_saas');
  assert.equal(lead.discoveryRequirementsFingerprint, 'fp-old');
});
