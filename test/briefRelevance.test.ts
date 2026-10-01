import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBriefRelevanceScore, computeScoreBreakdown } from '../server/leadSearch/scoring.js';

const agencyReqs: any[] = [
  { id: 'r_role', scope: 'person_role', importance: 'hard', acceptableTerms: ['founder', 'owner', 'ceo', 'cto'] },
  { id: 'r_type', scope: 'company_type', importance: 'hard', acceptableTerms: ['ai agency', 'ai', 'automation agency'] },
  { id: 'r_loc', scope: 'person_location', importance: 'hard', acceptableTerms: ['uk', 'united kingdom', 'london'] },
];

test('scores a true fit high and a substring-only lookalike low', () => {
  const trueFit = { currentTitle: 'Founder', currentCompany: 'Nimbus AI Automation Agency', location: 'London, England' };
  const lookalike = { currentTitle: 'Director of Retail', currentCompany: 'Chairish Inc', location: 'Ukiah, California' };
  assert.ok(computeBriefRelevanceScore(trueFit, agencyReqs) >= 8.5);
  assert.ok(computeBriefRelevanceScore(lookalike, agencyReqs) <= 3, 'cto/ai/uk must not match inside director/chairish/ukiah');
});

test('does not match a short term inside a longer word', () => {
  const reqs: any[] = [{ id: 'r', scope: 'person_role', importance: 'hard', acceptableTerms: ['cto'] }];
  assert.ok(computeBriefRelevanceScore({ currentTitle: 'Director of Sales' }, reqs) < 5);
});

test('keeps alias equivalence for locations', () => {
  const reqs: any[] = [{ id: 'r', scope: 'person_location', importance: 'hard', acceptableTerms: ['uk'] }];
  assert.ok(computeBriefRelevanceScore({ currentTitle: 'Founder', location: 'Leeds, United Kingdom' }, reqs) >= 8.5);
});

test('matches terms containing regex metacharacters', () => {
  const reqs: any[] = [{ id: 'r', scope: 'person_role', importance: 'hard', acceptableTerms: ['c++', 'node.js', 'r&d'] }];
  assert.doesNotThrow(() => computeBriefRelevanceScore({ currentTitle: 'Senior C++ Engineer' }, reqs));
  assert.ok(computeBriefRelevanceScore({ currentTitle: 'Senior C++ Engineer' }, reqs) >= 8.5);
  assert.ok(computeBriefRelevanceScore({ currentTitle: 'Node.js Developer' }, reqs) >= 8.5);
  assert.ok(computeBriefRelevanceScore({ currentTitle: 'Head of R&D' }, reqs) >= 8.5);
});

test('recomputes relevance when new evidence arrives and remembers it for later calls', () => {
  const reqs: any[] = [
    { id: 'r_role', scope: 'person_role', importance: 'hard', acceptableTerms: ['founder'] },
    { id: 'r_type', scope: 'company_type', importance: 'hard', acceptableTerms: ['ai agency'] },
  ];
  const lead: any = { currentTitle: 'Founder', currentCompany: 'Nimbus' };
  const before = computeScoreBreakdown(lead, 'weak', 'tavily', undefined, undefined, reqs, '').fitScore;
  const after = computeScoreBreakdown(lead, 'good', 'tavily', undefined, undefined, reqs, 'Nimbus is an AI agency building automations').fitScore;
  assert.ok(after > before, `fit should rise with company evidence (before ${before}, after ${after})`);
  const withoutReqs = computeScoreBreakdown(lead, 'good', 'tavily').fitScore;
  assert.equal(withoutReqs, after, 'calls without requirements reuse the last computed relevance');
});
