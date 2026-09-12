export type ProviderQueueTask<T> = {
  run: (signal?: AbortSignal) => Promise<T>;
  id?: string;
  priority?: number;
};

export type ProviderQueueOptions = {
  concurrency: number;
  signal?: AbortSignal;
  intervalCap?: number;
  intervalMs?: number;
};

type PQueueInstance = {
  add<T>(task: (options: { signal?: AbortSignal }) => Promise<T>, options?: {
    id?: string;
    priority?: number;
    signal?: AbortSignal;
  }): Promise<T | void>;
};

type PQueueConstructor = new (options: {
  concurrency: number;
  intervalCap?: number;
  interval?: number;
}) => PQueueInstance;

let pQueueConstructor: Promise<PQueueConstructor> | undefined;

const loadPQueue = () => {
  pQueueConstructor ||= import('p-queue').then(module => module.default as unknown as PQueueConstructor);
  return pQueueConstructor;
};

export async function runProviderQueue<T>(tasks: ProviderQueueTask<T>[], options: ProviderQueueOptions): Promise<T[]> {
  if (tasks.length === 0) return [];
  const PQueue = await loadPQueue();
  const concurrency = Math.min(Math.max(Math.floor(options.concurrency) || 1, 1), 16);
  const intervalCap = Math.max(Math.floor(options.intervalCap || 0), 0);
  const interval = Math.max(Math.floor(options.intervalMs || 0), 0);
  const queue = new PQueue({
    concurrency,
    ...(intervalCap > 0 && interval > 0 ? { intervalCap, interval } : {})
  });

  // Each task settles individually into `results` / `failures` instead of rejecting into the
  // aggregate. Previously a single task failure discarded every sibling result - which for
  // paid Tavily/Bright Data work meant throwing away results that had already been bought.
  const results = new Array<T | undefined>(tasks.length);
  const failures: unknown[] = [];

  const pending = tasks.map((task, index) => queue.add(
    async ({ signal }) => {
      if (options.signal?.aborted || signal?.aborted) {
        const error = new Error('Queued provider work was cancelled.');
        error.name = 'AbortError';
        throw error;
      }
      return task.run(signal || options.signal);
    },
    {
      id: task.id || `provider-task-${index + 1}`,
      priority: Number.isFinite(task.priority) ? task.priority : 0,
      signal: options.signal
    }
  ).then(
    (value) => {
      if (value !== undefined && value !== null) {
        results[index] = value as T;
      }
    },
    (error) => {
      failures.push(error);
    },
  ));

  // Cancellation must settle immediately and must NOT wait for in-flight tasks, which may
  // never settle (see test/adaptiveScheduler.test.ts "removes work that has not started when
  // the session is cancelled"). A plain Promise.all - or allSettled - would deadlock there.
  if (options.signal) {
    const abortSignal = options.signal;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      onAbort = () => resolve();
      abortSignal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([Promise.all(pending), aborted]);
    } finally {
      // The signal is session-scoped and runProviderQueue is called once per stage per
      // round, so without this the listeners would accumulate for the whole session and
      // eventually trip MaxListenersExceededWarning.
      if (onAbort) abortSignal.removeEventListener('abort', onAbort);
    }
    if (abortSignal.aborted) {
      const cancelError = new Error('Queued provider work was cancelled.');
      cancelError.name = 'AbortError';
      throw cancelError;
    }
  }

  await Promise.all(pending);

  const values = results.filter(
    (value): value is T => value !== undefined && value !== null,
  );
  // Nothing succeeded: surface the original failure so callers still see errors.
  if (values.length === 0 && failures.length > 0) {
    const first = failures[0];
    throw first instanceof Error ? first : new Error(String(first));
  }
  return values;
}
