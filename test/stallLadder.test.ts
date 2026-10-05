import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStallLevel,
  buildStallDirectives,
  buildStallGridQueries,
  buildDirectoryDiscoveryQueries,
} from '../server/leadSearch/stallLadder.js';
import { buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.js';

test('computeStallLevel escalates across 0-3 and does not expire', () => {
  // Empty history
  assert.equal(computeStallLevel([]), 0);

  // Round 1 productive (accepted = 3)
  assert.equal(computeStallLevel([{ round: 1, acceptedLeads: 3 }]), 0);

  // Round 2 low yield (accepted = 1)
  assert.equal(computeStallLevel([{ round: 1, acceptedLeads: 3 }, { round: 2, acceptedLeads: 1 }]), 1);

  // Round 3 high duplicate rate (raw 10, unique 5 -> dup rate 50%)
  assert.equal(
    computeStallLevel([
      { round: 1, acceptedLeads: 3 },
      { round: 2, acceptedLeads: 2 },
      { round: 3, acceptedLeads: 2, rawCandidates: 10, uniqueCandidates: 5 },
    ]),
    1,
  );

  // Round 4 zero yield (accepted = 0) -> Level 2
  assert.equal(
    computeStallLevel([
      { round: 1, acceptedLeads: 3 },
      { round: 2, acceptedLeads: 0 },
    ]),
    2,
  );

  // Consecutive zero yield (R2 = 0, R3 = 0) -> Level 3
  assert.equal(
    computeStallLevel([
      { round: 1, acceptedLeads: 3 },
      { round: 2, acceptedLeads: 0 },
      { round: 3, acceptedLeads: 0 },
    ]),
    3,
  );

  // Unbounded: does not expire on R4, R5, R6...
  assert.equal(
    computeStallLevel([
      { round: 1, acceptedLeads: 3 },
      { round: 2, acceptedLeads: 0 },
      { round: 3, acceptedLeads: 0 },
      { round: 4, acceptedLeads: 0 },
      { round: 5, acceptedLeads: 0 },
    ]),
    3,
  );

  // Productive round resets ladder to 0
  assert.equal(
    computeStallLevel([
      { round: 1, acceptedLeads: 3 },
      { round: 2, acceptedLeads: 0 },
      { round: 3, acceptedLeads: 0 },
      { round: 4, acceptedLeads: 4 },
    ]),
    0,
  );
});

test('stall directives and grid queries are strictly industry-agnostic (non-AI brief)', () => {
  const dentalContract = buildDeterministicProspectContract('dental clinic owners in Ohio');

  const { directiveText, effectiveLevel } = buildStallDirectives(2, dentalContract, {
    unvisitedMetros: ['Columbus Ohio', 'Cleveland Ohio', 'Cincinnati Ohio'],
    minedRefinements: ['pediatric dentistry', 'orthodontics'],
  });

  assert.equal(effectiveLevel, 2);
  // Ensure no AI vocabulary was invented
  assert.equal(/\b(ai|artificial intelligence|machine learning|prompt|llm)\b/i.test(directiveText), false);
  assert.ok(directiveText.includes('Columbus Ohio'));

  // Test deterministic grid generation
  const grid = buildStallGridQueries(dentalContract, ['Columbus Ohio', 'Cleveland Ohio'], 1);
  assert.ok(grid.length > 0);
  for (const item of grid) {
    assert.equal(/\b(ai|artificial intelligence|machine learning|prompt|llm)\b/i.test(item.query), false);
    assert.equal(item.lane, 'person');
    assert.equal(item.family, 'local_market');
    assert.equal(item.intent, 'recover_from_low_yield');
  }
});

test('Level 1 skips to Level 2 when contract has only a single role class', () => {
  // Single role contract
  const contract = buildDeterministicProspectContract('dentists in Ohio');
  const result = buildStallDirectives(1, contract, {
    unvisitedMetros: ['Columbus Ohio'],
  });
  // Since there are not multiple distinct role classes to rotate between, effectiveLevel should be 2
  assert.equal(result.effectiveLevel, 2);
});

test('Directory discovery queries generate signal-lane open-web queries', () => {
  const contract = buildDeterministicProspectContract('AI agencies in New Zealand');
  const queries = buildDirectoryDiscoveryQueries(contract, 'New Zealand');

  assert.equal(queries.length, 2);
  assert.equal(queries[0].lane, 'signal');
  assert.equal(queries[0].family, 'company_type');
  assert.equal(queries[0].intent, 'expand_surface_area');
  assert.ok(queries[0].query.includes('New Zealand'));
});

test('multi-round session roundHistory accumulates and triggers Level 3 stall ladder correctly', () => {
  const roundHistory: any[] = [];
  // Round 1 completes with 0 leads
  roundHistory.push({ round: 1, acceptedLeads: 0, viableCandidates: 0 });
  assert.equal(computeStallLevel(roundHistory), 2); // 1 zero round -> level 2

  // Round 2 completes with 0 leads
  roundHistory.push({ round: 2, acceptedLeads: 0, viableCandidates: 0 });
  assert.equal(computeStallLevel(roundHistory), 3); // 2 consecutive zero rounds -> level 3
});

