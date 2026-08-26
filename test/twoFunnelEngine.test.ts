import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SignalStore,
  companiesMatch,
  distinctiveTokens,
  normalizeCompanyName,
  MAX_SIGNAL_BLOCKS,
  MAX_SIGNAL_TEXT_LENGTH
} from '../server/leadSearch/signalStore.js';
import { executeFuseStage } from '../server/leadSearch/stages/fuseStage.js';
import { executePlanStage } from '../server/leadSearch/stages/planStage.js';
import { enforceContractQueries } from '../server/leadSearch/prospectContract.js';
import type { SessionContext, PipelineSessionState } from '../server/leadSearch/pipelineTypes.js';
import type { SearchSpec } from '../server/leadSearch/searchSpec.js';

describe('Two-Funnel Engine & Signal Architecture', () => {

  describe('SignalStore Bounds and Serialization', () => {
    test('enforces MAX_SIGNAL_BLOCKS capacity via FIFO eviction and cleans up stale companyMap', () => {
      const store = new SignalStore();
      for (let i = 1; i <= 60; i++) {
        store.add({
          companyName: `Company ${i}`,
          url: `https://company${i}.com/jobs`,
          text: `Hiring software engineers for company ${i}`,
          round: 1,
          query: 'hiring software engineers',
          lane: 'signal',
          provider: 'tavily',
          category: 'hiring'
        });
      }

      assert.equal(store.size, MAX_SIGNAL_BLOCKS);
      const serialized = store.toJSON();
      assert.equal(serialized.blocks.length, MAX_SIGNAL_BLOCKS);
      assert.equal(serialized.blocks[serialized.blocks.length - 1].companyName, 'Company 60');
      // Assert that evicted companies (1..10) were pruned from companyMap
      const uniqueNames = store.getUniqueCompanyNames();
      assert.ok(!uniqueNames.includes('company 1'));
      assert.ok(!uniqueNames.includes('Company 1'));
      assert.ok(uniqueNames.some(c => c.toLowerCase().includes('company 60')));
    });

    test('truncates long signal text to MAX_SIGNAL_TEXT_LENGTH', () => {
      const store = new SignalStore();
      const longText = 'A'.repeat(1000);
      store.add({
        companyName: 'Apex Corp',
        url: 'https://apex.ai/news',
        text: longText,
        round: 1,
        query: 'apex news',
        lane: 'signal',
        provider: 'tavily'
      });

      const blocks = store.toJSON().blocks;
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].text.length, MAX_SIGNAL_TEXT_LENGTH);
    });

    test('serializes toJSON and restores accurately via fromJSON', () => {
      const store = new SignalStore();
      store.add({
        companyName: 'Scale AI',
        url: 'https://scale.com/careers',
        text: 'Hiring annotation specialists and ML engineers',
        round: 1,
        query: 'scale hiring',
        lane: 'signal',
        provider: 'brightdata'
      });

      const serialized = store.toJSON();
      assert.equal(serialized.blocks.length, 1);
      assert.equal(serialized.companies.length, 1);

      const restored = SignalStore.fromJSON(serialized);
      assert.equal(restored.size, 1);
      const matched = restored.getForCandidate('Scale AI Inc');
      assert.equal(matched.length, 1);
      assert.equal(matched[0].companyName, 'Scale AI');
    });
  });

  describe('4-Tier Safe Company Matching & Collision Prevention', () => {
    test('matches exact and compact company names and distinctive 4+ char tokens', () => {
      assert.ok(companiesMatch('Rainbird Technologies Ltd', 'Rainbird Technologies'));
      assert.ok(companiesMatch('Apex Systems Inc', 'Apex Systems'));
      assert.ok(companiesMatch('Scale AI LLC', 'Scale AI'));
      // 4+ char brand match
      assert.ok(companiesMatch('Apex CRM', 'Apex'));
      assert.ok(companiesMatch('Apex CRM LLC', 'Apex'));
    });

    test('matches curated 3-character tech brands', () => {
      assert.ok(distinctiveTokens('n8n automation').includes('n8n'));
      assert.ok(companiesMatch('n8n io', 'n8n workflow automation'));
      assert.ok(companiesMatch('AWS Cloud Services', 'AWS'));
      assert.ok(companiesMatch('IBM Corp', 'IBM'));
    });

    test('prevents false-positive collisions on short generic tokens and conflicting qualifiers', () => {
      assert.ok(!companiesMatch('AI Studio', 'AI Consultancy'));
      assert.ok(!companiesMatch('Top Agency', 'Top Solutions'));
      assert.ok(!companiesMatch('One Media', 'One Systems'));
      assert.ok(!companiesMatch('Hub Marketing', 'Hub Digital'));
      assert.ok(!companiesMatch('Pro Services', 'Pro Group'));
      // Conflicting multi-word industry qualifiers
      assert.ok(!companiesMatch('Apex Solutions', 'Apex Growth'));
      assert.ok(!companiesMatch('Digital Growth Agency', 'Digital Automation Studio'));
    });
  });

  describe('Tri-Stream Fusion Output Routing', () => {
    test('routes signal observations to SignalStore without missing_linkedin_profile rejections', async () => {
      const signalStore = new SignalStore();
      const sessionState: Partial<PipelineSessionState> = {
        seenCandidateKeys: new Set(),
        existingKeys: new Set(),
        signalStore,
        acceptedLeads: [],
        debugLogs: [],
      };

      const ctx = {
        config: { promptQuery: 'AI agency hiring in USA', targetLimit: 10 },
        state: sessionState as PipelineSessionState,
        logEvent: () => {},
        recordTrace: () => ({ id: '1', timestamp: new Date().toISOString() })
      } as unknown as SessionContext;

      const stats = { rejectionReasons: {}, queryRuns: [] };
      const roundPlans = [
        {
          item: {
            id: 'q1',
            query: 'AI agency careers hiring developer',
            lane: 'signal',
            family: 'growth_signal',
            intent: 'find_buying_signal',
            providerPreference: 'tavily',
            tavily: { searchDepth: 'basic' }
          },
          executableQuery: 'AI agency careers hiring developer'
        },
        {
          item: {
            id: 'q2',
            query: 'AI agency founder USA',
            lane: 'person',
            family: 'persona_title',
            intent: 'find_decision_makers',
            providerPreference: 'tavily',
            tavily: { searchDepth: 'basic' }
          },
          executableQuery: 'AI agency founder USA'
        }
      ];

      const queryRuns = [
        {
          round: 1,
          query: 'AI agency careers hiring developer',
          rawCandidates: 0,
          uniqueCandidates: 0,
          evidenceBlocks: 0,
          extractedLeads: 0,
          acceptedLeads: 0,
          rejectionReasons: {} as Record<string, number>,
          searchLatencyMs: 10,
          providerUnits: 1,
          qualifiedFinalists: 0,
          rescuedFinalists: 0,
          returnedFinalists: 0
        },
        {
          round: 1,
          query: 'AI agency founder USA',
          rawCandidates: 0,
          uniqueCandidates: 0,
          evidenceBlocks: 0,
          extractedLeads: 0,
          acceptedLeads: 0,
          rejectionReasons: {} as Record<string, number>,
          searchLatencyMs: 10,
          providerUnits: 1,
          qualifiedFinalists: 0,
          rescuedFinalists: 0,
          returnedFinalists: 0
        }
      ];

      const roundItems = [
        {
          resultIndex: 0,
          item: {
            title: 'Senior AI Engineer | NeuralCraft Agency',
            url: 'https://neuralcraft.ai/careers/senior-engineer',
            content: 'NeuralCraft is an AI studio hiring Senior AI Engineers.',
            sourceProvider: 'tavily'
          }
        },
        {
          resultIndex: 1,
          item: {
            title: 'Sarah Connor - Founder & CEO at NeuralCraft',
            url: 'https://www.linkedin.com/in/sarah-connor-neuralcraft',
            content: 'Founder & CEO at NeuralCraft AI Agency.',
            sourceProvider: 'tavily'
          }
        }
      ];

      const result = await executeFuseStage(ctx, {
        round: 1,
        roundItems,
        roundPlans: roundPlans as any,
        queryRuns: queryRuns as any,
        stats
      });

      // Assert that candidateItems receives ONLY the LinkedIn profile (person lane)
      assert.equal(result.candidateItems.length, 1);
      assert.equal(result.candidateItems[0]._linkedinUsername, 'sarah-connor-neuralcraft');

      // Assert that SignalStore received the open-web hiring signal
      assert.equal(signalStore.size, 1);
      const discovered = signalStore.getUniqueCompanyNames();
      assert.ok(discovered.some(c => c.toLowerCase().includes('neuralcraft')));

      // Assert NO missing_linkedin_profile rejection was recorded for the signal lane
      assert.equal(queryRuns[0].rejectionReasons['missing_linkedin_profile'] || 0, 0);
      assert.equal(queryRuns[0].evidenceBlocks, 1);
    });

    test('rejects non-profile LinkedIn URLs in person lane', async () => {
      const signalStore = new SignalStore();
      const sessionState: Partial<PipelineSessionState> = {
        seenCandidateKeys: new Set(),
        existingKeys: new Set(),
        signalStore,
        acceptedLeads: [],
        debugLogs: [],
      };

      const ctx = {
        config: { promptQuery: 'AI agency founder', targetLimit: 10 },
        state: sessionState as PipelineSessionState,
        logEvent: () => {},
        recordTrace: () => ({ id: '1', timestamp: new Date().toISOString() })
      } as unknown as SessionContext;

      const stats = { rejectionReasons: {} as Record<string, number>, queryRuns: [] };
      const roundPlans = [
        {
          item: { id: 'q1', query: 'AI agency', lane: 'person', family: 'persona_title', intent: 'find_decision_makers', providerPreference: 'tavily', tavily: { searchDepth: 'basic' } },
          executableQuery: 'AI agency'
        }
      ];

      const queryRuns = [
        {
          round: 1,
          query: 'AI agency',
          rawCandidates: 0,
          uniqueCandidates: 0,
          evidenceBlocks: 0,
          extractedLeads: 0,
          acceptedLeads: 0,
          rejectionReasons: {} as Record<string, number>,
          searchLatencyMs: 10,
          providerUnits: 1,
          qualifiedFinalists: 0,
          rescuedFinalists: 0,
          returnedFinalists: 0
        }
      ];

      const roundItems = [
        {
          resultIndex: 0,
          item: {
            title: 'NeuralCraft AI Company Page',
            url: 'https://www.linkedin.com/company/neuralcraft-ai',
            content: 'About NeuralCraft AI company',
            sourceProvider: 'tavily'
          }
        }
      ];

      const result = await executeFuseStage(ctx, {
        round: 1,
        roundItems,
        roundPlans: roundPlans as any,
        queryRuns: queryRuns as any,
        stats
      });

      // Assert non-profile URL is filtered out from person candidateItems
      assert.equal(result.candidateItems.length, 0);
      assert.equal(stats.rejectionReasons['missing_linkedin_profile'], 1);
    });
  });

  describe('Location Query Enforcement Without Concatenation', () => {
    test('does not append conflicting location when query already targets a valid geography', () => {
      const contract: any = {
        brief: 'AI agency owner in USA or UK or Canada',
        exclusions: [],
        intentSpec: { toolingKeywords: [], hiringSignals: [], painSignals: [], growthSignals: [] },
        requirements: [
          {
            id: 'person_role-1',
            scope: 'person_role',
            importance: 'hard',
            sourcePhrase: 'owner',
            acceptableTerms: ['owner', 'founder', 'CEO'],
            queryable: true,
            evidenceModality: 'structured_profile'
          },
          {
            id: 'person_location-1',
            scope: 'person_location',
            importance: 'hard',
            sourcePhrase: 'USA',
            acceptableTerms: ['USA', 'UK', 'Canada', 'United States', 'US', 'Australia'],
            queryable: true,
            evidenceModality: 'structured_profile'
          },
          {
            id: 'company_type-1',
            scope: 'company_type',
            importance: 'hard',
            sourcePhrase: 'AI agency',
            acceptableTerms: ['AI agency', 'AI consultancy'],
            queryable: true,
            evidenceModality: 'structured_profile'
          }
        ]
      };

      const rawQueries = [
        { query: 'AI agency founder Australia', lane: 'person', family: 'persona_title' },
        { query: 'AI agency owner UK', lane: 'person', family: 'persona_title' },
        { query: 'AI agency CEO Canada', lane: 'person', family: 'persona_title' }
      ];

      const normalized = enforceContractQueries(rawQueries, contract);
      assert.equal(normalized.length, 4);
      assert.ok(normalized.some(q => q.query.includes('Australia') && !q.query.includes('USA')));
      assert.ok(normalized.some(q => q.query.includes('UK') && !q.query.includes('USA')));
      assert.ok(normalized.some(q => q.query.includes('Canada') && !q.query.includes('USA')));
    });
  });

  describe('Speculative Planning Generation Guard & Deferred Query Commit', () => {
    test('executePlanStage does not mutate seenQueryTexts or generatedQueries directly', async () => {
      const seenQueryTexts = new Set<string>();
      const generatedQueries: string[] = [];
      const sessionState: Partial<PipelineSessionState> = {
        signalStore: new SignalStore(),
        debugLogs: [],
        llmCircuitBreaker: { canAttempt: () => true, recordSuccess: () => {}, recordFailure: () => {} } as any,
        abortController: new AbortController()
      };

      const ctx = {
        config: { promptQuery: 'AI agency founder in USA', maxRounds: 5, contract: { requirements: [], exclusions: [] } },
        state: sessionState as PipelineSessionState,
        logEvent: () => {},
        recordTrace: () => ({ id: '1', timestamp: new Date().toISOString() })
      } as unknown as SessionContext;

      const dummySpec: SearchSpec = {
        version: 1,
        mode: 'person_first',
        person: { includeTitles: ['founder'], excludeTitles: [], seniorities: ['Owner', 'Founder'], locations: ['USA'] },
        company: { keywords: ['AI agency'], industries: ['Technology'], locations: ['USA'] },
        signals: { include: [] },
        exclusions: { companies: [], domains: [] },
        maxPerCompany: 2
      };

      const planResult = await executePlanStage(ctx, {
        round: 1,
        remaining: 10,
        generatedQueries,
        seenQueryTexts,
        searchSpec: dummySpec,
        discoveryProviderMode: 'hybrid',
        stats: { scout: {}, queryRuns: [] },
        generation: 1,
        isSpeculative: true
      });

      assert.ok(planResult.roundPlans.length > 0);
      assert.ok(planResult.proposedQueries.length > 0);
      // Assert caller structures were NOT mutated inside executePlanStage
      assert.equal(seenQueryTexts.size, 0);
      assert.equal(generatedQueries.length, 0);
      // Assert speculative planning did not push to state.debugLogs
      assert.equal(sessionState.debugLogs?.length || 0, 0);
    });
  });

});
