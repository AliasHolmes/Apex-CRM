import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getHashForLead,
  getHashForTab,
  getLeadIdFromHash,
  getTabFromHash,
} from '../src/lib/navigation';

describe('lead drawer deep links', () => {
  it('round-trips a lead id on top of a tab', () => {
    const hash = getHashForLead('inventory', 'lead-123');
    assert.equal(hash, '#prospects/lead-123');
    assert.equal(getTabFromHash(hash), 'inventory');
    assert.equal(getLeadIdFromHash(hash), 'lead-123');
  });

  it('encodes ids that contain reserved characters', () => {
    const hash = getHashForLead('pipeline', 'a/b c#d');
    assert.equal(getTabFromHash(hash), 'pipeline');
    assert.equal(getLeadIdFromHash(hash), 'a/b c#d');
  });

  it('has no lead id for plain tab hashes', () => {
    assert.equal(getLeadIdFromHash(getHashForTab('overview')), null);
    assert.equal(getLeadIdFromHash(''), null);
    assert.equal(getLeadIdFromHash('#prospects/'), null);
  });

  it('keeps legacy and unknown tab hashes working with a lead segment', () => {
    assert.equal(getTabFromHash('#workspace/lead-1'), 'workspace');
    assert.equal(getTabFromHash('#nope/lead-1'), 'overview');
  });

  it('ignores malformed percent-encoding instead of throwing', () => {
    assert.equal(getLeadIdFromHash('#prospects/%E0%A4%A'), null);
    assert.equal(getTabFromHash('#prospects/%E0%A4%A'), 'inventory');
  });
});
