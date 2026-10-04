import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runWithTransientRetry } from '../server/leadSearch/sessionHelpers.js';

describe('Optimization 5, 6 & 7: Resilience, Jitter & Cache Hygiene', () => {
  const originalJitterEnv = process.env.FULL_JITTER_RETRY_ENABLED;

  afterEach(() => {
    if (originalJitterEnv === undefined) {
      delete process.env.FULL_JITTER_RETRY_ENABLED;
    } else {
      process.env.FULL_JITTER_RETRY_ENABLED = originalJitterEnv;
    }
  });

  describe('runWithTransientRetry with Full Jitter', () => {
    it('retries transient 429 error and succeeds on subsequent attempt', async () => {
      process.env.FULL_JITTER_RETRY_ENABLED = 'true';
      let attempts = 0;
      const delays: number[] = [];

      const result = await runWithTransientRetry(
        async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('429 Too Many Requests: Rate limit exceeded');
          }
          return 'success';
        },
        {
          attempts: 2,
          baseDelayMs: 20,
          onRetry: (_attempt, delayMs) => {
            delays.push(delayMs);
          }
        }
      );

      assert.equal(result, 'success');
      assert.equal(attempts, 2);
      assert.equal(delays.length, 1);
      assert.ok(delays[0] >= 0 && delays[0] <= 40, 'Jitter delay is bounded within exponential window');
    });
  });
});
