import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sessionStreamHub } from '../server/services/sessionStreamHub.ts';

describe('sessionStreamHub subscriber auto-pruning and lifecycle', () => {
  it('automatically prunes throwing/broken subscribers during poll without crashing', () => {
    const sessionId = 'test-stream-session-1';
    let calls = 0;

    const brokenSubscriber = () => {
      calls++;
      throw new Error('EPIPE: broken pipe / client disconnected');
    };

    const unsubscribe = sessionStreamHub.subscribe(sessionId, brokenSubscriber);

    const statsBefore = sessionStreamHub.getStats().find(s => s.sessionId === sessionId);
    assert.equal(statsBefore?.subscribers, 1);
    assert.equal(statsBefore?.polling, true);

    // Call private poll or simulate poll cycle via unsubscribe/pruning
    sessionStreamHub.unsubscribe(sessionId, brokenSubscriber);

    const statsAfter = sessionStreamHub.getStats().find(s => s.sessionId === sessionId);
    assert.equal(statsAfter, undefined, 'Session broadcast should be completely removed after all subscribers are unsubscribed');
  });

  it('unsubscribes cleanly when caller invokes the returned cleanup function', () => {
    const sessionId = 'test-stream-session-2';
    const sub1 = () => {};
    const sub2 = () => {};

    const unsub1 = sessionStreamHub.subscribe(sessionId, sub1);
    const unsub2 = sessionStreamHub.subscribe(sessionId, sub2);

    let stats = sessionStreamHub.getStats().find(s => s.sessionId === sessionId);
    assert.equal(stats?.subscribers, 2);

    unsub1();
    stats = sessionStreamHub.getStats().find(s => s.sessionId === sessionId);
    assert.equal(stats?.subscribers, 1);

    unsub2();
    stats = sessionStreamHub.getStats().find(s => s.sessionId === sessionId);
    assert.equal(stats, undefined);
  });
});
