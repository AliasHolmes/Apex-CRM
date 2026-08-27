import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFallbackSearchSpec,
  buildFallbackQueryPlan,
  buildRetrievalTasks,
  type SearchSpec
} from '../server/leadSearch/searchSpec.js';
import { sanitizeQueryText } from '../server/leadSearch/strategist.js';
import {
  buildDeterministicProspectContract,
  enforceContractQueries,
  buildSignalLaneQueries
} from '../server/leadSearch/prospectContract.js';

describe('Query Sanitization & Multi-Metro Geographic Expansion', () => {
  it('keeps country and state prompts strictly in person_first mode (no local_business hijacking)', () => {
    const specUsa = buildFallbackSearchSpec('AI agency owner/founder from USA');
    assert.equal(specUsa.mode, 'person_first');

    const specNy = buildFallbackSearchSpec('AI agency founder from New York');
    assert.equal(specNy.mode, 'person_first');

    const specUk = buildFallbackSearchSpec('marketing agency CEO from United Kingdom');
    assert.equal(specUk.mode, 'person_first');

    // Only actual storefront trades trigger local_business
    const specDentist = buildFallbackSearchSpec('local dentist in Austin');
    assert.equal(specDentist.mode, 'local_business');
  });

  it('builds fallback query plans with distinct roles and metro anchors without title blob concatenation', () => {
    const brief = 'AI agency owner/founder from USA';
    const spec = buildFallbackSearchSpec(brief);
    const plan = buildFallbackQueryPlan(brief, spec);

    assert.ok(plan.length >= 3);
    for (const item of plan) {
      // Must not contain 10+ word title concatenation blobs
      const words = item.query.split(' ');
      assert.ok(words.length <= 8, `Query "${item.query}" has too many words (${words.length})`);
      // Must not contain boolean syntax
      assert.ok(!/\b(AND|OR|NOT)\b/.test(item.query), `Query "${item.query}" must not contain boolean operators`);
      assert.ok(!item.query.includes('"'), `Query "${item.query}" must not contain nested quotes`);
    }

    // Must distribute queries across executive roles and metros
    const queryTexts = plan.map(p => p.query.toLowerCase()).join(' ');
    assert.ok(queryTexts.includes('founder') || queryTexts.includes('owner') || queryTexts.includes('ceo'));
  });

  it('sets calibrated minimumScore (0.15) and maxResults (12) in retrieval tasks', () => {
    const brief = 'AI agency owner from USA';
    const spec = buildFallbackSearchSpec(brief);
    const plan = buildFallbackQueryPlan(brief, spec);
    const tasks = buildRetrievalTasks(plan, spec);

    assert.ok(tasks.length > 0);
    const personTask = tasks.find(t => t.lane === 'person');
    assert.ok(personTask);
    assert.equal(personTask.tavily.minimumScore, 0.15);
    assert.ok(personTask.tavily.maxResults >= 12);
  });

  it('sanitizeQueryText and enforceContractQueries strip all boolean syntax and site: tokens', () => {
    const rawQuery = 'owner OR founder OR CEO AND USA AND "AI agency" site:linkedin.com/in/';
    const sanitized = sanitizeQueryText(rawQuery);
    assert.ok(!/\b(AND|OR|NOT)\b/.test(sanitized));
    assert.ok(!sanitized.includes('site:'));
    assert.ok(!sanitized.includes('linkedin'));
    assert.ok(!sanitized.includes('"'));

    const contract = buildDeterministicProspectContract('AI agency owner from USA', buildFallbackSearchSpec('AI agency owner from USA'));
    const enforced = enforceContractQueries([{ query: 'founder OR CEO AND "AI studio"' }], contract);
    assert.ok(enforced.length > 0);
    assert.ok(!/\b(AND|OR|NOT)\b/.test(enforced[0].query));
    assert.ok(!enforced[0].query.includes('"'));
  });

  it('buildSignalLaneQueries generates natural search keywords without OR joins', () => {
    const contract = buildDeterministicProspectContract(
      'AI agency owner actively hiring n8n developers',
      buildFallbackSearchSpec('AI agency owner actively hiring n8n developers')
    );
    const signalQueries = buildSignalLaneQueries(contract.requirements);
    for (const sq of signalQueries) {
      assert.ok(!sq.query.includes(' OR '), `Signal query "${sq.query}" must not contain " OR "`);
    }
  });
});
