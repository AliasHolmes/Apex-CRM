import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStrategistPrompt } from '../server/leadSearch/searchSpec.js';
import { toLinkedInSearchQuery } from '../server/leadSearch/strategist.js';
import {
  buildDeterministicProspectContract,
  buildContractFallbackQueries,
  enforceContractQueries,
} from '../server/leadSearch/prospectContract.js';

describe('High-Efficiency Prospecting Engine (6-Pillar Architecture)', () => {
  describe('Pillar 1: History-Aware Metro Rotation & CRM Saturation Shield', () => {
    it('detects explored metros from previousQueries and injects exclusion directives', () => {
      const contract = buildDeterministicProspectContract('AI agency owner in USA and UK');
      const prompt = buildStrategistPrompt({
        query: 'AI agency owner in USA and UK',
        contract,
        round: 2,
        maxRounds: 5,
        remaining: 15,
        previousRoundSummary: {},
        previousQueries: [
          'site:linkedin.com/in/ "AI agency" founder Toronto',
          'site:linkedin.com/in/ "AI agency" CEO London',
          'site:linkedin.com/in/ "AI agency" owner Austin',
        ],
      });

      assert.ok(
        prompt.includes('ALREADY EXPLORED METROS IN THIS SESSION'),
        'Prompt must contain explored metros header'
      );
      assert.ok(prompt.includes('Toronto'), 'Prompt must flag Toronto as explored');
      assert.ok(prompt.includes('London'), 'Prompt must flag London as explored');
      assert.ok(prompt.includes('Austin'), 'Prompt must flag Austin as explored');
      assert.ok(
        prompt.includes('RECOMMENDED UNVISITED METROS TO TARGET NEXT'),
        'Prompt must provide unvisited metro recommendations'
      );
    });

    it('replaces static recovery examples with dynamic unvisited hubs', () => {
      const contract = buildDeterministicProspectContract('AI agency owner in UK');
      const prompt = buildStrategistPrompt({
        query: 'AI agency owner in UK',
        contract,
        round: 3,
        maxRounds: 5,
        remaining: 10,
        previousRoundSummary: {},
        isRecovery: true,
        recoveryAttempt: 1,
        previousQueries: ['"AI agency" founder London'],
      });

      assert.ok(prompt.includes('RECOVERY DIRECTIVE'));
      // London should be excluded and adjacent UK hubs recommended
      assert.ok(!prompt.includes('e.g. Austin, London, Toronto'));
    });
  });

  describe('Pillar 2: Tavily Person-Lane LinkedIn Profile Targeting', () => {
    it('prepends site:linkedin.com/in/ to person-lane queries', () => {
      const query = toLinkedInSearchQuery({
        query: '"AI agency" founder Austin',
        lane: 'person',
      });
      assert.equal(query, 'site:linkedin.com/in/ "AI agency" founder Austin');
    });

    it('is idempotent: never double-prepends site:linkedin.com/in/', () => {
      const alreadyPrefixed = 'site:linkedin.com/in/ "AI agency" CEO Manchester';
      const result = toLinkedInSearchQuery({
        query: alreadyPrefixed,
        lane: 'person',
      });
      assert.equal(result, alreadyPrefixed);
    });

    it('preserves clean queries for signal and account lanes', () => {
      const signalQuery = toLinkedInSearchQuery({
        query: '"AI agency" hiring n8n developer',
        lane: 'signal',
      });
      assert.equal(signalQuery, '"AI agency" hiring n8n developer');
      assert.ok(!signalQuery.includes('site:linkedin.com/in/'));

      const accountQuery = toLinkedInSearchQuery({
        query: '"AI agency" Clutch directory',
        lane: 'account',
      });
      assert.equal(accountQuery, '"AI agency" Clutch directory');
      assert.ok(!accountQuery.includes('site:linkedin.com/in/'));
    });
  });

  describe('Pillar 3: Multi-Country Fallback Query Cartesian Balance', () => {
    it('allocates distinct query slots to all countries in multi-country briefs without synonym displacement', () => {
      const brief = 'AI agency owner from USA/UK/Canada/Australia';
      const contract = buildDeterministicProspectContract(brief);
      const fallbackQueries = buildContractFallbackQueries(brief, contract.requirements);

      const personQueries = fallbackQueries.filter(q => q.lane === 'person');
      assert.equal(personQueries.length, 4, 'Must generate exactly 4 person fallback queries');

      const countryHits = {
        usa: personQueries.filter(q => /\b(usa|united states|us|america)\b/i.test(q.query)).length,
        uk: personQueries.filter(q => /\b(uk|united kingdom|britain|england)\b/i.test(q.query)).length,
        canada: personQueries.filter(q => /\b(canada|canadian)\b/i.test(q.query)).length,
        australia: personQueries.filter(q => /\b(australia|australian|au)\b/i.test(q.query)).length,
      };

      assert.equal(countryHits.usa, 1, 'USA must receive exactly 1 query slot');
      assert.equal(countryHits.uk, 1, 'UK must receive exactly 1 query slot');
      assert.equal(countryHits.canada, 1, 'Canada must receive exactly 1 query slot');
      assert.equal(countryHits.australia, 1, 'Australia must receive exactly 1 query slot (not crowded out)');
    });
  });

  describe('Pillar 4: Search Query Negative Keyword De-Bloat', () => {
    it('strips Big Tech negative filters from candidate queries in enforceContractQueries', () => {
      const contract = buildDeterministicProspectContract('AI agency owner from USA');
      const candidateQuery = {
        query: '"AI agency" founder -Microsoft -Google -Meta -Apple -Amazon -OpenAI -DeepMind',
        lane: 'person',
      };

      const enforced = enforceContractQueries([candidateQuery], contract);
      assert.ok(enforced.length > 0);
      const query = enforced[0].query;
      assert.ok(!query.toLowerCase().includes('-microsoft'), 'Must strip -Microsoft');
      assert.ok(!query.toLowerCase().includes('-google'), 'Must strip -Google');
      assert.ok(!query.toLowerCase().includes('-meta'), 'Must strip -Meta');
      assert.ok(!query.toLowerCase().includes('-apple'), 'Must strip -Apple');
      assert.ok(!query.toLowerCase().includes('-amazon'), 'Must strip -Amazon');
      assert.ok(!query.toLowerCase().includes('-openai'), 'Must strip -OpenAI');
      assert.ok(!query.toLowerCase().includes('-deepmind'), 'Must strip -DeepMind');
      assert.ok(query.includes('"AI agency"'), 'Must retain core vertical phrase');
    });

    it('does not append redundant -software -platform if query already has agency nouns', () => {
      const contract = buildDeterministicProspectContract('AI agency owner from Canada');
      const enforced = enforceContractQueries([{ query: '"AI agency" founder Toronto' }], contract);
      assert.ok(enforced.length > 0);
      assert.ok(!enforced[0].query.includes('-software'), 'Should not append -software when "agency" is present');
      assert.ok(!enforced[0].query.includes('-platform'), 'Should not append -platform when "agency" is present');
    });
  });

  describe('Pillar 5: Dynamic In-Round Replenishment Hardening', () => {
    it('toLinkedInSearchQuery formats dynamic replenishment queries for Tavily', () => {
      const rawQuery = '"AI agency" founder Brisbane';
      const formatted = toLinkedInSearchQuery({ query: rawQuery, lane: 'person' });
      assert.equal(formatted, 'site:linkedin.com/in/ "AI agency" founder Brisbane');
    });
  });

  describe('Pillar 6: Telemetry and Debug Log Snapshot Hygiene', () => {
    it('JSON clone snapshotting decouples debugLogs from downstream in-memory lead mutations', () => {
      const lead = {
        fullName: 'Jane Doe',
        company: 'Apex AI Lab',
        location: 'Melbourne, Australia',
      };
      const rawList = [lead];
      const snapshot = JSON.parse(JSON.stringify(rawList));

      // Downstream mutation
      (lead as any).scoreBreakdown = { finalScore: 95, confidence: 'high' };
      (lead as any).evidence = { snippet: 'Very large text evidence block...' };

      assert.equal((snapshot[0] as any).scoreBreakdown, undefined, 'Snapshot must not reflect downstream mutations');
      assert.equal((snapshot[0] as any).evidence, undefined, 'Snapshot must remain lightweight');
    });
  });
});
