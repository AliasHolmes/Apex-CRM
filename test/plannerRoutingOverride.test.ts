import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderProvidersForTier,
  computeByesuDynamicTimeoutMs,
  computeAtriaDynamicTimeoutMs,
} from '../server/services/llm.js';
import { resolvePlannerProviderOrder } from '../server/leadSearch/stages/planStage.js';

test('resolvePlannerProviderOrder defaults to primary (Byesu) first, then atria', () => {
  const originalEnv = process.env.LEAD_PLANNER_PROVIDER_ORDER;
  try {
    delete process.env.LEAD_PLANNER_PROVIDER_ORDER;
    assert.deepEqual(resolvePlannerProviderOrder(), ['primary', 'atria']);

    process.env.LEAD_PLANNER_PROVIDER_ORDER = 'atria, primary';
    assert.deepEqual(resolvePlannerProviderOrder(), ['atria', 'primary']);
  } finally {
    if (originalEnv !== undefined) {
      process.env.LEAD_PLANNER_PROVIDER_ORDER = originalEnv;
    } else {
      delete process.env.LEAD_PLANNER_PROVIDER_ORDER;
    }
  }
});

test('orderProvidersForTier prioritizes Byesu (primary) ahead of Atria when requested', () => {
  const providers = [{ id: 'atria' }, { id: 'primary' }, { id: 'groq' }];
  const ordered = orderProvidersForTier(providers, 'fast', ['primary', 'atria']);
  assert.equal(ordered[0].id, 'primary');
  assert.equal(ordered[1].id, 'atria');
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

test('computeAtriaDynamicTimeoutMs honors hardTimeoutMs bypassing the 120s floor', () => {
  const sampleMessages = [{ role: 'user', content: 'Generate search queries for NZ' }];
  // Without hardTimeoutMs, floor is at least 120,000ms
  const defaultTimeout = computeAtriaDynamicTimeoutMs(4000, sampleMessages as any, 90_000);
  assert.ok(defaultTimeout >= 120_000, `Expected default >= 120000, got ${defaultTimeout}`);

  // With hardTimeoutMs, returns requested 90,000ms
  const hardTimeout = computeAtriaDynamicTimeoutMs(4000, sampleMessages as any, undefined, undefined, 90_000);
  assert.equal(hardTimeout, 90_000);
});
