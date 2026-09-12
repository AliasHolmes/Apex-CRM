import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeterministicProspectContract,
  buildContractFallbackQueries,
} from '../server/leadSearch/prospectContract.js';
import {
  isCircuitBreakingProviderFailure,
  LLMProviderError,
} from '../server/services/llm.js';

describe('Location Expansion & Fallback Query Fixes', () => {
  it('does not contaminate UK brief with Spain, Italy, Switzerland, Germany, France or USA', () => {
    const brief = 'AI business owner, AI service provider and AI agency owner from UK';
    const contract = buildDeterministicProspectContract(brief);
    
    const locReq = contract.requirements.find(r => r.scope === 'person_location');
    assert.ok(locReq, 'Location requirement should exist');
    
    const terms = locReq.acceptableTerms;
    assert.ok(terms.includes('UK') || terms.includes('United Kingdom'));
    assert.ok(terms.includes('London'));
    assert.ok(terms.includes('Manchester'));

    // Critical assertions: substring collision prevention
    // 'manchester' must not trigger 'es' (Spain) or 'ch' (Switzerland)
    // 'britain' must not trigger 'it' (Italy)
    // 'business' must not trigger 'us' (USA) or 'es' (Spain)
    // 'provider' must not trigger 'de' (Germany)
    // 'from' must not trigger 'fr' (France)
    const forbidden = [
      'Spain', 'Spanish', 'Madrid', 'Barcelona', 'Valencia', 'Seville',
      'Italy', 'Italian', 'Milan', 'Rome', 'Turin', 'Bologna',
      'Switzerland', 'Swiss', 'Zurich', 'Geneva', 'Basel', 'Lausanne',
      'Germany', 'German', 'Berlin', 'Munich',
      'France', 'French', 'Paris',
      'USA', 'United States', 'Austin', 'San Francisco', 'New York'
    ];

    for (const term of forbidden) {
      assert.ok(
        !terms.includes(term),
        `acceptableTerms should NOT include '${term}' for a UK-only brief, but got: ${JSON.stringify(terms)}`
      );
    }
  });

  it('buildContractFallbackQueries does not generate queries for foreign countries on a UK brief', () => {
    const brief = 'AI business owner, AI service provider and AI agency owner from UK';
    const contract = buildDeterministicProspectContract(brief);
    const queries = buildContractFallbackQueries(brief, contract.requirements);

    assert.ok(queries.length > 0, 'Should generate fallback queries');
    for (const q of queries) {
      const lower = q.query.toLowerCase();
      assert.ok(!lower.includes('madrid'), `Query '${q.query}' should not mention Madrid`);
      assert.ok(!lower.includes('barcelona'), `Query '${q.query}' should not mention Barcelona`);
      assert.ok(!lower.includes('spain'), `Query '${q.query}' should not mention Spain`);
      assert.ok(!lower.includes('italy'), `Query '${q.query}' should not mention Italy`);
      assert.ok(!lower.includes('milan'), `Query '${q.query}' should not mention Milan`);
    }
  });

  it('legitimate country codes still expand correctly when provided as whole words or tokens', () => {
    const briefSpain = 'AI agency owner in Madrid, ES';
    const contractSpain = buildDeterministicProspectContract(briefSpain);
    const locSpain = contractSpain.requirements.find(r => r.scope === 'person_location');
    assert.ok(locSpain);
    assert.ok(locSpain.acceptableTerms.includes('Spain') || locSpain.acceptableTerms.includes('Madrid'));

    const briefGermany = 'AI consultant in Berlin, DE';
    const contractGermany = buildDeterministicProspectContract(briefGermany);
    const locGermany = contractGermany.requirements.find(r => r.scope === 'person_location');
    assert.ok(locGermany);
    assert.ok(locGermany.acceptableTerms.includes('Germany') || locGermany.acceptableTerms.includes('Berlin'));
  });

  it('isCircuitBreakingProviderFailure treats HTTP 404 model_not_found as circuit-breaking failure', () => {
    const fakeProvider = {
      id: 'primary' as const,
      name: 'Byesu',
      baseUrl: 'https://byesu.com/v1',
      model: 'gpt-5.5',
      apiKey: 'test-key',
    };
    const err404 = new LLMProviderError(fakeProvider, 404, 'Model "gpt-5.5" is not supported by any configured account');
    assert.equal(isCircuitBreakingProviderFailure(err404), true);

    const err500 = new LLMProviderError(fakeProvider, 500, 'Internal Server Error (openai exception)');
    assert.equal(isCircuitBreakingProviderFailure(err500), true);

    const err429 = new LLMProviderError(fakeProvider, 429, 'Rate limit exceeded');
    assert.equal(isCircuitBreakingProviderFailure(err429), false);
  });
});
