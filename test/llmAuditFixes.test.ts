import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;

const MANAGED_KEYS = [
  'OPENAI_API_KEY',
  'BYESU_API_KEY',
  'OPENAI_BASE',
  'OPENAI_MODEL',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'ATRIA_API_KEY',
  'ATRIA_BASE',
  'ATRIA_PRIORITY',
  'LLM_MAX_RETRIES',
  'LLM_RETRY_429',
  'LLM_COMPLETION_CACHE',
  'LLM_FAST_PROVIDER_IDS',
  'LLM_PRIMARY_RECOVERY_MAX_WAIT_MS',
  'LLM_AUTH_OUT_MS',
  'LLM_QUOTA_OUT_MS',
] as const;

const envSnapshot: Record<string, string | undefined> = {};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const okChat = (content: string) =>
  json({ choices: [{ finish_reason: 'stop', message: { content } }] });

async function importLLM(suffix: string): Promise<typeof import('../server/services/llm.ts')> {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

/** Fails the test instead of hanging the runner when the code under test never settles. */
async function settlesWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function markOut(llm: any, id: string, ms = 60_000) {
  const health = llm.getProviderHealth(id);
  health.status = 'out';
  health.outUntil = Date.now() + ms;
  health.outReason = 'fatal_error';
}

describe('LLM audit fixes', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_COMPLETION_CACHE = 'false';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  describe('structured JSON salvage', () => {
    it('keeps the complete elements of a truncated {"items":[...]} wrapper instead of discarding the batch', async () => {
      process.env.BYESU_API_KEY = 'k';
      const llm = await importLLM('wrapper-salvage');
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return okChat(
          '{"items":[{"fullName":"A","extractionConfidence":8},{"fullName":"B","extractionConfidence":7},{"fullName":"C","extr',
        );
      };
      const result = await llm.openAIStructured<Array<{ fullName: string }>>(
        'p',
        {
          type: llm.Type.ARRAY,
          items: {
            type: llm.Type.OBJECT,
            properties: { fullName: { type: llm.Type.STRING } },
            required: ['fullName', 'extractionConfidence'],
          },
        },
        undefined,
        { retryOnParseFailure: false },
      );
      assert.deepEqual(result.map((r) => r.fullName), ['A', 'B']);
      assert.equal(calls, 1);
    });
  });

  describe('retry configuration', () => {
    it('does not sleep before failing when LLM_MAX_RETRIES=0 and the network errors', async () => {
      process.env.BYESU_API_KEY = 'k';
      process.env.LLM_MAX_RETRIES = '0';
      const llm = await importLLM('zero-retries-no-sleep');
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        throw new TypeError('fetch failed');
      };
      const started = Date.now();
      await assert.rejects(() => llm.openAIText('p'), /fetch failed/);
      assert.equal(calls, 1);
      assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms; a dead 2s retry sleep is back`);
    });

    it('lets an explicit per-call maxRetries override LLM_MAX_RETRIES', async () => {
      process.env.BYESU_API_KEY = 'k';
      process.env.LLM_MAX_RETRIES = '0';
      const llm = await importLLM('explicit-retries-win');
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return calls === 1 ? new Response('upstream error', { status: 503 }) : okChat('ok');
      };
      const res = await llm.openAIText('p', undefined, { maxRetries: 1 });
      assert.equal(res.text, 'ok');
      assert.equal(calls, 2);
    });
  });

  describe('failsafe routing policy', () => {
    it('background sessions use the failsafe tier once both primaries are out', async () => {
      process.env.ATRIA_API_KEY = 'a';
      process.env.BYESU_API_KEY = 'b';
      process.env.GROQ_API_KEY = 'g';
      const llm = await importLLM('bg-both-out-failsafe');
      markOut(llm, 'atria');
      markOut(llm, 'primary');
      const urls: string[] = [];
      globalThis.fetch = async (url: any) => {
        urls.push(String(url));
        return okChat('failsafe ok');
      };
      const res = await settlesWithin(
        llm.openAIText('p', undefined, { metadata: { sessionId: 'session-bg-1' } }),
        3_000,
        'background call with both primaries out',
      );
      assert.equal(res.text, 'failsafe ok');
      assert.ok(urls[0].includes('api.groq.com'), `expected Groq, got ${urls[0]}`);
    });

    it('background sessions give up after a bounded wait when both primaries are out and no failsafe exists', async () => {
      process.env.ATRIA_API_KEY = 'a';
      process.env.BYESU_API_KEY = 'b';
      process.env.LLM_PRIMARY_RECOVERY_MAX_WAIT_MS = '50';
      const llm = await importLLM('bg-both-out-bounded');
      markOut(llm, 'atria');
      markOut(llm, 'primary');
      globalThis.fetch = async () => okChat('should never be called');
      await assert.rejects(
        () =>
          settlesWithin(
            llm.openAIText('p', undefined, { metadata: { sessionId: 'session-bg-2' } }),
            3_000,
            'bounded primary recovery wait',
          ),
        (err: Error) => {
          assert.ok(!/did not settle/.test(err.message), 'the call hung instead of giving up');
          assert.match(err.message, /primary providers .*out/i);
          return true;
        },
      );
    });

    it('does not escalate to the failsafe because a primary returned one unparseable answer', async () => {
      process.env.BYESU_API_KEY = 'b';
      process.env.GROQ_API_KEY = 'g';
      const llm = await importLLM('parse-failure-no-failsafe');
      const urls: string[] = [];
      globalThis.fetch = async (url: any) => {
        urls.push(String(url));
        return okChat('this is not json at all');
      };
      await assert.rejects(() =>
        llm.openAIStructured('p', { type: llm.Type.OBJECT, properties: {}, required: ['x'] }),
      );
      assert.ok(
        urls.every((u) => u.includes('byesu.com')),
        `failsafe was contacted after a parse failure: ${urls.join(', ')}`,
      );
    });

    it('fails a queued call over to the failsafe promptly when its primary goes out while it waits', async () => {
      process.env.BYESU_API_KEY = 'b';
      process.env.GROQ_API_KEY = 'g';
      const llm = await importLLM('waiter-primary-dies');
      let byesuCalls = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      globalThis.fetch = async (url: any) => {
        if (String(url).includes('byesu.com')) {
          byesuCalls++;
          await gate;
          return new Response('bad key', { status: 401 });
        }
        return okChat('groq ok');
      };
      const first = llm.openAIText('first').catch((e) => e);
      await new Promise((r) => setTimeout(r, 30));
      const second = llm.openAIText('second');
      await new Promise((r) => setTimeout(r, 30));
      release();
      const res = await settlesWithin(second, 3_000, 'queued waiter after primary auth failure');
      assert.equal(res.text, 'groq ok');
      await first;
      assert.equal(byesuCalls, 1);
    });

    it('caps the lockout after an auth failure at minutes, not a day', async () => {
      process.env.BYESU_API_KEY = 'b';
      const llm = await importLLM('auth-out-window');
      globalThis.fetch = async () => new Response('bad key', { status: 401 });
      await assert.rejects(() => llm.openAIText('p'));
      const health = llm.getProviderHealth('primary');
      assert.equal(health.status, 'out');
      assert.ok(
        (health.outUntil as number) - Date.now() <= 15 * 60_000,
        'auth lockout should be recoverable within 15 minutes',
      );
    });

    it('marks a half-open provider as probing so concurrent calls do not all probe it', async () => {
      process.env.BYESU_API_KEY = 'b';
      const llm = await importLLM('half-open-probe');
      const health = llm.getProviderHealth('primary');
      health.status = 'half_open';
      health.halfOpenActive = false;
      let probingDuringCall: boolean | undefined;
      globalThis.fetch = async () => {
        probingDuringCall = llm.getProviderHealth('primary').halfOpenActive;
        return okChat('ok');
      };
      await llm.openAIText('p');
      assert.equal(probingDuringCall, true);
      assert.equal(llm.getProviderHealth('primary').status, 'healthy');
    });

    it('keeps an out or half-open provider in that state after a non-fatal failure', async () => {
      process.env.BYESU_API_KEY = 'b';
      const llm = await importLLM('non-fatal-keeps-state');
      const health = llm.getProviderHealth('primary');
      health.status = 'half_open';
      llm.recordProviderFailure('primary', new Error('odd but harmless'));
      assert.equal(llm.getProviderHealth('primary').status, 'half_open');
      assert.equal(llm.getProviderHealth('primary').halfOpenActive, false);
    });
  });

  describe('route description', () => {
    it('LLM_FAST_PROVIDER_IDS cannot make the failsafe tier look first', async () => {
      process.env.ATRIA_API_KEY = 'a';
      process.env.BYESU_API_KEY = 'b';
      process.env.GROQ_API_KEY = 'g';
      process.env.LLM_FAST_PROVIDER_IDS = 'groq';
      const llm = await importLLM('route-description');
      assert.equal(llm.describeLLMRoute('fast').providerId, 'atria');
    });
  });
});
