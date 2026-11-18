/**
 * Direct Langfuse ingestion client for Apex CRM.
 * Upgraded to standard Langfuse v4 OpenTelemetry (OTLP/HTTP) trace ingestion specification
 * with graceful fallback for legacy v3 self-hosted instances.
 */

import crypto from "node:crypto";

export interface LangfuseLogPayload {
  sessionId?: string;
  traceName?: string;
  stage?: string;
  round?: number;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: "success" | "error";
  errorMessage?: string;
  messages?: any[];
  output?: string;
  metadata?: Record<string, any>;
}

export interface OtelAnyValue {
  stringValue?: string;
  intValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtelAnyValue[] };
}

export interface OtelAttribute {
  key: string;
  value: OtelAnyValue;
}

export interface OtelSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: {
    code: number;
    message?: string;
  };
  attributes: OtelAttribute[];
}

export interface OtelScopeSpans {
  scope: {
    name: string;
    version: string;
  };
  spans: OtelSpan[];
}

export interface OtelResourceSpans {
  resource: {
    attributes: OtelAttribute[];
  };
  scopeSpans: OtelScopeSpans[];
}

export interface ExportTraceServiceRequest {
  resourceSpans: OtelResourceSpans[];
}

let hasLoggedSunsetWarning = false;
let legacySunset = false;

export function isLangfuseConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY &&
    process.env.LANGFUSE_SECRET_KEY
  );
}

export function getLangfuseHost(): string {
  return (
    process.env.LANGFUSE_HOST ||
    process.env.LANGFUSE_BASE_URL ||
    process.env.LANGFUSE_BASEURL ||
    "https://us.cloud.langfuse.com"
  ).replace(/\/+$/, "");
}

function toOtelValue(value: any): OtelAnyValue {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    return { intValue: Number.isInteger(value) ? value : Math.round(value) };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  return { stringValue: typeof value === "object" ? JSON.stringify(value) : String(value) };
}

export function buildLangfuseOtelPayload(payload: LangfuseLogPayload): ExportTraceServiceRequest {
  const traceId = payload.sessionId
    ? crypto.createHash("md5").update(payload.sessionId).digest("hex")
    : crypto.randomBytes(16).toString("hex");

  const spanId = crypto.randomBytes(8).toString("hex");

  const now = Date.now();
  const latency = Math.max(0, Number(payload.latencyMs) || 0);
  const startTimeUnixNano = (
    BigInt(now - latency) * 1_000_000n
  ).toString();
  const endTimeUnixNano = (
    BigInt(now + (latency > 0 ? 0 : 1)) * 1_000_000n
  ).toString();

  const attributes: OtelAttribute[] = [
    {
      key: "langfuse.trace.name",
      value: {
        stringValue: payload.traceName || (payload.stage ? "Apex Mining: " + payload.stage : "LLM Call"),
      },
    },
    {
      key: "langfuse.session.id",
      value: {
        stringValue: payload.sessionId || "",
      },
    },
    {
      key: "langfuse.observation.type",
      value: {
        stringValue: "generation",
      },
    },
    {
      key: "langfuse.observation.level",
      value: {
        stringValue: payload.status === "error" ? "ERROR" : "DEFAULT",
      },
    },
  ];

  if (payload.errorMessage) {
    attributes.push({
      key: "langfuse.observation.status_message",
      value: { stringValue: payload.errorMessage },
    });
  }

  if (payload.messages) {
    attributes.push({
      key: "langfuse.observation.input",
      value: { stringValue: JSON.stringify(payload.messages) },
    });
  }

  if (payload.output) {
    attributes.push({
      key: "langfuse.observation.output",
      value: { stringValue: payload.output },
    });
  }

  attributes.push(
    {
      key: "gen_ai.system",
      value: { stringValue: payload.provider },
    },
    {
      key: "gen_ai.request.model",
      value: { stringValue: payload.model },
    },
    {
      key: "gen_ai.usage.input_tokens",
      value: { intValue: Math.max(0, payload.inputTokens || 0) },
    },
    {
      key: "gen_ai.usage.output_tokens",
      value: { intValue: Math.max(0, payload.outputTokens || 0) },
    },
    {
      key: "gen_ai.usage.total_tokens",
      value: { intValue: Math.max(0, payload.totalTokens || 0) },
    },
    {
      key: "langfuse.trace.tags",
      value: {
        arrayValue: {
          values: ["apex-crm", "mining-session", payload.provider]
            .filter(Boolean)
            .map((t) => ({ stringValue: t })),
        },
      },
    }
  );

  const metaRecords: Record<string, any> = {};
  if (payload.round !== undefined) metaRecords.round = payload.round;
  if (payload.stage !== undefined) metaRecords.stage = payload.stage;
  if (payload.latencyMs !== undefined) metaRecords.latencyMs = payload.latencyMs;
  if (payload.metadata && typeof payload.metadata === "object") {
    for (const [k, v] of Object.entries(payload.metadata)) {
      if (v !== undefined) {
        metaRecords[k] = v;
      }
    }
  }

  for (const [k, v] of Object.entries(metaRecords)) {
    if (v === undefined || v === null) continue;
    attributes.push({
      key: `langfuse.observation.metadata.${k}`,
      value: toOtelValue(v),
    });
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "apex-crm" } },
            { key: "service.version", value: { stringValue: "2.0.0" } },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "apex-crm.langfuse",
              version: "4.0.0",
            },
            spans: [
              {
                traceId,
                spanId,
                name: payload.stage || "generation",
                kind: 1,
                startTimeUnixNano,
                endTimeUnixNano,
                status: {
                  code: payload.status === "error" ? 2 : 1,
                  message: payload.errorMessage,
                },
                attributes,
              },
            ],
          },
        ],
      },
    ],
  };
}

async function sendLegacyLangfuseIngestion(
  host: string,
  auth: string,
  payload: LangfuseLogPayload
): Promise<void> {
  const traceId = payload.sessionId || `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const startTime = new Date(now.getTime() - Math.max(0, payload.latencyMs)).toISOString();
  const endTime = now.toISOString();

  const batch: any[] = [
    {
      id: crypto.randomUUID(),
      type: "trace-create",
      timestamp: endTime,
      body: {
        id: traceId,
        name: payload.traceName || `Apex Mining: ${payload.stage || "LLM Call"}`,
        sessionId: payload.sessionId,
        tags: ["apex-crm", "mining-session", payload.provider].filter(Boolean),
        metadata: {
          round: payload.round,
          stage: payload.stage,
          provider: payload.provider,
          model: payload.model,
          ...(payload.metadata || {}),
        },
      },
    },
    {
      id: crypto.randomUUID(),
      type: "generation-create",
      timestamp: endTime,
      body: {
        id: crypto.randomUUID(),
        traceId: traceId,
        name: payload.stage || "generation",
        model: payload.model,
        startTime,
        endTime,
        statusMessage: payload.status === "error" ? payload.errorMessage : undefined,
        level: payload.status === "error" ? "ERROR" : "DEFAULT",
        input: payload.messages,
        output: payload.output,
        usage: {
          input: payload.inputTokens,
          output: payload.outputTokens,
          total: payload.totalTokens,
        },
        metadata: {
          provider: payload.provider,
          latencyMs: payload.latencyMs,
          round: payload.round,
        },
      },
    },
  ];

  try {
    const res = await fetch(`${host}/api/public/ingestion`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ batch }),
    });

    if (!res.ok) {
      if (res.status === 410) {
        legacySunset = true;
        if (!hasLoggedSunsetWarning) {
          hasLoggedSunsetWarning = true;
          console.warn("[Langfuse] Legacy v3 ingestion API removed (HTTP 410). Disabling legacy fallback.");
        }
        return;
      }
      const errText = await res.text().catch(() => "");
      console.warn(`[Langfuse] Legacy ingestion returned HTTP ${res.status}:`, errText.slice(0, 150));
    }
  } catch (err: any) {
    console.warn("[Langfuse] Legacy telemetry push error:", err?.message || err);
  }
}

export async function sendDirectLangfuseTrace(payload: LangfuseLogPayload): Promise<void> {
  if (!isLangfuseConfigured()) return;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return;

  const host = getLangfuseHost();
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const otelPayload = buildLangfuseOtelPayload(payload);

  try {
    const res = await fetch(`${host}/api/public/otel/v1/traces`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(otelPayload),
    });

    if (res.ok) {
      return;
    }

    if (res.status === 410) {
      legacySunset = true;
      if (!hasLoggedSunsetWarning) {
        hasLoggedSunsetWarning = true;
        console.warn("[Langfuse] Langfuse API returned HTTP 410 (API removed/sunset). Legacy fallback disabled.");
      }
      return;
    }

    if (res.status === 404) {
      if (!legacySunset) {
        await sendLegacyLangfuseIngestion(host, auth, payload);
      }
      return;
    }

    const errText = await res.text().catch(() => "");
    console.warn(`[Langfuse] Ingestion returned HTTP ${res.status}:`, errText.slice(0, 150));
  } catch (err: any) {
    // Non-blocking: never fail search/mining execution on telemetry failure
    console.warn("[Langfuse] Telemetry push error:", err?.message || err);
  }
}
