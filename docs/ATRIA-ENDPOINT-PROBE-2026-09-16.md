# Atria Endpoint Probe — `Atria-Dawn-Preview`

Date: 2026-09-16 · Endpoint: `https://api.atria-asi.ai/v1/chat/completions`
Probe tool: [`scripts/tpm_probe.py`](../scripts/tpm_probe.py)

## 1. Question

The gateway publishes **no rate-limit information**: no `x-ratelimit-*` headers on
responses, and `/v1/limits`, `/v1/usage`, `/v1/rate_limits`, `/v1/account`, `/v1/me`,
`/limits`, `/usage` all return **404**. The only way to establish a TPM figure is to
measure it.

## 2. Verdict

**No TPM cap is enforced at any volume this application can reach.**

Across five escalating bursts totalling **~92,850 completion tokens**, the endpoint
returned **zero HTTP 429s**. Throughput was pushed to **30,866 output tok/min** with no
throttling signal of any kind.

The binding constraint is therefore **not quota — it is upstream stability and
saturation latency**, which is a different problem with a different mitigation.

## 3. Measurements

| Stage | Shape | OK / total | Output tokens | Wall | Throughput | p50 / p95 latency |
| ----- | ----- | ---------- | ------------- | ---- | ---------- | ----------------- |
| 1 | 60 req × 1 tok, conc 10 | 60 / 60 | 60 | 32.7s | 110 tok/min | 2.38s / 14.33s |
| 2 | 40 req × 100 tok, conc 10 | 38 / 40 | 3,800 | 26.8s | 8,499 tok/min | 2.90s / 14.58s |
| 3 | 24 req × 600 tok, conc 12 | 24 / 24 | 14,400 | 39.3s | 21,985 tok/min | 6.74s / 15.34s |
| 5 | 50 req × 1500 tok, conc 20 | 49 / 50 | 73,500 | 142.9s | 30,866 tok/min | 21.11s / 67.47s |
| 6 | 5 req × 2000 tok, conc 1 | 5 / 5 | 1,093 | 22.0s | 2,976 tok/min | **4.01s / 5.69s** |

Stage 6 is the regime that matters for this codebase: `withSequentialLLMExecution`
(`server/services/llm.ts:357`) serializes every LLM call, so the engine runs at
concurrency 1. At that concurrency the endpoint is **fast and clean — p50 4.0s, p95 5.7s**,
comfortably inside `LLM_EXTRACTION_TIMEOUT_MS=30000` and `LLM_FINALIST_TIMEOUT_MS=35000`.

## 4. Failure modes actually observed

Neither failure below is a rate limit, and both matter for provider selection:

| Failure | Where | Count | Body / shape |
| ------- | ----- | ----- | ------------ |
| Upstream inference error | Stage 2 | 2 / 40 | `502 {"error":{"message":"Inference request failed.","type":"atria_api_error","code":"upstream_error"}}` |
| Transport failure | Stage 5 | 1 / 50 | No HTTP response at all (connection dropped before status line) |

Both appeared only under concurrency ≥ 10. The engine's existing `isTransientLLMError`
path already treats 5xx as retryable, so these are handled — but note that the **502
carries `type: "atria_api_error"`**, which is a non-standard envelope. It is not the
OpenAI error shape, so any provider-specific error classification keyed on `error.type`
needs to account for it.

## 5. What the endpoint is

- `GET /v1/models` returns exactly one model: `Atria-Dawn-Preview`, `owned_by: "atria"`.
- `system_fingerprint: "vllm-0.26.0-tp8-..."` — self-hosted vLLM, tensor-parallel size 8.
- Backed by an Aliyun ALB in `ap-southeast-1` (Singapore); three healthy backends:
  `47.236.72.31`, `47.84.81.102`, `8.219.11.2`.
- It is a **reasoning model**: responses carry a `reasoning_content` field alongside
  `content`. This is the single most important integration detail — see below.

## 6. Integration gotcha: `content` is null until reasoning completes

`reasoning_content` is billed and counted as `completion_tokens` **before** any visible
answer is emitted. A request with a small `max_tokens` returns
`finish_reason: "length"` with `"content": null` — a *successful* HTTP 200 that contains
no answer:

```jsonc
// max_tokens: 20 -> HTTP 200, but no usable content
{ "finish_reason": "length",
  "message": { "content": null, "reasoning_content": "The user said \"hi\". This is a greeting..." } }
```

The same prompt at `max_tokens: 200` returns `finish_reason: "stop"` with
`content: "KEY IS WORKING"`.

**Consequence for this codebase:** `LEAD_EXTRACTION_MAX_TOKENS="2000"` is likely
adequate, but any JSON-mode call that must emit a complete object needs headroom for the
reasoning prefix on top of the payload. A response of `content: null` with
`finish_reason: "length"` should be classified as a **truncation**, not as an empty
result — otherwise the extraction stage will silently record a zero-candidate round.

## 7. Access notes

- The key `atr_...KVO` is **valid**; auth is genuinely enforced (invalid key and missing
  header both return `401 {"code":"invalid_api_key"}`), so 200s are meaningful.
- **DNS caveat:** this machine's resolver (Quad9, `9.9.9.9`) returns **NXDOMAIN** for
  `api.atria-asi.ai`, while Cloudflare `1.1.1.1` resolves it correctly. The probe therefore
  pins the IP via `curl --resolve`. Any code path that resolves this host through the
  default resolver will fail with a DNS error that looks nothing like the real cause.
  Fix the resolver or add a hosts entry before wiring this into the engine.

## 8. Recommendation

Safe to use as a primary or fallback provider **at the concurrency the engine already
enforces**. Do not raise LLM concurrency to exploit the absent TPM cap: at concurrency 20
p95 latency reached **67s**, which exceeds `LLM_EXTRACTION_TIMEOUT_MS=30000` and
`LLM_FINALIST_TIMEOUT_MS=35000` and would surface as spurious timeout failures rather than
as a clean rate limit. The sequential invariant is doing real work here — keep it.

Before adopting, confirm:

1. `content: null` + `finish_reason: "length"` is treated as truncation, not empty success.
2. The non-standard `atria_api_error` envelope is mapped in the transient-error classifier.
3. The DNS resolution problem in §7 is resolved on every machine that will run the engine.

---

## 9. Verification of the integration (2026-09-16)

The provider was wired into `server/services/llm.ts` as `id: "atria"`, registered only when
`ATRIA_API_KEY` is set, and appended after the existing chain unless
`ATRIA_PRIORITY="primary"`. Verified as follows.

### 9.1 Automated suites

| Check | Result |
| ----- | ------ |
| `npx tsc --noEmit` | 0 errors |
| `test/atriaProvider.test.ts` | 12 / 12 pass |
| `test:llm` (`llmFallback` + `llmBudget` + `atriaProvider`) | 45 / 45 pass |

### 9.2 Live end-to-end check against the real endpoint

`scripts/atria_live_check.ts` drives the real `llm.ts` code path (not mocks) — 5/5 pass:

- `openAIText` returns content, reports `provider: "Atria"`.
- A 10-token budget reproduces the real truncation shape and the guard fires:
  `chat completion truncated: finish_reason "length" produced no visible content
  (reasoning_content consumed the entire budget: 42 chars). Raise max_tokens.`
- That error is **not** circuit-breaking, as intended.
- `openAIStructured` returns parseable JSON (`{"leads":[{...}]}`) — the shape `extractStage` uses.

### 9.3 Correction to §7 — the DNS failure is confirmed at the Node layer

§7 reported the resolver problem from `curl`. It is worse than that in practice: Node's own
`dns.lookup` fails, so plain `fetch` in `llm.ts` cannot reach the endpoint at all.

```
node lookup FAILED -> ENOTFOUND getaddrinfo ENOTFOUND api.atria-asi.ai
fetch FAILED -> TypeError fetch failed | cause: ENOTFOUND
```

Resolver comparison for `api.atria-asi.ai`:

| Resolver | Result |
| -------- | ------ |
| `8.8.8.8` (Google) | OK |
| `208.67.222.222` (OpenDNS) | OK |
| `1.1.1.1` (Cloudflare) | intermittent timeout |
| `9.9.9.9` (Quad9) | **NXDOMAIN** |

Quad9 returning NXDOMAIN while Google and OpenDNS return a valid A record is consistent with
Quad9's security filtering rather than a typo. Treat this as an operational risk to confirm,
not a settled fact — but do confirm it before relying on the provider.

### 9.4 Correction — pinning the IP in `ATRIA_BASE` does not work

The ALB routes by `Host` header. Pointing `ATRIA_BASE` at a bare IP returns
`503 Service Temporarily Unavailable` (the `alb` error page), not the API. Any workaround must
preserve both the `Host` header and TLS SNI. The live check does this by overriding resolution
at the socket layer with an undici dispatcher; that is a diagnostic harness, not a fix.

### 9.5 Bug found and fixed — truncation was misclassified as retryable

The truncation message embeds the `reasoning_content` character count, and
`TRANSIENT_LLM_ERROR` (`sessionHelpers.ts`) contains a `5\d\d` heuristic for HTTP 5xx status
codes. Any character count whose decimal form contains such a run therefore matched:

| Budget | `isTransientLLMError` before fix |
| ------ | -------------------------------- |
| 45 / 120 / 499 chars | false (correct) |
| **545 / 599 / 1500 / 5432 chars** | **true (wrong)** |

Retrying is futile — the token budget is unchanged, so the same provider truncates again on
every attempt — and each retry re-cascades the provider chain. This directly contradicted the
guard's own comment that a budget-sizing fault "must not disable an otherwise healthy
provider".

Fixed by adding an explicit non-transient check ahead of the heuristic in
`isTransientLLMError`, pinned by `test/atriaProvider.test.ts` ("truncation errors are never
retried").

### 9.6 Adjacent pre-existing gap — "timed out" is not matched

While pinning §9.5, a separate pre-existing inconsistency surfaced: `TRANSIENT_LLM_ERROR`
matches `timeout` and `etimedout`, but **not** the two-word form `timed out` — even though
`llm.ts:874` treats `/LLM request timed out after/i` as a gateway-limit condition and
`llm.ts:529` tests the same string. Severity is limited because `sendChatCompletion` already
retries timeouts in its own fetch-error path, so this outer layer is a second retry rather
than the only one.

**Not changed.** It alters retry behaviour engine-wide and is unrelated to Atria, so it is
pinned by a test that asserts current behaviour and documents the inconsistency. Worth a
deliberate decision.

### 9.7 Secret hygiene

`scripts/tpm_probe.py` and `scripts/atria_live_check.ts` read the key from `ATRIA_API_KEY`
and exit with a clear message when it is unset. No key material is stored in the repository.

---

## 10. TPS assessment

TPM (§2) says nothing about speed. TPS is the metric that decides whether this model can
serve as the engine's primary, because `withSequentialLLMExecution` serialises every call —
so the engine runs at concurrency 1 and only ever sees single-stream speed.

Measured with `scripts/tps_bench.py` and `scripts/tps_reliability.py`. Note `llm.ts` makes
**no streaming calls at all** (the only `text/event-stream` in the codebase is the UI
telemetry stream in `api.ts:1038`), so the non-streaming figures are the ones that matter.
TTFT is reported for completeness only.

### 10.1 Single-stream TPS (concurrency 1)

| Mode | Median | Observed range |
| ---- | ------ | -------------- |
| Non-streaming, end-to-end | **~90 tok/s** | 43 – 134 |
| Non-streaming, end-to-end (slower window) | ~44 tok/s | 19 – 99 |
| Streaming, steady-state | ~91 – 99 tok/s | 79 – 171 |
| Streaming, end-to-end | ~53 – 83 tok/s | 24 – 138 |
| TTFT (streaming only) | 2.0 – 10.0s | 1.2 – 16.7s |

**Speed is highly variable** — the same request shape ranged 43 to 134 tok/s across runs,
and separate windows produced medians of 44 and 92 tok/s. Treat ~90 tok/s as a working
figure with a slow tail near 44, not a guarantee.

### 10.2 Aggregate throughput scales with concurrency

| Concurrency | Aggregate TPS | Median per-stream TPS |
| ----------- | ------------- | --------------------- |
| 1 | 70 | 92.6 |
| 2 | 98 | 59.2 |
| 4 | 141 | 35.7 |
| 8 | **330** | 80.6 |

Aggregate throughput rises ~4.7x from c=1 to c=8, so the deployment does have parallel
capacity — the absent TPM cap (§2) is real, not a measurement artefact. But per-stream
latency degrades sharply (p95 67s at c=20, §3). **The engine's serialisation is still the
right choice**: raising concurrency buys aggregate throughput the engine cannot use while
pushing individual calls past `LLM_EXTRACTION_TIMEOUT_MS`.

### 10.3 The binding constraint is reliability, not speed

| Window | 502 `upstream_error` rate |
| ------ | ------------------------- |
| 12 sequential requests, c=1 | **3 / 12 (25%)** |
| 40 requests, c=10 (§3 stage 2) | 2 / 40 (5%) |
| 5 streaming requests, c=1 | 3 / 5 (60%) |

Failures are **fast** (~1s) and always HTTP **502** — never 429. An earlier concern that the
concurrency sweep's inverted failure pattern (worse at c=1-2 than c=4-8) indicated throttling
was wrong: those were the same random 502s, which is why they did not correlate with load.

These are handled correctly today: the message renders as `chat completion error 502`, which
matches the `5\d\d` heuristic in `TRANSIENT_LLM_ERROR`, so `sendChatCompletion` retries and
the provider cascades. Cost is latency and token spend, not correctness. But at a 25% failure
rate roughly one call in four pays a retry.

### 10.4 Timeout budget is marginal

`LEAD_EXTRACTION_MAX_TOKENS="2000"` against `LLM_EXTRACTION_TIMEOUT_MS="30000"`:

| Observed TPS | Time for a full 2000-token completion | vs 30s timeout |
| ------------ | ------------------------------------- | -------------- |
| ~90 tok/s (median) | ~22s | fits |
| ~44 tok/s (slow tail) | **~45s** | **exceeds** |

On the slow tail a full-budget extraction call cannot finish inside the extraction timeout.
This is a sizing risk to confirm against a real session rather than a proven failure — most
extractions will not emit the full 2000 tokens — but the margin is thin.

### 10.5 `reasoning_effort` is ignored by the endpoint

The engine passes `reasoningEffort: "low"` for extraction, but `isReasoningCapable`
(`llm.ts:933`) is:

```ts
provider.id === "litellm" || /\b(gpt-5|o[134]|deepseek-r1|reasoning)\b/i.test(provider.model)
```

`Atria-Dawn-Preview` matches none of those alternatives, so **the parameter is never sent**.

Worse, sending it would not help. Same prompt, `max_tokens=900`, one call per setting:

| `reasoning_effort` | reasoning chars | visible content chars | finish_reason |
| ------------------ | --------------- | --------------------- | ------------- |
| (not sent) | 3,580 | **0** | `length` |
| `low` | 3,444 | **0** | `length` |
| `high` | 3,594 | **0** | `length` |

The spread is noise. **Reasoning length is not controllable on this endpoint**, and on a
long-form prompt the reasoning phase alone consumes the entire 900-token budget before a
single visible token is emitted.

Two consequences worth acting on:

1. **Do not expect `reasoningEffort` to bound cost or latency here.** Budget `max_tokens`
   with the reasoning prefix on top of the expected payload.
2. **This is exactly the case the §9.5 truncation guard exists for.** Without it, an
   extraction chunk that spends its whole budget reasoning returns `content:null`, collapses
   to `""`, and the round records zero candidates with no error anywhere. With the guard it
   surfaces as `finish_reason "length" produced no visible content`. The guard is not
   theoretical — this endpoint reaches that state readily.

### 10.6 Bottom line

Fast enough at concurrency 1 (~90 tok/s) and it scales further if ever needed, but it is
**unreliable at a ~5-25% 502 rate** and its reasoning phase is **unbounded and
uncontrollable**. That makes it a poor primary for the extraction path and a reasonable
last-resort fallback — which is exactly where the integration puts it by default.



## 9. Implementation status

Items 1 and 2 from §8 are now implemented and pinned by
[`test/atriaProvider.test.ts`](../test/atriaProvider.test.ts) (9 tests):

- **Provider registration.** `atria` was added to the `LLMProvider` id union and is
  registered in `getDirectLLMProviderCandidates` only when `ATRIA_API_KEY` is set. It is
  **appended last by default** so that supplying a key never silently re-routes a session;
  `ATRIA_PRIORITY="primary"` promotes it to the front (in both `direct` and `litellm`
  gateway modes). Overridable via `ATRIA_BASE`, `ATRIA_MODEL`, `ATRIA_PROVIDER_NAME`.
- **Truncation is no longer silent.** `sendChatCompletion` previously did
  `data.choices?.[0]?.message?.content || ""`, collapsing a reasoning-budget truncation
  into an empty string. It now detects `finish_reason === "length"` with empty content and
  throws an `LLMProviderError` naming the cause, so the chain cascades and the failure is
  visible instead of becoming a zero-yield round.
- **The truncation error deliberately does not trip the circuit breaker.** It sets neither
  `isTokenLimit` nor any message pattern matched by `isCircuitBreakingProviderFailure`, so
  a budget-sizing fault cannot disable a healthy provider for the rest of the session.
  This is asserted against the *real* thrown error, not a hand-written string.

Still outstanding:

- **Item 3 (DNS).** Unresolved. This machine's resolver returns NXDOMAIN for the host and
  the probe still pins the IP manually. Fix before running the engine against Atria.
- **The `atria_api_error` envelope** is not specially mapped. The 502s observed in §4 are
  handled by the existing generic 5xx retry path, which is sufficient — but the envelope
  carries a non-standard `type`, so any future error-code-specific logic needs to know.
- **No end-to-end session has been run against Atria.** The provider is wired and unit
  tested, but the 2026-09-13 baseline (1.2% yield, 39.8% LLM failure rate, 79% LLM latency
  share) has not been re-measured with Atria in the chain.

