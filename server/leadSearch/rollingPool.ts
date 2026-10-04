export type RollingPoolOptions = {
  concurrency: number;
  /**
   * Consulted before each item is dequeued. Once it returns true no further item starts, but
   * items already in flight are never interrupted.
   */
  shouldStop?: () => boolean;
};

export type RollingPoolResult<R> = {
  /** Positioned by input index; undefined for items that never started. */
  results: Array<R | undefined>;
  startedCount: number;
};

/**
 * Runs `run` over `items` with at most `concurrency` calls in flight. A finished item frees its
 * slot at once, so one slow item never holds back its siblings the way a Promise.all wave does.
 */
export async function runRollingPool<I, R>(
  items: readonly I[],
  run: (item: I, index: number) => Promise<R>,
  options: RollingPoolOptions,
): Promise<RollingPoolResult<R>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  const workerCount = Math.min(
    Math.max(Math.floor(options.concurrency) || 1, 1),
    items.length,
  );
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      if (options.shouldStop?.()) return;
      const index = nextIndex++;
      results[index] = await run(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  return { results, startedCount: nextIndex };
}
