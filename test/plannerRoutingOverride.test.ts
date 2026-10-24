import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderProvidersForTier,
  computeByesuDynamicTimeoutMs,
} from '../server/services/llm.js';
import { resolvePlannerProviderOrder } from '../server/leadSearch/stages/planStage.js';

test('resolvePlannerProviderOrder defaults to the fast tier order (primary, byesu, openrouter, groq)', () => {
  const originalEnv = process.env.LEAD_PLANNER_PROVIDER_ORDER;
  try {
    delete process.env.LEAD_PLANNER_PROVIDER_ORDER;
    assert.deepEqual(resolvePlannerProviderOrder(), ['primary', 'byesu', 'openrouter', 'groq']);

    process.env.LEAD_PLANNER_PROVIDER_ORDER = 'openrouter, primary';
    assert.deepEqual(resolvePlannerProviderOrder(), ['openrouter', 'primary']);
  } finally {
    if (originalEnv !== undefined) {
      process.env.LEAD_PLANNER_PROVIDER_ORDER = originalEnv;
    } else {
      delete process.env.LEAD_PLANNER_PROVIDER_ORDER;
    }
  }
});

test('orderProvidersForTier prioritizes Byesu (primary) ahead of failsafes when requested', () => {
  const providers = [{ id: 'openrouter' }, { id: 'primary' }, { id: 'groq' }];
  const ordered = orderProvidersForTier(providers, 'fast', ['primary', 'openrouter']);
  assert.equal(ordered[0].id, 'primary');
  assert.equal(ordered[1].id, 'openrouter');
  assert.equal(ordered[2].id, 'groq');
});

test('computeByesuDynamicTimeoutMs honors hardTimeoutMs bypassing the 75s floor', () => {
  const sampleMessages = [{ role: 'user', content: 'Generate search queries for NZ' }];
  // Without hardTimeoutMs, floor is at least 75,000ms
  const defaultTimeout = computeByesuDynamicTimeoutMs(4000, sampleMessages as any, 35_000);
  assert.ok(defaultTimeout >= 75_000, `Expected default >= 75000, got ${defaultTimeout}`);

  // With hardTimeoutMs, returns requested 35,000ms
  const hardTimeout = computeByesuDynamicTimeoutMs(4000, sampleMessages as any, undefined, undefined, 35_000);
  assert.equal(hardTimeout, 35_000);
});
