import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRY_CANONICAL_MAP } from '../server/leadSearch/prospectContract.js';
import { resolveCountryCode, canonicalCountryLabel } from '../server/leadSearch/geo.js';

test('covers every ISO country while keeping the legacy US/UK labels', () => {
  assert.equal(COUNTRY_CANONICAL_MAP['nigeria'], 'Nigeria');
  assert.equal(COUNTRY_CANONICAL_MAP['united arab emirates'], 'United Arab Emirates');
  assert.equal(COUNTRY_CANONICAL_MAP['uae'], 'United Arab Emirates');
  assert.equal(COUNTRY_CANONICAL_MAP['kenya'], 'Kenya');
  assert.equal(COUNTRY_CANONICAL_MAP['usa'], 'USA');
  assert.equal(COUNTRY_CANONICAL_MAP['united kingdom'], 'UK');
  assert.equal(COUNTRY_CANONICAL_MAP['britain'], 'UK');
  assert.equal(COUNTRY_CANONICAL_MAP['german'], 'Germany');
  assert.equal(COUNTRY_CANONICAL_MAP['netherlands'], 'Netherlands');
  assert.ok(Object.keys(COUNTRY_CANONICAL_MAP).length > 240);
});

test('never treats common short words as countries', () => {
  for (const word of ['in', 'it', 'is', 'no', 'be', 'at', 'me', 'to', 'de']) {
    assert.equal(COUNTRY_CANONICAL_MAP[word], undefined, word);
  }
});

test('resolves names, aliases and demonyms to ISO codes', () => {
  assert.equal(resolveCountryCode('Nigeria'), 'NG');
  assert.equal(resolveCountryCode('South Korea'), 'KR');
  assert.equal(resolveCountryCode('england'), 'GB');
  assert.equal(resolveCountryCode('Atlantis'), null);
  assert.equal(canonicalCountryLabel('U.S.'), 'USA');
});
