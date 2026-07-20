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
  ));

  return Promise.all(pending) as Promise<T[]>;
}
