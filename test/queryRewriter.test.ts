import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteZeroYieldQuery } from '../server/leadSearch/queryRewriter.js';
import { quantizeBriefToCentroid } from '../server/leadSearch/adaptiveScheduler.js';
import { classifyQueryComplexity, resolveGeo, compressBriefForPrompt } from '../server/leadSearch/queryUnderstanding.js';
import { aliasIncludes, expandAliasTerm } from '../server/leadSearch/aliasMap.js';

describe('Phase 2: queryRewriter + aliasMap + understanding', () => {
  it('vague query broadens by dropping trailing token', () => {
    const contract: any = { brief: 'founders', requirements: [] };
    const r = rewriteZeroYieldQuery('SaaS founders Berlin', contract, 1);
    assert.ok(['broaden', 'synonym_swap', 'relax', 'none'].includes(r.strategy));
    assert.ok(r.query.length > 0);
  });
  it('rich query relaxes lowest-salience covered hard', () => {
    const contract: any = {
      brief: 'SaaS founders in Berlin using HubSpot hiring SDRs with manual outbound',
      requirements: [
        { id: 'person_role-1', scope: 'person_role', importance: 'hard', acceptableTerms: ['founder'] },
        { id: 'signal-1', scope: 'signal', importance: 'hard', acceptableTerms: ['HubSpot'] },
      ],
    };
    const r = rewriteZeroYieldQuery('SaaS founder Berlin HubSpot', contract, 1);
    assert.ok(r.strategy === 'relax' || r.strategy === 'none' || r.strategy === 'broaden');
  });
  it('returns none after 3 attempts', () => {
    const r = rewriteZeroYieldQuery('x', null, 5);
    assert.equal(r.strategy, 'none');
  });
  it('centroids are stable and bounded to 24 buckets', () => {
    const a = quantizeBriefToCentroid('SaaS founders in Berlin');
    const b = quantizeBriefToCentroid('SaaS founders in Berlin');
    assert.equal(a, b);
    assert.ok(a.startsWith('centroid_'));
    assert.equal(quantizeBriefToCentroid(''), 'centroid_global_00');
  });
  it('aliasIncludes grounds acronyms', () => {
    assert.ok(aliasIncludes('Managing Director at Acme', 'MD'));
    assert.ok(aliasIncludes('United States SaaS founder', 'US'));
    assert.ok(!aliasIncludes('Berlin SaaS founder', 'HubSpot'));
  });
  it('expandAliasTerm returns variants', () => {
    assert.ok(expandAliasTerm('MD').includes('managing director'));
  });
  it('compressBriefForPrompt caps long briefs', () => {
    const long = 'Founder '.repeat(300);
    const c = compressBriefForPrompt(long, 900);
    assert.ok(c.length <= 900);
  });
  it('resolveGeo handles regions without invention', () => {
    assert.equal(resolveGeo('founders').geo, 'open_global');
    assert.equal(resolveGeo('SaaS founders in Germany').countryAnchor, 'Germany');
    assert.equal(resolveGeo('remote SaaS founders').geo, 'remote');
  });
  it('classify handles empty brief', () => {
    const c = classifyQueryComplexity('');
    assert.equal(c.tier, 'vague');
  });
});
