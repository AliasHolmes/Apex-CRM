import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Lead } from '../src/types';
import {
  EMPTY_PROSPECT_FILTERS,
  countActiveFilters,
  parseStoredViews,
  serializeViews,
  sortLeads,
  type ProspectView,
} from '../src/lib/prospectViews';
import { describeMatchScore, getMatchScore } from '../src/lib/matchScore';
import { formatRelativeTime } from '../src/lib/relativeTime';

function lead(id: string, overrides: Partial<Lead> & { fullName?: string; company?: string } = {}): Lead {
  const { fullName = id, company = 'Acme', ...rest } = overrides;
  return {
    id,
    stage: 'SCRAPED',
    createdAt: '2026-01-01T00:00:00.000Z',
    profile: { id, fullName, currentCompany: company, currentTitle: 'Founder' } as Lead['profile'],
    ...rest,
  } as Lead;
}

const view: ProspectView = {
  id: 'view-1',
  name: 'High intent',
  filters: { ...EMPTY_PROSPECT_FILTERS, review: 'KEEP', nextAction: 'MESSAGE' },
  sort: { key: 'score', direction: 'desc' },
  density: 'compact',
  hiddenColumns: ['title', 'authority'],
};

describe('saved prospect views', () => {
  it('round-trips through serialize and parse', () => {
    assert.deepEqual(parseStoredViews(serializeViews([view])), [view]);
  });

  it('degrades to no views for missing, corrupt, or foreign data', () => {
    assert.deepEqual(parseStoredViews(null), []);
    assert.deepEqual(parseStoredViews('not json'), []);
    assert.deepEqual(parseStoredViews('{"version":99,"views":[]}'), []);
    assert.deepEqual(parseStoredViews('{"version":1,"views":"nope"}'), []);
    assert.deepEqual(parseStoredViews('[]'), []);
  });

  it('sanitizes unknown filter values, sort keys, and required columns', () => {
    const raw = JSON.stringify({
      version: 1,
      views: [{
        id: 'a',
        name: '  Messy  ',
        filters: { stage: 'NOT_A_STAGE', review: 'KEEP', location: '' },
        sort: { key: 'bogus', direction: 'asc' },
        density: 'huge',
        hiddenColumns: ['contact', 'title', 'title', 'nonsense'],
      }, { id: '', name: 'no id' }, { id: 'a', name: 'duplicate id' }, 7],
    });
    const [parsed, ...rest] = parseStoredViews(raw);
    assert.equal(rest.length, 0);
    assert.equal(parsed.name, 'Messy');
    assert.equal(parsed.filters.stage, 'All');
    assert.equal(parsed.filters.review, 'KEEP');
    assert.equal(parsed.filters.location, 'All');
    assert.equal(parsed.sort, null);
    assert.equal(parsed.density, 'comfortable');
    assert.deepEqual(parsed.hiddenColumns, ['title']);
  });

  it('counts only non-default filters', () => {
    assert.equal(countActiveFilters(EMPTY_PROSPECT_FILTERS), 0);
    assert.equal(countActiveFilters({ ...EMPTY_PROSPECT_FILTERS, search: '  ', stage: 'REPLIED', industry: 'AI' }), 2);
  });
});

describe('sortLeads', () => {
  it('sorts by name in both directions without mutating the input', () => {
    const input = [lead('b', { fullName: 'Bea' }), lead('a', { fullName: 'adam' }), lead('c', { fullName: 'Cy' })];
    assert.deepEqual(sortLeads(input, { key: 'name', direction: 'asc' }).map((item) => item.id), ['a', 'b', 'c']);
    assert.deepEqual(sortLeads(input, { key: 'name', direction: 'desc' }).map((item) => item.id), ['c', 'b', 'a']);
    assert.deepEqual(input.map((item) => item.id), ['b', 'a', 'c']);
  });

  it('keeps unscored prospects last regardless of direction', () => {
    const input = [lead('none'), lead('low', { qualificationScore: 20 }), lead('high', { qualificationScore: 90 })];
    assert.deepEqual(sortLeads(input, { key: 'score', direction: 'desc' }).map((item) => item.id), ['high', 'low', 'none']);
    assert.deepEqual(sortLeads(input, { key: 'score', direction: 'asc' }).map((item) => item.id), ['low', 'high', 'none']);
  });

  it('sorts by added date and is stable for ties', () => {
    const input = [
      lead('x', { createdAt: '2026-02-01T00:00:00.000Z' }),
      lead('y', { createdAt: '2026-01-01T00:00:00.000Z' }),
      lead('z', { createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    assert.deepEqual(sortLeads(input, { key: 'added', direction: 'desc' }).map((item) => item.id), ['x', 'z', 'y']);
  });

  it('returns a copy in original order when there is no sort', () => {
    const input = [lead('b'), lead('a')];
    const output = sortLeads(input, null);
    assert.deepEqual(output.map((item) => item.id), ['b', 'a']);
    assert.notEqual(output, input);
  });
});

describe('match score and relative time helpers', () => {
  it('reads the 0-100 score without rescaling', () => {
    assert.equal(getMatchScore(lead('a', { qualificationScore: 10 })), 10);
    assert.equal(getMatchScore(lead('a')), null);
    assert.equal(getMatchScore(lead('a', { qualificationScore: 250 })), 100);
  });

  it('describes scores in plain language', () => {
    assert.equal(describeMatchScore(85).label, 'Strong match');
    assert.equal(describeMatchScore(65).label, 'Good match');
    assert.equal(describeMatchScore(45).label, 'Possible match');
    assert.equal(describeMatchScore(5).label, 'Weak match');
    assert.equal(describeMatchScore(null).label, 'Not scored yet');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-03-01T12:00:00.000Z');
    assert.equal(formatRelativeTime('2026-03-01T11:59:50.000Z', now), 'just now');
    assert.equal(formatRelativeTime('2026-03-01T11:30:00.000Z', now), '30m ago');
    assert.equal(formatRelativeTime('2026-03-01T06:00:00.000Z', now), '6h ago');
    assert.equal(formatRelativeTime('2026-02-26T12:00:00.000Z', now), '3d ago');
    assert.equal(formatRelativeTime('2025-12-01T12:00:00.000Z', now), '3mo ago');
    assert.equal(formatRelativeTime('garbage', now), '');
  });
});
