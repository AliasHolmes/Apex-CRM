import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeterministicProspectContract, isAuthorityRelevant } from '../server/leadSearch/prospectContract.js';
import { computeScoreBreakdown } from '../server/leadSearch/scoring.js';

test('authority matters only for briefs that ask for it', () => {
  assert.equal(isAuthorityRelevant(buildDeterministicProspectContract('Senior software engineers at fintech startups in Singapore')), false);
  assert.equal(isAuthorityRelevant(buildDeterministicProspectContract('Procurement directors at hospitals in Germany')), true);
  assert.equal(isAuthorityRelevant(undefined), true, 'unknown contracts keep the existing behavior');
});

test('an individual-contributor title is not penalized when authority is irrelevant', () => {
  const lead = { currentTitle: 'Senior Software Engineer' };
  const icSignal = { confidence: 2, ignoredTitle: true };
  const penalized = computeScoreBreakdown({ ...lead }, 'partial', 'tavily', icSignal).finalScore;
  const neutral = computeScoreBreakdown({ ...lead }, 'partial', 'tavily', undefined).finalScore;
  assert.ok(neutral > penalized, 'passing no decision-maker signal removes the 1.5 penalty');
});
