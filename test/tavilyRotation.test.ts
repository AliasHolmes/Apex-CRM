import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

async function importLLM(suffix: string) {
  return import(`../server/services/llm.ts?t=${Date.now()}-${suffix}`);
}

describe('Tavily key rotation', () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('rotates tavilySearch from an exhausted key to a healthy key', async () => {
    process.env.TAVILY_API_KEYS = 'bad-key, good-key';
    const llm = await importLLM('tavily-search-rotation');
    const authHeaders: string[] = [];

    globalThis.fetch = async (_url, options: any) => {
      authHeaders.push(options.headers.Authorization);
      if (authHeaders.length === 1) {
        return new Response('credits exhausted', { status: 402 });
      }

      return new Response(JSON.stringify({
        results: [
          { title: 'Founder Profile', url: 'https://www.linkedin.com/in/founder', content: 'Founder and CEO' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await llm.tavilySearch('founder linkedin', ['linkedin.com/in']);

    assert.deepEqual(authHeaders, ['Bearer bad-key', 'Bearer good-key']);
    assert.equal(result.sources[0].uri, 'https://www.linkedin.com/in/founder');
    const status = llm.getTavilyKeyStatus();
    assert.equal(status.keys[0].status, 'exhausted');
    assert.equal(JSON.stringify(status).includes('bad-key'), false);
  });

  it('tavilyExtract uses plural keys without TAVILY_API_KEY', async () => {
    process.env.TAVILY_API_KEYS = '["extract-key"]';
    const llm = await importLLM('tavily-extract-plural');
    let authHeader = '';

    globalThis.fetch = async (_url, options: any) => {
      authHeader = options.headers.Authorization;
      return new Response(JSON.stringify({
        results: [
          { url: 'https://example.com/contact', raw_content: 'email us at hello@example.com' }
        ]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    assert.equal(llm.hasTavilyKey(), true);
    const result = await llm.tavilyExtract(['https://example.com/contact'], 'email');

    assert.equal(authHeader, 'Bearer extract-key');
    assert.equal(result[0].rawContent, 'email us at hello@example.com');
  });

  it('normalizes a planner country value to Tavily\'s documented lowercase enum', async () => {
    process.env.TAVILY_API_KEYS = 'country-key';
    const llm = await importLLM('tavily-country-normalization');
    let requestBody: any;

    globalThis.fetch = async (_url, options: any) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    await llm.tavilySearch('Miami founders', { country: 'United States' });

    assert.equal(requestBody.country, 'united states');
  });

  it('normalizes full URLs and paths to Tavily domain filters', async () => {
    process.env.TAVILY_API_KEYS = 'domain-key';
    const llm = await importLLM('tavily-domain-normalization');
    let requestBody: any;

    globalThis.fetch = async (_url, options: any) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    await llm.tavilySearch('founders', ['https://www.linkedin.com/in/example', 'linkedin.com/in/example']);

    assert.deepEqual(requestBody.include_domains, ['linkedin.com']);
  });
});
