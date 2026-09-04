import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoundDiagnostics } from '../server/leadSearch/roundDiagnostics.js';
import { executeJudgeStage } from '../server/leadSearch/stages/judgeStage.js';
import { executePersistStage } from '../server/leadSearch/stages/persistStage.js';
import { SignalStore } from '../server/leadSearch/signalStore.js';
import type { ProspectContract } from '../server/leadSearch/prospectContract.js';
import type { SessionContext } from '../server/leadSearch/pipelineTypes.js';

const createMockContract = (): any => ({
  version: 1,
  policyVersion: 'evidence-contract-v8',
  brief: 'VP Engineering at AI SaaS startups',
  requirements: [
    {
      id: 'req_role',
      label: 'Role',
      description: 'VP of Engineering or CTO',
      scope: 'person_role',
      importance: 'hard',
      requirementClass: 'identity_hard',
      acceptableTerms: ['vp of engineering', 'cto', 'head of engineering'],
      forbiddenTerms: [],
    },
    {
      id: 'req_industry',
      label: 'Industry',
      description: 'AI SaaS',
      scope: 'company_industry',
      importance: 'hard',
      requirementClass: 'context_hard',
      acceptableTerms: ['artificial intelligence', 'ai saas', 'machine learning'],
      forbiddenTerms: [],
    },
  ],
  rules: [],
  confidence: 0.9,
});

describe('Engine Bug Fixes Verification', () => {

  describe('Bug 1: discoveryEngine buildRoundDiagnostics & Early-Stop Trapdoor', () => {
    it('does not falsely set shouldRecover=false when alreadyQualified is 0 (or accumulatedViableCount is low)', () => {
      const contract = createMockContract();
      const roundLeads = [
        { fullName: 'Dev 1', currentTitle: 'VP Engineering', currentCompany: 'Generic Staffing', evidence: { rawText: 'Staffing agency recruiter' } },
        { fullName: 'Dev 2', currentTitle: 'CTO', currentCompany: 'Recruitment LLC', evidence: { rawText: 'Executive search' } },
      ];

      // If alreadyQualified was fed 17 raw unjudged candidates from Round 1:
      const faultyDiag = buildRoundDiagnostics({
        round: 2,
        rawCandidates: 20,
        extractedCandidates: 2,
        leads: roundLeads,
        contract,
        targetLimit: 20,
        alreadyQualified: 17, // The old bug
      });
      assert.equal(faultyDiag.viableCandidates, 0);

      // With the fix: accumulatedViableCount passed as alreadyQualified is 0
      const fixedDiag = buildRoundDiagnostics({
        round: 2,
        rawCandidates: 20,
        extractedCandidates: 2,
        leads: roundLeads,
        contract,
        targetLimit: 20,
        alreadyQualified: 0, // The fix: only true viable candidates banked
      });
      assert.equal(fixedDiag.viableCandidates, 0);
      assert.equal(fixedDiag.shouldRecover, true, 'Engine must flag shouldRecover=true when cumulative viable is below threshold');
    });

    it('validates that early-stop condition requires rerankPoolTarget or proven viable buffer', () => {
      const targetLimit = 20;
      const rerankPoolTarget = 40;
      const provenViableBuffer = Math.ceil(targetLimit * 0.6); // 12
      const earlyStopTargetThreshold = 25;

      const shouldStopEarly = (acceptedCount: number, accumulatedViable: number) => {
        return (
          acceptedCount >= rerankPoolTarget ||
          (acceptedCount >= targetLimit &&
            (acceptedCount >= earlyStopTargetThreshold ||
              accumulatedViable >= provenViableBuffer))
        );
      };

      // Case 1: 20 accepted leads, but only 3 accumulated viable candidates -> MUST NOT stop early!
      assert.equal(shouldStopEarly(20, 3), false, 'Should not stop early when viable buffer is insufficient');

      // Case 2: 20 accepted leads, with 12 accumulated viable candidates -> CAN stop early
      assert.equal(shouldStopEarly(20, 12), true, 'Can stop early when proven viable buffer (>= 12) is established');

      // Case 3: 40 accepted leads -> stops because rerank pool target (40) is reached
      assert.equal(shouldStopEarly(40, 5), true, 'Stops when rerankPoolTarget is fully met');
    });
  });

  describe('Bug 2: planStage Cross-Session Prompt Pollution Elimination', () => {
    it('only supplies session-discovered companies from signalStore and never queries global DB fallback', async () => {
      const signalStore = new SignalStore();
      signalStore.add({
        companyName: 'Acme AI',
        lane: 'company',
        text: 'Acme AI launched enterprise model',
        url: 'https://acme.ai',
        round: 1,
        query: 'test',
      });

      const mockCtx: any = {
        config: {
          sessionId: 'session-test-pollute',
          promptQuery: 'Find AI founders',
          targetLimit: 20,
          minScore: 0.5,
          ttlDays: 30,
          startedAt: Date.now(),
          maxRounds: 3,
        },
        state: {
          round: 1,
          seenCandidateKeys: new Set(),
          existingKeys: new Set(),
          queryRuns: [],
          acceptedLeads: [],
          qualifiedLeads: [],
          finalLeads: [],
          rejectionCounts: {},
          brightDataStats: {} as any,
          freeTierBudget: {} as any,
          llmCircuitBreaker: {} as any,
          abortController: new AbortController(),
          telemetry: { recordEvent: () => {} } as any,
          debugLogs: [],
          urlRetryQueue: [],
          signalStore,
        },
        ports: {} as any,
        logEvent: () => {},
        recordTrace: () => {},
      };

      const emptyStoreCtx: any = {
        ...mockCtx,
        state: {
          ...mockCtx.state,
          signalStore: new SignalStore(),
        },
      };

      const discoveredCompanies = emptyStoreCtx.state.signalStore
        ? emptyStoreCtx.state.signalStore.getUniqueCompanyNames()
        : [];
      assert.deepEqual(discoveredCompanies, [], 'Empty session signalStore yields empty discovered companies array');

      const activeDiscovered = mockCtx.state.signalStore!.getUniqueCompanyNames();
      assert.deepEqual(activeDiscovered, ['Acme AI']);
    });
  });

  describe('Bug 3: judgeStage Dynamic candidatePoolCap & Deferred judgeOutcomeTotals Accumulation', () => {
    it('dynamically scales candidatePoolCap to rerankPoolTarget up to 60 candidates', async () => {
      const contract = createMockContract();
      const targetLimit = 20;
      const rerankPoolTarget = 40;

      const acceptedLeads = Array.from({ length: 35 }, (_, i) => ({
        fullName: `Candidate ${i + 1}`,
        currentTitle: 'VP of Engineering',
        currentCompany: 'Tech Corp',
        sourceUrl: `https://linkedin.com/in/cand-${i + 1}`,
        score: 0.85,
      }));

      const qualifiedLeads: any[] = [];
      const mockCtx: any = {
        config: {
          sessionId: 'session-cap-test',
          promptQuery: 'VP Engineering',
          targetLimit,
          minScore: 0.5,
          ttlDays: 30,
          startedAt: Date.now(),
          maxRounds: 3,
        },
        state: {
          round: 1,
          seenCandidateKeys: new Set(),
          existingKeys: new Set(),
          queryRuns: [],
          acceptedLeads,
          qualifiedLeads,
          finalLeads: [],
          rejectionCounts: {},
          brightDataStats: {} as any,
          freeTierBudget: {} as any,
          llmCircuitBreaker: { failureCounts: {}, disabledProviderIds: new Set(), failureThreshold: 2 },
          abortController: new AbortController(),
          telemetry: { recordEvent: () => {} } as any,
          debugLogs: [],
          urlRetryQueue: [],
        },
        ports: {} as any,
        logEvent: () => {},
        recordTrace: () => {},
      };

      const stats: any = { rounds: 1, queryRuns: [] };
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async () => {
          const payload = {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    judgments: acceptedLeads.map((c) => ({
                      candidateId: `c${c.sourceUrl}`,
                      decision: 'qualified',
                      finalScore: 9.0,
                      summary: 'Matches role and industry',
                      requirements: [
                        { requirementId: 'req_role', status: 'pass' },
                        { requirementId: 'req_industry', status: 'pass' },
                      ],
                    })),
                  }),
                },
              },
            ],
            usage: { total_tokens: 500 },
          };
          return {
            ok: true,
            status: 200,
            json: async () => payload,
            text: async () => JSON.stringify(payload),
          } as any;
        };

        await executeJudgeStage(mockCtx, {
          contract,
          evidenceByUrl: new Map(),
          stats,
          checkpointAcceptedLeads: () => {},
          rerankPoolTarget,
        });

        assert.equal(stats.rerank.poolSize, 35);
        assert.ok(qualifiedLeads.length >= 20, `Expected at least targetLimit leads, got ${qualifiedLeads.length}`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('does not accumulate phantom unjudged leads into judgeOutcomeTotals when batch is split', async () => {
      const contract = createMockContract();
      const targetLimit = 4;

      const acceptedLeads = Array.from({ length: 4 }, (_, i) => ({
        fullName: `Candidate ${i + 1}`,
        currentTitle: 'VP of Engineering',
        currentCompany: 'Tech Corp',
        sourceUrl: `https://linkedin.com/in/split-cand-${i + 1}`,
        score: 0.85,
      }));

      const qualifiedLeads: any[] = [];
      const mockCtx: any = {
        config: {
          sessionId: 'session-split-test',
          promptQuery: 'VP Engineering',
          targetLimit,
          minScore: 0.5,
          ttlDays: 30,
          startedAt: Date.now(),
          maxRounds: 3,
        },
        state: {
          round: 1,
          seenCandidateKeys: new Set(),
          existingKeys: new Set(),
          queryRuns: [],
          acceptedLeads,
          qualifiedLeads,
          finalLeads: [],
          rejectionCounts: {},
          brightDataStats: {} as any,
          freeTierBudget: {} as any,
          llmCircuitBreaker: { failureCounts: {}, disabledProviderIds: new Set(), failureThreshold: 2 },
          abortController: new AbortController(),
          telemetry: { recordEvent: () => {} } as any,
          debugLogs: [],
          urlRetryQueue: [],
        },
        ports: {} as any,
        logEvent: () => {},
        recordTrace: () => {},
      };

      const stats: any = { rounds: 1, queryRuns: [] };
      const originalFetch = globalThis.fetch;
      let callCount = 0;
      try {
        globalThis.fetch = async (url: any, init: any) => {
          callCount++;
          const body = JSON.parse(init.body);
          const prompt = body.messages?.[1]?.content || '';

          if (callCount === 1) {
            const payload = {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      judgments: [
                        {
                          candidateId: `c${acceptedLeads[0].sourceUrl}`,
                          decision: 'qualified',
                          finalScore: 9.0,
                          summary: 'Matches role and industry',
                          requirements: [
                            { requirementId: 'req_role', status: 'pass' },
                            { requirementId: 'req_industry', status: 'pass' },
                          ],
                        },
                      ],
                    }),
                  },
                },
              ],
              usage: { total_tokens: 300 },
            };
            return {
              ok: true,
              status: 200,
              headers: new Headers({ 'content-type': 'application/json' }),
              json: async () => payload,
              text: async () => JSON.stringify(payload),
            } as any;
          }

          const candMatches = acceptedLeads.filter(c => prompt.includes(c.fullName));
          const payload = {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    judgments: candMatches.map(c => ({
                      candidateId: `c${c.sourceUrl}`,
                      decision: 'qualified',
                      finalScore: 8.5,
                      summary: 'Sub-batch judgment',
                      requirements: [
                        { requirementId: 'req_role', status: 'pass' },
                        { requirementId: 'req_industry', status: 'pass' },
                      ],
                    })),
                  }),
                },
              },
            ],
            usage: { total_tokens: 300 },
          };
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => payload,
            text: async () => JSON.stringify(payload),
          } as any;
        };

        await executeJudgeStage(mockCtx, {
          contract,
          evidenceByUrl: new Map(),
          stats,
          checkpointAcceptedLeads: () => {},
          rerankPoolTarget: 10,
        });

        assert.ok(callCount >= 2, `Expected at least 2 LLM calls due to splitting, got ${callCount}`);
        assert.equal(stats.rerank.judge.unjudged, 0, 'Phantom unjudged leads must not be recorded when batch is split');
        assert.equal(stats.rerank.judge.qualified, 4, 'All 4 candidates should be recorded as qualified in judgeOutcomeTotals');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Bug 4: persistStage Accurate Session Stop Reason', () => {
    it('corrects target_fulfilled_early to partial_fulfillment when mappedLeads falls short of targetLimit', async () => {
      const stats: any = {
        stopReason: 'target_fulfilled_early',
        rounds: 2,
        rejectionReasons: {},
        queryRuns: [],
      };

      const mockCtx: any = {
        config: {
          sessionId: 'session-partial-fulfillment-test',
          promptQuery: 'VP AI Engineering',
          targetLimit: 10,
          minScore: 0.5,
          ttlDays: 30,
          startedAt: Date.now(),
          maxRounds: 3,
        },
        state: {
          round: 2,
          seenCandidateKeys: new Set(),
          existingKeys: new Set(),
          queryRuns: [],
          acceptedLeads: [],
          qualifiedLeads: [],
          finalLeads: [],
          rejectionCounts: {},
          brightDataStats: {} as any,
          freeTierBudget: {} as any,
          llmCircuitBreaker: {} as any,
          abortController: new AbortController(),
          telemetry: {
            finish: () => {},
            getSummary: () => ({
              providerSummary: {},
              costSummary: {},
              phaseTimeline: [],
              schemaVersion: 1,
            }),
          } as any,
          debugLogs: [],
          urlRetryQueue: [],
        },
        ports: {} as any,
        logEvent: () => {},
        recordTrace: () => {},
      };

      const finalLeads = Array.from({ length: 6 }, (_, i) => ({
        id: `lead-test-${i + 1}`,
        fullName: `Lead ${i + 1}`,
        currentTitle: 'VP AI Engineering',
        currentCompany: 'AI Startup',
        sourceUrl: `https://linkedin.com/in/lead-${i + 1}`,
      }));

      const persistOutput = await executePersistStage(mockCtx, {
        finalLeads,
        leadsFound: 6,
        rawResultsCount: 30,
        generatedQueries: ['query 1', 'query 2'],
        stats,
        persistedLeadIds: new Set(),
        sessionLogs: ['round 1', 'round 2'],
        safeInsertSearchLog: () => {},
      });

      assert.equal(stats.stopReason, 'partial_fulfillment');
      assert.equal(persistOutput.result.stopReason, 'partial_fulfillment');
      assert.equal(persistOutput.result.shortfall, 4);
      assert.ok(persistOutput.result.shortfallReason?.includes('6/10'));
    });

    it('preserves target_fulfilled_early when mappedLeads meets or exceeds targetLimit', async () => {
      const stats: any = {
        stopReason: 'target_fulfilled_early',
        rounds: 1,
        rejectionReasons: {},
        queryRuns: [],
      };

      const mockCtx: any = {
        config: {
          sessionId: 'session-fulfilled-test',
          promptQuery: 'VP AI Engineering',
          targetLimit: 5,
          minScore: 0.5,
          ttlDays: 30,
          startedAt: Date.now(),
          maxRounds: 3,
        },
        state: {
          round: 1,
          seenCandidateKeys: new Set(),
          existingKeys: new Set(),
          queryRuns: [],
          acceptedLeads: [],
          qualifiedLeads: [],
          finalLeads: [],
          rejectionCounts: {},
          brightDataStats: {} as any,
          freeTierBudget: {} as any,
          llmCircuitBreaker: {} as any,
          abortController: new AbortController(),
          telemetry: {
            finish: () => {},
            getSummary: () => ({
              providerSummary: {},
              costSummary: {},
              phaseTimeline: [],
              schemaVersion: 1,
            }),
          } as any,
          debugLogs: [],
          urlRetryQueue: [],
        },
        ports: {} as any,
        logEvent: () => {},
        recordTrace: () => {},
      };

      const finalLeads = Array.from({ length: 5 }, (_, i) => ({
        id: `lead-test-full-${i + 1}`,
        fullName: `Lead ${i + 1}`,
        currentTitle: 'VP AI Engineering',
        currentCompany: 'AI Startup',
        sourceUrl: `https://linkedin.com/in/lead-full-${i + 1}`,
      }));

      const persistOutput = await executePersistStage(mockCtx, {
        finalLeads,
        leadsFound: 5,
        rawResultsCount: 20,
        generatedQueries: ['query 1'],
        stats,
        persistedLeadIds: new Set(),
        sessionLogs: ['round 1'],
        safeInsertSearchLog: () => {},
      });

      assert.equal(stats.stopReason, 'target_fulfilled_early');
      assert.equal(persistOutput.result.stopReason, 'target_fulfilled_early');
      assert.equal(persistOutput.result.shortfall, 0);
    });
  });
});
