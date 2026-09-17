/**
 * Direct Langfuse ingestion client for Apex CRM.
 * Traces LLM calls in Langfuse directly across all configured providers
 * (Atria, Byesu, OpenRouter, Groq).
 */

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

export async function sendDirectLangfuseTrace(payload: LangfuseLogPayload): Promise<void> {
  if (!isLangfuseConfigured()) return;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return;

  const host = getLangfuseHost();
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
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
      const errText = await res.text().catch(() => "");
      console.warn(`[Langfuse] Ingestion returned HTTP ${res.status}:`, errText.slice(0, 150));
    }
  } catch (err: any) {
    // Non-blocking: never fail search/mining execution on telemetry failure
    console.warn("[Langfuse] Telemetry push error:", err?.message || err);
  }
}
