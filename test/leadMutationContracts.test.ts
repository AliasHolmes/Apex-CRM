import assert from 'node:assert/strict';
import test from 'node:test';

import { preferNewerCanonical, rebaseLeadChanges } from '../src/lib/leadMutations';
import type { Lead } from '../src/types';

const makeLead = (overrides: Partial<Lead> = {}): Lead => ({
  id: 'lead-contract',
  profile: {
    id: 'profile-contract',
    fullName: 'Contract Test',
    currentCompany: 'Apex',
    contactDetails: {},
  },
  stage: 'SCRAPED',
  notes: 'Initial note',
  tags: ['Initial'],
  createdAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
  ...overrides,
});

test('queued stage delta preserves newer enrichment fields', () => {
  const baseline = makeLead();
  const desired = { ...baseline, stage: 'ENRICHED' as const };
  const canonical = makeLead({
    revision: 3,
    profile: {
      ...baseline.profile,
      contactDetails: { email: 'verified@example.com' },
    },
    reviewStatus: 'KEEP',
    nextAction: 'MESSAGE',
  });

  const rebased = rebaseLeadChanges(canonical, desired, baseline);
  assert.equal(rebased.stage, 'ENRICHED');
  assert.equal(rebased.profile.contactDetails?.email, 'verified@example.com');
  assert.equal(rebased.reviewStatus, 'KEEP');
  assert.equal(rebased.nextAction, 'MESSAGE');
  assert.equal(rebased.revision, 3);
});

test('queued note delta preserves a previously confirmed stage change', () => {
  const baseline = makeLead({ stage: 'ENRICHED' });
  const desired = { ...baseline, notes: 'Updated note' };
  const canonical = makeLead({ stage: 'SEQUENCE ACTIVE', revision: 4 });

  const rebased = rebaseLeadChanges(canonical, desired, baseline);
  assert.equal(rebased.notes, 'Updated note');
  assert.equal(rebased.stage, 'SEQUENCE ACTIVE');
  assert.equal(rebased.revision, 4);
});

test('out-of-order canonical responses never replace a newer revision', () => {
  const delayed = makeLead({ revision: 2, stage: 'ENRICHED' });
  const newer = makeLead({ revision: 3, stage: 'ENRICHED', notes: 'Provider result' });
  assert.equal(preferNewerCanonical(delayed, newer), newer);
  assert.equal(preferNewerCanonical(newer, delayed), newer);
});
