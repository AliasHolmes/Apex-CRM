import test from 'node:test';
import assert from 'node:assert/strict';
import {
  saveMiningSessionCheckpoint,
  readMiningSessionCheckpoint,
  readResumableMiningSessions,
  reconcileOrphanedMiningSessions,
  upsertMiningSession,
  readMiningSessionById,
  type MiningSessionCheckpoint
} from '../server/db.js';
import { discoveryEngine } from '../server/leadSearch/discoveryEngine.js';

test('saveMiningSessionCheckpoint and readMiningSessionCheckpoint round-trip correctly', () => {
  const sessionId = `test-persist-${Date.now()}`;
  upsertMiningSession({
    id: sessionId,
    status: 'running',
    prompt: 'CTOs in Berlin',
    requestedLimit: 10,
    startedAt: new Date().toISOString()
  });

  const checkpoint: MiningSessionCheckpoint = {
    sessionId,
    round: 2,
    stage: 'enrich',
    promptQuery: 'CTOs in Berlin',
    targetLimit: 10,
    contract: {
      brief: 'CTOs in Berlin',
      requirements: [{ id: 'req-1', text: 'Chief Technology Officer', importance: 'hard', category: 'role' }],
      exclusions: [],
      scoringRubric: { coreFitWeight: 40, buyerAuthorityWeight: 30, firmographicWeight: 20, buyingSignalWeight: 10, penaltyPerMissingRequirement: 15 },
      searchQueries: [{ query: 'CTO Berlin tech startup', rationale: 'initial query', providerPreference: 'tavily', targetPersona: 'CTO' }],
      decompositionMode: 'single_stream',
      policyVersion: 'test-v1'
    } as any,
    queryRuns: [
      {
        round: 1,
        query: 'CTO Berlin tech startup',
        family: 'person',
        lane: 'person',
        providerPreference: 'tavily',
        rawCandidates: 8,
        uniqueCandidates: 7,
        extractedLeads: 5,
        acceptedLeads: 3,
        qualifiedFinalists: 0,
        rescuedFinalists: 0,
        returnedFinalists: 0,
        searchLatencyMs: 120,
        providerUnits: 1,
        rejectionReasons: {}
      }
    ],
    acceptedLeads: [
      {
        id: 'lead-test-1',
        fullName: 'Hans Schmidt',
        currentTitle: 'Chief Technology Officer',
        currentCompany: 'BerlinTech GmbH',
        contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/hans-schmidt-berlin' },
        fitScore: 9,
        compositeScore: 92
      }
    ],
    qualifiedLeads: [],
    finalLeads: [],
    rejectionCounts: { not_decision_maker: 2 },
    failureCounts: {},
    brightDataStats: { attempted: 2, succeeded: 2, failed: 0 },
    previousRoundSummary: { viableCandidates: 3, shouldRecover: false },
    updatedAt: new Date().toISOString()
  };

  saveMiningSessionCheckpoint(sessionId, checkpoint);

  const restored = readMiningSessionCheckpoint(sessionId);
  assert.ok(restored);
  assert.equal(restored?.sessionId, sessionId);
  assert.equal(restored?.round, 2);
  assert.equal(restored?.stage, 'enrich');
  assert.equal(restored?.acceptedLeads.length, 1);
  assert.equal(restored?.acceptedLeads[0].fullName, 'Hans Schmidt');
  assert.equal(restored?.contract.policyVersion, 'test-v1');
});

test('reconcileOrphanedMiningSessions preserves checkpoint and marks resumable status', () => {
  const sessionId = `test-orphaned-${Date.now()}`;
  upsertMiningSession({
    id: sessionId,
    status: 'running',
    prompt: 'VPs of Engineering in London',
    requestedLimit: 5,
    startedAt: new Date(Date.now() - 60000).toISOString()
  });

  const checkpoint: MiningSessionCheckpoint = {
    sessionId,
    round: 3,
    stage: 'enrich',
    promptQuery: 'VPs of Engineering in London',
    targetLimit: 5,
    contract: {
      brief: 'VPs of Engineering in London',
      requirements: [],
      exclusions: [],
      scoringRubric: { coreFitWeight: 40, buyerAuthorityWeight: 30, firmographicWeight: 20, buyingSignalWeight: 10, penaltyPerMissingRequirement: 15 },
      searchQueries: [],
      decompositionMode: 'single_stream',
      policyVersion: 'test-v1'
    } as any,
    queryRuns: [],
    acceptedLeads: [
      {
        id: 'lead-test-2',
        fullName: 'Jane Doe',
        currentTitle: 'VP of Engineering',
        currentCompany: 'London SaaS Ltd',
        contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/jane-doe-london' }
      }
    ],
    qualifiedLeads: [],
    finalLeads: [],
    rejectionCounts: {},
    failureCounts: {},
    brightDataStats: { attempted: 0, succeeded: 0, failed: 0 },
    updatedAt: new Date().toISOString()
  };

  saveMiningSessionCheckpoint(sessionId, checkpoint);

  const count = reconcileOrphanedMiningSessions();
  assert.ok(count >= 1);

  const session = readMiningSessionById(sessionId);
  assert.equal(session?.status, 'interrupted');
  assert.ok(session?.errorMessage?.includes('Resumable from round 3'));

  const resumableList = readResumableMiningSessions();
  assert.ok(resumableList.some(s => s.id === sessionId));
});

test('discoveryEngine.resume fails gracefully when no checkpoint exists', async () => {
  await assert.rejects(
    () => discoveryEngine.resume('non-existent-session-id-xyz'),
    /No resumable checkpoint found/
  );
});

test('deleteMiningSession and deleteMiningSessions delete target sessions', async () => {
  const { deleteMiningSession, deleteMiningSessions, clearInterruptedMiningSessions } = await import('../server/db.js');
  const s1 = `test-del-1-${Date.now()}`;
  const s2 = `test-del-2-${Date.now()}`;
  const s3 = `test-del-3-${Date.now()}`;

  upsertMiningSession({ id: s1, status: 'interrupted', prompt: 'test 1' });
  upsertMiningSession({ id: s2, status: 'interrupted', prompt: 'test 2' });
  upsertMiningSession({ id: s3, status: 'interrupted', prompt: 'test 3' });

  assert.equal(deleteMiningSession(s1), true);
  assert.equal(readMiningSessionById(s1), null);

  const deletedCount = deleteMiningSessions([s2, s3]);
  assert.equal(deletedCount, 2);
  assert.equal(readMiningSessionById(s2), null);
  assert.equal(readMiningSessionById(s3), null);

  const s4 = `test-del-4-${Date.now()}`;
  upsertMiningSession({ id: s4, status: 'interrupted', prompt: 'test 4' });
  const cleared = deleteMiningSessions([s4]);
  assert.equal(cleared, 1);
  assert.equal(readMiningSessionById(s4), null);
});

