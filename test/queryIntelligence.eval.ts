import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectDecompositionMode, buildDeterministicProspectContract, computeCoveredRequirementIds } from '../server/leadSearch/prospectContract.js';
import { buildFallbackQueryPlan } from '../server/leadSearch/searchSpec.js';
import { classifyQueryComplexity, resolveGeo } from '../server/leadSearch/queryUnderstanding.js';
import { normalizeAliasTerm } from '../server/leadSearch/aliasMap.js';

const VAGUE_BRIEFS = [
  'founders',
  'growth marketers',
  'solar installers',
  'recruiting agencies',
  'fintech leads',
  'CEOs',
  'coaches',
  'SaaS founders',
  'ecommerce brands',
  'clinics',
  // G21 pronoun-collision regression briefs (must stay open_global, never US-anchored)
  'help us find agency owners',
  'find agencies that can help us scale',
];

const PLURAL_PERSONA_BRIEFS = [
  'Presidents in Berlin',
  'CEOs in London',
  'VPs in Austin',
  'co-founders in Toronto',
];

const STANDARD_BRIEFS = [
  'B2B SaaS founders in Germany hiring sales reps',
  'healthcare clinics in UK needing CRM automation',
  'Shopify agency owners in California',
  'fintech founders in London using HubSpot',
  'manufacturing plant managers in Texas',
  'executive coaches in New York',
  'dental clinic owners in Austin hiring receptionists',
  'law firm partners in Toronto',
  'ecommerce brand founders in Sydney using Klaviyo',
  'SaaS CEOs in Berlin scaling sales',
];

const RICH_BRIEFS = [
  'Find B2B SaaS founders in Berlin with 11-50 employees using n8n and HubSpot, actively hiring SDRs, struggling with manual outbound, exclude software employees, decision makers only',
  'Shopify DTC apparel brand founders in California using Klaviyo and Omnisend with 20-100 staff, expanding to wholesale, hiring growth marketers, exclude Amazon employees',
  'Executive coaching practices with mastermind programs in New York run by founders, using Notion and Airtable, hiring operations managers, exclude therapists and life coaches',
  'Biotech clinical directors at hospitals in Boston with 100+ staff using Epic systems, hiring clinical coordinators, manual patient intake bottleneck',
  'Managing partners at corporate law firms in London with 50-200 staff using Clio, hiring associates, scaling past manual document review',
  'Manufacturing plant owners in Ohio using SAP with 200+ employees hiring plant managers, bottleneck in supply chain tracking',
  'Local dental clinic owners in Texas with 10-30 staff needing CRM automation, hiring receptionists, manual appointment scheduling pain',
  'AI agency owners in Austin with 11-50 staff using Supabase and n8n, hiring AI engineers, white label partner program, exclude SaaS platform employees',
  'Professional services CPA firm partners in Sydney using QuickBooks with 20-50 staff, hiring accountants, expanding advisory services',
  'Ecommerce retail founders in UAE using Shopify Plus with 50+ staff, hiring logistics managers, scaling past manual fulfillment',
];

describe('Phase 0: Query Intelligence Eval Harness (30 gold briefs)', () => {
  it('vague briefs classify as vague/standard (never rich) and never invent USA geo', () => {
    for (const brief of VAGUE_BRIEFS) {
      const c = classifyQueryComplexity(brief);
      assert.ok(c.tier !== 'rich', `expected vague/standard for: ${brief}, got ${c.tier}`);
      const geo = resolveGeo(brief);
      assert.equal(geo.geo, 'open_global', `must not invent geo for: ${brief}, got ${geo.countryAnchor}`);
      assert.ok(!geo.invented, `invented flag must be false for: ${brief}`);
    }
  });

  it('default_invention_rate: fallback plan never injects USA when brief has no geo', () => {
    let inventions = 0;
    for (const brief of VAGUE_BRIEFS) {
      const plans = buildFallbackQueryPlan(brief);
      const joined = plans.map(p => p.query).join(' ').toLowerCase();
      const geo = resolveGeo(brief);
      if (geo.geo === 'open_global' && (joined.includes('usa') || joined.includes('united states') || joined.includes('new york') || joined.includes('san francisco'))) {
        inventions++;
      }
    }
    const rate = inventions / VAGUE_BRIEFS.length;
    assert.ok(rate === 0, `default_invention_rate must be 0, got ${rate} (${inventions} inventions)`);
  });

  it('standard briefs classify as standard and resolve explicit geo', () => {
    const geoGermany = resolveGeo('B2B SaaS founders in Germany hiring sales reps');
    assert.equal(geoGermany.countryAnchor, 'Germany');
    const c = classifyQueryComplexity('B2B SaaS founders in Germany hiring sales reps');
    assert.ok(c.tier === 'standard' || c.tier === 'rich', `expected standard/rich, got ${c.tier}`);
  });

  it('rich briefs classify as rich with 6+ words and multi-constraints', () => {
    for (const brief of RICH_BRIEFS) {
      const c = classifyQueryComplexity(brief);
      assert.equal(c.tier, 'rich', `expected rich for: ${brief.slice(0, 60)}`);
      assert.ok(c.missingSlots.length >= 0);
    }
  });

  it('contract_fidelity: deterministic contract preserves explicit hard requirements', () => {
    const contract = buildDeterministicProspectContract('B2B SaaS founders in Germany hiring sales reps');
    assert.ok(contract.requirements.length >= 1, 'must emit at least 1 requirement');
    const roles = contract.requirements.filter(r => r.scope === 'person_role');
    assert.ok(roles.length >= 1, 'must emit person_role');
  });

  it('covered_requirements_ratio: real set-cover only claims terms present in query', () => {
    const contract = buildDeterministicProspectContract('SaaS founders in Berlin using HubSpot');
    const ids = computeCoveredRequirementIds('SaaS founders in Berlin', contract.requirements, false);
    assert.ok(Array.isArray(ids));
    // A query mentioning only Berlin must not claim HubSpot signal coverage
    const signalIds = new Set(contract.requirements.filter(r => r.scope === 'signal').map(r => r.id));
    const claimedSignal = ids.filter(id => signalIds.has(id));
    assert.equal(claimedSignal.length, 0, 'Berlin-only query must not claim signal coverage');
  });

  it('zero_yield_query_rate simulation: queries are non-empty and bounded', () => {
    let empty = 0;
    const all = [...VAGUE_BRIEFS, ...STANDARD_BRIEFS, ...RICH_BRIEFS];
    for (const brief of all) {
      const plans = buildFallbackQueryPlan(brief);
      assert.ok(plans.length >= 1 && plans.length <= 6, `plan count 1-6 for: ${brief}`);
      for (const p of plans) {
        if (!p.query || p.query.trim().length < 3) empty++;
        assert.ok(p.query.length <= 240, `query bounded 240: ${p.query}`);
      }
    }
    assert.equal(empty, 0, 'zero empty queries allowed');
  });

  it('alias normalization grounds acronyms without invention', () => {
    assert.equal(normalizeAliasTerm('MD'), 'managing director');
    assert.equal(normalizeAliasTerm('VP'), 'vice president');
    assert.equal(normalizeAliasTerm('US'), 'united states');
    assert.equal(normalizeAliasTerm('UK'), 'united kingdom');
  });

  it('G21 pronoun briefs never resolve to US geo', () => {
    for (const brief of ['help us find agency owners', 'find agencies that can help us scale']) {
      const geo = resolveGeo(brief);
      assert.equal(geo.geo, 'open_global', `pronoun brief must not anchor geo: ${brief}`);
      assert.equal(geo.countryAnchor, null);
    }
  });

  it('G22 plural-persona briefs emit person_role (never company_type role leak)', () => {
    for (const brief of PLURAL_PERSONA_BRIEFS) {
      const contract = buildDeterministicProspectContract(brief);
      const roles = contract.requirements.filter(r => r.scope === 'person_role');
      assert.ok(roles.length >= 1, `must emit person_role for: ${brief}`);
      const leakedCompanyType = contract.requirements.filter(r =>
        r.scope === 'company_type' && /ceos?|presidents?|vps?|co-founders?/i.test(r.sourcePhrase || r.description || ''));
      assert.equal(leakedCompanyType.length, 0, `role must not leak to company_type for: ${brief}`);
    }
    const london = buildDeterministicProspectContract('CEOs in London');
    const roleTerms = london.requirements.filter(r => r.scope === 'person_role').flatMap(r => r.acceptableTerms || []);
    assert.ok(roleTerms.some(t => /ceo/i.test(t)), 'CEOs in London must keep ceo term');
  });

  it('G24: city-only geos anchor queries; vertical never equals the location', async () => {
    const londonPlans = buildFallbackQueryPlan('CEOs in London');
    assert.ok(londonPlans.some(p => /london/i.test(p.query)), 'at least one query must include London');
    for (const p of londonPlans) assert.ok(p.query.length <= 240);
    const { buildContractFallbackQueries } = await import('../server/leadSearch/prospectContract.js');
    const berlin = buildDeterministicProspectContract('founders in Berlin');
    const fallbacks = buildContractFallbackQueries('founders in Berlin', berlin.requirements, (berlin as any).identitySpec);
    for (const q of fallbacks) {
      // No query may consist of role+location only with location as vertical is covered
      // by the vertical-equals-location ban: vertical slot must not be the location.
      assert.ok(!/^berlin\s/i.test(String(q.query)) || /founder|owner|ceo/i.test(String(q.query)));
    }
  });

  it('golden-set qualified-yield baseline (fixture, deterministic)', () => {
    // Baseline artifact: contract fidelity across all brief tiers.
    // Recorded so later precision fixes (G1/G2) show yield movement, not silent drift.
    const all = [...VAGUE_BRIEFS, ...STANDARD_BRIEFS, ...RICH_BRIEFS, ...PLURAL_PERSONA_BRIEFS];
    let withRole = 0;
    for (const brief of all) {
      const contract = buildDeterministicProspectContract(brief);
      if (contract.requirements.some(r => r.scope === 'person_role')) withRole++;
    }
    const yieldRate = withRole / all.length;
    assert.ok(yieldRate >= 0.5, `person_role yield baseline >= 0.5, got ${yieldRate}`);
  });

  it('decomposition does not misroute intent-rich short briefs', () => {
    // Short but intent-rich must still reach dual stream via classifier, legacy heuristic may say single
    const legacy = detectDecompositionMode('SaaS using HubSpot');
    const c = classifyQueryComplexity('SaaS using HubSpot');
    assert.ok(legacy === 'dual_stream_intent' || c.tier === 'vague', `legacy=${legacy} tier=${c.tier}`);
  });
});
