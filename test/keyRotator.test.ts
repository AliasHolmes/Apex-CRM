import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiKeyPool, KeyRotationError, executeWithKeyRotation, parseApiKeys } from '../server/services/keyRotator.js';

test('parseApiKeys merges plural and singular sources with stable deduplication', () => {
  assert.deepEqual(parseApiKeys('["a", "b", "a", " "]', ['fallback']), ['a', 'b', 'fallback']);
  assert.deepEqual(parseApiKeys(' a, b, a ,, ', ['fallback', 'b']), ['a', 'b', 'fallback']);
  assert.deepEqual(parseApiKeys('', [' fallback-1, fallback-2 ', 'fallback-1']), ['fallback-1', 'fallback-2']);
});

test('executeWithKeyRotation exhausts quota failures, rate-limits 429s, and succeeds on the next key', async () => {
  const pool = new ApiKeyPool('Mock', () => ['key1', 'key2', 'key3']);
  const attempts: string[] = [];

  const result = await executeWithKeyRotation(pool, async (key) => {
    attempts.push(key);
    if (key === 'key1') throw new KeyRotationError('payment required', { statusCode: 402, responseText: 'credits exhausted' });
    if (key === 'key2') throw new KeyRotationError('too many requests', { statusCode: 429, retryAfterMs: 120_000 });
    return { ok: true, key };
  });

  assert.deepEqual(result, { ok: true, key: 'key3' });
  assert.deepEqual(attempts, ['key1', 'key2', 'key3']);

  const status = pool.getStatus();
  assert.equal(status.keys[0].status, 'exhausted');
  assert.equal(status.keys[1].status, 'rate_limited');
  assert.equal(status.keys[1].cooldownMsRemaining > 0, true);
  assert.equal(status.keys[2].status, 'active');
});

test('request-shape failures do not burn through the pool', async () => {
  const pool = new ApiKeyPool('Mock', () => ['key1', 'key2']);
  const attempts: string[] = [];

  await assert.rejects(
    executeWithKeyRotation(pool, async (key) => {
      attempts.push(key);
      throw new KeyRotationError('bad request', { statusCode: 400, responseText: 'validation failed' });
    }),
    /bad request/
  );

  assert.deepEqual(attempts, ['key1']);
  const status = pool.getStatus();
  assert.equal(status.keys[0].status, 'active');
  assert.equal(status.keys[1].status, 'active');
});

test('three transient failures place a key on transient cooldown', async () => {
  const pool = new ApiKeyPool('Mock', () => ['key1']);

  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      executeWithKeyRotation(pool, async () => {
        throw new KeyRotationError('gateway unavailable', { statusCode: 503 });
      }),
      /gateway unavailable|All configured Mock API keys failed/
    );
  }

  const [key] = pool.getStatus().keys;
  assert.equal(key.status, 'transient_cooldown');
  assert.equal(key.consecutiveTransientFailures, 3);
  assert.equal(key.cooldownMsRemaining > 0, true);
});

test('status summaries do not expose raw key values', async () => {
  const secret = 'super-secret-api-key';
  const pool = new ApiKeyPool('Mock', () => [secret]);
  const status = pool.getStatus();
  const serialized = JSON.stringify(status);

  assert.equal(serialized.includes(secret), false);
  assert.equal(status.keys[0].label, 'key_1');
  assert.equal(status.keys[0].fingerprint.length, 8);
});
