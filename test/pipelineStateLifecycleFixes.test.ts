import test from 'node:test';
import assert from 'node:assert/strict';
import { executeFuseStage } from '../server/leadSearch/stages/fuseStage.js';
import { evaluateIncrementalJudgeBatches } from '../server/leadSearch/stages/judgeStage.js';
import { executeExtractStage } from '../server/leadSearch/stages/extractStage.js';
import { executeEnrichStage } from '../server/leadSearch/stages/enrichStage.js';
import { upsertCandidateVerdict, computeRequirementsFingerprint } from '../server/db.js';
import { ScoutFreeTierBudget } from '../server/leadSearch/freeTier.js';
import { normalizeLinkedInUrl } from '../server/services/linkedinEvidence.js';
import { installMockLlm, makeFounderContract, makeJudgeContext } from './helpers/mockLlm.js';

test('fuseStage: dropped excess candidates do not have their keys committed to seenCandidateKeys', async () => {
  const seenCandidateKeys = new Set<string>();
  const existingKeys = new Set<string>();
  const stats: any = {};
  const ctx: any = {
    config: { targetLimit: 1 }, // targetScale = 4, candidateBudget = 20
    state: { seenCandidateKeys, existingKeys, acceptedLeads: [] },
    logEvent: () => {},
  };

  // Generate 25 distinct candidate items
  const roundItems = Array.from({ length: 25 }, (_, i) => ({
    item: {
      url: `https://www.linkedin.com/in/founder-${i + 1}`,
      title: `Founder & CEO at Startup ${i + 1}`,
      content: `Founder and CEO of an AI agency in San Francisco ${i + 1}`,
    },
    resultIndex: i,
  }));

  const res = await executeFuseStage(ctx, {
    round: 1,
    roundItems,
    roundPlans: [],
    queryRuns: [],
    searchSpec: { maxPerCompany: 2 } as any,
    stats,
  });

  // Budget is Math.min(25, Math.max(4, 20)) = 20 candidates
  assert.equal(res.candidateItems.length, 20);
  assert.equal(res.uniqueRoundItemsCount, 25);

  // The 20 accepted candidates must be in seenCandidateKeys
  for (let i = 0; i < 20; i++) {
    const username = `founder-${i + 1}`;
    assert.equal(seenCandidateKeys.has(username), true, `accepted candidate ${username} must be in seenCandidateKeys`);
  }

  // The 5 dropped excess candidates (21..25) must NOT be in seenCandidateKeys!
  for (let i = 20; i < 25; i++) {
    const username = `founder-${i + 1}`;
    assert.equal(seenCandidateKeys.has(username), false, `dropped candidate ${username} must NOT be poisoned in seenCandidateKeys`);
    assert.equal(seenCandidateKeys.has(`url:https://www.linkedin.com/in/founder-${i + 1}`), false);
  }
});

test('judgeStage: reuses cached hard_fail disqualification without calling LLM', async () => {
  const contract = makeFounderContract();
  const reqFingerprint = computeRequirementsFingerprint(contract.requirements as any);
  const mock = installMockLlm(() => {
    throw new Error('LLM judge must not be called when candidate verdict is cached as hard_fail');
  });

  try {
    // Record hard_fail verdict in SQLite
    upsertCandidateVerdict({
      identityKey: 'linkedin:disqualified-candidate',
      requirementHash: reqFingerprint,
      verdict: 'hard_fail',
      reason: 'Disqualified by prior judge verdict: not a decision maker',
      failedRequirementId: 'req-role',
    });

    const candidate = {
      candidateId: 'cand-disqualified',
      lead: {
        fullName: 'Disqualified Person',
        currentTitle: 'Consultant',
        currentCompany: 'Freelance',
        contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/disqualified-candidate' },
      },
      evidence: [{ id: 'e1', text: 'Disqualified Person is a consultant' }],
    };

    const { ctx } = makeJudgeContext(contract);
    const stats: any = { cachedDisqualifications: 0 };
    const out = await evaluateIncrementalJudgeBatches(ctx, {
      candidates: [candidate] as any,
      contract,
      stats,
      round: 1,
    } as any);

    assert.equal(mock.calls.length, 0, 'LLM judge must not be called');
    assert.equal(out.qualifiedCandidates.length, 0, 'Must not be qualified');
    assert.equal(stats.cachedDisqualifications, 1, 'cachedDisqualifications counter must increment');
    assert.equal((candidate.lead as any).judgmentInsight?.status, 'hard_fail');
    assert.equal((candidate.lead as any).qualification?.verdict, 'hard_fail');
    assert.equal((candidate.lead as any).qualification?.qualificationSource, 'cached');
  } finally {
    mock.restore();
  }
});

test('extractStage: diet trimming deletes all candidate identity keys symmetrically', async () => {
  const mock = installMockLlm(() => ({
    extractedCandidates: [],
  }));

  try {
    const seenCandidateKeys = new Set<string>();

    // Create 10 candidate items so evidenceBlocks.length (10) exceeds neededEvidenceBlocks (8 in diet mode)
    const candidateItems = Array.from({ length: 10 }, (_, i) => {
      const username = `candidate-${i + 1}`;
      const url = `https://www.linkedin.com/in/${username}`;
      const company = `Company ${i + 1}`;
      const email = `person${i + 1}@company${i + 1}.com`;
      const nameComp = `person ${i + 1}::company ${i + 1}`;

      const keys = [
        username,
        `url:${url}`,
        url,
        `email:${email}`,
        `name_company:${nameComp}`,
      ];

      for (const k of keys) {
        seenCandidateKeys.add(k);
      }

      return {
        url,
        _normalizedUrl: url,
        _linkedinUsername: username,
        _candidateKeys: keys,
        title: `Person ${i + 1} - Founder at ${company}`,
        content: `Person ${i + 1} Founder at ${company}`,
      };
    });

    const ctx: any = {
      config: {
        targetLimit: 1,
        targetCeiling: 2,
      },
      state: {
        seenCandidateKeys,
        existingKeys: new Set<string>(),
        acceptedLeads: [{ id: 'existing-1' }], // remainingToTarget = 0 -> triggers late-round diet
        freeTierBudget: new ScoutFreeTierBudget(),
        debugLogs: [],
        llmCircuitBreaker: { isTripped: () => false },
        abortController: new AbortController(),
      },
      logEvent: () => {},
      recordTrace: () => {},
    };

    await executeExtractStage(ctx, {
      candidateItems,
      round: 2,
      rerankPoolTarget: 10,
      brightDataReady: false,
      brightDataProviderDisabled: true,
      tavilyCapabilities: {},
      brightDataCapabilities: {},
      consecutiveFailedExtractionRounds: 0,
      failedExtractionRoundsBeforeStop: 2,
      stats: { candidateExtractions: 0 } as any,
    });

    // Items 9 and 10 (index 8, 9) were trimmed by diet
    // Verify that the trimmed items had all their keys (including name_company and email) deleted
    for (let i = 8; i < 10; i++) {
      const username = `candidate-${i + 1}`;
      const url = `https://www.linkedin.com/in/${username}`;
      const email = `person${i + 1}@company${i + 1}.com`;
      const nameComp = `person ${i + 1}::company ${i + 1}`;

      assert.equal(seenCandidateKeys.has(username), false, `trimmed candidate ${username} must be deleted`);
      assert.equal(seenCandidateKeys.has(`url:${url}`), false);
      assert.equal(seenCandidateKeys.has(`name_company:${nameComp}`), false, 'name_company key must be deleted');
      assert.equal(seenCandidateKeys.has(`email:${email}`), false, 'email key must be deleted');
    }

    // Accepted candidate 1 must still have its keys in seenCandidateKeys
    assert.equal(seenCandidateKeys.has('candidate-1'), true);
  } finally {
    mock.restore();
  }
});

test('enrichStage: urlRetryQueue cleans up authwalled and completed targets without leaks', async () => {
  const normAuth = normalizeLinkedInUrl('https://www.linkedin.com/in/authwalled-user');
  const normValid = normalizeLinkedInUrl('https://www.linkedin.com/in/valid-user');

  const urlRetryQueue = new Set<string>([normAuth, normValid]);

  const authwalledTarget: any = {
    url: 'https://www.linkedin.com/in/authwalled-user',
    normalizedUrl: normAuth,
    username: 'authwalled-user',
    lead: {
      fullName: 'Authwalled Person',
      currentTitle: 'Founder',
      currentCompany: 'Secret Co',
      contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/authwalled-user' },
      evidenceReasons: ['Found in search'],
    },
    evidenceMeta: { evidenceBlock: 'test block', evidenceQuality: 'bad' },
    highValue: true,
    enriched: false,
    retryAttempts: 0,
  };

  const validTarget: any = {
    url: 'https://www.linkedin.com/in/valid-user',
    normalizedUrl: normValid,
    username: 'valid-user',
    lead: {
      fullName: 'Valid Person',
      currentTitle: 'Founder',
      currentCompany: 'Good Co',
      contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/valid-user' },
      evidenceReasons: ['Found in search'],
    },
    evidenceMeta: { evidenceBlock: 'test block', evidenceQuality: 'bad' },
    highValue: true,
    enriched: false,
    retryAttempts: 0,
  };

  const ctx: any = {
    config: { promptQuery: 'founder', targetLimit: 5, minScore: 5 },
    state: {
      urlRetryQueue,
      existingKeys: new Set<string>(),
      acceptedLeads: [],
      qualifiedLeads: [],
      brightDataStats: {
        profileRetryAttempted: 0,
        profileRetryQueued: 0,
        profileScrapesAttempted: 0,
        failed: 0,
        failureReasons: {},
        siteProbe: { negativeHits: 0, skippedCap: 0, attempted: 0 },
      },
      debugLogs: [],
      abortController: new AbortController(),
    },
    ports: {
      scrapeMarkdown: async () => '# Valid Profile\nFounder at Good Co',
    },
    logEvent: () => {},
    recordTrace: () => {},
  };

  await executeEnrichStage(ctx, {
    postFilterLeads: [
      { lead: authwalledTarget.lead, evidenceMeta: authwalledTarget.evidenceMeta },
      { lead: validTarget.lead, evidenceMeta: validTarget.evidenceMeta },
    ],
    profileEnrichmentStage: 'post_filter',
    round: 1,
    rerankPoolTarget: 10,
    profileMaxPerSearch: 10,
    enrichmentCap: 10,
    profileConcurrency: 2,
    ttlDays: 30,
    contract: makeFounderContract() as any,
    stats: { brightDataFailures: 0, queryRuns: [], siteProbe: { negativeHits: 0, skippedCap: 0, attempted: 0 } } as any,
    leadQueryRuns: new WeakMap(),
    trackableBrightDataSearch: async () => [],
    brightDataProviderDisabled: false,
    brightDataTransportRetryAfter: 0,
  });

  // Both authwalled (purged before tasks) and valid (deleted in finally) must be evicted!
  assert.equal(urlRetryQueue.has(normAuth), false, 'authwalled target must be purged from queue');
  assert.equal(urlRetryQueue.has(normValid), false, 'valid target must be purged from queue in finally');
  assert.equal(urlRetryQueue.size, 0, 'queue must be completely empty');
});
