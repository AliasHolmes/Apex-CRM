import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveRollingPool } from '../server/leadSearch/liveRollingPool.ts';

test('bounds in-flight work to the configured concurrency and aligns results with submission order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const completionOrder: number[] = [];

  const pool = createLiveRollingPool<number, string>({
    concurrency: 2,
    run: async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Later items finish first on purpose: results must stay submission-ordered.
      await new Promise((r) => setTimeout(r, item === 0 ? 30 : 5));
      inFlight--;
      completionOrder.push(item);
      return `r${item}`;
    },
  });

  for (let i = 0; i < 6; i++) pool.submit(i);
  const results = await pool.drain();

  assert.equal(maxInFlight, 2, `in-flight must cap at 2, got ${maxInFlight}`);
  assert.deepEqual(results, ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
  assert.equal(pool.submittedCount(), 6);
  assert.equal(pool.completedCount(), 6);
  // Out-of-order completion proves the index alignment is real.
  assert.notDeepEqual(completionOrder, [0, 1, 2, 3, 4, 5]);
});

test('drains items submitted while workers are already running', async () => {
  const pool = createLiveRollingPool<number, number>({
    concurrency: 2,
    run: async (item) => {
      await new Promise((r) => setTimeout(r, 20));
      return item * 2;
    },
  });

  pool.submit(1);
  pool.submit(2);
  // Submit mid-flight: workers must pick these up without a second drain() call.
  setTimeout(() => {
    pool.submit(3);
    pool.submit(4);
  }, 5);

  const results = await pool.drain();
  assert.deepEqual(results, [2, 4, 6, 8]);
});

test('shouldStop stops dequeuing further items but leaves in-flight work alone', async () => {
  let stop = false;
  const ran: number[] = [];
  const pool = createLiveRollingPool<number, void>({
    concurrency: 1,
    shouldStop: () => stop,
    run: async (item) => {
      ran.push(item);
      await new Promise((r) => setTimeout(r, 10));
    },
  });

  pool.submit(1);
  stop = true;
  pool.submit(2);
  pool.submit(3);
  await pool.drain();

  assert.deepEqual(ran, [1], 'only the in-flight item may run after shouldStop');
});

test('a worker failure surfaces through drain() instead of hanging', async () => {
  const pool = createLiveRollingPool<number, number>({
    concurrency: 1,
    run: async () => {
      throw new Error('judge exploded');
    },
  });

  pool.submit(1);
  await assert.rejects(() => pool.drain(), /judge exploded/);
});
