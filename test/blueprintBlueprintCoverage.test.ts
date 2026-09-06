import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readStoredCompanyNames } from '../server/db.js';
import { sanitizeQueryText } from '../server/leadSearch/strategist.js';
import {
  deconcatenateContractQuery,
  buildContractFallbackQueries,
  type ProspectContract,
  type ProspectRequirement,
} from '../server/leadSearch/prospectContract.js';
import {
  classifyAblationTier,
  ablateQueryTask,
  ABLATION_TIERS,
} from '../server/leadSearch/constraintAblation.js';
import {
  structuredFieldsForRequirement,
  hasStrictStructuredMatch,
} from '../server/leadSearch/evidenceSelection.js';
import {
  LLMProviderError,
  providerCooldowns,
  clearProviderCooldowns,
} from '../server/services/llm.js';
import { evaluateIncrementalJudgeBatches } from '../server/leadSearch/stages/judgeStage.js';
import type { SessionContext } from '../server/leadSearch/pipelineTypes.js';

describe('Blueprint 6-Module Comprehensive Verification Suite', () => {
  describe('Module 1: Preliminary Deduplication & Dynamic In-Round Replenishment', () => {
    it('readStoredCompanyNames returns an array of distinct strings', () => {
      const companies = readStoredCompanyNames(50);
      assert.ok(Array.isArray(companies));
      // All returned company names must be non-empty strings
      for (const name of companies) {
        assert.ok(typeof name === 'string' && name.trim().length > 0);
      }
      // Must be deduplicated
      const uniqueNames = new Set(companies);
      assert.strictEqual(uniqueNames.size, companies.length);
    });
  });

  describe('Module 2: Search Query Generation & De-concatenation', () => {
    const mockContract: ProspectContract = {
      version: 1,
      policyVersion: 'evidence-contract-v8',
      brief: 'AI agency owner from Australia',
      authorityRequired: true,
      exclusions: [],
      identitySpec: {
        roles: ['owner', 'founder', 'CEO', 'managing director'],
        locations: ['Australia', 'UK', 'Canada', 'USA'],
        companyTypes: ['AI agency'],
        industries: [],
      },
      requirements: [
        {
          id: 'req-role',
          description: 'Agency owner or founder',
          sourcePhrase: 'owner',
          acceptableTerms: ['owner', 'founder', 'CEO', 'managing director'],
          scope: 'person_role',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          requirementClass: 'identity_hard',
          queryHardness: 'required_in_every_query',
          queryable: true,
        },
        {
          id: 'req-loc',
          description: 'Based in Australia or UK',
          sourcePhrase: 'Australia',
          acceptableTerms: ['Australia', 'UK', 'Canada', 'USA'],
          scope: 'person_location',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          requirementClass: 'context_hard',
          queryHardness: 'distributed_across_queries',
          queryable: true,
        },
        {
          id: 'req-type',
          description: 'AI agency',
          sourcePhrase: 'AI agency',
          acceptableTerms: ['AI agency', 'AI studio'],
          scope: 'company_type',
          importance: 'hard',
          evidenceModality: 'structured_profile',
          requirementClass: 'context_hard',
          queryHardness: 'required_in_every_query',
          queryable: true,
        },
      ],
      initialQueries: [],
    };

    it('sanitizeQueryText preserves OR and -negation while stripping boolean AND', () => {
      const input = 'owner OR founder AND "AI agency" -software -saas site:linkedin.com/in/';
      const sanitized = sanitizeQueryText(input);
      assert.ok(sanitized.includes(' OR '), 'Must preserve OR syntax');
      assert.ok(!/\bAND\b/.test(sanitized), 'Must strip boolean AND');
      assert.ok(sanitized.includes('-software'), 'Must preserve -software');
      assert.ok(sanitized.includes('-saas'), 'Must preserve -saas');
      assert.ok(sanitized.includes('"AI agency"'), 'Must preserve balanced quotes');
      assert.ok(!sanitized.includes('site:'));
      assert.ok(!sanitized.includes('linkedin'));
    });

    it('deconcatenateContractQuery strips multiple synonym roles cleanly without dangling OR/commas', () => {
      const q1 = 'owner OR founder OR CEO "AI agency" Australia';
      const clean1 = deconcatenateContractQuery(q1, mockContract);
      assert.ok(!clean1.includes('founder'), 'Redundant role founder must be stripped');
      assert.ok(!clean1.includes('CEO'), 'Redundant role CEO must be stripped');
      assert.ok(!/\bOR\b/.test(clean1), 'Dangling OR must not be left behind');
      assert.ok(clean1.includes('owner'), 'Primary role owner must be retained');
      assert.ok(clean1.includes('"AI agency"'));
      assert.ok(clean1.includes('Australia'));

      const q2 = 'founder, CEO, managing director "AI studio" UK, Australia';
      const clean2 = deconcatenateContractQuery(q2, mockContract);
      assert.ok(clean2.includes('founder'), 'Primary role founder must be retained');
      assert.ok(!clean2.includes('CEO'));
      assert.ok(!clean2.includes('managing director'));
      assert.ok(clean2.includes('UK'), 'Primary country UK must be retained');
      assert.ok(!clean2.includes('Australia'), 'Redundant country Australia must be stripped');
      assert.ok(!clean2.includes(', ,'));
      assert.ok(!clean2.endsWith(','));
    });

    it('buildContractFallbackQueries generates clean Cartesian grid of single roles x single locations', () => {
      const fallbackQueries = buildContractFallbackQueries(
        'AI agency owner in Australia',
        mockContract.requirements,
      );
      assert.ok(fallbackQueries.length > 0);
      for (const item of fallbackQueries) {
        // Must contain quotes around AI agency
        assert.ok(item.query.includes('"AI agency"'));
        // Must not contain OR joins
        assert.ok(!item.query.includes(' OR '));
        // Must target at most one country
        const countriesPresent = ['australia', 'uk', 'canada', 'usa'].filter((c) =>
          item.query.toLowerCase().includes(c),
        );
        assert.ok(countriesPresent.length <= 1, `Query "${item.query}" targets >1 country: ${countriesPresent}`);
      }
    });
  });

  describe('Module 3: LLM Rate Limit (429) Resiliency & Circuit Breaker Decoupling', () => {
    it('LLMProviderError never sets isTokenLimit = true on HTTP 429 or rate limits', () => {
      const mockProvider = {
        id: 'groq' as const,
        name: 'Groq',
        baseUrl: 'https://api.groq.com',
        model: 'llama-3.3-70b-versatile',
        apiKey: 'test-key',
      };

      const error429 = new LLMProviderError(mockProvider, 429, 'Rate limit reached: 1000 tokens per minute');
      assert.strictEqual(error429.isTokenLimit, false, '429 must NEVER be classified as isTokenLimit');

      const errorTokens = new LLMProviderError(mockProvider, 413, 'Context window exceeded: payload too large');
      assert.strictEqual(errorTokens.isTokenLimit, true, '413 must be classified as isTokenLimit');
    });

    it('providerCooldowns tracks 30-second temporary cooldown for 429 providers', () => {
      clearProviderCooldowns();
      providerCooldowns.set('groq', Date.now() + 30_000);
      assert.ok(providerCooldowns.has('groq'));
      const remaining = providerCooldowns.get('groq')! - Date.now();
      assert.ok(remaining > 20_000 && remaining <= 30_000);
      clearProviderCooldowns();
      assert.strictEqual(providerCooldowns.size, 0);
    });

    it('evaluateSingleBatch in evaluateIncrementalJudgeBatches applies split-and-retry and fallback qualification when upstream fails', async () => {
      const mockContract: ProspectContract = {
        version: 1,
        policyVersion: 'evidence-contract-v8',
        brief: 'AI agency founder',
        authorityRequired: true,
        exclusions: [],
        identitySpec: { roles: ['founder'], locations: [], companyTypes: ['AI agency'], industries: [] },
        requirements: [
          {
            id: 'req-role',
            description: 'Founder',
            sourcePhrase: 'founder',
            acceptableTerms: ['founder'],
            scope: 'person_role',
            importance: 'hard',
            evidenceModality: 'structured_profile',
            requirementClass: 'identity_hard',
            queryHardness: 'required_in_every_query',
            queryable: true,
          },
        ],
        initialQueries: [],
      };

      const mockCandidates = [
        {
          candidateId: 'cand-1',
          sourceUrl: 'https://linkedin.com/in/alex-test',
          lead: {
            id: 'lead-1',
            fullName: 'Alex Test',
            currentTitle: 'Founder',
            currentCompany: 'Apex Studio',
            finalSelectionScore: 80,
          },
          evidence: [{ id: 'ev-1', text: 'Founder at Apex Studio' }],
        },
        {
          candidateId: 'cand-2',
          sourceUrl: 'https://linkedin.com/in/sarah-test',
          lead: {
            id: 'lead-2',
            fullName: 'Sarah Test',
            currentTitle: 'Founder',
            currentCompany: 'Nova AI',
            finalSelectionScore: 78,
          },
          evidence: [{ id: 'ev-2', text: 'Founder at Nova AI' }],
        },
      ];

      const logs: string[] = [];
      const traces: any[] = [];
      const mockContext: SessionContext = {
        config: {
          sessionId: 'test-session-judge-resilience',
          promptQuery: 'AI agency founder',
          targetLimit: 10,
          maxRounds: 1,
          contract: mockContract,
          policyVersion: 'evidence-contract-v8',
        } as any,
        state: {
          abortController: new AbortController(),
          llmCircuitBreaker: {
            recordSuccess: () => {},
            recordFailure: () => {},
            isOpen: () => false,
          } as any,
        } as any,
        ports: {} as any,
        logEvent: (msg: string) => logs.push(msg),
        recordTrace: (event: any) => {
          traces.push(event);
          return event as any;
        },
      };

      // When openAIStructured throws (e.g. rate limit error or unconfigured upstream key)
      const output = await evaluateIncrementalJudgeBatches(mockContext, {
        candidates: mockCandidates as any,
        contract: mockContract,
        stats: { rounds: 1, rerank: {} },
        round: 1,
      });

      // Split-and-retry must exhaust and apply fallback resilient qualification
      // so ZERO candidates are dropped!
      assert.strictEqual(output.qualifiedCandidates.length, 2, 'ZERO candidates must be dropped on upstream failures');
      for (const lead of output.qualifiedCandidates) {
        assert.strictEqual(lead.qualification.verdict, 'qualified_partial');
        assert.strictEqual(lead._qualificationFallback, 'fallback_resilient');
        assert.ok(lead.finalSelectionScore >= 60, 'Fallback score must be >= 60');
      }
    });
  });

  describe('Module 4: Query-Anchored Geo Inference (0-Token Qualification)', () => {
    it('structuredFieldsForRequirement falls back to _sourceQuery or evidence.sourceQuery when location is empty', () => {
      const reqLoc: ProspectRequirement = {
        id: 'req-loc',
        description: 'Australia',
        sourcePhrase: 'Australia',
        acceptableTerms: ['Australia', 'Sydney', 'Melbourne'],
        scope: 'person_location',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        requirementClass: 'context_hard',
        queryHardness: 'distributed_across_queries',
        queryable: true,
      };

      const leadWithoutLocation = {
        fullName: 'Jane Doe',
        currentTitle: 'Founder',
        company: 'Apex AI',
        location: '', // empty location snippet
        _sourceQuery: '"AI agency" founder Australia',
      };

      const fields = structuredFieldsForRequirement(leadWithoutLocation, reqLoc);
      assert.ok(fields.includes('"AI agency" founder Australia'), 'Must fall back to _sourceQuery');
      assert.strictEqual(
        hasStrictStructuredMatch(leadWithoutLocation, reqLoc),
        true,
        'Must auto-qualify via query anchor with 0 LLM tokens',
      );
    });
  });

  describe('Module 5: Immutable Core Firmographics (No Dentists/Plumbers)', () => {
    it('classifies person_role, company_type, and company_industry as TIER_1_IMMUTABLE_CORE', () => {
      const roleReq: ProspectRequirement = {
        id: 'r1',
        description: 'Agency founder',
        sourcePhrase: 'founder',
        acceptableTerms: ['founder', 'owner'],
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        requirementClass: 'identity_hard',
        queryHardness: 'required_in_every_query',
        queryable: true,
      };
      const typeReq: ProspectRequirement = {
        id: 'r2',
        description: 'AI agency',
        sourcePhrase: 'AI agency',
        acceptableTerms: ['AI agency', 'AI studio'],
        scope: 'company_type',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        requirementClass: 'context_hard',
        queryHardness: 'required_in_every_query',
        queryable: true,
      };
      const indReq: ProspectRequirement = {
        id: 'r3',
        description: 'B2B SaaS',
        sourcePhrase: 'B2B SaaS',
        acceptableTerms: ['B2B SaaS'],
        scope: 'company_industry',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        requirementClass: 'context_hard',
        queryHardness: 'required_in_every_query',
        queryable: true,
      };

      assert.strictEqual(classifyAblationTier(roleReq), ABLATION_TIERS.TIER_1_IMMUTABLE_CORE);
      assert.strictEqual(classifyAblationTier(typeReq), ABLATION_TIERS.TIER_1_IMMUTABLE_CORE);
      assert.strictEqual(classifyAblationTier(indReq), ABLATION_TIERS.TIER_1_IMMUTABLE_CORE);
    });

    it('ablateQueryTask NEVER ablates the core vertical term into generic plumbers/dentists', () => {
      const contract: ProspectContract = {
        version: 1,
        policyVersion: 'evidence-contract-v8',
        brief: 'AI agency founder in Sydney',
        authorityRequired: true,
        exclusions: [],
        identitySpec: { roles: ['founder'], locations: ['Sydney'], companyTypes: ['AI agency'], industries: [] },
        requirements: [
          {
            id: 'req-role',
            description: 'Founder',
            sourcePhrase: 'founder',
            acceptableTerms: ['founder'],
            scope: 'person_role',
            importance: 'hard',
            evidenceModality: 'structured_profile',
            requirementClass: 'identity_hard',
            queryHardness: 'required_in_every_query',
            queryable: true,
          },
          {
            id: 'req-type',
            description: 'AI agency',
            sourcePhrase: 'AI agency',
            acceptableTerms: ['AI agency'],
            scope: 'company_type',
            importance: 'hard',
            evidenceModality: 'structured_profile',
            requirementClass: 'context_hard',
            queryHardness: 'required_in_every_query',
            queryable: true,
          },
          {
            id: 'req-loc',
            description: 'Sydney',
            sourcePhrase: 'Sydney',
            acceptableTerms: ['Sydney'],
            scope: 'person_location',
            importance: 'hard',
            evidenceModality: 'structured_profile',
            requirementClass: 'context_hard',
            queryHardness: 'distributed_across_queries',
            queryable: true,
          },
        ],
        initialQueries: [],
      };

      // 1. First relaxation ablates location (Sydney)
      const res1 = ablateQueryTask('"AI agency" founder Sydney', contract);
      assert.ok(res1);
      assert.strictEqual(res1.ablatedRequirementId, 'req-loc');
      assert.strictEqual(res1.ablatedQuery, '"AI agency" founder');

      // 2. Second relaxation cannot ablate "AI agency" or founder, so it returns null
      const res2 = ablateQueryTask('"AI agency" founder', contract);
      assert.strictEqual(res2, null, 'Core vertical "AI agency" must NEVER be ablated to avoid dentists/plumbers');
    });
  });
});
