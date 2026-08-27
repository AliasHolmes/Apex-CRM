import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreAdaptiveArm,
  type AdaptivePerformanceRow
} from '../server/leadSearch/adaptiveScheduler.js';

describe('Phase 5: Class-Aware Adaptive Scheduler', () => {
  const originalEnv = process.env.CLASS_AWARE_SCHEDULER_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLASS_AWARE_SCHEDULER_ENABLED;
    } else {
      process.env.CLASS_AWARE_SCHEDULER_ENABLED = originalEnv;
    }
  });

  const baseRow: AdaptivePerformanceRow = {
    family: 'persona_title',
    lane: 'person',
    provider: 'tavily',
    outcome_runs: 5,
    qualified_candidates: 3,
    returned_candidates: 3,
    rescued_candidates: 0,
    unique_candidates: 10,
    duplicate_candidates: 1,
    provider_units: 5,
    search_latency_ms: 1000,
    identity_pass_count: 5,
    context_pass_count: 4,
    signal_pass_count: 0
  };

  describe('When flag is DISABLED (Standard UCB1 / Thompson Sampling)', () => {
    beforeEach(() => {
      process.env.CLASS_AWARE_SCHEDULER_ENABLED = 'false';
    });

    it('calculates score without class bonus', () => {
      const result = scoreAdaptiveArm(baseRow, 10, 1.25, false);
      assert.ok(result.score > 0);
      assert.equal(result.outcomeRuns, 5);
    });
  });

  describe('When flag is ENABLED (Class-Aware scoring)', () => {
    beforeEach(() => {
      process.env.CLASS_AWARE_SCHEDULER_ENABLED = 'true';
    });

    it('rewards arm with higher class pass counts', () => {
      process.env.CLASS_AWARE_SCHEDULER_ENABLED = 'false';
      const disabledScore = scoreAdaptiveArm(baseRow, 10, 1.25, false);
      
      process.env.CLASS_AWARE_SCHEDULER_ENABLED = 'true';
      const enabledScore = scoreAdaptiveArm(baseRow, 10, 1.25, false);
      
      assert.ok(
        enabledScore.score > disabledScore.score,
        `Enabled score (${enabledScore.score}) should exceed disabled score (${disabledScore.score}) due to class bonus`
      );
    });

    it('handles cold start arms smoothly', () => {
      const coldStart = scoreAdaptiveArm(undefined, 10, 1.25, false);
      assert.equal(coldStart.outcomeRuns, 0);
      assert.equal(coldStart.reason, 'exploration');
      assert.ok(coldStart.score > 0);
    });
  });
});
