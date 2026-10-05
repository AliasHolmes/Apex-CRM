import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Lead } from '../src/types';
import {
  bucketAddsByDay,
  countStrongMatches,
  countTodayItems,
  weekOverWeek,
} from '../src/lib/overviewStats';

const NOW = new Date(2026, 5, 15, 14, 30).getTime();

function daysAgo(days: number, hour = 9): string {
  const date = new Date(NOW);
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function lead(id: string, overrides: Partial<Lead> = {}): Lead {
  return {
    id,
    stage: 'SCRAPED',
    createdAt: daysAgo(0),
    profile: { id, fullName: id } as Lead['profile'],
    ...overrides,
  } as Lead;
}

describe('overview stats', () => {
  it('buckets additions per calendar day, oldest first', () => {
    const leads = [lead('a', { createdAt: daysAgo(0) }), lead('b', { createdAt: daysAgo(0, 1) }), lead('c', { createdAt: daysAgo(2) }), lead('old', { createdAt: daysAgo(40) })];
    const buckets = bucketAddsByDay(leads, 14, NOW);
    assert.equal(buckets.length, 14);
    assert.equal(buckets[13], 2);
    assert.equal(buckets[11], 1);
    assert.equal(buckets.reduce((sum, count) => sum + count, 0), 3);
  });

  it('ignores prospects with unparseable or future dates', () => {
    const buckets = bucketAddsByDay([lead('bad', { createdAt: 'nope' }), lead('future', { createdAt: daysAgo(-3) })], 7, NOW);
    assert.deepEqual(buckets, [0, 0, 0, 0, 0, 0, 0]);
  });

  it('compares this week with the previous week', () => {
    const leads = [
      lead('a', { createdAt: daysAgo(1) }), lead('b', { createdAt: daysAgo(3) }), lead('c', { createdAt: daysAgo(5) }), lead('d', { createdAt: daysAgo(6) }),
      lead('e', { createdAt: daysAgo(9) }), lead('f', { createdAt: daysAgo(12) }),
    ];
    assert.deepEqual(weekOverWeek(leads, NOW), { thisWeek: 4, previousWeek: 2, changePercent: 100 });
  });

  it('has no percent change without a baseline', () => {
    assert.equal(weekOverWeek([lead('a')], NOW).changePercent, null);
  });

  it('counts the "today" shortcuts', () => {
    const leads = [
      lead('hot', { postIntentEvidence: { quality: 'strong' } as Lead['postIntentEvidence'], nextAction: 'MESSAGE', reviewStatus: 'KEEP' }),
      lead('weak', { postIntentEvidence: { quality: 'none' } as Lead['postIntentEvidence'], nextAction: 'CONNECT' }),
      lead('plain'),
    ];
    assert.deepEqual(countTodayItems(leads), { whyNow: 1, unreviewed: 2, readyToMessage: 1, readyToConnect: 1 });
  });

  it('counts strong matches on the 0-100 scale', () => {
    const leads = [lead('a', { qualificationScore: 95 }), lead('b', { qualificationScore: 79 }), lead('c')];
    assert.equal(countStrongMatches(leads), 1);
    assert.equal(countStrongMatches(leads, 70), 2);
    assert.equal(countStrongMatches(leads, 50), 2);
  });
});
