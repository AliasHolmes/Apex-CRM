import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { describe } from 'node:test';

import {
  isLangfuseConfigured,
  getLangfuseHost,
  buildLangfuseOtelPayload,
  sendDirectLangfuseTrace,
  type LangfuseLogPayload,
} from '../server/services/langfuse.ts';

// Helper to extract attribute values from OTLP KeyValue arrays
function getAttr(attributes: any[] | undefined, key: string): any {
  if (!Array.isArray(attributes)) return undefined;
  const item = attributes.find((a: any) => a.key === key);
  if (!item || !item.value) return undefined;
  const val = item.value;
  if ('stringValue' in val) return val.stringValue;
  if ('intValue' in val) return Number(val.intValue);
  if ('boolValue' in val) return Boolean(val.boolValue);
  if ('arrayValue' in val) {
    return (val.arrayValue?.values || []).map((v: any) =>
      v.stringValue !== undefined ? v.stringValue : v.intValue !== undefined ? Number(v.intValue) : v
    );
  }
  return val;
}

describe('Langfuse v4 Configuration & Host Normalization', () => {
  const originalEnv = { ...process.env };

  test('isLangfuseConfigured() returns true only when both keys are present', () => {
    try {
      // Both present
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-1234567890';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-0987654321';
      assert.equal(isLangfuseConfigured(), true);

      // Only public key
      delete process.env.LANGFUSE_SECRET_KEY;
      assert.equal(isLangfuseConfigured(), false);

      // Only secret key
      delete process.env.LANGFUSE_PUBLIC_KEY;
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-0987654321';
      assert.equal(isLangfuseConfigured(), false);

      // Neither present
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      assert.equal(isLangfuseConfigured(), false);
    } finally {
      process.env = { ...originalEnv };
    }
  });

  test('getLangfuseHost() strips trailing slashes and resolves defaults properly', () => {
    try {
      delete process.env.LANGFUSE_HOST;
      delete process.env.LANGFUSE_BASE_URL;
      delete process.env.LANGFUSE_BASEURL;

      // Default fallback
      assert.equal(getLangfuseHost(), 'https://us.cloud.langfuse.com');

      // LANGFUSE_HOST with single trailing slash
      process.env.LANGFUSE_HOST = 'https://custom.langfuse.instance.com/';
      assert.equal(getLangfuseHost(), 'https://custom.langfuse.instance.com');

      // LANGFUSE_HOST with multiple trailing slashes
      process.env.LANGFUSE_HOST = 'https://custom.langfuse.instance.com///';
      assert.equal(getLangfuseHost(), 'https://custom.langfuse.instance.com');

      // LANGFUSE_BASE_URL fallback with trailing slash
      delete process.env.LANGFUSE_HOST;
      process.env.LANGFUSE_BASE_URL = 'https://base-url.langfuse.com//';
      assert.equal(getLangfuseHost(), 'https://base-url.langfuse.com');

      // LANGFUSE_BASEURL fallback
      delete process.env.LANGFUSE_BASE_URL;
      process.env.LANGFUSE_BASEURL = 'https://baseurl.langfuse.com/';
      assert.equal(getLangfuseHost(), 'https://baseurl.langfuse.com');
    } finally {
      process.env = { ...originalEnv };
    }
  });
});

describe('Langfuse v4 OTLP Payload Construction (buildLangfuseOtelPayload)', () => {
  const samplePayload: LangfuseLogPayload = {
    sessionId: 'session-uuid-test-1234',
    traceName: 'Apex Extraction Run',
    stage: 'extractStage',
    round: 2,
    model: 'gpt-4o-mini',
    provider: 'OpenRouter',
    inputTokens: 1250,
    outputTokens: 420,
    totalTokens: 1670,
    latencyMs: 1350,
    status: 'success',
    messages: [
      { role: 'system', content: 'You are an extraction assistant.' },
      { role: 'user', content: 'Extract key leads.' },
    ],
    output: 'Extracted 5 qualified leads.',
    metadata: {
      accountFilter: 'enterprise',
      highPriority: true,
      retryCount: 1,
    },
  };

  test('generates valid ExportTraceServiceRequest structure with resource and scope spans', () => {
    const otlp = buildLangfuseOtelPayload(samplePayload);

    assert.ok(otlp, 'Payload must not be empty');
    assert.ok(Array.isArray(otlp.resourceSpans), 'resourceSpans must be an array');
    assert.equal(otlp.resourceSpans.length, 1);

    const resource = otlp.resourceSpans[0].resource;
    assert.ok(resource, 'resource must exist');
    assert.equal(getAttr(resource.attributes, 'service.name'), 'apex-crm');
    assert.equal(getAttr(resource.attributes, 'service.version'), '2.0.0');

    const scopeSpans = otlp.resourceSpans[0].scopeSpans;
    assert.ok(Array.isArray(scopeSpans), 'scopeSpans must be an array');
    assert.equal(scopeSpans.length, 1);

    const scope = scopeSpans[0].scope;
    assert.ok(scope, 'scope must exist');
    assert.equal(scope.name, 'apex-crm.langfuse');
    assert.equal(scope.version, '4.0.0');

    assert.ok(Array.isArray(scopeSpans[0].spans), 'spans must be an array');
    assert.equal(scopeSpans[0].spans.length, 1);
  });

  test('verifies traceId and spanId adhere strictly to OTLP hexadecimal formatting', () => {
    const otlp = buildLangfuseOtelPayload(samplePayload);
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];

    // traceId: 32 hex chars
    assert.match(span.traceId, /^[0-9a-f]{32}$/, 'traceId must be 32 lowercase hex characters');

    // traceId derived from sessionId MD5 hash
    const expectedTraceId = crypto.createHash('md5').update('session-uuid-test-1234').digest('hex');
    assert.equal(span.traceId, expectedTraceId);

    // spanId: 16 hex chars
    assert.match(span.spanId, /^[0-9a-f]{16}$/, 'spanId must be 16 lowercase hex characters');

    // Without sessionId, generates a valid 32-hex random traceId
    const payloadNoSession: LangfuseLogPayload = {
      ...samplePayload,
      sessionId: undefined,
    };
    const otlpNoSession = buildLangfuseOtelPayload(payloadNoSession);
    const spanNoSession = otlpNoSession.resourceSpans[0].scopeSpans[0].spans[0];
    assert.match(spanNoSession.traceId, /^[0-9a-f]{32}$/, 'fallback traceId must be 32 hex characters');
  });

  test('verifies nanosecond timestamps are valid numeric strings and endTime >= startTime', () => {
    const otlp = buildLangfuseOtelPayload(samplePayload);
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];

    assert.match(span.startTimeUnixNano, /^\d+$/, 'startTimeUnixNano must be a decimal string');
    assert.match(span.endTimeUnixNano, /^\d+$/, 'endTimeUnixNano must be a decimal string');

    const startBig = BigInt(span.startTimeUnixNano);
    const endBig = BigInt(span.endTimeUnixNano);
    assert.ok(endBig >= startBig, 'endTimeUnixNano must be greater than or equal to startTimeUnixNano');

    // When latencyMs > 0, endBig must strictly exceed startBig
    assert.ok(endBig > startBig, 'endTimeUnixNano must strictly exceed startTimeUnixNano when latencyMs > 0');
  });

  test('verifies all standard GenAI and Langfuse trace attributes', () => {
    const otlp = buildLangfuseOtelPayload(samplePayload);
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = span.attributes;

    assert.equal(getAttr(attrs, 'langfuse.trace.name'), 'Apex Extraction Run');
    assert.equal(getAttr(attrs, 'langfuse.session.id'), 'session-uuid-test-1234');
    assert.equal(getAttr(attrs, 'langfuse.observation.type'), 'generation');
    assert.equal(getAttr(attrs, 'langfuse.observation.level'), 'DEFAULT');
    assert.equal(getAttr(attrs, 'langfuse.observation.input'), JSON.stringify(samplePayload.messages));
    assert.equal(getAttr(attrs, 'langfuse.observation.output'), 'Extracted 5 qualified leads.');

    assert.equal(getAttr(attrs, 'gen_ai.system'), 'OpenRouter');
    assert.equal(getAttr(attrs, 'gen_ai.request.model'), 'gpt-4o-mini');
    assert.equal(getAttr(attrs, 'gen_ai.usage.input_tokens'), 1250);
    assert.equal(getAttr(attrs, 'gen_ai.usage.output_tokens'), 420);
    assert.equal(getAttr(attrs, 'gen_ai.usage.total_tokens'), 1670);

    const tags = getAttr(attrs, 'langfuse.trace.tags');
    assert.ok(Array.isArray(tags), 'tags must be an array');
    assert.ok(tags.includes('apex-crm'));
    assert.ok(tags.includes('mining-session'));
    assert.ok(tags.includes('OpenRouter'));

    assert.equal(span.status.code, 1, 'Success status code must be 1');
    assert.equal(span.kind, 1, 'Span kind must be 1 (SPAN_KIND_INTERNAL)');
  });

  test('verifies error status, error message, and ERROR level mapping', () => {
    const errorPayload: LangfuseLogPayload = {
      ...samplePayload,
      status: 'error',
      errorMessage: 'Rate limit exceeded (HTTP 429)',
      output: undefined,
    };

    const otlp = buildLangfuseOtelPayload(errorPayload);
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = span.attributes;

    assert.equal(span.status.code, 2, 'Error status code must be 2');
    assert.equal(span.status.message, 'Rate limit exceeded (HTTP 429)');
    assert.equal(getAttr(attrs, 'langfuse.observation.level'), 'ERROR');
    assert.equal(getAttr(attrs, 'langfuse.observation.status_message'), 'Rate limit exceeded (HTTP 429)');
  });

  test('verifies fallback trace name generation when traceName is omitted', () => {
    // When stage is provided
    const payloadWithStage: LangfuseLogPayload = {
      ...samplePayload,
      traceName: undefined,
      stage: 'judgeStage',
    };
    const otlpStage = buildLangfuseOtelPayload(payloadWithStage);
    const spanStage = otlpStage.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(getAttr(spanStage.attributes, 'langfuse.trace.name'), 'Apex Mining: judgeStage');

    // When stage is also omitted
    const payloadNoStage: LangfuseLogPayload = {
      ...samplePayload,
      traceName: undefined,
      stage: undefined,
    };
    const otlpNoStage = buildLangfuseOtelPayload(payloadNoStage);
    const spanNoStage = otlpNoStage.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(getAttr(spanNoStage.attributes, 'langfuse.trace.name'), 'LLM Call');
  });

  test('verifies metadata items are mapped under langfuse.observation.metadata namespace', () => {
    const otlp = buildLangfuseOtelPayload(samplePayload);
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    const attrs = span.attributes;

    assert.equal(getAttr(attrs, 'langfuse.observation.metadata.round'), 2);
    assert.equal(getAttr(attrs, 'langfuse.observation.metadata.stage'), 'extractStage');
    assert.equal(getAttr(attrs, 'langfuse.observation.metadata.latencyMs'), 1350);
    assert.equal(getAttr(attrs, 'langfuse.observation.metadata.accountFilter'), 'enterprise');
    assert.equal(getAttr(attrs, 'langfuse.observation.metadata.highPriority'), true);
    assert.equal(getAttr(attrs, 'langfuse.observation.metadata.retryCount'), 1);
  });
});

describe('Langfuse v4 Network Dispatch & Non-Blocking Resilience', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  test('sendDirectLangfuseTrace dispatches OTLP POST to /api/public/otel/v1/traces with v4 headers', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key-123';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-key-456';
    process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';

    let capturedUrl = '';
    let capturedOptions: any = null;

    globalThis.fetch = (async (url: string | URL | Request, options?: any) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as any;

    try {
      const payload: LangfuseLogPayload = {
        sessionId: 'session-net-test',
        traceName: 'Network Dispatch Test',
        model: 'groq/llama-3.3-70b',
        provider: 'groq',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        latencyMs: 300,
        status: 'success',
      };

      await sendDirectLangfuseTrace(payload);

      assert.equal(capturedUrl, 'https://cloud.langfuse.com/api/public/otel/v1/traces');
      assert.ok(capturedOptions, 'fetch options must be passed');
      assert.equal(capturedOptions.method, 'POST');

      const headers = capturedOptions.headers;
      assert.equal(headers['x-langfuse-ingestion-version'], '4');
      assert.equal(headers['Content-Type'], 'application/json');

      const expectedAuth = `Basic ${Buffer.from('pk-test-key-123:sk-test-key-456').toString('base64')}`;
      assert.equal(headers['Authorization'], expectedAuth);

      // Verify body parses as valid JSON matching OTLP structure
      const parsedBody = JSON.parse(capturedOptions.body);
      assert.ok(Array.isArray(parsedBody.resourceSpans));
      assert.equal(parsedBody.resourceSpans.length, 1);
    } finally {
      process.env = { ...originalEnv };
      globalThis.fetch = originalFetch;
    }
  });

  test('sendDirectLangfuseTrace falls back to legacy endpoint if OTel endpoint returns 404', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key-123';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-key-456';
    process.env.LANGFUSE_HOST = 'https://legacy-host.langfuse.com';

    const calledUrls: string[] = [];

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      calledUrls.push(urlStr);
      if (urlStr.includes('/api/public/otel/v1/traces')) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as any;

    try {
      const payload: LangfuseLogPayload = {
        model: 'test-model',
        provider: 'byesu',
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
        latencyMs: 100,
        status: 'success',
      };

      await sendDirectLangfuseTrace(payload);

      assert.ok(calledUrls.some((u) => u.endsWith('/api/public/otel/v1/traces')), 'Should call OTel endpoint first');
      assert.ok(calledUrls.some((u) => u.endsWith('/api/public/ingestion')), 'Should fall back to legacy ingestion endpoint on 404');
    } finally {
      process.env = { ...originalEnv };
      globalThis.fetch = originalFetch;
    }
  });

  test('sendDirectLangfuseTrace never throws or rejects on HTTP 500 error', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key-123';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-key-456';
    process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';

    globalThis.fetch = (async () => {
      return new Response('Internal Server Error', { status: 500 });
    }) as any;

    try {
      const payload: LangfuseLogPayload = {
        model: 'test-model',
        provider: 'openrouter',
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        latencyMs: 50,
        status: 'success',
      };

      // Must resolve cleanly without throwing
      await assert.doesNotReject(async () => {
        await sendDirectLangfuseTrace(payload);
      });
    } finally {
      process.env = { ...originalEnv };
      globalThis.fetch = originalFetch;
    }
  });

  test('sendDirectLangfuseTrace never throws or retries on HTTP 410 (legacy sunset)', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key-123';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-key-456';
    process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';

    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify({ error: 'LANGFUSE_V3_API_REMOVED' }), { status: 410 });
    }) as any;

    try {
      const payload: LangfuseLogPayload = {
        model: 'test-model',
        provider: 'openrouter',
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        latencyMs: 50,
        status: 'success',
      };

      await assert.doesNotReject(async () => {
        await sendDirectLangfuseTrace(payload);
      });
      assert.equal(callCount, 1, 'Must not retry when HTTP 410 is returned');
    } finally {
      process.env = { ...originalEnv };
      globalThis.fetch = originalFetch;
    }
  });

  test('sendDirectLangfuseTrace never throws or rejects on network failure (fetch reject)', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test-key-123';
    process.env.LANGFUSE_SECRET_KEY = 'sk-test-key-456';
    process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';

    globalThis.fetch = (async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    }) as any;

    try {
      const payload: LangfuseLogPayload = {
        model: 'test-model',
        provider: 'openrouter',
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        latencyMs: 50,
        status: 'success',
      };

      await assert.doesNotReject(async () => {
        await sendDirectLangfuseTrace(payload);
      });
    } finally {
      process.env = { ...originalEnv };
      globalThis.fetch = originalFetch;
    }
  });

  test('sendDirectLangfuseTrace no-ops when Langfuse is not configured', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as any;

    try {
      const payload: LangfuseLogPayload = {
        model: 'test-model',
        provider: 'openrouter',
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        latencyMs: 50,
        status: 'success',
      };

      await sendDirectLangfuseTrace(payload);
      assert.equal(fetchCalled, false, 'fetch should not be called when keys are not configured');
    } finally {
      process.env = { ...originalEnv };
      globalThis.fetch = originalFetch;
    }
  });
});
