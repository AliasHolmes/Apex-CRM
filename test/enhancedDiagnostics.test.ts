import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoundDiagnostics
} from '../server/leadSearch/roundDiagnostics.js';
import {
  buildRecoveryQueryPrompt,
  type ProspectContract
} from '../server/leadSearch/prospectContract.js';

describe('Phase 6: Enhanced Diagnostics & Targeted Recovery', () => {
  const originalEnv = process.env.ENHANCED_DIAGNOSTICS_ENABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ENHANCED_DIAGNOSTICS_ENABLED;
    } else {
      process.env.ENHANCED_DIAGNOSTICS_ENABLED = originalEnv;
    }
  });

  const contract: ProspectContract = {
    version: 1,
    policyVersion: 'evidence-contract-v7',
    brief: 'Find AI agency owners in New York',
    authorityRequired: false,
    exclusions: [],
    initialQueries: [],
    requirements: [
      {
        id: 'req-owner',
        scope: 'person_role',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'owner',
        sourcePhrase: 'owner',
        acceptableTerms: ['owner', 'founder'],
        queryable: true,
        requirementClass: 'identity_hard',
        queryHardness: 'required_in_every_query'
      },
      {
        id: 'req-ny',
        scope: 'person_location',
        importance: 'hard',
        evidenceModality: 'structured_profile',
        description: 'New York',
        sourcePhrase: 'New York',
        acceptableTerms: ['New York', 'NY', 'NYC'],
        queryable: true,
        requirementClass: 'context_hard',
        queryHardness: 'distributed_across_queries'
      }
    ]
  };

  const leads = [
    { fullName: 'Alice', currentTitle: 'Owner', location: 'London' },
    { fullName: 'Bob', currentTitle: 'Founder', location: 'Paris' },
    { fullName: 'Charlie', currentTitle: 'Founder', location: 'Berlin' },
    { fullName: 'David', currentTitle: 'CEO', location: 'Tokyo' }
  ];

  describe('When flag is DISABLED (Standard Diagnostics)', () => {
    beforeEach(() => {
      process.env.ENHANCED_DIAGNOSTICS_ENABLED = 'false';
    });

    it('builds standard diagnostics without classSummary', () => {
      const diag = buildRoundDiagnostics({
        round: 1,
        rawCandidates: 4,
        extractedCandidates: 4,
        leads,
        contract,
        targetLimit: 10
      });

      assert.equal(diag.classSummary, undefined);
      assert.ok(diag.shouldRecover);
    });
  });

  describe('When flag is ENABLED (Class-Aware Diagnostics)', () => {
    beforeEach(() => {
      process.env.ENHANCED_DIAGNOSTICS_ENABLED = 'true';
    });

    it('identifies context_hard as the bottleneck when location fails but title passes', () => {
      const diag = buildRoundDiagnostics({
        round: 1,
        rawCandidates: 4,
        extractedCandidates: 4,
        leads,
        contract,
        targetLimit: 10
      });

      assert.ok(diag.classSummary);
      assert.ok(diag.classSummary.identityPassRate > 0.5, 'Identity pass rate should be high');
      assert.equal(diag.classSummary.contextPassRate, 0, 'Context pass rate should be 0 because all are non-NY');
      assert.equal(diag.classSummary.bottleneckClass, 'context_hard', 'Bottleneck should be context_hard');
    });

    it('injects bottleneck guidance into recovery prompt', () => {
      const diag = buildRoundDiagnostics({
        round: 1,
        rawCandidates: 4,
        extractedCandidates: 4,
        leads,
        contract,
        targetLimit: 10
      });

      const prompt = buildRecoveryQueryPrompt(contract, diag);
      assert.ok(prompt.includes('Bottleneck identified: Context Hard'), 'Prompt should include context bottleneck guidance');
    });
  });
});
