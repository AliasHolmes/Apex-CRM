import { readMiningSessionById } from "../db.js";
import { discoveryEngine } from "../leadSearch/discoveryEngine.js";

/**
 * Per-session SSE broadcaster: one polling interval + one SQLite read per
 * session, fanned out to all connected subscribers. Replaces the previous
 * per-client interval model where N browser tabs produced N DB reads every
 * 250ms.
 */

export type SessionStreamFrame = {
  logs: string[];
  traceEvents: any[];
  session: Record<string, any> | null;
};

type Subscriber = (frame: SessionStreamFrame) => void;

type SessionBroadcast = {
  subscribers: Set<Subscriber>;
  interval: NodeJS.Timeout | null;
  lastLogCount: number;
  lastTraceCount: number;
};

const POLL_INTERVAL_MS = 250;

class SessionStreamHub {
  private broadcasts = new Map<string, SessionBroadcast>();

  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    let broadcast = this.broadcasts.get(sessionId);
    if (!broadcast) {
      broadcast = {
        subscribers: new Set(),
        interval: null,
        lastLogCount: 0,
        lastTraceCount: 0,
      };
      this.broadcasts.set(sessionId, broadcast);
    }

    broadcast.subscribers.add(subscriber);

    if (!broadcast.interval) {
      // Seed counters so the first tick only sends genuinely-new deltas.
      const logs = discoveryEngine.getLiveLogs(sessionId) || [];
      const traceEvents = discoveryEngine.getLiveTrace(sessionId) || [];
      broadcast.lastLogCount = logs.length;
      broadcast.lastTraceCount = traceEvents.length;
      broadcast.interval = setInterval(
        () => this.poll(sessionId),
        POLL_INTERVAL_MS,
      );
    }

    return () => this.unsubscribe(sessionId, subscriber);
  }

  private unsubscribe(sessionId: string, subscriber: Subscriber) {
    const broadcast = this.broadcasts.get(sessionId);
    if (!broadcast) return;
    broadcast.subscribers.delete(subscriber);
    if (broadcast.subscribers.size === 0) {
      if (broadcast.interval) clearInterval(broadcast.interval);
      this.broadcasts.delete(sessionId);
    }
  }

  /** One poll per session regardless of subscriber count. */
  private poll(sessionId: string) {
    const broadcast = this.broadcasts.get(sessionId);
    if (!broadcast) return;

    try {
      const logs = discoveryEngine.getLiveLogs(sessionId) || [];
      const traceEvents = discoveryEngine.getLiveTrace(sessionId) || [];
      const session = readMiningSessionById(sessionId);

      const newLogs = logs.slice(broadcast.lastLogCount);
      const newTrace = traceEvents.slice(broadcast.lastTraceCount);
      broadcast.lastLogCount = logs.length;
      broadcast.lastTraceCount = traceEvents.length;

      const hasNewContent = newLogs.length > 0 || newTrace.length > 0;
      const isTerminal =
        Boolean(session) &&
        session!.status !== "running" &&
        session!.status !== "cancellation_requested";

      if (hasNewContent || isTerminal) {
        const frame: SessionStreamFrame = {
          logs: newLogs,
          traceEvents: newTrace,
          session,
        };
        for (const subscriber of Array.from(broadcast.subscribers)) {
          try {
            subscriber(frame);
          } catch {
            // A broken subscriber pipe must not kill the fan-out loop.
          }
        }
      }

      if (isTerminal) {
        for (const subscriber of Array.from(broadcast.subscribers)) {
          this.unsubscribe(sessionId, subscriber);
        }
      }
    } catch (error) {
      console.warn(
        `[sessionStreamHub] Error polling session ${sessionId}:`,
        error,
      );
    }
  }

  /** Test/diagnostic hook. */
  getStats() {
    return Array.from(this.broadcasts.entries()).map(([sessionId, b]) => ({
      sessionId,
      subscribers: b.subscribers.size,
      polling: Boolean(b.interval),
    }));
  }
}

export const sessionStreamHub = new SessionStreamHub();
