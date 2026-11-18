import { readMiningSessionSummaryById } from "../db.js";
import { discoveryEngine } from "../leadSearch/discoveryEngine.js";

/**
 * Per-session SSE broadcaster: one polling interval + one SQLite read per
 * session, fanned out to all connected subscribers. Replaces the previous
 * per-client interval model where N browser tabs produced N DB reads every
 * 250ms.
 */

export type SessionStreamFrame = {
  seq?: number;
  logs: string[];
  traceEvents: any[];
  session: Record<string, any> | null;
};

export type Subscriber = (frame: SessionStreamFrame) => void;

type SubscriberCursor = {
  lastLogTotal: number;
  lastTraceSeq: number;
};

type SessionBroadcast = {
  subscribers: Map<Subscriber, SubscriberCursor>;
  interval: NodeJS.Timeout | null;
  sequence: number;
  missingTicks: number;
  lastDbReadAt: number;
  cachedSession: Record<string, any> | null;
  /** updated_at of the session row last embedded in a frame (null = never). */
  lastEmittedSessionUpdatedAt: string | null;
};

const POLL_INTERVAL_MS = 250;

class SessionStreamHub {
  private broadcasts = new Map<string, SessionBroadcast>();

  subscribe(
    sessionId: string,
    subscriber: Subscriber,
    cursor?: { lastLogTotal?: number; lastTraceSeq?: number },
  ): () => void {
    let broadcast = this.broadcasts.get(sessionId);
    if (!broadcast) {
      broadcast = {
        subscribers: new Map(),
        interval: null,
        sequence: 0,
        missingTicks: 0,
        lastDbReadAt: 0,
        cachedSession: null,
        lastEmittedSessionUpdatedAt: null,
      };
      this.broadcasts.set(sessionId, broadcast);
    }

    const initialLogTotal =
      typeof cursor?.lastLogTotal === "number"
        ? cursor.lastLogTotal
        : discoveryEngine.getLiveLogTotal(sessionId);
    const initialTraceSeq =
      typeof cursor?.lastTraceSeq === "number"
        ? cursor.lastTraceSeq
        : discoveryEngine.getLiveTraceTotal(sessionId);

    broadcast.subscribers.set(subscriber, {
      lastLogTotal: initialLogTotal,
      lastTraceSeq: initialTraceSeq,
    });

    if (!broadcast.interval) {
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
      const now = Date.now();
      const totalLogs = discoveryEngine.getLiveLogTotal(sessionId);
      const totalTraces = discoveryEngine.getLiveTraceTotal(sessionId);

      let memoryCountersChanged = false;
      for (const cursor of broadcast.subscribers.values()) {
        if (totalLogs > cursor.lastLogTotal || totalTraces > cursor.lastTraceSeq) {
          memoryCountersChanged = true;
          break;
        }
      }

      const isEngineActive = discoveryEngine.isActive(sessionId);
      const wasActiveInCache =
        broadcast.cachedSession?.status === "running" ||
        broadcast.cachedSession?.status === "cancellation_requested";
      const engineTransitionedToInactive = wasActiveInCache && !isEngineActive;

      const shouldReadDb =
        broadcast.lastDbReadAt === 0 ||
        memoryCountersChanged ||
        engineTransitionedToInactive ||
        now - broadcast.lastDbReadAt >= 1000;

      if (shouldReadDb) {
        broadcast.cachedSession = readMiningSessionSummaryById(sessionId);
        broadcast.lastDbReadAt = now;
      }

      const session = broadcast.cachedSession;
      const logs = discoveryEngine.getLiveLogs(sessionId) || [];
      const traceEvents = discoveryEngine.getLiveTrace(sessionId) || [];

      const isMissing = !session && logs.length === 0 && traceEvents.length === 0;
      if (isMissing) {
        broadcast.missingTicks = (broadcast.missingTicks || 0) + 1;
      } else {
        broadcast.missingTicks = 0;
      }

      // If session remains missing after a 30-second grace period (120 ticks * 250ms), close cleanly
      if (broadcast.missingTicks >= 120) {
        broadcast.sequence++;
        const frame: SessionStreamFrame = {
          seq: broadcast.sequence,
          logs: ["Session not found or expired."],
          traceEvents: [],
          session: null,
        };
        for (const [subscriber] of Array.from(broadcast.subscribers.entries())) {
          try {
            subscriber(frame);
          } catch {
            // ignore
          }
          this.unsubscribe(sessionId, subscriber);
        }
        return;
      }

      const isTerminal =
        Boolean(session) &&
        session!.status !== "running" &&
        session!.status !== "cancellation_requested";

      const sessionUpdatedAt = session
        ? String((session as any).updatedAt || (session as any).updated_at || "")
        : "";
      const sessionChanged =
        Boolean(session) &&
        (isTerminal ||
          !sessionUpdatedAt ||
          broadcast.lastEmittedSessionUpdatedAt !== sessionUpdatedAt);
      if (sessionChanged) {
        broadcast.lastEmittedSessionUpdatedAt = sessionUpdatedAt || null;
      }

      for (const [subscriber, cursor] of Array.from(broadcast.subscribers.entries())) {
        const newLogCount = Math.max(
          0,
          Math.min(totalLogs - cursor.lastLogTotal, logs.length),
        );
        const newLogs =
          newLogCount > 0 ? logs.slice(logs.length - newLogCount) : [];

        let newTrace: any[] = [];
        if (totalTraces > cursor.lastTraceSeq) {
          const deltaCount = Math.min(totalTraces - cursor.lastTraceSeq, traceEvents.length);
          const candidateSlice = deltaCount > 0 ? traceEvents.slice(traceEvents.length - deltaCount) : [];
          newTrace = candidateSlice.filter((e) => (e.seq ?? 0) > cursor.lastTraceSeq || !e.seq);
          if (newTrace.length === 0 && candidateSlice.length > 0) {
            newTrace = candidateSlice;
          }
        }

        cursor.lastLogTotal = totalLogs;
        cursor.lastTraceSeq = totalTraces;

        const hasNewContent = newLogs.length > 0 || newTrace.length > 0;
        if (hasNewContent || isTerminal || sessionChanged) {
          broadcast.sequence++;
          const frame: SessionStreamFrame = {
            seq: broadcast.sequence,
            logs: newLogs,
            traceEvents: newTrace,
            session: sessionChanged ? session : null,
          };
          try {
            subscriber(frame);
          } catch {
            this.unsubscribe(sessionId, subscriber);
          }
        }
      }

      if (isTerminal) {
        for (const [subscriber] of Array.from(broadcast.subscribers.entries())) {
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
