import test from 'node:test';
import assert from 'node:assert/strict';
import { runRollingPool } from '../server/leadSearch/rollingPool.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

test('a finished item frees its slot immediately (no wave barrier)', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const started: number[] = [];
  const pool = runRollingPool(
    [0, 1, 2, 3],
    async (item) => {
      started.push(item);
      await gates[item].promise;
      return item;
    },
    { concurrency: 2 },
  );

  await tick();
  assert.deepEqual(started, [0, 1]);

  // Item 1 finishes while item 0 is still running: item 2 must start right away.
  gates[1].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2], 'item 2 must not wait for slow item 0');

  gates[0].resolve();
  gates[2].resolve();
  await tick();
  gates[3].resolve();
  await pool;
});

test('never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await runRollingPool(
    Array.from({ length: 12 }, (_, i) => i),
    async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    },
    { concurrency: 3 },
  );
  assert.equal(maxInFlight, 3);
});

test('results are positioned by item index regardless of completion order', async () => {
  const delays = [30, 5, 15];
  const { results } = await runRollingPool(
    delays,
    async (delay, index) => {
      await new Promise((r) => setTimeout(r, delay));
      return `item-${index}`;
    },
    { concurrency: 3 },
  );
  assert.deepEqual(results, ['item-0', 'item-1', 'item-2']);
});

test('shouldStop halts dequeuing but lets in-flight items finish', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred(), deferred()];
  const started: number[] = [];
  const completed: number[] = [];
  let satisfied = false;

  const pool = runRollingPool(
    [0, 1, 2, 3, 4],
    async (item) => {
      started.push(item);
      await gates[item].promise;
      completed.push(item);
      if (item === 0) satisfied = true;
      return item;
    },
    { concurrency: 2, shouldStop: () => satisfied },
  );

  await tick();
  assert.deepEqual(started, [0, 1]);

  gates[0].resolve(); // quota reached by item 0
  await tick();
  assert.deepEqual(started, [0, 1], 'no new item may start once shouldStop is true');

  gates[1].resolve(); // in-flight sibling must still complete
  const { results, startedCount } = await pool;
  assert.deepEqual(completed.sort(), [0, 1]);
  assert.equal(startedCount, 2);
  assert.deepEqual(results, [0, 1, undefined, undefined, undefined]);
});

test('shouldStop is consulted before the very first item', async () => {
  const started: number[] = [];
  const { startedCount } = await runRollingPool(
    [0, 1],
    async (item) => {
      started.push(item);
    },
    { concurrency: 2, shouldStop: () => true },
  );
  assert.equal(startedCount, 0);
  assert.deepEqual(started, []);
});

test('empty input resolves immediately', async () => {
  const { results, startedCount } = await runRollingPool<number, number>([], async (n) => n, {
    concurrency: 4,
  });
  assert.deepEqual(results, []);
  assert.equal(startedCount, 0);
});

test('a non-positive or fractional concurrency still makes progress', async () => {
  const { results } = await runRollingPool([1, 2, 3], async (n) => n * 2, { concurrency: 0 });
  assert.deepEqual(results, [2, 4, 6]);
});
