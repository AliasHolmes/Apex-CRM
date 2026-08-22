import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useMiningTraceStream } from '@/lib/traceStore';
import { Badge } from '@/components/ui/badge';
import type { MiningTraceEvent } from '@/types';

function TraceSummaryViewer({ traceEvents }: { traceEvents: MiningTraceEvent[] }) {
  if (!traceEvents || traceEvents.length === 0) return null;

  const totalEvents = traceEvents.length;
  const errorEvents = traceEvents.filter(e => e.status === 'error');
  const lastEvent = traceEvents[traceEvents.length - 1];
  const lastLabel = lastEvent ? (lastEvent.operation || lastEvent.query || lastEvent.error?.message || lastEvent.phase) : '';

  return (
    <div className="border-t border-slate-800 bg-slate-950/70 p-3 flex items-center justify-between text-xs text-slate-400">
      <div className="flex items-center gap-2">
        <span>Events: <strong className="text-slate-200">{totalEvents}</strong></span>
        {errorEvents.length > 0 && (
          <Badge variant="outline" className="border-rose-500/30 text-rose-300 text-xs px-1.5 py-0">
            {errorEvents.length} errors
          </Badge>
        )}
      </div>
      {lastLabel && (
        <div className="text-slate-400 truncate max-w-xs text-xs">
          Latest: <span className="text-slate-300">{lastLabel}</span>
        </div>
      )}
    </div>
  );
}

export function TraceTerminal({ sessionId }: { sessionId: string | null | undefined }) {
  const shouldReduceMotion = useReducedMotion();
  const { logs, traceEvents, status } = useMiningTraceStream(sessionId);

  if (!sessionId && logs.length === 0) return null;

  return (
    <div className="mt-4 rounded-xl border border-indigo-500/20 bg-slate-950/90 overflow-hidden shadow-2xl">
      <div className="p-5 font-mono text-xs text-indigo-300 space-y-2.5 max-h-72 overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-slate-950">
        <div className="flex gap-3 items-center mb-1">
          <div className="relative h-4 w-4 shrink-0">
            <div className={`absolute inset-0 h-full w-full rounded-full border-2 border-indigo-400 border-t-transparent ${status === 'running' || status === 'connecting' ? 'animate-spin motion-reduce:animate-none' : ''}`} />
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
            let colorClass = "text-slate-300";
            if (log.includes("WAITING") || log.includes("FILTERING")) colorClass = "text-amber-400 font-bold";
            if (log.includes("REQUEST") || log.includes("QUERY") || log.includes("DISCOVERY") || log.includes("EVIDENCE") || log.includes("EXTRACTION")) {
              colorClass = "text-indigo-400 font-bold";
            }
            return (
              <motion.div 
                key={i} 
                className={`${colorClass} leading-relaxed flex items-start gap-1`}
                initial={shouldReduceMotion ? false : { opacity: 0, x: -5 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.15 }}
              >
                <span className="shrink-0 text-slate-600 select-none">{">"}</span>
                <span>{log}</span>
              </motion.div>
            );
          })
        ) : (
          <p className="text-slate-500 italic">Starting the search...</p>
        )}
      </div>
      <TraceSummaryViewer traceEvents={traceEvents} />
    </div>
  );
}
