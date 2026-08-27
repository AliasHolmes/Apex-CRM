import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runWithTransientRetry } from '../server/leadSearch/sessionHelpers.js';
import { ProviderTrafficController } from '../server/services/keyRotator.js';

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

  describe('ProviderTrafficController Rate Regulator', () => {
    it('regulates sliding-window request concurrency', () => {
      const controller = new ProviderTrafficController({
        maxRequestsPerMinute: 3,
        maxTokensPerMinute: 10_000
      });

      const now = Date.now();
      assert.equal(controller.canAcquire(500, now), true);
      controller.recordUsage(500, now);
      assert.equal(controller.canAcquire(500, now), true);
      controller.recordUsage(500, now);
      assert.equal(controller.canAcquire(500, now), true);
      controller.recordUsage(500, now);

      // 4th request exceeds limit of 3
      assert.equal(controller.canAcquire(500, now), false);

      // After 61 seconds, capacity recovers
      const later = now + 61_000;
      assert.equal(controller.canAcquire(500, later), true);
    });

    it('regulates sliding-window token throughput', () => {
      const controller = new ProviderTrafficController({
        maxRequestsPerMinute: 10,
        maxTokensPerMinute: 2_000
      });

      const now = Date.now();
      assert.equal(controller.canAcquire(1_200, now), true);
      controller.recordUsage(1_200, now);

      // Attempting 1000 tokens when 1200 / 2000 is used should be blocked
      assert.equal(controller.canAcquire(1_000, now), false);

      // Attempting 500 tokens should be allowed (1200 + 500 <= 2000)
      assert.equal(controller.canAcquire(500, now), true);
    });
  });
});
