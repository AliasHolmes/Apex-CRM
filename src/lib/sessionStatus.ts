/**
 * Mining-session status handling shared by the workspace watcher and the trace store.
 *
 * The server writes `partial_success` when a session finished but only some prospects reached
 * SQLite (persistStage). Every consumer must treat it as a finished-with-warning outcome; a
 * consumer that only knows `success` would report the session as failed.
 */

export type SessionOutcome = 'active' | 'success' | 'partial' | 'cancelled' | 'failed';

const ACTIVE_STATUSES = new Set(['running', 'cancellation_requested']);

export function isTerminalSessionStatus(status: unknown): boolean {
  const value = String(status ?? '');
  return value !== '' && !ACTIVE_STATUSES.has(value);
}

export function classifySessionStatus(status: unknown): SessionOutcome {
  switch (String(status ?? '')) {
    case 'success':
      return 'success';
    case 'partial_success':
      return 'partial';
    case 'cancelled':
      return 'cancelled';
    case 'running':
    case 'cancellation_requested':
    case '':
      return 'active';
    default:
      return 'failed';
  }
}

/** True for a session that ended with results to show (full or partial). */
export function isFinishedWithResults(status: unknown): boolean {
  const outcome = classifySessionStatus(status);
  return outcome === 'success' || outcome === 'partial';
}
