import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { isTransientLLMError } from '../server/leadSearch/sessionHelpers.ts';

const originalFetch = globalThis.fetch;

/**
 * Only the provider keys this suite depends on are touched. This suite deliberately does
 * NOT wipe process.env wholesale: node:test runs files concurrently, so a global wipe
 * leaks into other files that read process.env at call time (a known hazard in this repo).
 */
const MANAGED_KEYS = [
  'LLM_GATEWAY_MODE',
  'OPENAI_API_KEY',
  'BYESU_API_KEY',
  'OPENAI_BASE',
  'OPENAI_MODEL',
  'OPENAI_PROVIDER_NAME',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'TOKEN_HARBOR_API_KEY',
  'LITELLM_MASTER_KEY',
  'LITELLM_API_KEY',
  'ATRIA_API_KEY',
  'ATRIA_BASE',
  'ATRIA_MODEL',
  'ATRIA_PROVIDER_NAME',
  'ATRIA_PRIORITY',
] as const;

const envSnapshot: Record<string, string | undefined> = {};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function importLLM(suffix: string) {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

describe('Atria provider registration', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_GATEWAY_MODE = 'direct';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('is not registered at all when ATRIA_API_KEY is unset', async () => {
    const llm = await importLLM('atria-absent');
    const ids = llm.getLLMProviderSummaries().map((p: any) => p.id);
    assert.equal(ids.includes('atria'), false);
  });

  it('appends Atria last by default so supplying a key never re-routes a session', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('atria-fallback-order');
    const ids = llm.getLLMProviderSummaries().map((p: any) => p.id);

    assert.equal(ids[0], 'primary');
    assert.equal(ids[ids.length - 1], 'atria');
    assert.equal(llm.getPrimaryLLMProvider(), 'Byesu');
    assert.equal(llm.getPrimaryLLMModel(), 'gpt-5.5');
  });

  it('promotes Atria to the front when ATRIA_PRIORITY=primary', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('atria-promoted');
    const ids = llm.getLLMProviderSummaries().map((p: any) => p.id);

    assert.equal(ids[0], 'atria');
    assert.equal(llm.getPrimaryLLMProvider(), 'Atria');
    assert.equal(llm.getPrimaryLLMModel(), 'Atria-Dawn-Preview');
  });

  it('honours ATRIA_BASE / ATRIA_MODEL overrides and strips trailing slashes', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.ATRIA_BASE = 'https://custom.example/v1/';
    process.env.ATRIA_MODEL = 'custom-model';

    const llm = await importLLM('atria-override');

    let capturedUrl = '';
    let capturedBody: any = null;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url.toString();
      capturedBody = JSON.parse((options as RequestInit).body as string);
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
      });
    };

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'ok');
    assert.equal(capturedUrl, 'https://custom.example/v1/chat/completions');
    assert.equal(capturedBody.model, 'custom-model');
  });
});

describe('reasoning-model truncation handling', () => {
  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
    process.env.LLM_GATEWAY_MODE = 'direct';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key] as string;
    }
  });

  it('cascades to the next provider when reasoning consumes the whole budget', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('truncation-cascade');

    const calls: string[] = [];
    globalThis.fetch = async (url) => {
      calls.push(url.toString());
      if (calls.length === 1) {
        // Atria-Dawn-Preview shape: HTTP 200, content null, reasoning ate the budget.
        return jsonResponse({
          model: 'Atria-Dawn-Preview',
          choices: [
            {
              finish_reason: 'length',
              message: {
                content: null,
                reasoning_content: 'Let me think about this carefully...',
              },
            },
          ],
        });
      }
      return jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }],
      });
    };

    const res = await llm.openAIText('test prompt');

    assert.equal(res.text, 'recovered');
    assert.equal(res.provider, 'Byesu');
    assert.equal(calls.length, 2, 'should have cascaded to the second provider');
    assert.match(calls[0], /atria-asi\.ai/);
    assert.match(calls[1], /byesu\.com/);
  });

  it('surfaces a clear error instead of a silent empty string when every provider truncates', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('truncation-solo');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'length',
            message: { content: null, reasoning_content: 'thinking...' },
          },
        ],
      });

    await assert.rejects(
      () => llm.openAIText('test prompt'),
      (error: Error) => {
        assert.match(error.message, /truncated/);
        assert.match(error.message, /finish_reason "length"/);
        assert.match(error.message, /reasoning_content consumed the entire budget/);
        return true;
      },
    );
  });

  it('does not classify a truncation as a circuit-breaking provider failure', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('truncation-breaker');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'length',
            message: { content: null, reasoning_content: 'thinking...' },
          },
        ],
      });

    // Derive the error from the real code path rather than hand-writing the message, so
    // this assertion cannot pass vacuously if the thrown message is later reworded into
    // something the breaker regexes happen to match.
    let thrown: any = null;
    try {
      await llm.openAIText('test prompt');
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown, 'expected the call to reject');
    const cause = thrown.cause ?? thrown;
    assert.equal(cause.name, 'LLMProviderError');
    assert.match(cause.message, /truncated/);

    // A budget-sizing fault must cascade but must never disable a healthy provider for
    // the rest of the session, so this classification has to stay false.
    assert.equal(llm.isCircuitBreakingProviderFailure(cause), false);
    assert.equal(cause.isTokenLimit, false);
  });

  it('still returns partial content when finish_reason is length but content exists', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('truncation-partial');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [
          { finish_reason: 'length', message: { content: 'partial answer' } },
        ],
      });

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, 'partial answer');
  });

  it('preserves the existing empty-result behaviour for a non-truncated empty completion', async () => {
    process.env.ATRIA_API_KEY = 'test-atria-key';
    process.env.ATRIA_PRIORITY = 'primary';

    const llm = await importLLM('empty-stop');

    globalThis.fetch = async () =>
      jsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: null } }],
      });

    const res = await llm.openAIText('test prompt');
    assert.equal(res.text, '');
  });
});

describe('truncation errors are never retried', () => {
  // The truncation message embeds the reasoning_content character count. A count whose
  // decimal form contains a `5\d\d` run (545, 1500, 5432, ...) satisfies the HTTP-status
  // heuristic in TRANSIENT_LLM_ERROR. Retrying is futile because the token budget is
  // unchanged, so the same provider truncates again on every attempt.
  const truncation = (chars: number) =>
    new Error(
      '[Atria] chat completion truncated: finish_reason "length" produced no visible ' +
        `content (reasoning_content consumed the entire budget: ${chars} chars). Raise max_tokens.`,
    );

  it('reports colliding character counts as non-transient', () => {
    for (const chars of [45, 120, 499, 545, 599, 1500, 5432]) {
      assert.equal(
        isTransientLLMError(truncation(chars)),
        false,
        `${chars} chars must not be retried`,
      );
    }
  });

  it('still treats genuine transport failures as transient', () => {
    for (const message of [
      'chat completion error 503: upstream unavailable',
      'fetch failed',
      'socket hang up',
      'rate limit exceeded (429)',
      'connect ETIMEDOUT 47.236.72.31:443',
    ]) {
      assert.equal(isTransientLLMError(new Error(message)), true, message);
    }
  });

  it('does not classify "timed out" as transient (documented gap, not a regression)', () => {
    // TRANSIENT_LLM_ERROR matches `timeout` / `etimedout` but NOT the two-word form
    // "timed out", even though llm.ts:874 treats `/LLM request timed out after/i` as a
    // gateway-limit condition and llm.ts:529 tests the same string. Severity is limited
    // because sendChatCompletion already retries timeouts in its own fetch-error path, so
    // this outer layer is a second retry rather than the only one. Pinned here so the
    // inconsistency is visible rather than silently inherited; changing it alters retry
    // behaviour engine-wide and should be a deliberate decision.
    assert.equal(isTransientLLMError(new Error('LLM request timed out after 30000ms')), false);
  });
});
