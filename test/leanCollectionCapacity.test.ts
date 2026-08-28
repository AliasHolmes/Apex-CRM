import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCollectionCapacity } from '../server/leadSearch/collectionCapacity.js';
import { buildRoundDiagnostics } from '../server/leadSearch/roundDiagnostics.js';
import { executeSelectStage } from '../server/leadSearch/stages/selectStage.js';
import type { ProspectContract } from '../server/leadSearch/prospectContract.js';

describe('Lean Adaptive Collection Capacity', () => {
  it('calculates lean rerankPoolTarget and batch sizes for target = 20', () => {
    const cap = buildCollectionCapacity({ targetLimit: 20 });
    // 20 * 1.25 = 25 candidates (instead of 80)
    assert.equal(cap.rerankPoolTarget, 25);
    assert.equal(cap.candidateBatchSize, 15);
    assert.ok(cap.maxRounds <= 3, `Expected maxRounds <= 3, got ${cap.maxRounds}`);
  });

  it('calculates lean rerankPoolTarget and batch sizes for target = 50', () => {
    const cap = buildCollectionCapacity({ targetLimit: 50 });
    // 50 * 1.20 = 60 candidates
    assert.equal(cap.rerankPoolTarget, 60);
    assert.equal(cap.candidateBatchSize, 38);
    assert.ok(cap.maxRounds <= 4, `Expected maxRounds <= 4, got ${cap.maxRounds}`);
  });

  it('calculates lean rerankPoolTarget for target = 10', () => {
    const cap = buildCollectionCapacity({ targetLimit: 10 });
    assert.equal(cap.rerankPoolTarget, 13);
    assert.equal(cap.candidateBatchSize, 15);
    assert.ok(cap.maxRounds <= 3, `Expected maxRounds <= 3, got ${cap.maxRounds}`);
  });
});

describe('Round Diagnostics Semantic Resilience', () => {
  const mockContract = {
    version: 1,
    policyVersion: 'evidence-contract-v8',
    brief: 'B2B marketing agency owners in London',
    requirements: [
      {
        id: 'R1',
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'Agency owner or CEO',
        sourcePhrase: 'agency owner',
        acceptableTerms: ['Founder', 'Owner', 'CEO', 'Managing Director'],
        queryable: true,
      },
      {
        id: 'R2',
        scope: 'company_type',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'B2B marketing agency',
        sourcePhrase: 'B2B marketing agency',
        acceptableTerms: ['B2B marketing agency', 'digital marketing agency firm'],
        queryable: true,
      },
      {
        id: 'R3',
        scope: 'person_location',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'Located in London',
        sourcePhrase: 'in London',
        acceptableTerms: ['London', 'United Kingdom', 'UK'],
        queryable: true,
      }
    ],
    exclusions: []
  } as unknown as ProspectContract;

  it('recognizes viable candidates when title and company match semantically without failing on consecutive substrings', () => {
    const leads = [
      {
        fullName: 'Sarah Jenkins',
        currentTitle: 'Managing Director & Founder',
        currentCompany: 'Apex Digital Agency',
        industry: 'Marketing & Advertising',
        location: 'London, Greater London, United Kingdom',
        decisionMakerVerification: { verified: true },
        evidence: { rawText: 'Founder of Apex Digital Agency in London specializing in B2B performance marketing' }
      },
      {
        fullName: 'David Clark',
        currentTitle: 'CEO',
        currentCompany: 'Growth Labs UK',
        industry: 'Marketing Consulting',
        location: 'London, UK',
        decisionMakerVerification: { verified: true },
        evidence: { rawText: 'CEO at Growth Labs London. Leading B2B growth and digital agency operations.' }
      }
    ];

    const diag = buildRoundDiagnostics({
      round: 1,
      rawCandidates: 20,
      extractedCandidates: 2,
      leads,
      contract: mockContract,
      targetLimit: 2,
      alreadyQualified: 0
    });

    assert.equal(diag.viableCandidates, 2);
    assert.equal(diag.shouldRecover, false);
    assert.equal(diag.missingHardRequirementIds.length, 0);
  });
});

describe('Targeted Post-Selection Stage Flow', () => {
  it('selects finalists before running LinkedIn post intent enrichment', async () => {
    const qualifiedLeads = [
      { id: 'lead-1', fullName: 'Alice', currentCompany: 'Acme 1', scoreBreakdown: { composite: 9.0 } },
      { id: 'lead-2', fullName: 'Bob', currentCompany: 'Acme 2', scoreBreakdown: { composite: 8.5 } },
      { id: 'lead-3', fullName: 'Charlie', currentCompany: 'Acme 3', scoreBreakdown: { composite: 7.0 } },
    ];

    const mockCtx: any = {
      config: { targetLimit: 2, maxRounds: 3, linkedinPostIntentEnabled: false },
      state: { qualifiedLeads, abortController: new AbortController() },
      ports: {},
      logEvent: () => {},
      recordTrace: () => {}
    };

    const result = await executeSelectStage(mockCtx, {
      contract: {} as any,
      searchSpec: { maxPerCompany: 1 } as any,
      ttlDays: 7,
      stats: { queryRuns: [] },
      leadQueryRuns: new Map() as any,
      trackableBrightDataSearch: async () => []
    });

    assert.equal(result.leadsFound, 2);
    assert.equal(result.finalLeads.length, 2);
    assert.equal(result.finalLeads[0].id, 'lead-1');
    assert.equal(result.finalLeads[1].id, 'lead-2');
  });
});
