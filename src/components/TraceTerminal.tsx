import React, { useMemo, useState, useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useMiningTraceStream } from '@/lib/traceStore';
import { Badge } from '@/components/ui/badge';
import { Clock } from 'lucide-react';
import type { MiningTraceEvent, MiningTraceSummary, ProviderSummary } from '@/types';

export const formatDuration = (ms?: number) => {
  if (ms === undefined || ms === null || isNaN(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) {
    const s = Math.round(ms / 100) / 10;
    return Number.isInteger(s) ? `${s}.0s` : `${s}s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
};

export function useSessionDuration({
  startedAt,
  endedAt,
  durationMs,
  isRunning,
}: {
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  isRunning?: boolean;
}) {
  const [now, setNow] = useState<number>(() => Date.now());
  const initialMountTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [isRunning]);

  return useMemo(() => {
    const startMs = startedAt ? Date.parse(startedAt) : NaN;
    const endMs = endedAt ? Date.parse(endedAt) : NaN;

    if (isRunning) {
      if (Number.isFinite(startMs)) {
        return Math.max(0, now - startMs);
      }
      return Math.max(0, now - initialMountTimeRef.current);
    }

    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      return durationMs;
    }

    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      return Math.max(0, endMs - startMs);
    }

    if (Number.isFinite(startMs)) {
      return Math.max(0, (Number.isFinite(endMs) ? endMs : now) - startMs);
    }

    return undefined;
  }, [startedAt, endedAt, durationMs, isRunning, now]);
}

export interface TraceSummaryViewerProps {
  traceSummary?: MiningTraceSummary;
  traceEvents?: MiningTraceEvent[];
  status?: string;
  isRunning?: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export const TraceSummaryViewer = ({
  traceSummary,
  traceEvents = [],
  status,
  isRunning,
  startedAt,
  endedAt,
  durationMs
}: TraceSummaryViewerProps) => {
  const active = isRunning ?? (status === 'running' || status === 'connecting' || traceSummary?.status === 'running');
  const effectiveStartedAt = startedAt || traceSummary?.startedAt || traceEvents[0]?.timestamp;
  const effectiveEndedAt = endedAt || traceSummary?.endedAt || (!active && traceEvents.length > 0 ? traceEvents[traceEvents.length - 1]?.timestamp : undefined);
  const effectiveDuration = useSessionDuration({
    startedAt: effectiveStartedAt,
    endedAt: effectiveEndedAt,
    durationMs: durationMs ?? traceSummary?.durationMs,
    isRunning: active
  });

  const derivedSummary = useMemo(() => {
    if (traceSummary) return null;
    let totalTokens = 0;
    let estimatedUsd = 0;
    const providerMap: Record<
      string,
      { calls: number; successes: number; failures: number; skipped: number; totalTokens: number; totalLatencyMs: number }
    > = {};
    const phaseMap: Record<
      string,
      { phase: string; status: 'ok' | 'error'; events: number; totalLatencyMs: number }
    > = {};

    for (const ev of traceEvents) {
      if (ev.llm) {
        totalTokens += Number(ev.llm.totalTokens || 0);
        estimatedUsd += Number(ev.llm.estimatedCostUsd || 0);
      }
      const prov =
        ev.provider ||
        (ev.llm ? 'llm' : ev.tavily ? 'tavily' : ev.brightData ? 'brightdata' : 'system');
      if (!providerMap[prov]) {
        providerMap[prov] = {
          calls: 0,
          successes: 0,
          failures: 0,
          skipped: 0,
          totalTokens: 0,
          totalLatencyMs: 0
        };
      }
      providerMap[prov].calls++;
      if (ev.status === 'success') providerMap[prov].successes++;
      else if (ev.status === 'error') providerMap[prov].failures++;
      else if (ev.status === 'skipped') providerMap[prov].skipped++;
      if (ev.llm?.totalTokens) providerMap[prov].totalTokens += Number(ev.llm.totalTokens);
      if (ev.latencyMs) providerMap[prov].totalLatencyMs += Number(ev.latencyMs);

      const ph = ev.phase || 'session';
      if (!phaseMap[ph]) {
        phaseMap[ph] = { phase: ph, status: 'ok', events: 0, totalLatencyMs: 0 };
      }
      phaseMap[ph].events++;
      if (ev.status === 'error') phaseMap[ph].status = 'error';
      if (ev.latencyMs) phaseMap[ph].totalLatencyMs += Number(ev.latencyMs);
    }

    const providers: [string, any][] = Object.entries(providerMap).map(([p, item]) => [
      p,
      {
        calls: item.calls,
        successes: item.successes,
        failures: item.failures,
        skipped: item.skipped,
        totalTokens: item.totalTokens,
        latencyMs: item.totalLatencyMs,
        avgLatencyMs: item.calls > 0 ? Math.round(item.totalLatencyMs / item.calls) : 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        fallbackUses: 0
      }
    ]);

    const phases = Object.values(phaseMap).map(p => ({
      phase: p.phase,
      status: p.status,
      events: p.events,
      durationMs: p.totalLatencyMs
    }));

    return { totalTokens, estimatedUsd, providers, phases };
  }, [traceSummary, traceEvents]);

  const providerSummary: ProviderSummary = traceSummary?.providerSummary || {};
  const providers = traceSummary
    ? Object.entries(providerSummary).filter(
        ([, item]) => item.calls > 0 || item.failures > 0 || item.skipped > 0
      )
    : derivedSummary?.providers || [];
  const phases = traceSummary?.phaseTimeline || derivedSummary?.phases || [];
  const totalTokens =
    traceSummary?.costSummary?.totalTokens ?? derivedSummary?.totalTokens ?? 0;
  const estimatedUsd =
    traceSummary?.costSummary?.estimatedUsd ?? derivedSummary?.estimatedUsd ?? 0;
  const costPerLead = traceSummary?.costSummary?.costPerAcceptedLead;
  const eventCount = traceSummary?.eventCount ?? traceEvents.length;
  const recent = traceEvents.slice(-6).reverse();

  if (!traceSummary && traceEvents.length === 0) return null;

  return (
    <div className="p-4 border-t border-slate-800 bg-slate-950/70 space-y-3 text-xs text-slate-400">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <div className="bg-slate-900/60 border border-slate-800 rounded-md p-2.5">
          <div className="text-xs uppercase text-slate-500 font-bold tracking-wider flex items-center justify-between">
            <span>Duration</span>
            {active && (
              <span className="flex items-center gap-1 text-xs font-semibold text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse motion-reduce:animate-none" />
                Live
              </span>
            )}
          </div>
          <div className="text-sm text-cyan-300 font-semibold mt-0.5 font-mono">
            {formatDuration(effectiveDuration)}
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-md p-2.5">
          <div className="text-xs uppercase text-slate-500 font-bold tracking-wider">Events</div>
          <div className="text-sm text-slate-200 font-semibold mt-0.5">{eventCount}</div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-md p-2.5">
          <div className="text-xs uppercase text-slate-500 font-bold tracking-wider">Model tokens</div>
          <div className="text-sm text-indigo-300 font-semibold mt-0.5">
            {totalTokens.toLocaleString()}
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-md p-2.5">
          <div className="text-xs uppercase text-slate-500 font-bold tracking-wider">Est. Cost</div>
          <div className="text-sm text-emerald-300 font-semibold mt-0.5">
            ${estimatedUsd.toFixed(4)}
          </div>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-md p-2.5">
          <div className="text-xs uppercase text-slate-500 font-bold tracking-wider">Cost / Lead</div>
          <div className="text-sm text-slate-200 font-semibold mt-0.5">
            {costPerLead !== undefined ? `$${costPerLead.toFixed(4)}` : '-'}
          </div>
        </div>
      </div>

      {typeof traceSummary?.existingCrmLeadsSkipped === 'number' && traceSummary.existingCrmLeadsSkipped > 0 && (
        <div className="flex items-center gap-2 pt-0.5">
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/10 text-amber-300 font-mono text-xs py-1 px-2.5 flex items-center gap-1.5"
          >
            <span>CRM Duplicates Filtered: {traceSummary.existingCrmLeadsSkipped}</span>
          </Badge>
        </div>
      )}

      {providers.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
          {providers.map(([provider, item]) => (
            <div
              key={provider}
              className="bg-slate-900/50 border border-slate-800 rounded-md p-2.5 text-xs"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="uppercase font-bold text-slate-300 flex items-center gap-1.5">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      provider === 'brightdata'
                        ? 'bg-amber-400'
                        : provider === 'tavily'
                        ? 'bg-cyan-400'
                        : provider === 'llm'
                        ? 'bg-indigo-400'
                        : 'bg-slate-400'
                    }`}
                  />
                  {provider}
                </span>
                <span className="text-slate-500 text-xs">
                  avg {formatDuration(item.avgLatencyMs)}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span>
                  <strong className="text-slate-200">{item.calls}</strong> calls
                </span>
                <span className="text-emerald-400 font-medium">{item.successes} ok</span>
                {item.failures > 0 && (
                  <span className="text-rose-400 font-medium">{item.failures} fail</span>
                )}
                {item.totalTokens > 0 && (
                  <span className="text-indigo-300">
                    {item.totalTokens.toLocaleString()} tok
                  </span>
                )}
              </div>
              {item.models && Object.keys(item.models).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2 pt-1.5 border-t border-slate-800/80">
                  {Object.entries(item.models).map(([modelName, count]) => (
                    <span
                      key={modelName}
                      className="px-1.5 py-0.5 rounded text-xs font-mono bg-cyan-950/60 border border-cyan-500/30 text-cyan-300 flex items-center gap-1"
                    >
                      <span className="text-cyan-300">{modelName}</span>
                      <span className="text-cyan-500 font-sans font-semibold">({String(count)})</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {phases.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {phases.map((phase) => (
            <span
              key={phase.phase}
              className={`px-2 py-1 rounded-md border text-xs font-semibold flex items-center gap-1.5 ${
                phase.status === 'error'
                  ? 'border-rose-500/30 text-rose-300 bg-rose-500/5'
                  : 'border-slate-800 text-slate-300 bg-slate-900/70'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  phase.status === 'error' ? 'bg-rose-400' : 'bg-emerald-400'
                }`}
              />
              {phase.phase.replace(/_/g, ' ')} ({phase.events}) - {formatDuration(phase.durationMs)}
            </span>
          ))}
        </div>
      )}

      {recent.length > 0 && (
        <div className="space-y-1 pt-1">
          <div className="text-xs uppercase text-slate-500 font-bold tracking-wider mb-1">
            Recent tool calls
          </div>
          {recent.map((event) => (
            <div
              key={event.id}
              className="text-xs text-slate-400 font-mono bg-slate-900/40 border border-slate-800/80 rounded px-2 py-1.5 flex items-center justify-between gap-2"
            >
              <span className="truncate flex items-center gap-1.5 min-w-0">
                <span className="text-slate-500 font-semibold shrink-0">
                  {event.provider ? `[${event.provider.toUpperCase()}] ` : ''}
                </span>
                <span className="text-slate-300 shrink-0">
                  {event.phase}/{event.operation}
                </span>
                {(event.model || event.llm?.model) && (
                  <span className="px-1.5 py-0.5 rounded text-xs bg-cyan-950/80 border border-cyan-500/40 text-cyan-300 font-mono shrink-0">
                    {event.model || event.llm?.model}
                  </span>
                )}
                {event.query ? (
                  <span className="text-slate-400 truncate"> - "{event.query}"</span>
                ) : (
                  ''
                )}
              </span>
              <span
                className={`shrink-0 text-xs font-semibold px-1.5 py-0.5 rounded ${
                  event.status === 'error'
                    ? 'text-rose-400 bg-rose-500/10'
                    : event.status === 'success'
                    ? 'text-emerald-400 bg-emerald-500/10'
                    : 'text-slate-400 bg-slate-800/50'
                }`}
              >
                {event.latencyMs ? `${formatDuration(event.latencyMs)} ` : ''}
                {event.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function renderTerminalLog(log: string) {
  if (log.includes('[LLM 200 OK]')) {
    const match = log.match(
      /\[LLM 200 OK\]\s+([^\s\u00b7]+)\s+\u00b7\s+model:\s+([^\s\u00b7]+)\s+\u00b7\s+([\d,]+ms)(?:\s+\u00b7\s+([\d,]+ tok))?(?:\s+(.*))?/,
    );
    if (match) {
      const [, provider, model, latency, tokens, details] = match;
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5 py-0.5">
          <span className="px-1.5 py-0.5 rounded text-xs font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm shadow-emerald-950">
            200 OK
          </span>
          <span className="font-semibold text-slate-200">{provider}</span>
          <span className="text-slate-600">{"\u00b7"}</span>
          <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-cyan-950/80 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950">
            {model}
          </span>
          <span className="text-slate-600">{"\u00b7"}</span>
          <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30">
            {latency}
          </span>
          {tokens && (
            <>
              <span className="text-slate-600">{"\u00b7"}</span>
              <span className="px-1.5 py-0.5 rounded text-xs font-mono bg-purple-500/15 text-purple-300 border border-purple-500/30">
                {tokens}
              </span>
            </>
          )}
          {details && (
            <span className="text-indigo-300 font-medium ml-0.5">{details}</span>
          )}
        </span>
      );
    }
  }

  if (log.includes('[LLM ERROR') || log.startsWith('WARN:')) {
    const isError = log.includes('[LLM ERROR');
    const badgeText = isError ? 'LLM ERROR' : 'WARNING';
    const cleanLog = log.replace(/^\[LLM ERROR[^\]]*\]\s*/, '').replace(/^WARN:\s*/, '');
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 py-0.5">
        <span
          className={`px-1.5 py-0.5 rounded text-xs font-bold ${
            isError
              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-sm shadow-rose-950'
              : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
          }`}
        >
          {badgeText}
        </span>
        <span className={isError ? 'text-rose-300' : 'text-amber-300'}>{cleanLog}</span>
      </span>
    );
  }

  if (log.includes('RATE LIMIT') || log.includes('429')) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5 py-0.5">
        <span className="px-1.5 py-0.5 rounded text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
          429 BACKOFF
        </span>
        <span className="text-amber-300">{log}</span>
      </span>
    );
  }

  return <span>{log}</span>;
}

export function TraceTerminal({ sessionId }: { sessionId: string | null | undefined }) {
  const shouldReduceMotion = useReducedMotion();
  const { logs, traceEvents, status, sessionMeta } = useMiningTraceStream(sessionId);

  const isRunning = status === 'running' || status === 'connecting';
  const effectiveStartedAt = sessionMeta?.startedAt || sessionMeta?.traceSummary?.startedAt || traceEvents[0]?.timestamp;
  const effectiveEndedAt = sessionMeta?.completedAt || sessionMeta?.traceSummary?.endedAt;
  const elapsedMs = useSessionDuration({
    startedAt: effectiveStartedAt,
    endedAt: effectiveEndedAt,
    durationMs: sessionMeta?.traceSummary?.durationMs,
    isRunning
  });

  if (!sessionId && logs.length === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-indigo-500/20 bg-slate-950/90 overflow-hidden shadow-2xl">
      <div className="p-5 font-mono text-xs text-indigo-300 space-y-2.5 max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950">
        <div className="flex flex-wrap gap-3 items-center justify-between mb-1">
          <div className="flex gap-3 items-center">
            <div className="relative h-4 w-4 shrink-0">
              <div
                className={`absolute inset-0 h-full w-full rounded-full border-2 border-indigo-400 border-t-transparent ${
                  isRunning
                    ? 'animate-spin motion-reduce:animate-none'
                    : ''
                }`}
              />
            </div>
            <div className="text-sm text-slate-100 font-semibold flex items-center gap-2">
              <span>Search live telemetry</span>
              {status === 'running' && (
                <Badge variant="outline" className="border-indigo-500/40 text-indigo-300 text-xs py-0">
                  Streaming
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {Boolean(
              (sessionMeta?.stats as any)?.existingCrmLeadsSkipped ||
                sessionMeta?.traceSummary?.existingCrmLeadsSkipped,
            ) && (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/10 text-amber-300 font-mono text-xs py-0.5 px-2.5"
              >
                CRM Duplicates Filtered:{" "}
                {(sessionMeta?.stats as any)?.existingCrmLeadsSkipped ||
                  sessionMeta?.traceSummary?.existingCrmLeadsSkipped}
              </Badge>
            )}
            <Badge
              variant="outline"
              className={`font-mono text-xs py-0.5 px-2.5 flex items-center gap-1.5 ${
                isRunning
                  ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200'
                  : 'border-slate-800 bg-slate-900/60 text-slate-300'
              }`}
            >
              <Clock className={`w-3.5 h-3.5 ${isRunning ? 'text-indigo-400 animate-pulse motion-reduce:animate-none' : 'text-slate-400'}`} />
              <span>{isRunning ? `Running: ${formatDuration(elapsedMs)}` : `Duration: ${formatDuration(elapsedMs)}`}</span>
            </Badge>
          </div>
        </div>

        {logs.length > 0 ? (
          logs.map((log, i) => {
            let colorClass = 'text-slate-300';
            if (log.includes('[LLM 200 OK]')) colorClass = 'text-slate-200';
            else if (log.includes('[LLM ERROR') || log.startsWith('WARN:')) colorClass = 'text-rose-400 font-medium';
            else if (log.includes('RATE LIMIT') || log.includes('429')) colorClass = 'text-amber-400 font-medium';
            else if (log.includes('WAITING') || log.includes('FILTERING')) colorClass = 'text-amber-400 font-bold';
            else if (
              log.includes('REQUEST') ||
              log.includes('QUERY') ||
              log.includes('DISCOVERY') ||
              log.includes('EVIDENCE') ||
              log.includes('EXTRACTION')
            ) {
              colorClass = 'text-indigo-400 font-bold';
            }
            return (
              <motion.div
                key={i}
                className={`${colorClass} leading-relaxed flex items-start gap-1`}
                initial={shouldReduceMotion ? false : { opacity: 0, x: -5 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.15 }}
              >
                <span className="shrink-0 text-slate-600 select-none">{'>'}</span>
                <div className="min-w-0 flex-1">{renderTerminalLog(log)}</div>
              </motion.div>
            );
          })
        ) : (
          <p className="text-slate-500 italic">Starting the search...</p>
        )}
      </div>
      <TraceSummaryViewer
        traceSummary={sessionMeta?.traceSummary}
        traceEvents={traceEvents}
        status={status}
        isRunning={isRunning}
        startedAt={effectiveStartedAt}
        endedAt={effectiveEndedAt}
        durationMs={sessionMeta?.traceSummary?.durationMs}
      />
    </div>
  );
}
