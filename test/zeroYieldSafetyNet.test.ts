import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeJudgeStage } from '../server/leadSearch/stages/judgeStage.js';
import { buildDeterministicProspectContract } from '../server/leadSearch/prospectContract.js';

describe('Zero-Yield Prevention & Starvation Safety Net', () => {
  it('rescues high-scoring accepted candidates when all candidates receive hard_fail from strict judge', async () => {
    const contract = buildDeterministicProspectContract('AI agency owner/founder from USA');
    
    const acceptedLeads = [
      {
        fullName: 'Roberto Martinez',
        currentTitle: 'CEO',
        currentCompany: 'Braven Agency',
        location: 'Los Angeles, CA, USA',
        contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/robthemarketer' },
        scout: { corroborationScore: 8, criteriaCoverageScore: 8 },
        scoreBreakdown: {
          fitScore: 7,
          intentScore: 6,
          timingScore: 6,
          evidenceQualityScore: 8,
          sourceConfidenceScore: 7,
          finalScore: 7.2
        }
      },
      {
        fullName: 'Jane Doe',
        currentTitle: 'Founder',
        currentCompany: 'Apex AI Studio',
        location: 'New York, NY, USA',
        contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/janedoe' },
        scout: { corroborationScore: 9, criteriaCoverageScore: 9 },
        scoreBreakdown: {
          fitScore: 8,
          intentScore: 7,
          timingScore: 7,
          evidenceQualityScore: 9,
          sourceConfidenceScore: 8,
          finalScore: 8.1
        }
      }
    ];

    const qualifiedLeads: any[] = [];
    const debugLogs: any[] = [];
    const sessionLogs: string[] = [];

    const mockCtx: any = {
      config: {
        sessionId: 'test-session-123',
        promptQuery: 'AI agency owner/founder from USA',
        targetLimit: 5,
        judgeConcurrency: 1
      },
      state: {
        acceptedLeads,
        qualifiedLeads,
        llmCircuitBreaker: { failureCounts: {}, disabledProviderIds: new Set(), failureThreshold: 2 },
        debugLogs,
        abortController: new AbortController()
      },
      ports: {},
      logEvent: (msg: string) => sessionLogs.push(msg),
      recordTrace: () => {}
    };

    // Simulate judgeStage input where LLM judging produces zero direct qualifications
    // (mocking the judge queue or running deterministic partition)
    const stats: any = { rerank: {} };
    const evidenceByUrl = new Map<string, any>();
    evidenceByUrl.set('https://www.linkedin.com/in/robthemarketer', {
      evidenceBlock: 'CEO of Braven Agency based in Los Angeles, CA.',
      evidenceQuality: 'high',
      sourceProvider: 'tavily',
      sourceUrl: 'https://www.linkedin.com/in/robthemarketer',
      sourceQuery: 'AI agency owner USA',
      sourceRound: 1
    });
    evidenceByUrl.set('https://www.linkedin.com/in/janedoe', {
      evidenceBlock: 'Founder of Apex AI Studio in New York, NY.',
      evidenceQuality: 'high',
      sourceProvider: 'tavily',
      sourceUrl: 'https://www.linkedin.com/in/janedoe',
      sourceQuery: 'AI agency founder USA',
      sourceRound: 1
    });

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    judgments: [
                      {
                        candidateIndex: 0,
                        verdict: 'hard_fail',
                        confidence: 9,
                        reason: 'Fails strict criteria for test',
                        evidencePassage: '',
                        overallScore: 2.0,
                      },
                      {
                        candidateIndex: 1,
                        verdict: 'hard_fail',
                        confidence: 9,
                        reason: 'Fails strict criteria for test',
                        evidencePassage: '',
                        overallScore: 2.0,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          text: async () => '',
        } as any;
      };

      await executeJudgeStage(mockCtx, {
        contract,
        evidenceByUrl,
        stats,
        checkpointAcceptedLeads: () => {},
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(qualifiedLeads.length > 0, `Expected at least 1 rescued lead, got ${qualifiedLeads.length}`);
    assert.equal(qualifiedLeads.length, 2, 'Should rescue both available candidates');
    assert.ok(qualifiedLeads.some(l => l.fullName === 'Jane Doe'));
    assert.ok(qualifiedLeads.some(l => l.fullName === 'Roberto Martinez'));
    assert.ok(qualifiedLeads.every(l => l.qualification?.verdict === 'qualified' || l.qualification?.verdict === 'rescued' || l.qualification?.verdict === 'qualified_partial'));
  });
});
