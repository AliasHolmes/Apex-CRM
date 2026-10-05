import { useSyncExternalStore } from 'react';

/**
 * Leads that a long-running background job (profile enrichment) is currently touching.
 * The Prospects table owns the job; the shared lead drawer reads this so it can disable
 * edits for the same records instead of racing the job.
 */
let lockedLeadIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

export function setLockedLeadIds(ids: Iterable<string>): void {
  const next = new Set(ids);
  if (sameMembers(lockedLeadIds, next)) return;
  lockedLeadIds = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadonlySet<string> {
  return lockedLeadIds;
}

export function useLockedLeadIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
