import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLMStallError,
  isStallError,
  sanitizeModelName,
  openAIText,
  openAIStructured,
} from '../server/services/llm.js';
import { isTransientLLMError } from '../server/leadSearch/sessionHelpers.js';
import { PLANNER_PROVIDER_HARD_TIMEOUT_MS } from '../server/leadSearch/plannerRouting.js';

const originalFetch = globalThis.fetch;

test('LLMStallError has correct properties and is recognized by isStallError and isTransientLLMError', () => {
  const dummyProvider = {
    id: 'primary' as const,
    name: 'OmniRoute',
    model: 'gemini-3.8-flash-high',
    baseUrl: 'http://localhost:20128/v1',
    apiKey: 'dummy-key',
  };

  const stallErr = new LLMStallError(
    dummyProvider as any,
    'No forward token progress received within 45s.',
    45000,
  );

  assert.equal(stallErr.isStall, true);
  assert.equal(stallErr.isTimeout, true);
  assert.equal(isStallError(stallErr), true);
  assert.equal(isTransientLLMError(stallErr), true);
  assert.ok(stallErr.message.includes('No forward token progress'));
});

test('Streaming stall watchdog aborts within LLM_STALL_TIMEOUT_MS when stream stalls without chunks', async () => {
  const savedStallEnv = process.env.LLM_STALL_TIMEOUT_MS;
  const savedBase = process.env.OPENAI_BASE;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedName = process.env.OPENAI_PROVIDER_NAME;

  try {
    process.env.LLM_STALL_TIMEOUT_MS = '150';
    process.env.OPENAI_BASE = 'http://localhost:20128/v1';
    process.env.OPENAI_API_KEY = 'test-omniroute-key';
    process.env.OPENAI_PROVIDER_NAME = 'OmniRoute';

    globalThis.fetch = async () => {
      const stream = new ReadableStream({
        start(_controller) {
          // Never emit chunks or progress frames
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
        },
      });
    };

    const startTime = Date.now();
    let caughtError: any = null;

    try {
      await openAIText('test stall trigger', undefined, {
        stream: true,
        maxRetries: 0,
      });
    } catch (err) {
      caughtError = err;
    }

    const elapsed = Date.now() - startTime;
    assert.ok(caughtError !== null, 'Expected openAIText to throw on stall');
    assert.ok(isStallError(caughtError?.cause || caughtError), 'Expected error to be LLMStallError');
    assert.ok(elapsed < 2000, `Expected abort in <2s, took ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedStallEnv !== undefined) process.env.LLM_STALL_TIMEOUT_MS = savedStallEnv; else delete process.env.LLM_STALL_TIMEOUT_MS;
    if (savedBase !== undefined) process.env.OPENAI_BASE = savedBase; else delete process.env.OPENAI_BASE;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY;
    if (savedName !== undefined) process.env.OPENAI_PROVIDER_NAME = savedName; else delete process.env.OPENAI_PROVIDER_NAME;
  }
});

test('Same-model retry on Gemini first when initial Gemini call stalls, succeeding on retry', async () => {
  const savedBase = process.env.OPENAI_BASE;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedName = process.env.OPENAI_PROVIDER_NAME;
  const savedModel = process.env.OPENAI_MODEL;
  const savedByesuKey = process.env.BYESU_API_KEY;
  const savedByesuBase = process.env.BYESU_BASE;
  const savedStallEnv = process.env.LLM_STALL_TIMEOUT_MS;

  try {
    process.env.OPENAI_BASE = 'http://localhost:20128/v1';
    process.env.OPENAI_API_KEY = 'test-omniroute-key';
    process.env.OPENAI_PROVIDER_NAME = 'OmniRoute';
    process.env.OPENAI_MODEL = 'gemini-3.8-flash-high';
    process.env.BYESU_API_KEY = 'test-byesu-key';
    process.env.BYESU_BASE = 'https://byesu.com/v1';
    process.env.LLM_STALL_TIMEOUT_MS = '150';

    let geminiCallCount = 0;
    let byesuCallCount = 0;

    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('byesu.com')) {
        byesuCallCount++;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'byesu response' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      geminiCallCount++;
      if (geminiCallCount === 1) {
        // First Gemini attempt stalls
        const stream = new ReadableStream({
          start(_controller) {
            // Never emit chunks
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      }

      // Second Gemini attempt (same-model retry) succeeds
      return new Response(
        'data: {"choices":[{"delta":{"content":"gemini recovered"}}]}\n\ndata: [DONE]\n\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        },
      );
    };

    const res = await openAIText('test same model retry', undefined, { stream: true });
    assert.equal(res.text, 'gemini recovered');
    assert.equal(geminiCallCount, 2, 'Expected Gemini to be called twice (initial + same-model retry)');
    assert.equal(byesuCallCount, 0, 'Expected Byesu NOT to be called when same-model retry succeeds');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedBase !== undefined) process.env.OPENAI_BASE = savedBase; else delete process.env.OPENAI_BASE;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY;
    if (savedName !== undefined) process.env.OPENAI_PROVIDER_NAME = savedName; else delete process.env.OPENAI_PROVIDER_NAME;
    if (savedModel !== undefined) process.env.OPENAI_MODEL = savedModel; else delete process.env.OPENAI_MODEL;
    if (savedByesuKey !== undefined) process.env.BYESU_API_KEY = savedByesuKey; else delete process.env.BYESU_API_KEY;
    if (savedByesuBase !== undefined) process.env.BYESU_BASE = savedByesuBase; else delete process.env.BYESU_BASE;
    if (savedStallEnv !== undefined) process.env.LLM_STALL_TIMEOUT_MS = savedStallEnv; else delete process.env.LLM_STALL_TIMEOUT_MS;
  }
});

test('Repeated stall on Gemini delegates to Byesu (gpt-6.1-sol) in failsafeTier', async () => {
  const savedBase = process.env.OPENAI_BASE;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedName = process.env.OPENAI_PROVIDER_NAME;
  const savedModel = process.env.OPENAI_MODEL;
  const savedByesuKey = process.env.BYESU_API_KEY;
  const savedByesuBase = process.env.BYESU_BASE;
  const savedStallEnv = process.env.LLM_STALL_TIMEOUT_MS;

  try {
    process.env.OPENAI_BASE = 'http://localhost:20128/v1';
    process.env.OPENAI_API_KEY = 'test-omniroute-key';
    process.env.OPENAI_PROVIDER_NAME = 'OmniRoute';
    process.env.OPENAI_MODEL = 'gemini-3.8-flash-high';
    process.env.BYESU_API_KEY = 'test-byesu-key';
    process.env.BYESU_BASE = 'https://byesu.com/v1';
    process.env.LLM_STALL_TIMEOUT_MS = '150';

    let geminiCallCount = 0;
    let byesuCallCount = 0;

    globalThis.fetch = async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes('byesu.com')) {
        byesuCallCount++;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ verified: true, delegatedTo: 'byesu' }) } }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      geminiCallCount++;
      // Gemini stalls on every attempt
      const stream = new ReadableStream({
        start(_controller) {
          // Never emit chunks
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    };

    const schema = {
      type: 'object',
      properties: {
        verified: { type: 'boolean' },
        delegatedTo: { type: 'string' },
      },
      required: ['verified', 'delegatedTo'],
    };

    const res = await openAIStructured<any>('test delegation prompt', schema, 'system', { stream: true });
    assert.deepEqual(res, { verified: true, delegatedTo: 'byesu' });
    assert.equal(geminiCallCount, 2, 'Expected Gemini to be attempted twice (initial + same-model retry)');
    assert.equal(byesuCallCount, 1, 'Expected delegation to Byesu after repeated Gemini stalls');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedBase !== undefined) process.env.OPENAI_BASE = savedBase; else delete process.env.OPENAI_BASE;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY;
    if (savedName !== undefined) process.env.OPENAI_PROVIDER_NAME = savedName; else delete process.env.OPENAI_PROVIDER_NAME;
    if (savedModel !== undefined) process.env.OPENAI_MODEL = savedModel; else delete process.env.OPENAI_MODEL;
    if (savedByesuKey !== undefined) process.env.BYESU_API_KEY = savedByesuKey; else delete process.env.BYESU_API_KEY;
    if (savedByesuBase !== undefined) process.env.BYESU_BASE = savedByesuBase; else delete process.env.BYESU_BASE;
    if (savedStallEnv !== undefined) process.env.LLM_STALL_TIMEOUT_MS = savedStallEnv; else delete process.env.LLM_STALL_TIMEOUT_MS;
  }
});

test('OmniRoute keepalive chunks (choices: []) reset stream inactivity and prevent stalls', async () => {
  const savedBase = process.env.OPENAI_BASE;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedName = process.env.OPENAI_PROVIDER_NAME;
  const savedModel = process.env.OPENAI_MODEL;
  const savedStallEnv = process.env.LLM_STALL_TIMEOUT_MS;
  const savedInactivityEnv = process.env.LLM_STALL_INACTIVITY_MS;

  try {
    process.env.OPENAI_BASE = 'http://localhost:20128/v1';
    process.env.OPENAI_API_KEY = 'test-omniroute-key';
    process.env.OPENAI_PROVIDER_NAME = 'OmniRoute';
    process.env.OPENAI_MODEL = 'gemini-3.8-flash-high';
    process.env.LLM_STALL_TIMEOUT_MS = '200';
    process.env.LLM_STALL_INACTIVITY_MS = '200';

    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          // Send keepalive chunk at 80ms
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(
            encoder.encode('data: {"id":"chatcmpl-keepalive","object":"chat.completion.chunk","model":"keepalive","choices":[]}\n\n'),
          );
          // Send second keepalive chunk at 160ms (past original 200ms without keepalives)
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(encoder.encode('data: {"model":"keepalive","choices":[]}\n\n'));
          // Send final answer at 240ms
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"keepalive success"}}]}\n\ndata: [DONE]\n\n'),
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    };

    const res = await openAIText('test keepalive chunks', undefined, { stream: true, maxRetries: 0 });
    assert.equal(res.text, 'keepalive success');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedBase !== undefined) process.env.OPENAI_BASE = savedBase; else delete process.env.OPENAI_BASE;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY;
    if (savedName !== undefined) process.env.OPENAI_PROVIDER_NAME = savedName; else delete process.env.OPENAI_PROVIDER_NAME;
    if (savedModel !== undefined) process.env.OPENAI_MODEL = savedModel; else delete process.env.OPENAI_MODEL;
    if (savedStallEnv !== undefined) process.env.LLM_STALL_TIMEOUT_MS = savedStallEnv; else delete process.env.LLM_STALL_TIMEOUT_MS;
    if (savedInactivityEnv !== undefined) process.env.LLM_STALL_INACTIVITY_MS = savedInactivityEnv; else delete process.env.LLM_STALL_INACTIVITY_MS;
  }
});

test('OmniRoute SSE comment keepalives (: keepalive) reset stream inactivity', async () => {
  const savedBase = process.env.OPENAI_BASE;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedName = process.env.OPENAI_PROVIDER_NAME;
  const savedModel = process.env.OPENAI_MODEL;
  const savedStallEnv = process.env.LLM_STALL_TIMEOUT_MS;
  const savedInactivityEnv = process.env.LLM_STALL_INACTIVITY_MS;

  try {
    process.env.OPENAI_BASE = 'http://localhost:20128/v1';
    process.env.OPENAI_API_KEY = 'test-omniroute-key';
    process.env.OPENAI_PROVIDER_NAME = 'OmniRoute';
    process.env.OPENAI_MODEL = 'gemini-3.8-flash-high';
    process.env.LLM_STALL_TIMEOUT_MS = '200';
    process.env.LLM_STALL_INACTIVITY_MS = '200';

    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          // Send comment keepalive at 80ms
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(encoder.encode(': keepalive 2026-11-12T16:00:00.000Z\n\n'));
          // Send second comment keepalive at 160ms
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(encoder.encode(': keepalive 2026-11-12T16:00:00.100Z\n\n'));
          // Send final answer at 240ms
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"comment keepalive success"}}]}\n\ndata: [DONE]\n\n'),
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    };

    const res = await openAIText('test comment keepalives', undefined, { stream: true, maxRetries: 0 });
    assert.equal(res.text, 'comment keepalive success');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedBase !== undefined) process.env.OPENAI_BASE = savedBase; else delete process.env.OPENAI_BASE;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY;
    if (savedName !== undefined) process.env.OPENAI_PROVIDER_NAME = savedName; else delete process.env.OPENAI_PROVIDER_NAME;
    if (savedModel !== undefined) process.env.OPENAI_MODEL = savedModel; else delete process.env.OPENAI_MODEL;
    if (savedStallEnv !== undefined) process.env.LLM_STALL_TIMEOUT_MS = savedStallEnv; else delete process.env.LLM_STALL_TIMEOUT_MS;
    if (savedInactivityEnv !== undefined) process.env.LLM_STALL_INACTIVITY_MS = savedInactivityEnv; else delete process.env.LLM_STALL_INACTIVITY_MS;
  }
});

test('Reasoning deltas reset inactivity and do not pollute accumulated text output', async () => {
  const savedBase = process.env.OPENAI_BASE;
  const savedKey = process.env.OPENAI_API_KEY;
  const savedName = process.env.OPENAI_PROVIDER_NAME;
  const savedModel = process.env.OPENAI_MODEL;
  const savedStallEnv = process.env.LLM_STALL_TIMEOUT_MS;
  const savedInactivityEnv = process.env.LLM_STALL_INACTIVITY_MS;

  try {
    process.env.OPENAI_BASE = 'http://localhost:20128/v1';
    process.env.OPENAI_API_KEY = 'test-omniroute-key';
    process.env.OPENAI_PROVIDER_NAME = 'OmniRoute';
    process.env.OPENAI_MODEL = 'gemini-3.8-flash-high';
    process.env.LLM_STALL_TIMEOUT_MS = '200';
    process.env.LLM_STALL_INACTIVITY_MS = '200';

    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          // Send reasoning delta at 80ms
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"Thinking about step 1..."}}]}\n\n'),
          );
          // Send second reasoning delta at 160ms
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"Thinking about step 2..."}}]}\n\n'),
          );
          // Send final content at 240ms
          await new Promise((r) => setTimeout(r, 80));
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"Clean response content"}}]}\n\ndata: [DONE]\n\n'),
          );
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    };

    const res = await openAIText('test reasoning deltas', undefined, { stream: true, maxRetries: 0 });
    assert.equal(res.text, 'Clean response content');
    assert.equal(res.text.includes('Thinking'), false, 'Reasoning content must not leak into text');
  } finally {
    globalThis.fetch = originalFetch;
    if (savedBase !== undefined) process.env.OPENAI_BASE = savedBase; else delete process.env.OPENAI_BASE;
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey; else delete process.env.OPENAI_API_KEY;
    if (savedName !== undefined) process.env.OPENAI_PROVIDER_NAME = savedName; else delete process.env.OPENAI_PROVIDER_NAME;
    if (savedModel !== undefined) process.env.OPENAI_MODEL = savedModel; else delete process.env.OPENAI_MODEL;
    if (savedStallEnv !== undefined) process.env.LLM_STALL_TIMEOUT_MS = savedStallEnv; else delete process.env.LLM_STALL_TIMEOUT_MS;
    if (savedInactivityEnv !== undefined) process.env.LLM_STALL_INACTIVITY_MS = savedInactivityEnv; else delete process.env.LLM_STALL_INACTIVITY_MS;
  }
});

test('sanitizeModelName cleanly aliases gemini-3.8-flash-n to gemini-3.8-flash-high', () => {
  assert.equal(sanitizeModelName('gemini-3.8-flash-n'), 'gemini-3.8-flash-high');
  assert.equal(sanitizeModelName('antigravity/gemini-3.8-flash-n'), 'gemini-3.8-flash-high');
  assert.equal(sanitizeModelName('antigravity/gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
  assert.equal(sanitizeModelName('gemini-3.8-flash-high'), 'gemini-3.8-flash-high');
  assert.equal(sanitizeModelName('gpt-6.1-sol'), 'gpt-6.1-sol');
});

test('PLANNER_PROVIDER_HARD_TIMEOUT_MS.primary is aligned with reasoning model stall threshold (>= 90s)', () => {
  assert.ok(
    PLANNER_PROVIDER_HARD_TIMEOUT_MS.primary >= 90_000,
    `Planner primary hard timeout (${PLANNER_PROVIDER_HARD_TIMEOUT_MS.primary}ms) must be at least 90,000ms to allow reasoning TTFT`,
  );
});
