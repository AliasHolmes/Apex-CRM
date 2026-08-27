import { readMiningSessionSummaryById } from "../db.js";
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
  lastLogTotal: number;
  lastTraceTotal: number;
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
        lastLogTotal: 0,
        lastTraceTotal: 0,
      };
      this.broadcasts.set(sessionId, broadcast);
    }

    broadcast.subscribers.add(subscriber);

    if (!broadcast.interval) {
      // Seed total counters so the first tick only sends genuinely-new deltas.
      broadcast.lastLogTotal = discoveryEngine.getLiveLogTotal(sessionId);
      broadcast.lastTraceTotal = discoveryEngine.getLiveTraceTotal(sessionId);
      broadcast.interval = setInterval(
        () => this.poll(sessionId),
        POLL_INTERVAL_MS,
      );
    }

    return () => this.unsubscribe(sessionId, subscriber);
  }

  unsubscribe(sessionId: string, subscriber: Subscriber) {
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
      const session = readMiningSessionSummaryById(sessionId);

      const totalLogs = discoveryEngine.getLiveLogTotal(sessionId);
      const totalTraces = discoveryEngine.getLiveTraceTotal(sessionId);

      const newLogCount = Math.max(
        0,
        Math.min(totalLogs - broadcast.lastLogTotal, logs.length),
      );
      const newTraceCount = Math.max(
        0,
        Math.min(totalTraces - broadcast.lastTraceTotal, traceEvents.length),
      );

      const newLogs =
        newLogCount > 0 ? logs.slice(logs.length - newLogCount) : [];
      const newTrace =
        newTraceCount > 0
          ? traceEvents.slice(traceEvents.length - newTraceCount)
          : [];

      broadcast.lastLogTotal = totalLogs;
      broadcast.lastTraceTotal = totalTraces;

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
            // A broken subscriber pipe must be pruned immediately to prevent leaks.
            this.unsubscribe(sessionId, subscriber);
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
