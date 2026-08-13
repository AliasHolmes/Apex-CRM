import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  UNIVERSAL_SIGNALS,
  computeSignalFingerprint,
  normalizeDynamicSignals,
  buildFallbackIntentSignals
} from '../server/leadSearch/intentSignals.js';

test('normalizeDynamicSignals cleans, deduplicates, and caps dynamic signals', () => {
  const raw = [
    '  White Label  ',
    'white-label',
    'fulfillment partner',
    'hiring', // universal signal -- should be filtered out
    'a', // too short (< 2 chars) -- should be filtered out
    'this is a very long signal phrase with more than three words' // > 3 words -- should be filtered out
  ];

  const normalized = normalizeDynamicSignals(raw);
  assert.ok(normalized.includes('white label'));
  assert.ok(normalized.includes('fulfillment partner'));
  assert.strictEqual(normalized.includes('hiring'), false);
  assert.strictEqual(normalized.includes('a'), false);
});

test('computeSignalFingerprint produces stable hash for identical signal sets', () => {
  const setA = ['white label', 'fulfillment partner', 'delivery team'];
  const setB = ['delivery team', 'white label', 'fulfillment partner'];

  const fpA = computeSignalFingerprint(setA);
  const fpB = computeSignalFingerprint(setB);

  assert.strictEqual(fpA, fpB);
  assert.notStrictEqual(fpA, 'fallback');
});

test('computeSignalFingerprint produces different hash for different signals', () => {
  const setA = ['white label', 'fulfillment partner'];
  const setB = ['hvac installation', 'service technician'];

  const fpA = computeSignalFingerprint(setA);
  const fpB = computeSignalFingerprint(setB);

  assert.notStrictEqual(fpA, fpB);
});

test('buildFallbackIntentSignals returns universal-only spec', () => {
  const fallback = buildFallbackIntentSignals();
  assert.strictEqual(fallback.version, 1);
  assert.deepStrictEqual(fallback.universal, UNIVERSAL_SIGNALS);
  assert.deepStrictEqual(fallback.dynamic, []);
  assert.strictEqual(fallback.fingerprint, 'fallback');
});
