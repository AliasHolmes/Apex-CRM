import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readPlanCache,
  writePlanCache,
  clearPlanCache,
  planCacheSize,
} from '../server/leadSearch/planCache.ts';

test('round-trips plan items and expires them after the TTL', () => {
  clearPlanCache();
  const now = Date.now();

  writePlanCache('k1', [{ query: 'a' }, { query: 'b' }], now);
  assert.deepEqual(readPlanCache('k1', now + 60_000), [{ query: 'a' }, { query: 'b' }]);

  // TTL is 6h.
  assert.equal(readPlanCache('k1', now + 7 * 60 * 60 * 1000), null, 'entries must expire');
});

test('ignores empty payloads and evicts beyond the size cap', () => {
  clearPlanCache();
  writePlanCache('empty', []);
  assert.equal(readPlanCache('empty'), null);

  for (let i = 0; i < 80; i++) writePlanCache(`k${i}`, [{ query: `q${i}` }]);
  assert.ok(planCacheSize() <= 64, `cache must stay capped, got ${planCacheSize()}`);
  // The oldest key was evicted; the newest survives.
  assert.equal(readPlanCache('k0'), null);
  assert.deepEqual(readPlanCache('k79'), [{ query: 'q79' }]);
  clearPlanCache();
});

test('different keys never collide', () => {
  clearPlanCache();
  writePlanCache('spec-a', [{ query: 'A' }]);
  writePlanCache('spec-b', [{ query: 'B' }]);
  assert.deepEqual(readPlanCache('spec-a'), [{ query: 'A' }]);
  assert.deepEqual(readPlanCache('spec-b'), [{ query: 'B' }]);
  clearPlanCache();
});
