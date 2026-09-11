import { useSyncExternalStore } from 'react';
import type { MiningTraceEvent } from '@/types';

export type MiningSessionLiveState = {
  sessionId: string;
  logs: string[];
  traceEvents: MiningTraceEvent[];
  status: 'idle' | 'connecting' | 'running' | 'completed' | 'error' | 'cancelled';
  sessionMeta?: any;
  error?: string;
};

class MiningTraceStore {
  private sessions = new Map<string, MiningSessionLiveState>();
  private listeners = new Set<() => void>();
  private activeEventSources = new Map<string, EventSource>();

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private connectionCounts = new Map<string, number>();
  private seenEventIds = new Map<string, Set<string>>();

  private trimSessions() {
    if (this.sessions.size <= 20) return;
    for (const [key, state] of this.sessions.entries()) {
      if (this.sessions.size <= 20) break;
      if (
        !this.activeEventSources.has(key) &&
        state.status !== 'running' &&
        state.status !== 'connecting'
      ) {
        this.sessions.delete(key);
        this.seenEventIds.delete(key);
        this.connectionCounts.delete(key);
      }
    }
  }

  ensureSession(sessionId: string): MiningSessionLiveState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      this.trimSessions();
      state = {
        sessionId,
        logs: [],
        traceEvents: [],
        status: 'idle'
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  getSnapshot(sessionId: string | null | undefined): MiningSessionLiveState {
    if (!sessionId) return DEFAULT_MINING_STATE;
    return this.sessions.get(sessionId) ?? DEFAULT_MINING_STATE;
  }

  getState(sessionId: string): MiningSessionLiveState {
    return this.ensureSession(sessionId);
  }

  private releaseConnection(sessionId: string): void {
    const current = (this.connectionCounts.get(sessionId) || 1) - 1;
    if (current <= 0) {
      this.connectionCounts.delete(sessionId);
      this.disconnect(sessionId);
    } else {
      this.connectionCounts.set(sessionId, current);
    }
  }

  connect(sessionId: string, onPersistenceEvent?: () => void): () => void {
    if (!sessionId) return () => {};

    const refs = (this.connectionCounts.get(sessionId) || 0) + 1;
    this.connectionCounts.set(sessionId, refs);

    const existing = this.activeEventSources.get(sessionId);
    if (existing && existing.readyState !== EventSource.CLOSED) {
      return () => this.releaseConnection(sessionId);
    }

    const current = this.ensureSession(sessionId);
    this.sessions.set(sessionId, {
      ...current,
      status: 'connecting'
    });
    this.notify();

    if (typeof EventSource === 'undefined') {
      this.sessions.set(sessionId, {
        ...current,
        status: 'running'
      });
      this.notify();
      return () => this.releaseConnection(sessionId);
    }

    try {
      const sse = new EventSource(`/api/mining-sessions/${sessionId}/stream`);
      this.activeEventSources.set(sessionId, sse);
      let isInitialSnapshot = true;

      sse.onopen = () => {
        const state = this.ensureSession(sessionId);
        this.sessions.set(sessionId, { ...state, status: 'running' });
        this.notify();
      };

      sse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const state = this.ensureSession(sessionId);

          let nextLogs = state.logs;
          if (isInitialSnapshot) {
            if (Array.isArray(data.logs)) {
              nextLogs = data.logs.slice(-2000);
            }
          } else if (Array.isArray(data.logs) && data.logs.length > 0) {
            nextLogs = [...state.logs, ...data.logs].slice(-2000);
          }

          let seen = this.seenEventIds.get(sessionId);
          if (!seen) {
            seen = new Set(state.traceEvents.map((e) => e.id));
            this.seenEventIds.set(sessionId, seen);
          }

          let nextEvents = state.traceEvents;
          if (isInitialSnapshot) {
            if (Array.isArray(data.traceEvents)) {
              for (const e of data.traceEvents) {
                if (e?.id) seen.add(e.id);
              }
              nextEvents = data.traceEvents.slice(-2000);
              if (nextEvents.some((e: MiningTraceEvent) => e.phase === 'persistence')) {
                onPersistenceEvent?.();
              }
            }
            isInitialSnapshot = false;
          } else if (Array.isArray(data.traceEvents) && data.traceEvents.length > 0) {
            const newEvents: MiningTraceEvent[] = [];
            for (const e of data.traceEvents) {
              if (e?.id && !seen.has(e.id)) {
                seen.add(e.id);
                newEvents.push(e);
              }
            }
            if (newEvents.length > 0) {
              nextEvents = [...state.traceEvents, ...newEvents].slice(-2000);
              if (newEvents.some((e: MiningTraceEvent) => e.phase === 'persistence')) {
                onPersistenceEvent?.();
              }
            }
          }

          const status = data.session?.status || state.status;
          this.sessions.set(sessionId, {
            ...state,
            logs: nextLogs,
            traceEvents: nextEvents,
            sessionMeta: data.session || state.sessionMeta,
            status: status === 'success' ? 'completed' : status
          });
          this.notify();
        } catch {
          // ignore transient json parse errors
        }
      };

      sse.addEventListener('end', () => {
        const state = this.getState(sessionId);
        this.sessions.set(sessionId, { ...state, status: 'completed' });
        this.disconnect(sessionId);
      });

      sse.onerror = () => {
        const state = this.getState(sessionId);
        if (sse.readyState === EventSource.CLOSED) {
          this.disconnect(sessionId);
          void fetch(`/api/mining-sessions/${sessionId}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              const session = data?.session;
              const termStatus = session?.status;
              const finalStatus =
                termStatus === 'success'
                  ? 'completed'
                  : termStatus === 'error'
                    ? 'error'
                    : termStatus === 'cancelled'
                      ? 'cancelled'
                      : state.status;
              const updatedState = this.getState(sessionId);
              this.sessions.set(sessionId, {
                ...updatedState,
                sessionMeta: session || updatedState.sessionMeta,
                status: finalStatus as any,
              });
              this.notify();
            })
            .catch(() => {
              // Silently ignore status fetch error
            });
        }
      };
    } catch (err: any) {
      const state = this.getState(sessionId);
      this.sessions.set(sessionId, { ...state, status: 'error', error: err.message });
      this.notify();
    }

    return () => this.releaseConnection(sessionId);
  }

  disconnect(sessionId: string) {
    this.connectionCounts.delete(sessionId);
    this.seenEventIds.delete(sessionId);
    const sse = this.activeEventSources.get(sessionId);
    if (sse) {
      sse.close();
      this.activeEventSources.delete(sessionId);
    }
  }

  resetSession(sessionId: string) {
    this.disconnect(sessionId);
    this.sessions.delete(sessionId);
    this.notify();
  }
}

export const miningTraceStore = new MiningTraceStore();

const DEFAULT_MINING_STATE: MiningSessionLiveState = Object.freeze({
  sessionId: '',
  logs: Object.freeze([]) as unknown as string[],
  traceEvents: Object.freeze([]) as unknown as MiningTraceEvent[],
  status: 'idle',
});

export function useMiningTraceStream(sessionId: string | null | undefined, onPersistenceEvent?: () => void): MiningSessionLiveState {
  const getSnapshot = () => miningTraceStore.getSnapshot(sessionId);

  return useSyncExternalStore(
    miningTraceStore.subscribe,
    getSnapshot,
    getSnapshot
  );
}
