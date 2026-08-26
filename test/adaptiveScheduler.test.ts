import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scheduleAdaptiveRetrievalTasks, scoreAdaptiveArm } from '../server/leadSearch/adaptiveScheduler.ts';
import { runProviderQueue } from '../server/leadSearch/providerQueue.ts';
import type { RetrievalTask } from '../server/leadSearch/searchSpec.ts';

const task = (
  query: string,
  family: RetrievalTask['family'],
  lane: RetrievalTask['lane'],
  providerPreference: RetrievalTask['providerPreference'],
  priority: number
): RetrievalTask => ({
  id: query,
  query,
  family,
  lane,
  providerPreference,
  priority,
  tavily: {
    searchDepth: 'basic',
    topic: 'general',
    maxResults: 10,
    minimumScore: 0.35
  }
});

const tasks = [
  task('founders', 'persona_title', 'person', 'tavily', 1),
  task('local firms', 'local_market', 'account', 'brightdata', 2),
  task('hiring signal', 'growth_signal', 'signal', 'corroborate', 3),
  task('tooling signal', 'tooling_signal', 'signal', 'brightdata', 4)
];

describe('adaptive retrieval scheduler', () => {
  it('does not reduce retrieval during cold start or with legacy pre-final history', () => {
    const result = scheduleAdaptiveRetrievalTasks(tasks, [{
      family: 'persona_title', lane: 'person', provider: 'tavily', unique_candidates: 100
    }], { maxTasks: 2, minOutcomeRuns: 4 });

    assert.equal(result.active, false);
    assert.deepEqual(result.tasks.map(item => item.query), tasks.map(item => item.query));
  });

  it('uses finalist outcomes, explores under-tested arms, and drops a proven weak arm', () => {
    const result = scheduleAdaptiveRetrievalTasks(tasks, [
      { family: 'persona_title', lane: 'person', provider: 'tavily', outcome_runs: 8, qualified_candidates: 6, returned_candidates: 5 },
      { family: 'local_market', lane: 'account', provider: 'brightdata', outcome_runs: 8, qualified_candidates: 0, returned_candidates: 0, provider_units: 8 },
      { family: 'growth_signal', lane: 'signal', provider: 'corroborate', outcome_runs: 1, qualified_candidates: 1, returned_candidates: 1 },
      { family: 'tooling_signal', lane: 'signal', provider: 'brightdata', outcome_runs: 8, qualified_candidates: 0, rescued_candidates: 5, provider_units: 8 }
    ], { maxTasks: 2, minOutcomeRuns: 4, explorationStrength: 1.25 });

    assert.equal(result.active, true);
    assert.deepEqual(result.tasks.map(item => item.query), ['hiring signal', 'founders']);
    assert.equal(result.decisions.find(item => item.query === 'local firms')?.selected, false);
    assert.equal(result.decisions.find(item => item.query === 'tooling signal')?.selected, false);
  });

  it('values directly qualified output above rescue-heavy output', () => {
    const qualified = scoreAdaptiveArm({ outcome_runs: 5, qualified_candidates: 4, returned_candidates: 3 }, 10, 0);
    const rescued = scoreAdaptiveArm({ outcome_runs: 5, rescued_candidates: 4, returned_candidates: 3 }, 10, 0);
    assert.ok(qualified.score > rescued.score);
  });

  it('preserves a person lane even when historical scores favor only signals', () => {
    const result = scheduleAdaptiveRetrievalTasks(tasks, [
      { family: 'persona_title', lane: 'person', provider: 'tavily', outcome_runs: 10 },
      { family: 'local_market', lane: 'account', provider: 'brightdata', outcome_runs: 10, qualified_candidates: 5 },
      { family: 'growth_signal', lane: 'signal', provider: 'corroborate', outcome_runs: 10, qualified_candidates: 8 },
      { family: 'tooling_signal', lane: 'signal', provider: 'brightdata', outcome_runs: 10, qualified_candidates: 7 }
    ], { maxTasks: 2, minOutcomeRuns: 4, explorationStrength: 0 });

    assert.ok(result.tasks.some(item => item.lane === 'person'));
    assert.equal(result.decisions.find(item => item.query === 'founders')?.reason, 'person_lane_guard');
  });

  it('never prunes contract coverage even when it exceeds the normal task cap', () => {
    const contractTasks = tasks.map((item, index) => ({
      ...item,
      coveredRequirementIds: index < 3 ? [`hard-${index + 1}`] : undefined
    }));
    const result = scheduleAdaptiveRetrievalTasks(contractTasks, [
      { family: 'persona_title', lane: 'person', provider: 'tavily', outcome_runs: 10 },
      { family: 'local_market', lane: 'account', provider: 'brightdata', outcome_runs: 10 },
      { family: 'growth_signal', lane: 'signal', provider: 'corroborate', outcome_runs: 10 },
      { family: 'tooling_signal', lane: 'signal', provider: 'brightdata', outcome_runs: 10, qualified_candidates: 10 }
    ], { maxTasks: 2, minOutcomeRuns: 4, explorationStrength: 0 });

    assert.equal(result.tasks.length, 3);
    assert.deepEqual(new Set(result.tasks.flatMap(item => item.coveredRequirementIds || [])), new Set(['hard-1', 'hard-2', 'hard-3']));
    assert.ok(result.decisions.filter(item => item.selected).every(item => item.reason === 'contract_guard'));
  });
});

describe('provider-aware promise queue', () => {
  it('caps active work and returns results in input order', async () => {
    let active = 0;
    let peak = 0;
    const delays = [25, 5, 15, 1];
    const results = await runProviderQueue(delays.map((delay, index) => ({
      id: `queue-test-${index}`,
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, delay));
        active--;
        return index;
      }
    })), { concurrency: 2 });

    assert.equal(peak, 2);
    assert.deepEqual(results, [0, 1, 2, 3]);
  });

  it('removes work that has not started when the session is cancelled', async () => {
    const controller = new AbortController();
    let releaseFirst!: () => void;
    let startedSecond = false;
    const firstRunning = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const didStart = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });

    const queued = runProviderQueue([
      {
        id: 'running',
        run: async () => {
          markFirstStarted();
          await firstRunning;
          return 1;
        }
      },
      {
        id: 'waiting',
        run: async () => {
          startedSecond = true;
          return 2;
        }
      }
    ], { concurrency: 1, signal: controller.signal });

    await didStart;
    controller.abort();
    await assert.rejects(queued, error => (error as Error).name === 'AbortError');
    releaseFirst();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(startedSecond, false);
  });

  it('F5: promotes top deferred arm on exploration floor rounds', () => {
    const history = [
      { family: 'persona_title', lane: 'person', provider: 'tavily', outcome_runs: 8, qualified_candidates: 6, returned_candidates: 5 },
      { family: 'local_market', lane: 'account', provider: 'brightdata', outcome_runs: 8, qualified_candidates: 0, returned_candidates: 0 },
      { family: 'growth_signal', lane: 'signal', provider: 'corroborate', outcome_runs: 8, qualified_candidates: 4, returned_candidates: 3 },
      { family: 'tooling_signal', lane: 'signal', provider: 'brightdata', outcome_runs: 8, qualified_candidates: 0, rescued_candidates: 1 }
    ];

    // On round 2 (not multiple of 3): exactly 2 tasks selected
    const nonExploration = scheduleAdaptiveRetrievalTasks(tasks, history, {
      maxTasks: 2, minOutcomeRuns: 4, round: 2, explorationFloorEvery: 3
    });
    assert.equal(nonExploration.tasks.length, 2);
    assert.equal(nonExploration.decisions.some(d => d.promoted), false);

    // On round 3 (multiple of 3): top deferred arm is promoted
    const exploration = scheduleAdaptiveRetrievalTasks(tasks, history, {
      maxTasks: 2, minOutcomeRuns: 4, round: 3, explorationFloorEvery: 3
    });
    assert.equal(exploration.tasks.length, 3, 'Exploration floor should promote 1 deferred arm');
    const promotedDecision = exploration.decisions.find(d => d.promoted);
    assert.ok(promotedDecision, 'Should have a promoted decision');
    assert.equal(promotedDecision.selected, true);
    assert.equal(promotedDecision.reason, 'exploration');
  });

  it('correctly isolates decision selection flags when tasks share identical query strings', () => {
    const collidingTasks = [
      task('same query', 'persona_title', 'person', 'tavily', 1),
      task('same query', 'growth_signal', 'signal', 'brightdata', 2),
      task('other query 1', 'local_market', 'account', 'brightdata', 3),
      task('other query 2', 'tooling_signal', 'signal', 'brightdata', 4)
    ];

    const history = [
      { family: 'persona_title', lane: 'person', provider: 'tavily', outcome_runs: 8, qualified_candidates: 6, returned_candidates: 5 },
      { family: 'growth_signal', lane: 'signal', provider: 'brightdata', outcome_runs: 8, qualified_candidates: 0, returned_candidates: 0 }
    ];

    const result = scheduleAdaptiveRetrievalTasks(collidingTasks, history, {
      maxTasks: 1, minOutcomeRuns: 4
    });

    // Exactly 1 task selected
    assert.equal(result.tasks.length, 1);
    const personDecision = result.decisions.find(d => d.scopeKey.includes('person'));
    const signalDecision = result.decisions.find(d => d.scopeKey.includes('signal'));

    assert.equal(personDecision?.selected, true);
    assert.equal(signalDecision?.selected, false);
  });
});

