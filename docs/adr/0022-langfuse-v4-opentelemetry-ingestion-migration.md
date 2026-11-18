# 22. Langfuse v4 OpenTelemetry Ingestion Migration and Legacy Endpoint Sunset Remediation

Date: 2026-11-18

## Status

Accepted (amends ADR-0007, ADR-0010)

## Scope

This ADR documents the migration of Apex CRM's telemetry layer from the deprecated Langfuse v3 batch ingestion API to the modern OpenTelemetry (OTLP/HTTP) trace ingestion standard (Langfuse v4):
- Ingestion transport modernization from legacy `POST /api/public/ingestion` to native OpenTelemetry endpoint `POST /api/public/otel/v1/traces` in [`server/services/langfuse.ts`](../../server/services/langfuse.ts)
- OpenTelemetry `ExportTraceServiceRequest` JSON payload construction engine (`buildLangfuseOtelPayload`)
- Protocol versioning and routing header standardization (`x-langfuse-ingestion-version: 4`, `x-langfuse-session-id`)
- Deterministic 32-character hexadecimal trace ID derivation from mining session IDs via MD5 hashing and cryptographically secure 16-character span ID generation
- Nanosecond timestamp conversion (`startTimeUnixNano`, `endTimeUnixNano`) using BigInt precision
- OpenTelemetry GenAI semantic conventions (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`) and Langfuse observation namespace attributes
- Failover defense, HTTP 410 sunset protection, and non-blocking fire-and-forget execution safety in [`server/services/llm.ts`](../../server/services/llm.ts)
- Automated verification suite covering schema compliance, ID formats, and error shielding in [`test/langfuseUpgrade.test.ts`](../../test/langfuseUpgrade.test.ts)
- Codebase indexing and architectural reference updates in [`docs/CODEBASE_INDEX.md`](../CODEBASE_INDEX.md)

---

## Context

Apex CRM integrates with Langfuse to provide real-time observability into LLM execution across all configured providers (OmniRoute Gemini 3.8 Flash High, Byesu GPT-6.1, OpenRouter, and Groq). Observability is essential for monitoring prompt token consumption, latency regressions, provider failovers, reasoning chains, and judge qualification accuracy during multi-round prospect mining.

### 1. Langfuse v3 Batch API Sunset & HTTP 410 Gone

Historically, Apex CRM utilized Langfuse's proprietary v3 batch ingestion API (`POST /api/public/ingestion`). The payload structure consisted of an ad-hoc batch array containing discrete, untyped event objects:
- `trace-create`: Sent to register a trace identifier, session ID, and trace name.
- `generation-create`: Sent alongside or following the trace to record prompt messages, completion outputs, token usage, and latency.

On November 16, 2026, Langfuse officially shut down the legacy v3 ingestion API across all managed cloud environments (`https://us.cloud.langfuse.com` and `https://cloud.langfuse.com`). Ingestion requests to `POST /api/public/ingestion` began immediately failing with HTTP 410 Gone and error body:
```json
{
  "error": "LANGFUSE_V3_API_REMOVED",
  "message": "The Langfuse v3 batch ingestion API (/api/public/ingestion) was officially sunset on November 16, 2026. Please upgrade to OpenTelemetry trace ingestion (/api/public/otel/v1/traces) with header x-langfuse-ingestion-version: 4."
}
```

Because `sendDirectLangfuseTrace` in `server/services/langfuse.ts` was implemented with non-blocking error handling, these failures did not crash the discovery engine or interrupt active mining runs. However, LLM telemetry was completely blacked out:
- No new traces or generations were recorded in the Langfuse dashboard.
- Token accounting, cost tracking, and model latency metrics stopped updating.
- Failed LLM calls and provider circuit breaker trips could no longer be diagnosed post-session.
- Ingestion warning logs (`[Langfuse] Ingestion returned HTTP 410: ...`) began accumulating in server output.

### 2. Paradigm Shift: OpenTelemetry OTLP & Observations-First Data Model

Langfuse v4 fully replaced proprietary batch ingestion with native OpenTelemetry (OTLP/HTTP) trace ingestion. This shift represents a structural paradigm change:

1. **Unified Distributed Trace Hierarchy**: In v3, traces and generations were decoupled database entities linked by string keys. In v4, traces are standard OpenTelemetry traces, and LLM calls (generations) are modeled directly as spans within the trace tree.
2. **Standardized Semantic Conventions**: Rather than inventing proprietary field names for tokens and models, v4 adopts CNCF OpenTelemetry GenAI semantic conventions (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, etc.), enabling seamless interoperability with broader telemetry ecosystems.
3. **Strict OpenTelemetry Schema Requirements**:
   - Trace IDs must be exactly 16 bytes encoded as 32 lowercase hexadecimal characters (`/^[0-9a-f]{32}$/`). Arbitrary string IDs (such as UUIDs or raw session strings like `session-1731974400`) are rejected by OTel parsers.
   - Span IDs must be exactly 8 bytes encoded as 16 lowercase hexadecimal characters (`/^[0-9a-f]{16}$/`).
   - Timestamps cannot use ISO 8601 strings; they must be formatted as Unix nanoseconds since the Unix epoch, represented as decimal strings to avoid 64-bit float precision loss.
4. **Header-Based Versioning & Ingestion Routing**: Ingestion requests require `x-langfuse-ingestion-version: 4` to instruct ingestion gateway workers to route payloads through the modern observations processing pipeline.

To restore observability and future-proof Apex CRM's telemetry layer, the ingestion client required a complete architectural migration to OpenTelemetry.

---

## Decision

We have modernized Apex CRM's Langfuse integration to adhere strictly to the OpenTelemetry v4 ingestion standard.

### 1. Ingestion Endpoint & Transport Modernization

In [`server/services/langfuse.ts`](../../server/services/langfuse.ts):
- Updated the primary ingestion endpoint from `${host}/api/public/ingestion` to:
  `${host}/api/public/otel/v1/traces`
- Standardized request headers:
  - `Authorization: Basic ${auth}` (HTTP Basic auth using `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`)
  - `Content-Type: application/json`
  - `x-langfuse-ingestion-version: 4` (signals v4 observation-first pipeline)
  - `x-langfuse-session-id: ${payload.sessionId}` (propagates session ID for proxy routing)
- Configured a 5-second abortable timeout via `AbortSignal.timeout(5_000)` to guarantee telemetry calls never hang background worker queues.

### 2. Standard OpenTelemetry `ExportTraceServiceRequest` Construction

Exported a pure, deterministic payload factory function `buildLangfuseOtelPayload(payload: LangfuseLogPayload)` that compiles internal LLM execution metrics into the standard OpenTelemetry protobuf-over-JSON representation:

```typescript
{
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "apex-crm" } },
          { key: "service.version", value: { stringValue: "2.0.0" } }
        ]
      },
      scopeSpans: [
        {
          scope: {
            name: "apex-crm.langfuse",
            version: "4.0.0"
          },
          spans: [ ... ]
        }
      ]
    }
  ]
}
```

### 3. Deterministic 32-Hex Trace ID & 16-Hex Span ID Formatting

OpenTelemetry strictly mandates 16-byte trace IDs and 8-byte span IDs. To preserve session correlation while complying with OTel constraints:
- **Trace ID (`traceId`)**:
  - When `payload.sessionId` is present, `buildLangfuseOtelPayload` generates a stable 32-character hexadecimal string using MD5:
    `crypto.createHash("md5").update(payload.sessionId).digest("hex")`
  - Because MD5 outputs an exact 128-bit (16-byte) digest as 32 hex characters, all LLM calls executed during a single discovery session (across rounds, strategist planning, extraction, and finalist judging) automatically map to the same OTel `traceId`.
  - When `sessionId` is omitted, the factory generates 16 cryptographically random bytes:
    `crypto.randomBytes(16).toString("hex")`
- **Span ID (`spanId`)**:
  - Each individual LLM invocation generates a unique 8-byte identifier:
    `crypto.randomBytes(8).toString("hex")` (16 hexadecimal characters).
  - Matches pattern `/^[0-9a-f]{16}$/`.

### 4. Nanosecond Timestamp Conversion via BigInt

OpenTelemetry spans require start and end timestamps expressed in nanoseconds as stringified integers:
- Calculated from millisecond timestamps using JavaScript `BigInt` to prevent numeric overflow and IEEE 754 precision degradation:
  - `endTimeUnixNano`: `(BigInt(Date.now()) * 1_000_000n).toString()`
  - `startTimeUnixNano`: `(BigInt(Date.now() - Math.max(0, payload.latencyMs)) * 1_000_000n).toString()`
- Enforces strict monotonic ordering where `endTimeUnixNano >= startTimeUnixNano`.

### 5. Semantic Conventions & Langfuse Namespaces

Within `spans[0]`:
- **Span Kind**: Set to `1` (`SPAN_KIND_INTERNAL`).
- **Span Name**: Defaults to `payload.stage || "generation"`.
- **Status Object**:
  - On success: `{ code: 1 }` (`STATUS_CODE_OK`).
  - On error: `{ code: 2, message: payload.errorMessage }` (`STATUS_CODE_ERROR`).
- **GenAI Semantic Convention Attributes**:
  - `gen_ai.system`: `stringValue: payload.provider` (e.g. `"omniroute"`, `"byesu"`, `"groq"`).
  - `gen_ai.request.model`: `stringValue: payload.model` (e.g. `"gemini-3.8-flash-high"`, `"gpt-6.1-sol"`).
  - `gen_ai.usage.input_tokens`: `intValue: Math.max(0, payload.inputTokens || 0)`.
  - `gen_ai.usage.output_tokens`: `intValue: Math.max(0, payload.outputTokens || 0)`.
  - `gen_ai.usage.total_tokens`: `intValue: Math.max(0, payload.totalTokens || 0)`.
- **Langfuse Observation Attributes**:
  - `langfuse.trace.name`: `stringValue: payload.traceName || "Apex Mining: " + (payload.stage || "LLM Call")`.
  - `langfuse.session.id`: `stringValue: payload.sessionId || ""`.
  - `langfuse.observation.type`: strictly `stringValue: "generation"`.
  - `langfuse.observation.level`: `stringValue: payload.status === "error" ? "ERROR" : "DEFAULT"`.
  - `langfuse.observation.status_message`: stringValue with `errorMessage` when status is error.
  - `langfuse.observation.input`: stringValue containing `JSON.stringify(payload.messages)` to capture prompt context and system instructions.
  - `langfuse.observation.output`: stringValue containing completion response text.
  - `langfuse.trace.tags`: `arrayValue` containing `["apex-crm", "mining-session", payload.provider]`.
  - Dynamic metadata attributes: `round`, `stage`, `latencyMs`, and any custom keys in `payload.metadata` are mapped into `langfuse.observation.metadata.<key>` using typed OTLP wrappers (`stringValue`, `intValue`, `boolValue`).

### 6. Edge Gateway & Proxy Session Propagation

To support multi-tenant routing, distributed logging, and cloud trace indexing without requiring edge reverse proxies to parse large JSON payloads:
- Injected `x-langfuse-session-id: ${payload.sessionId}` into the HTTP request headers whenever `sessionId` is present.
- Injected `x-langfuse-ingestion-version: 4` into request headers to guarantee routing to the v4 ingestion cluster.

### 7. Resilient Failover & Non-Blocking Safety

Telemetry must never degrade or disrupt core prospect discovery workflows:
- **Fire-and-Forget Invocations**: In `server/services/llm.ts`, telemetry calls continue to be dispatched asynchronously via `void sendDirectLangfuseTrace(...)` without blocking LLM provider response resolution.
- **Graceful Sunset Defense (HTTP 410)**:
  - If the server receives an HTTP 410, it logs a warning once and does not attempt to retry against deprecated endpoints, preventing infinite retry loops or log flooding.
- **Legacy Fallback Compatibility (HTTP 404)**:
  - If a user configures a self-hosted Langfuse instance running an older version without OpenTelemetry ingestion routes (`HTTP 404 Not Found`), the client transparently falls back to the legacy endpoint (`/api/public/ingestion`).
- **Exception Shielding**:
  - All network exceptions, DNS resolution failures, and request timeouts are trapped within `try / catch` blocks and logged with `console.warn`. No error can propagate to callers.

### 8. Verification & Test Harness

Authored an automated test suite in [`test/langfuseUpgrade.test.ts`](../../test/langfuseUpgrade.test.ts) using `node:test` and `node:assert/strict`:
- Validates host normalization, trailing slash pruning, and key presence checks.
- Validates `buildLangfuseOtelPayload` output against the OpenTelemetry `ExportTraceServiceRequest` schema.
- Verifies regex adherence for 32-hex trace IDs (`/^[0-9a-f]{32}$/`) and 16-hex span IDs (`/^[0-9a-f]{16}$/`).
- Validates nanosecond timestamps, BigInt precision, and monotonic order (`endTimeUnixNano >= startTimeUnixNano`).
- Verifies exact GenAI attribute mappings, status codes (`1` vs `2`), and Langfuse metadata serialization.
- Mocks global `fetch` to verify header propagation (`x-langfuse-ingestion-version: 4`, `x-langfuse-session-id`, `Authorization: Basic ...`) and confirms non-blocking resilience under network errors, HTTP 410 responses, and 500 server errors.

---

## Consequences

### Positive
- **Observability Restored**: Resolves the HTTP 410 `LANGFUSE_V3_API_REMOVED` outage, restoring real-time LLM execution tracing, token accounting, latency metrics, and error rates across all mining sessions.
- **OpenTelemetry Standard Compliance**: Aligns Apex CRM with industry-standard OTLP/HTTP protocols and CNCF GenAI semantic conventions, enabling future trace export to OpenTelemetry collectors, Datadog, Honeycomb, or Jaeger without codebase redesign.
- **Deterministic Session Correlation**: Deriving 32-character hexadecimal trace IDs from mining session IDs via MD5 hashing guarantees that all multi-stage, multi-round LLM evaluations for a search session group into a single coherent trace tree in the Langfuse UI.
- **Zero Performance & Token Impact**: Telemetry execution remains entirely non-blocking (`void sendDirectLangfuseTrace`) with a 5-second abort ceiling, ensuring zero token penalty, zero latency overhead, and zero failure blast radius on lead mining.
- **Edge Routing & Proxy Support**: Header propagation (`x-langfuse-session-id`, `x-langfuse-ingestion-version`) enables downstream API gateways and reverse proxies to inspect and partition telemetry streams without body deserialization.

### Negative / Trade-offs
- **Payload Verbosity**: The OpenTelemetry OTLP JSON schema requires typed attribute envelopes (`{ key, value: { stringValue } }`), resulting in moderately larger JSON payload sizes compared to the legacy v3 format. Given local execution and broadband telemetry egress, this overhead is negligible.
- **Strict Format Sensitivity**: Upstream OTel ingesters enforce strict format constraints (e.g. non-hex characters in `traceId` or `spanId` result in 400 Bad Request). This is mitigated by unit tests enforcing regex validation on all ID generators.
