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
      }
    }
  }

  getState(sessionId: string): MiningSessionLiveState {
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

  connect(sessionId: string, onPersistenceEvent?: () => void): () => void {
    if (!sessionId) return () => {};

    const existing = this.activeEventSources.get(sessionId);
    if (existing && existing.readyState !== EventSource.CLOSED) {
      return () => this.disconnect(sessionId);
    }

    const current = this.getState(sessionId);
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
      return () => {};
    }

    try {
      const sse = new EventSource(`/api/mining-sessions/${sessionId}/stream`);
      this.activeEventSources.set(sessionId, sse);
      let isInitialSnapshot = true;

      sse.onopen = () => {
        const state = this.getState(sessionId);
        this.sessions.set(sessionId, { ...state, status: 'running' });
        this.notify();
      };

      sse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const state = this.getState(sessionId);

          let nextLogs = state.logs;
          if (isInitialSnapshot) {
            if (Array.isArray(data.logs)) {
              nextLogs = data.logs;
            }
          } else if (Array.isArray(data.logs) && data.logs.length > 0) {
            nextLogs = [...state.logs, ...data.logs];
          }

          let nextEvents = state.traceEvents;
          if (isInitialSnapshot) {
            if (Array.isArray(data.traceEvents)) {
              nextEvents = data.traceEvents;
              if (nextEvents.some((e: MiningTraceEvent) => e.phase === 'persistence')) {
                onPersistenceEvent?.();
              }
            }
            isInitialSnapshot = false;
          } else if (Array.isArray(data.traceEvents) && data.traceEvents.length > 0) {
            const seenIds = new Set(state.traceEvents.map(e => e.id));
            const newEvents = data.traceEvents.filter((e: MiningTraceEvent) => !seenIds.has(e.id));
            if (newEvents.length > 0) {
              nextEvents = [...state.traceEvents, ...newEvents];
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

    return () => this.disconnect(sessionId);
  }

  disconnect(sessionId: string) {
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

export function useMiningTraceStream(sessionId: string | null | undefined, onPersistenceEvent?: () => void): MiningSessionLiveState {
  const defaultState: MiningSessionLiveState = {
    sessionId: sessionId || '',
    logs: [],
    traceEvents: [],
    status: 'idle'
  };

  const getSnapshot = () => {
    if (!sessionId) return defaultState;
    return miningTraceStore.getState(sessionId);
  };

  return useSyncExternalStore(
    miningTraceStore.subscribe,
    getSnapshot,
    getSnapshot
  );
}
