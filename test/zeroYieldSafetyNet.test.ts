import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  executeJudgeStage,
  isEligibleForSafetyNet,
} from '../server/leadSearch/stages/judgeStage.js';
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
    const originalSafetyNet = process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION;
    process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION = 'true';
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
      if (originalSafetyNet !== undefined) {
        process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION = originalSafetyNet;
      } else {
        delete process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION;
      }
    }

    assert.ok(qualifiedLeads.length > 0, `Expected at least 1 rescued lead, got ${qualifiedLeads.length}`);
    assert.equal(qualifiedLeads.length, 2, 'Should rescue both available candidates');
    assert.ok(qualifiedLeads.some(l => l.fullName === 'Jane Doe'));
    assert.ok(qualifiedLeads.some(l => l.fullName === 'Roberto Martinez'));
    assert.ok(qualifiedLeads.every(l => l.qualification?.verdict === 'qualified' || l.qualification?.verdict === 'rescued' || l.qualification?.verdict === 'qualified_partial'));
  });

  it('does NOT rescue unverified candidates when ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION is not set (default honest shortfall)', async () => {
    const contract = buildDeterministicProspectContract('AI agency owner/founder from USA');
    const acceptedLeads = [
      {
        fullName: 'Roberto Martinez',
        currentTitle: 'Director of Partnerships',
        currentCompany: 'Braven Agency',
        location: 'Los Angeles, CA, USA',
        contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/robthemarketer' },
        scout: { corroborationScore: 8, criteriaCoverageScore: 8 },
        scoreBreakdown: { fitScore: 7, intentScore: 6, timingScore: 6, evidenceQualityScore: 8, sourceConfidenceScore: 7, finalScore: 7.2 }
      }
    ];
    const qualifiedLeads: any[] = [];
    const mockCtx: any = {
      config: { sessionId: 'test-session-456', promptQuery: 'AI agency owner/founder from USA', targetLimit: 5, judgeConcurrency: 1 },
      state: { acceptedLeads, qualifiedLeads, llmCircuitBreaker: { failureCounts: {}, disabledProviderIds: new Set(), failureThreshold: 2 }, debugLogs: [], abortController: new AbortController() },
      ports: {},
      logEvent: () => {},
      recordTrace: () => {}
    };
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

    const originalFetch = globalThis.fetch;
    const originalSafetyNet = process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION;
    delete process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION;
    try {
      globalThis.fetch = async (_url: any, opts: any) => {
        let candidateId = 'clinkedin.com/in/robthemarketer';
        try {
          const body = JSON.parse(opts?.body || '{}');
          const prompt = body?.messages?.[1]?.content || '';
          const m = prompt.match(/### (c[^\s\n]+)/);
          if (m) candidateId = m[1];
        } catch {}
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  judgments: [{
                    candidateId,
                    requirements: contract.requirements.map((r: any) => ({ requirementId: r.id, status: 'fail', reason: 'Fails test' })),
                    semanticFit: 1,
                    authorityFit: 1,
                    evidenceConfidence: 1,
                    reason: 'Fails strict criteria'
                  }]
                })
              }
            }]
          }),
          text: async () => ''
        } as any;
      };

      await executeJudgeStage(mockCtx, {
        contract,
        evidenceByUrl,
        stats,
        checkpointAcceptedLeads: () => {}
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalSafetyNet !== undefined) {
        process.env.ENABLE_UNVERIFIED_SAFETY_NET_PROMOTION = originalSafetyNet;
      }
    }

    assert.equal(qualifiedLeads.length, 0, 'Must NOT rescue failed leads by default');
  });
});

describe('isEligibleForSafetyNet (shared safety-net eligibility core)', () => {
  // The live safety net in discoveryEngine.ts:2086 calls this helper. Before 2026-09-16 the
  // same three checks were duplicated inline at that call site while this exported helper had
  // no production caller at all, so the rule had two definitions and only the dead one was
  // covered. These assertions pin the shared rule itself.
  //
  // A permissive contract is used deliberately: with the agency contract below,
  // checkStrictContradiction() returns non-null for any minimal lead, so the helper would
  // return false at the contradiction branch and every later assertion would pass vacuously.
  const permissiveContract = {
    brief: 'software engineers',
    requirements: [],
    exclusions: [],
    policyVersion: 'test',
  } as any;
  const plainLead = { currentTitle: 'CEO', fullName: 'Jane Doe' };

  it('admits a lead with no disqualifying signal', () => {
    assert.equal(isEligibleForSafetyNet(plainLead, permissiveContract, null), true);
  });

  it('rejects auto-failed leads', () => {
    assert.equal(
      isEligibleForSafetyNet({ ...plainLead, _autoFailed: true }, permissiveContract, null),
      false,
    );
  });

  it('rejects leads whose judge insight is hard_fail', () => {
    // Assert the otherwise-eligible baseline first, so this cannot pass vacuously via the
    // contradiction branch.
    assert.equal(isEligibleForSafetyNet(plainLead, permissiveContract, null), true);
    assert.equal(
      isEligibleForSafetyNet(plainLead, permissiveContract, { status: 'hard_fail' }),
      false,
    );
  });

  it('admits a non-hard_fail insight', () => {
    assert.equal(
      isEligibleForSafetyNet(plainLead, permissiveContract, { status: 'qualified', score: 8 }),
      true,
    );
  });

  it('treats an absent insight as eligible (third argument is optional)', () => {
    assert.equal(isEligibleForSafetyNet(plainLead, permissiveContract, undefined), true);
    assert.equal(isEligibleForSafetyNet(plainLead, permissiveContract), true);
  });
});
