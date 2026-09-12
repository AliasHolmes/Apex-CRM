import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

async function importLLM(suffix: string) {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

const okResponse = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Regression coverage for the "failure classification regex-matches model output" bug.
 *
 * Parse failures used to interpolate 300 characters of verbatim model output into the thrown
 * error's `message`, and the fallback layer classified failures by regex on that string.
 * Prospect data routinely contains "413" (area code, "Suite 413"), "timeout" and "aborted",
 * so a single malformed response from a perfectly healthy provider could trip the circuit
 * breaker, apply a 30s cooldown, or abort the entire fallback chain.
 */
describe('LLM failure classification ignores untrusted model text', () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    process.env.LLM_GATEWAY_MODE = 'direct';
    process.env.LLM_MAX_RETRIES = '0';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('still cascades to the next provider when malformed output contains "aborted"', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

    const llm = await importLLM('untrusted-aborted');
    const calls: string[] = [];

    globalThis.fetch = async (url, _options: any) => {
      const target = url.toString();
      calls.push(target);
      if (calls.length === 1) {
        // Unparseable completion that happens to contain the word "aborted".
        return okResponse('Sure! (aborted) here you go: {"leads": [ this is not json');
      }
      return okResponse('{"leads": []}');
    };

    const result = await llm.openAIStructured(
      'test prompt',
      { type: 'object' },
      undefined,
      { retryOnParseFailure: false },
    );

    // Previously the echoed "aborted" matched `message.includes("aborted")` and rethrew past
    // every remaining provider, so only one call was made and the request failed outright.
    assert.equal(calls.length, 2, 'should have fallen through to the second provider');
    assert.deepEqual(result, { leads: [] });
  });

  it('does not cooldown a healthy provider when malformed output contains "timeout"', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';

    const llm = await importLLM('untrusted-timeout');
    llm.clearProviderCooldowns();

    let call = 0;
    globalThis.fetch = async (_url, _options: any) => {
      call += 1;
      if (call === 1) {
        // Unparseable completion that happens to mention a timeout.
        return okResponse('Suite 413, connection timeout occurred: {"leads": [ broken');
      }
      return okResponse('{"leads": []}');
    };

    await assert.rejects(async () => {
      await llm.openAIStructured('test prompt', { type: 'object' }, undefined, {
        retryOnParseFailure: false,
      });
    });

    // A second call must still reach the provider. Previously the "timeout" in the model text
    // classified as a transient failure and put the provider on a 30s cooldown, so with a
    // single provider configured this second call failed with "All providers failed".
    const result = await llm.openAIStructured(
      'test prompt',
      { type: 'object' },
      undefined,
      { retryOnParseFailure: false },
    );
    assert.deepEqual(result, { leads: [] });
    assert.equal(call, 2);
  });

  it('marks parse failures as untrusted and exposes hasUntrustedMessage', async () => {
    process.env.OPENAI_API_KEY = 'test-primary-key';
    const llm = await importLLM('untrusted-flag');

    globalThis.fetch = async (_url, _options: any) =>
      okResponse('not json at all');

    let captured: unknown;
    try {
      await llm.openAIStructured('test prompt', { type: 'object' }, undefined, {
        retryOnParseFailure: false,
      });
    } catch (error) {
      captured = error;
    }

    assert.ok(captured instanceof Error);
    // The surfaced error is the aggregate from withProviderFallback, so assert on the
    // observable property: the untrusted completion must never be spliced into a message
    // that failure classification regex-matches.
    assert.ok(
      !(captured as Error).message.includes('not json at all'),
      'model text must not be interpolated into any error message',
    );
    assert.ok(
      (captured as Error).message.includes('Failed to parse'),
      'aggregate should still surface the parse-failure reason',
    );
    // Sanity: the helper is exported and does not flag ordinary errors.
    assert.equal(llm.hasUntrustedMessage(new Error('plain error')), false);
  });
});
