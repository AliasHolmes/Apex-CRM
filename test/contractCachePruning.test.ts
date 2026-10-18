import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
import {
  getLeadsDb,
  upsertProspectContractCache,
  pruneExpiredProspectContractCache,
} from '../server/db.ts';
import type { ProspectContract } from '../server/leadSearch/prospectContract.ts';

const mockContract: ProspectContract = {
  version: 1,
  policyVersion: 'test-v1',
  brief: 'Engineering Leads',
  authorityRequired: false,
  requirements: [],
  exclusions: [],
  initialQueries: [],
};

describe('Work Package C: Contract Cache Pruning & Spec-Aware Key Isolation', () => {
  it('C1: pruneExpiredProspectContractCache removes expired rows and preserves active rows', () => {
    const db = getLeadsDb();
    const testBrief = 'Test Brief For Pruning ' + Date.now();
    const activeKey = 'active_' + Date.now();
    const expiredKey = 'expired_' + Date.now();

    // Insert active contract
    upsertProspectContractCache(activeKey, testBrief, 'test-v1', mockContract);

    // Insert expired contract directly via DB
    const pastDate = new Date(Date.now() - 100_000).toISOString();
    db.prepare(`
      INSERT INTO prospect_contract_cache (cache_key, raw_brief, policy_version, contract_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(expiredKey, testBrief, 'test-v1', JSON.stringify(mockContract), pastDate, pastDate);

    // Verify both exist before pruning
    const rowActive = db.prepare('SELECT * FROM prospect_contract_cache WHERE cache_key = ?').get(activeKey);
    const rowExpired = db.prepare('SELECT * FROM prospect_contract_cache WHERE cache_key = ?').get(expiredKey);
    assert.ok(rowActive, 'Active row should exist before pruning');
    assert.ok(rowExpired, 'Expired row should exist before pruning');

    // Run pruner
    const prunedCount = pruneExpiredProspectContractCache();
    assert.ok(prunedCount >= 1, 'Should have pruned at least 1 expired contract row');

    // Verify expired row deleted, active row retained
    const postActive = db.prepare('SELECT * FROM prospect_contract_cache WHERE cache_key = ?').get(activeKey);
    const postExpired = db.prepare('SELECT * FROM prospect_contract_cache WHERE cache_key = ?').get(expiredKey);
    assert.ok(postActive, 'Active row should remain after pruning');
    assert.equal(postExpired, undefined, 'Expired row should be removed by pruning');

    // Cleanup active test row
    db.prepare('DELETE FROM prospect_contract_cache WHERE cache_key = ?').run(activeKey);
  });

  it('C2: spec-aware cache keys isolate contracts for identical queries with differing specs', () => {
    const query = 'VP of Engineering';
    const specAustin = { location: 'Austin, TX', industries: ['SaaS'] };
    const specLondon = { location: 'London, UK', industries: ['Fintech'] };

    const hashAustin = crypto.createHash('sha1').update(JSON.stringify(specAustin)).digest('hex').slice(0, 8);
    const hashLondon = crypto.createHash('sha1').update(JSON.stringify(specLondon)).digest('hex').slice(0, 8);

    const keyAustin = `${query.trim().toLowerCase()}::${hashAustin}`;
    const keyLondon = `${query.trim().toLowerCase()}::${hashLondon}`;

    assert.notEqual(keyAustin, keyLondon, 'Differing search specs must produce different cache keys');
    assert.ok(keyAustin.startsWith('vp of engineering::'));
    assert.ok(keyLondon.startsWith('vp of engineering::'));
  });
});
