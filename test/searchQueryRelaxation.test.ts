import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDeterministicProspectContract, buildContractFallbackQueries } from '../server/leadSearch/prospectContract.js';

describe('Search Query Precision & Agency Disambiguation', () => {
  it('applies negative platform disambiguation for agency briefs', () => {
    const contract = buildDeterministicProspectContract('AI agency owner/founder from USA');
    const queries = buildContractFallbackQueries('AI agency owner/founder from USA', contract.requirements);
    
    assert.ok(queries.length >= 2, 'Should generate fallback queries');
    const anyDisambiguated = queries.some(q => q.query.includes('-software') || q.query.includes('-platform') || q.query.includes('-SaaS'));
    assert.ok(anyDisambiguated, 'At least one query variant should attach negative platform filters for agency briefs');
  });

  it('keeps fallback query lengths within safe limits', () => {
    const contract = buildDeterministicProspectContract('AI marketing agency founder in San Francisco California');
    const queries = buildContractFallbackQueries('AI marketing agency founder in San Francisco California', contract.requirements);
    
    for (const q of queries) {
      assert.ok(q.query.length <= 240, `Query length ${q.query.length} exceeds 240 chars: ${q.query}`);
    }
  });
});
