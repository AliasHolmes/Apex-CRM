import React, { useMemo } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useMiningTraceStream } from '@/lib/traceStore';
import { Badge } from '@/components/ui/badge';
import type { MiningTraceEvent, MiningTraceSummary, ProviderSummary } from '@/types';

const formatDuration = (ms?: number) => {
  if (!ms || ms < 0) return '0s';
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`;
};

export const TraceSummaryViewer = ({
  traceSummary,
  traceEvents = []
}: {
  traceSummary?: MiningTraceSummary;
  traceEvents?: MiningTraceEvent[];
}) => {
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
              <span className="truncate">
                <span className="text-slate-500 font-semibold">
                  {event.provider ? `[${event.provider.toUpperCase()}] ` : ''}
                </span>
                <span className="text-slate-300">
                  {event.phase}/{event.operation}
                </span>
                {event.query ? (
                  <span className="text-slate-400"> - "{event.query}"</span>
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

export function TraceTerminal({ sessionId }: { sessionId: string | null | undefined }) {
  const shouldReduceMotion = useReducedMotion();
  const { logs, traceEvents, status, sessionMeta } = useMiningTraceStream(sessionId);

  if (!sessionId && logs.length === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-indigo-500/20 bg-slate-950/90 overflow-hidden shadow-2xl">
      <div className="p-5 font-mono text-xs text-indigo-300 space-y-2.5 max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950">
        <div className="flex gap-3 items-center mb-1">
          <div className="relative h-4 w-4 shrink-0">
            <div
              className={`absolute inset-0 h-full w-full rounded-full border-2 border-indigo-400 border-t-transparent ${
                status === 'running' || status === 'connecting'
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

        {logs.length > 0 ? (
          logs.map((log, i) => {
            let colorClass = 'text-slate-300';
            if (log.includes('WAITING') || log.includes('FILTERING')) colorClass = 'text-amber-400 font-bold';
            if (
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
                <span>{log}</span>
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
      />
    </div>
  );
}
