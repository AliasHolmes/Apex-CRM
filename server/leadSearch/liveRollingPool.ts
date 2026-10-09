/**
 * Live rolling pool: a concurrency-bounded worker pool whose items arrive over time
 * (unlike runRollingPool, which receives a fixed array up front).
 *
 * Used by the streaming judge seam (see docs/adr/0012-*): enrichment completes in
 * batches while the judge pool drains them concurrently, so the judge stage no longer
 * waits for the whole enrichment phase to finish.
 */

export type LiveRollingPoolOptions<T, R> = {
  concurrency: number;
  run: (item: T) => Promise<R>;
  /** Consulted before each item is pulled. Items already in flight are never interrupted. */
  shouldStop?: () => boolean;
};

export type LiveRollingPool<T, R> = {
  /** Enqueue an item. Safe to call while workers are draining. */
  submit: (item: T) => void;
  /** Resolves once every submitted item has been processed. Results are index-aligned with submission order. */
  drain: () => Promise<Array<R | undefined>>;
  submittedCount: () => number;
  completedCount: () => number;
};

type QueuedItem<T> = { item: T; index: number };

export function createLiveRollingPool<T, R>(
  options: LiveRollingPoolOptions<T, R>,
): LiveRollingPool<T, R> {
  const concurrency = Math.max(1, Math.floor(options.concurrency) || 1);
  const queue: QueuedItem<T>[] = [];
  const results: Array<R | undefined> = [];
  let submitted = 0;
  let completed = 0;
  let activeWorkers = 0;
  let failed = false;
  let drainResolver: (() => void) | null = null;
  let drainRejecter: ((error: unknown) => void) | null = null;

  const finishDrain = (error?: unknown) => {
    const resolve = drainResolver;
    const reject = drainRejecter;
    drainResolver = null;
    drainRejecter = null;
    if (error !== undefined && reject) reject(error);
    else resolve?.();
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const next = queue.shift();
      if (!next) return;
      if (options.shouldStop?.()) {
        // Stop dequeuing further work; in-flight items still finish. The stopped item is
        // reported as undefined, mirroring runRollingPool's startedCount semantics.
        continue;
      }
      try {
        results[next.index] = await options.run(next.item);
      } catch (error) {
        if (!failed) {
          failed = true;
          finishDrain(error);
          return;
        }
        console.error("[liveRollingPool] worker failed:", error);
        return;
      }
      completed++;
    }
  };

  const ensureWorkers = (): void => {
    while (activeWorkers < concurrency && activeWorkers < submitted - completed) {
      activeWorkers++;
      void worker().finally(() => {
        activeWorkers--;
        if (activeWorkers === 0 && queue.length === 0 && drainResolver) {
          finishDrain();
        }
      });
    }
  };

  return {
    submit(item: T) {
      results.push(undefined);
      queue.push({ item, index: submitted });
      submitted++;
      ensureWorkers();
    },
    drain() {
      if (queue.length === 0 && activeWorkers === 0) return Promise.resolve(results);
      return new Promise<Array<R | undefined>>((resolve, reject) => {
        drainResolver = () => resolve(results);
        drainRejecter = reject;
        if (activeWorkers === 0 && queue.length === 0) {
          drainResolver = null;
          drainRejecter = null;
          resolve(results);
        }
      });
    },
    submittedCount: () => submitted,
    completedCount: () => completed,
  };
}
