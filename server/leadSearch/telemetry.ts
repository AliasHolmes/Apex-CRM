export type MiningProvider = 'llm' | 'tavily' | 'brightdata' | 'sqlite' | 'system';
export type MiningPhase =
  | 'session'
  | 'strategy'
  | 'search'
  | 'candidate_processing'
  | 'extraction'
  | 'filtering'
  | 'enrichment'
  | 'persistence';
export type MiningEventStatus = 'started' | 'success' | 'error' | 'skipped' | 'info';

export type MiningTraceEvent = {
  id: string;
  timestamp: string;
  phase: MiningPhase;
  operation: string;
  status: MiningEventStatus;
  provider?: MiningProvider;
  round?: number;
  query?: string;
  chunk?: {
    index: number;
    total: number;
    inputChars?: number;
  };
  latencyMs?: number;
  counts?: Record<string, number>;
  llm?: {
    purpose?: string;
    model?: string;
    route?: string;
    fallbackUsed?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
    finishReason?: string;
    parseRetries?: number;
    providerAttempts?: Array<{
      providerId: string;
      provider: string;
      model: string;
      status: 'success' | 'error' | 'skipped';
      statusCode?: number;
      latencyMs: number;
      error?: string;
    }>;
  };
  tavily?: {
    searchDepth?: string;
    maxResults?: number;
    includeDomains?: string[];
  };
  brightData?: {
    transport?: string;
    target?: string;
    targetCount?: number;
    circuitOpen?: boolean;
    cooldownMsRemaining?: number;
    disabledReason?: string | null;
  };
  email?: {
    status?: string;
    cacheHit?: boolean;
    evidenceCount?: number;
    sourceTypes?: string[];
  };
  error?: {
    message: string;
    code?: string;
  };
  metadata?: Record<string, any>;
};

export type ProviderSummary = Record<string, {
  calls: number;
  successes: number;
  failures: number;
  skipped: number;
  latencyMs: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  fallbackUses: number;
}>;

export type CostSummary = {
  estimatedUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costPerAcceptedLead?: number;
  tokensPerAcceptedLead?: number;
};

export type PhaseTimelineItem = {
  phase: MiningPhase;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status: MiningEventStatus;
  events: number;
};

export type MiningTraceSummary = {
  sessionId: string;
  query: string;
  requested: number;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  stopReason?: string;
  returned?: number;
  eventCount: number;
  providerSummary: ProviderSummary;
  costSummary: CostSummary;
  phaseTimeline: PhaseTimelineItem[];
};

export type MiningSessionTrace = MiningTraceSummary & {
  schemaVersion: number;
  finalStats?: Record<string, any>;
  events: MiningTraceEvent[];
};

const SCHEMA_VERSION = 1;
const PROVIDER_KEYS: MiningProvider[] = ['llm', 'tavily', 'brightdata', 'sqlite', 'system'];

const nowIso = () => new Date().toISOString();

export function clampSearchLogRetentionLimit(raw = process.env.SEARCH_LOG_RETENTION_LIMIT): number {
  const parsed = Number(raw || 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.round(parsed), 10), 500);
}

export function sanitizeTelemetryString(value: unknown, maxLength = 300): string {
  const text = String(value || '').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
  return text.length > maxLength ? `${text.slice(0, maxLength)}... [truncated]` : text;
}

export function estimateLLMCostUsd(inputTokens = 0, outputTokens = 0): number {
  const inputPerMillion = Number(process.env.LLM_OBSERVABILITY_INPUT_COST_PER_1M || 0);
  const outputPerMillion = Number(process.env.LLM_OBSERVABILITY_OUTPUT_COST_PER_1M || 0);
  if (!Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion)) return 0;
  return Number((((inputTokens / 1_000_000) * inputPerMillion) + ((outputTokens / 1_000_000) * outputPerMillion)).toFixed(6));
}

export function getLLMRouteLabel() {
  const mode = process.env.LLM_GATEWAY_MODE || 'direct';
  const model = mode === 'litellm'
    ? (process.env.LITELLM_MODEL || 'apex-primary')
    : (process.env.OPENAI_MODEL || 'gpt-5.5');
  return { mode, model, route: `${mode}:${model}` };
}

function blankProviderSummary(): ProviderSummary {
  const summary: ProviderSummary = {};
  for (const provider of PROVIDER_KEYS) {
    summary[provider] = {
      calls: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      latencyMs: 0,
      avgLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      fallbackUses: 0
    };
  }
  return summary;
}

function summarizeProviders(events: MiningTraceEvent[]): ProviderSummary {
  const summary = blankProviderSummary();
  for (const event of events) {
    if (!event.provider) continue;
    const item = summary[event.provider] || (summary[event.provider] = blankProviderSummary()[event.provider]);
    if (event.status === 'started') continue;
    item.calls++;
    if (event.status === 'success') item.successes++;
    else if (event.status === 'error') item.failures++;
    else if (event.status === 'skipped') item.skipped++;
    item.latencyMs += Number(event.latencyMs || 0);
    item.inputTokens += Number(event.llm?.inputTokens || 0);
    item.outputTokens += Number(event.llm?.outputTokens || 0);
    item.totalTokens += Number(event.llm?.totalTokens || 0);
    item.estimatedCostUsd = Number((item.estimatedCostUsd + Number(event.llm?.estimatedCostUsd || 0)).toFixed(6));
    if (event.llm?.fallbackUsed) item.fallbackUses++;
  }
  for (const item of Object.values(summary)) {
    item.avgLatencyMs = item.calls > 0 ? Math.round(item.latencyMs / item.calls) : 0;
  }
  return summary;
}

function summarizePhases(events: MiningTraceEvent[]): PhaseTimelineItem[] {
  const byPhase = new Map<MiningPhase, PhaseTimelineItem & { firstMs?: number; lastMs?: number }>();
  for (const event of events) {
    const atMs = Date.parse(event.timestamp);
    const existing = byPhase.get(event.phase) || {
      phase: event.phase,
      status: 'info' as MiningEventStatus,
      events: 0
    };
    existing.events++;
    if (Number.isFinite(atMs)) {
      existing.firstMs = existing.firstMs === undefined ? atMs : Math.min(existing.firstMs, atMs);
      existing.lastMs = existing.lastMs === undefined ? atMs : Math.max(existing.lastMs, atMs);
      existing.startedAt = new Date(existing.firstMs).toISOString();
      existing.endedAt = new Date(existing.lastMs).toISOString();
      existing.durationMs = Math.max(0, existing.lastMs - existing.firstMs);
    }
    if (event.status === 'error') existing.status = 'error';
    else if (existing.status !== 'error' && event.status === 'success') existing.status = 'success';
    else if (existing.status === 'info') existing.status = event.status;
    byPhase.set(event.phase, existing);
  }
  return Array.from(byPhase.values()).map(({ firstMs, lastMs, ...item }) => item);
}

export class MiningTelemetryRecorder {
  private events: MiningTraceEvent[] = [];
  private sequence = 0;
  private endedAt?: string;
  private status: 'running' | 'success' | 'error' = 'running';
  private finalStats?: Record<string, any>;

  constructor(
    private readonly sessionId: string,
    private readonly query: string,
    private readonly requested: number,
    private readonly startedAt = nowIso()
  ) {}

  record(event: Omit<MiningTraceEvent, 'id' | 'timestamp'> & { timestamp?: string }) {
    const traceEvent: MiningTraceEvent = {
      ...event,
      id: `${this.sessionId}-${++this.sequence}`,
      timestamp: event.timestamp || nowIso(),
      error: event.error ? {
        ...event.error,
        message: sanitizeTelemetryString(event.error.message)
      } : undefined,
      metadata: event.metadata ? sanitizeMetadata(event.metadata) : undefined
    };
    this.events.push(traceEvent);
    return traceEvent;
  }

  finish(status: 'success' | 'error', finalStats?: Record<string, any>) {
    this.status = status;
    this.endedAt = nowIso();
    this.finalStats = finalStats;
    this.record({
      phase: 'session',
      operation: 'complete',
      status,
      provider: 'system',
      counts: {
        returned: Number(finalStats?.returned || 0),
        requested: this.requested
      },
      metadata: {
        stopReason: finalStats?.stopReason
      }
    });
  }

  getEvents() {
    return [...this.events];
  }

  getSummary(): MiningTraceSummary {
    const providerSummary = summarizeProviders(this.events);
    const llm = providerSummary.llm || blankProviderSummary().llm;
    const returned = Number(this.finalStats?.returned || 0);
    const costSummary: CostSummary = {
      estimatedUsd: Number(llm.estimatedCostUsd.toFixed(6)),
      inputTokens: llm.inputTokens,
      outputTokens: llm.outputTokens,
      totalTokens: llm.totalTokens,
      costPerAcceptedLead: returned > 0 ? Number((llm.estimatedCostUsd / returned).toFixed(6)) : undefined,
      tokensPerAcceptedLead: returned > 0 ? Math.round(llm.totalTokens / returned) : undefined
    };
    const endedAt = this.endedAt;
    const startMs = Date.parse(this.startedAt);
    const endMs = endedAt ? Date.parse(endedAt) : undefined;
    return {
      sessionId: this.sessionId,
      query: this.query,
      requested: this.requested,
      status: this.status,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endMs && Number.isFinite(startMs) ? Math.max(0, endMs - startMs) : undefined,
      stopReason: this.finalStats?.stopReason,
      returned,
      eventCount: this.events.length,
      providerSummary,
      costSummary,
      phaseTimeline: summarizePhases(this.events)
    };
  }

  getTrace(): MiningSessionTrace {
    return {
      ...this.getSummary(),
      schemaVersion: SCHEMA_VERSION,
      finalStats: this.finalStats,
      events: this.getEvents()
    };
  }
}

function sanitizeMetadata(metadata: Record<string, any>) {
  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/prompt|raw|evidence|api[_-]?key|token|secret/i.test(key)) {
      if (typeof value === 'string') {
        sanitized[`${key}Length`] = value.length;
      } else {
        sanitized[key] = '[redacted]';
      }
      continue;
    }
    if (typeof value === 'string') sanitized[key] = sanitizeTelemetryString(value, 500);
    else sanitized[key] = value;
  }
  return sanitized;
}
