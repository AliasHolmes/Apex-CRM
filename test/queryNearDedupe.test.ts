import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuerySignature,
  isNearDuplicateQuery,
  isSignatureExhausted,
  type QuerySignature,
} from '../server/leadSearch/querySignature.js';

test('buildQuerySignature canonicalizes role class, org container class, and geo anchor', () => {
  const sig1 = buildQuerySignature('founder AI consultancy New Zealand');
  assert.equal(sig1.roleClass, 'founder');
  assert.equal(sig1.orgClass, 'container_org');
  assert.equal(sig1.geoAnchor, 'new zealand');
  assert.deepEqual(sig1.topicTokens, ['ai']);

  const sig2 = buildQuerySignature('founder AI agency NZ');
  assert.equal(sig2.roleClass, 'founder');
  assert.equal(sig2.orgClass, 'container_org');
  assert.equal(sig2.geoAnchor, 'new zealand');
  assert.deepEqual(sig2.topicTokens, ['ai']);

  // Same role class + org class + geo anchor + topics -> Near duplicate!
  assert.ok(isNearDuplicateQuery(sig2, [sig1]));

  // Distinct role class (owner vs founder) -> Not near duplicate!
  const sigOwner = buildQuerySignature('owner AI agency NZ');
  assert.equal(sigOwner.roleClass, 'owner');
  assert.equal(isNearDuplicateQuery(sigOwner, [sig1]), false);
});

test('distinct metros are not considered near-duplicates of country-level or other metro queries', () => {
  const sigCountry = buildQuerySignature('founder AI consultancy New Zealand');
  const sigMetro1 = buildQuerySignature('founder AI consultancy Auckland');
  const sigMetro2 = buildQuerySignature('founder AI consultancy Christchurch');

  assert.equal(sigCountry.geoAnchor, 'new zealand');
  assert.equal(sigMetro1.geoAnchor, 'auckland');
  assert.equal(sigMetro2.geoAnchor, 'christchurch');

  // Different geo anchors must NOT be dropped as duplicates
  assert.equal(isNearDuplicateQuery(sigMetro1, [sigCountry]), false);
  assert.equal(isNearDuplicateQuery(sigMetro2, [sigCountry, sigMetro1]), false);
});

test('distinct role classes or substantive verticals are kept', () => {
  const sigFounder = buildQuerySignature('founder AI agency Auckland');
  const sigDirector = buildQuerySignature('managing director AI agency Auckland');
  assert.equal(sigFounder.roleClass, 'founder');
  assert.equal(sigDirector.roleClass, 'director');
  assert.equal(isNearDuplicateQuery(sigDirector, [sigFounder]), false);
});

test('isSignatureExhausted only blocks when role, org, geo, AND topic overlap', () => {
  const exhausted: QuerySignature[] = [
    {
      roleClass: 'executive',
      orgClass: 'container_org',
      geoAnchor: 'new zealand',
      topicTokens: ['ai'],
    },
  ];

  // Same topic (ai) + same role/org/geo -> exhausted (blocks).
  const sameTopicSig = buildQuerySignature('CEO AI boutique New Zealand');
  assert.equal(sameTopicSig.roleClass, 'executive');
  assert.equal(sameTopicSig.orgClass, 'container_org');
  assert.equal(sameTopicSig.geoAnchor, 'new zealand');
  assert.ok(isSignatureExhausted(sameTopicSig, exhausted), 'same topic should be exhausted');

  // Different topic (machine learning), same role/org/geo -> NOT exhausted.
  // A distinct vertical must not be suppressed as an "exhausted" duplicate.
  const diffTopicSig = buildQuerySignature('CEO machine learning boutique New Zealand');
  assert.equal(diffTopicSig.roleClass, 'executive');
  assert.equal(diffTopicSig.orgClass, 'container_org');
  assert.equal(diffTopicSig.geoAnchor, 'new zealand');
  assert.equal(
    isSignatureExhausted(diffTopicSig, exhausted),
    false,
    'different topic must not be treated as exhausted',
  );
});

test('Session 3 real queries fixture: catches same-geo duplicate variations', () => {
  const history: QuerySignature[] = [];

  const session3Queries = [
    // R1 queries
    'founder AI consultancy New Zealand',
    'CEO AI automation agency New Zealand',
    'director AI consultancy Auckland',
    // R4 repeat variations
    'founder AI agency New Zealand', // Duplicate of founder AI consultancy NZ
    'managing partner AI agency Wellington', // Distinct
    'founder AI consultancy Auckland', // Distinct geo from NZ
    'founder AI agency Auckland', // Duplicate of founder AI consultancy Auckland
  ];

  const results = session3Queries.map((q) => {
    const sig = buildQuerySignature(q);
    const isDup = isNearDuplicateQuery(sig, history);
    if (!isDup) history.push(sig);
    return { query: q, isDup };
  });

  // "founder AI consultancy New Zealand" is accepted
  assert.equal(results[0].isDup, false);
  // "CEO AI automation agency New Zealand" has distinct role executive -> accepted
  assert.equal(results[1].isDup, false);
  // "director AI consultancy Auckland" is accepted (distinct geo Auckland, distinct role director)
  assert.equal(results[2].isDup, false);
  // "founder AI agency New Zealand" is rejected (duplicate of founder AI consultancy NZ)
  assert.equal(results[3].isDup, true);
  // "managing partner AI agency Wellington" is accepted (Wellington)
  assert.equal(results[4].isDup, false);
  // "founder AI consultancy Auckland" is accepted (first founder in Auckland)
  assert.equal(results[5].isDup, false);
  // "founder AI agency Auckland" is rejected (duplicate of founder AI in Auckland)
  assert.equal(results[6].isDup, true);
});
