import test from 'node:test';
import assert from 'node:assert';
import { verifyDecisionMakerFromEvidence } from '../server/leadSearch/verification.js';
import { findCompanyWebsite } from '../server/leadSearch/companyIntent.js';
import { getNegativeEnrichmentCacheEntry, upsertNegativeEnrichmentCacheEntry } from '../server/db.js';
import { baseMaxRetries, baseTimeoutSeconds, BRIGHTDATA_SCRAPE_BATCH_MAX_URLS, BrightDataError, buildBrightDataSearchArguments, chunkBrightDataBatchItems, classifyBrightDataError, executeBrightDataSearchWithRetry, normalizeBrightDataGeoLocation, normalizeBrightDataUrl } from '../server/services/brightdata.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { brightDataFreeTierCapabilities } from '../server/leadSearch/freeTier.js';

test('verifyDecisionMakerFromEvidence accepts founder', (t) => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'find me some founders',
    currentTitle: 'Founder and CEO'
  });
  assert.strictEqual(result.titleMatched, true);
  assert.strictEqual(result.ignoredTitle, false);
});

test('verifyDecisionMakerFromEvidence rejects intern unless requested', (t) => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'find me tech leads',
    currentTitle: 'Software Engineering Intern'
  });
  assert.strictEqual(result.titleMatched, false);
  assert.strictEqual(result.ignoredTitle, true);
});

test('verifyDecisionMakerFromEvidence accepts intern if requested', (t) => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'find me interns',
    currentTitle: 'Software Engineering Intern'
  });
  assert.strictEqual(result.titleMatched, false);
  assert.strictEqual(result.ignoredTitle, false);
});

test('negative cache works', (t) => {
  upsertNegativeEnrichmentCacheEntry({
    normalizedUrl: 'linkedin.com/in/test-negative',
    linkedinUsername: 'test-negative',
    evidenceBlock: 'brightdata_login_wall',
    scrapeQuality: 'bad',
    sourceProvider: 'brightdata'
  }, 1);
  
  const cacheHit = getNegativeEnrichmentCacheEntry({ normalizedUrl: 'linkedin.com/in/test-negative' });
  assert.ok(cacheHit);
  assert.strictEqual(cacheHit.evidenceBlock, 'brightdata_login_wall');
  assert.strictEqual(cacheHit.scrapeQuality, 'bad');
});

test('post-enrichment decision-maker verification can rescue unclear evidence', () => {
  const initial = verifyDecisionMakerFromEvidence({
    query: 'dental clinic owners',
    currentTitle: 'Professional',
    evidenceText: 'LINK: https://linkedin.com/in/example\nTITLE: Example Person'
  });
  const enriched = verifyDecisionMakerFromEvidence({
    query: 'dental clinic owners',
    currentTitle: 'Professional',
    currentCompany: 'Bright Smile Dental',
    evidenceText: 'LINK: https://linkedin.com/in/example\nHEADLINE: Founder and Practice Owner at Bright Smile Dental'
  });

  assert.ok(initial.confidence < enriched.confidence);
  assert.strictEqual(enriched.titleMatched, true);
  assert.ok(enriched.confidence >= 7);
});

test('post-enrichment verification rejects confirmed weak title', () => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'agency owners',
    currentTitle: 'Marketing Assistant',
    evidenceText: 'LINK: https://linkedin.com/in/example\nEXPERIENCE: Marketing Assistant at Growth Co'
  });

  assert.strictEqual(result.ignoredTitle, true);
  assert.ok(result.confidence < 5);
});

test('decision-maker verification accepts executive acronyms and head roles', () => {
  for (const currentTitle of ['CRO', 'Chief Revenue Officer', 'CIO', 'Head of Engineering', 'VP of Sales']) {
    const result = verifyDecisionMakerFromEvidence({
      query: 'find decision makers',
      currentTitle
    });

    assert.strictEqual(result.titleMatched, true, currentTitle);
    assert.strictEqual(result.ignoredTitle, false, currentTitle);
    assert.ok(result.confidence >= 7, currentTitle);
  }
});

test('decision-maker verification rejects assistant-to-executive false positive', () => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'agency owners and CEOs',
    currentTitle: 'Assistant to the CEO'
  });

  assert.strictEqual(result.titleMatched, true);
  assert.strictEqual(result.ignoredTitle, true);
  assert.ok(result.confidence < 5);
});

test('decision-maker verification rejects student organization founder false positive', () => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'startup founders',
    currentTitle: 'Co-Founder at Student Club'
  });

  assert.strictEqual(result.titleMatched, true);
  assert.strictEqual(result.ignoredTitle, true);
  assert.ok(result.confidence < 5);
});

test('decision-maker verification does not treat product owner as company owner', () => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'business owners',
    currentTitle: 'Product Owner'
  });

  assert.strictEqual(result.titleMatched, false);
  assert.strictEqual(result.ignoredTitle, false);
  assert.strictEqual(result.confidence, 5);
});

test('decision-maker verification does not treat principal IC titles as buyers', () => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'technology buyers',
    currentTitle: 'Principal Engineer'
  });

  assert.strictEqual(result.titleMatched, false);
  assert.strictEqual(result.ignoredTitle, false);
  assert.strictEqual(result.confidence, 5);
});

test('decision-maker verification uses extracted seniority as authority evidence', () => {
  const result = verifyDecisionMakerFromEvidence({
    query: 'clinic operators',
    currentTitle: 'Professional',
    seniorityLevel: 'Founder-Owner'
  });

  assert.strictEqual(result.titleMatched, true);
  assert.strictEqual(result.ignoredTitle, false);
  assert.ok(result.confidence >= 7);
});

test('findCompanyWebsite rejects social and job-board URLs and chooses official site', async () => {
  const website = await findCompanyWebsite({
    companyName: 'Bright Smile Dental',
    location: 'Austin',
    brightDataSearch: async () => [
      { title: 'Bright Smile Dental | LinkedIn', url: 'https://linkedin.com/company/bright-smile-dental', content: 'Company page' },
      { title: 'Bright Smile Dental jobs', url: 'https://indeed.com/cmp/bright-smile-dental', content: 'Jobs' },
      { title: 'Bright Smile Dental - Family Dentistry', url: 'https://brightsmiledental.com', content: 'Official website for Bright Smile Dental in Austin' }
    ]
  });

  assert.strictEqual(website, 'https://brightsmiledental.com');
});

test('findCompanyWebsite returns null when only blocked domains are present', async () => {
  const website = await findCompanyWebsite({
    companyName: 'Blocked Co',
    brightDataSearch: async () => [
      { title: 'Blocked Co | LinkedIn', url: 'https://linkedin.com/company/blocked-co', content: 'Company page' },
      { title: 'Blocked Co reviews', url: 'https://yelp.com/biz/blocked-co', content: 'Reviews' }
    ]
  });

  assert.strictEqual(website, null);
});

test('findCompanyWebsite rejects one-label and news-article domains that only mention the company', async () => {
  const website = await findCompanyWebsite({
    companyName: 'Cal AI',
    location: 'Miami',
    brightDataSearch: async () => [
      { title: 'Cal AI founder profile', url: 'https://cnbc.com/young-founder-cal-ai', content: 'Cal AI founder interview' },
      { title: 'GoTo official', url: 'https://goto/', content: 'Cal AI partner' },
      { title: 'Cal AI official website', url: 'https://cal.ai', content: 'Official Cal AI product site' }
    ]
  });

  assert.strictEqual(website, 'https://cal.ai');
});

test('Bright Data classifies target gateway and malformed search responses as retryable target transients', () => {
  for (const message of ['HTTP 502 Bad Gateway', 'status 503 Service Unavailable', '504 Gateway Timeout', 'fetch failed', 'Bright Data scrape_as_markdown returned empty body', "Unexpected non-JSON response from Bright Data for search_engine."]) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.reasonCode, 'target_transient');
    assert.strictEqual(classified.retryable, true);
    assert.strictEqual(classified.providerDisabled, false);
    assert.strictEqual(classified.clearClient, false);
  }
});

test('Bright Data search retry recovers one transient malformed response', async () => {
  let attempts = 0;
  const retries: number[] = [];
  let retryNotifications = 0;
  const result = await executeBrightDataSearchWithRetry(async attempt => {
    attempts = attempt;
    if (attempt === 1) throw new Error("Unexpected non-JSON response from Bright Data for search_engine.");
    return ['recovered'];
  }, {
    maxRetries: 1,
    baseDelayMs: 0,
    jitterMs: 0,
    sleep: async delayMs => { retries.push(delayMs); },
    onRetry: () => { retryNotifications++; }
  });

  assert.deepStrictEqual(result, ['recovered']);
  assert.strictEqual(attempts, 2);
  assert.deepStrictEqual(retries, [0]);
  assert.strictEqual(retryNotifications, 1);
});

test('Bright Data search retry stops after two physical attempts', async () => {
  let attempts = 0;
  await assert.rejects(
    executeBrightDataSearchWithRetry(async attempt => {
      attempts = attempt;
      throw new Error("Unexpected non-JSON response from Bright Data for search_engine.");
    }, { maxRetries: 1, baseDelayMs: 0, jitterMs: 0, sleep: async () => {} }),
    (error: unknown) => error instanceof BrightDataError && error.reasonCode === 'target_transient'
  );
  assert.strictEqual(attempts, 2);
});

test('Bright Data search retry never repeats non-retryable failures', async () => {
  for (const message of ['401 unauthorized invalid token', 'quota credits exhausted', 'HTTP 400 Request validation failed']) {
    let attempts = 0;
    await assert.rejects(
      executeBrightDataSearchWithRetry(async () => {
        attempts++;
        throw new Error(message);
      }, { maxRetries: 1, baseDelayMs: 0, jitterMs: 0, sleep: async () => {} })
    );
    assert.strictEqual(attempts, 1, message);
  }
});

test('Bright Data classifies transport failures as retryable client resets', () => {
  for (const message of ['Connection closed', 'SSE stream disconnected', 'MCP error -32000: process exited']) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.reasonCode, 'transport_transient');
    assert.strictEqual(classified.retryable, true);
    assert.strictEqual(classified.providerDisabled, false);
    assert.strictEqual(classified.clearClient, true);
  }
});

test('Bright Data classifies auth and quota failures as provider disabled', () => {
  for (const message of ['401 unauthorized invalid token', '403 forbidden', 'quota credits exhausted']) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.providerDisabled, true);
    assert.ok(['provider_auth', 'provider_quota'].includes(classified.reasonCode));
  }
});

test('Bright Data timeout and retry env defaults and clamps match MCP recommendations', (t) => {
  const oldBaseTimeout = process.env.BASE_TIMEOUT;
  const oldBrightDataTimeout = process.env.BRIGHTDATA_BASE_TIMEOUT;
  const oldRetries = process.env.BASE_MAX_RETRIES;
  t.after(() => {
    if (oldBaseTimeout === undefined) delete process.env.BASE_TIMEOUT; else process.env.BASE_TIMEOUT = oldBaseTimeout;
    if (oldBrightDataTimeout === undefined) delete process.env.BRIGHTDATA_BASE_TIMEOUT; else process.env.BRIGHTDATA_BASE_TIMEOUT = oldBrightDataTimeout;
    if (oldRetries === undefined) delete process.env.BASE_MAX_RETRIES; else process.env.BASE_MAX_RETRIES = oldRetries;
  });

  delete process.env.BASE_TIMEOUT;
  delete process.env.BRIGHTDATA_BASE_TIMEOUT;
  delete process.env.BASE_MAX_RETRIES;
  assert.strictEqual(baseTimeoutSeconds(), 180);
  assert.strictEqual(baseMaxRetries(), 2);

  process.env.BRIGHTDATA_BASE_TIMEOUT = '90';
  assert.strictEqual(baseTimeoutSeconds(), 90);
  process.env.BASE_TIMEOUT = '240';
  assert.strictEqual(baseTimeoutSeconds(), 240);
  process.env.BASE_MAX_RETRIES = '9';
  assert.strictEqual(baseMaxRetries(), 3);
  process.env.BASE_MAX_RETRIES = '-1';
  assert.strictEqual(baseMaxRetries(), 0);
});

test('Bright DataError preserves explicit classifier metadata', () => {
  const original = new BrightDataError('empty response', { reasonCode: 'target_transient', retryable: true });
  assert.strictEqual(classifyBrightDataError(original), original);
});

test('Bright Data treats MCP request validation as non-provider failure', () => {
  for (const message of [
    'MCP error -32602: Tool scrape_batch parameter validation failed: urls: Array must contain at most 5 element(s)',
    'HTTP 400: {"error":"Request validation failed","details":[{"message":"\"url\" must be a valid uri","type":"string.uri"}]}'
  ]) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.reasonCode, 'request_invalid');
    assert.strictEqual(classified.retryable, false);
    assert.strictEqual(classified.providerDisabled, false);
    assert.strictEqual(classified.clearClient, false);
  }
});

test('Bright Data URL normalization encodes LinkedIn unicode slugs before MCP validation', () => {
  const unicodeUrl = 'https://www.linkedin.com/in/james-pe' + String.fromCharCode(241) + 'as-758a841b';
  assert.strictEqual(
    normalizeBrightDataUrl(unicodeUrl),
    'https://www.linkedin.com/in/james-pe%C3%B1as-758a841b'
  );
  assert.strictEqual(BRIGHTDATA_SCRAPE_BATCH_MAX_URLS, 5);
});

test('Bright Data evidence batching keeps every target within the five-URL tool contract', () => {
  const urls = Array.from({ length: 11 }, (_, index) => `https://example.com/${index + 1}`);
  const batches = chunkBrightDataBatchItems(urls);

  assert.deepStrictEqual(batches.map(batch => batch.length), [5, 5, 1]);
  assert.deepStrictEqual(batches.flat(), urls);
});

test('Bright Data search arguments match the installed MCP search_engine schema', () => {
  assert.strictEqual(normalizeBrightDataGeoLocation('US'), 'us');
  assert.strictEqual(normalizeBrightDataGeoLocation('United States'), '');
  assert.deepStrictEqual(
    buildBrightDataSearchArguments('AI founders', { country: 'US', cursor: 'next-page' }),
    { query: 'AI founders', engine: 'google', cursor: 'next-page', geo_location: 'us' }
  );
});

const originalConnect = Client.prototype.connect;
const originalCallTool = Client.prototype.callTool;
const originalListTools = Client.prototype.listTools;
const originalEnv = { ...process.env };

function restoreMocks() {
  Client.prototype.connect = originalConnect;
  Client.prototype.callTool = originalCallTool;
  Client.prototype.listTools = originalListTools;
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

test('scrape_batch actually invoked on free tier when listTools() advertises it', async (t) => {
  t.after(restoreMocks);
  process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  process.env.BRIGHTDATA_PLAN = 'free';
  process.env.BRIGHTDATA_MCP_TRANSPORT = 'local';

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => {
    return { tools: [{ name: 'scrape_batch', description: 'Scrape batch of URLs', inputSchema: {} as any }] };
  };

  let callToolName = '';
  let callToolArgs: any = null;
  Client.prototype.callTool = async (params) => {
    callToolName = params.name;
    callToolArgs = params.arguments;
    return {
      content: [{ type: 'text', text: JSON.stringify([{ url: 'https://example.com/1', markdown: 'content 1' }]) }]
    } as any;
  };

  const bd = await import(`../server/services/brightdata.ts?t=${Date.now()}-batch-success`);
  const results = await bd.scrapeBatchAsMarkdown(['https://example.com/1']);

  assert.strictEqual(callToolName, 'scrape_batch');
  assert.deepStrictEqual(callToolArgs, { urls: ['https://example.com/1'] });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].url, 'https://example.com/1');
  assert.strictEqual(results[0].content, 'content 1');

  const status = bd.getBrightDataStatus();
  assert.strictEqual(status.batchTool.detected, true);
  assert.strictEqual(status.batchTool.runtimeVerified, true);
});

test('Free-mode isBrightDataFreeTier guard no longer short-circuits batch scraping', async (t) => {
  t.after(restoreMocks);
  process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  process.env.BRIGHTDATA_PLAN = 'free';
  process.env.BRIGHTDATA_MCP_TRANSPORT = 'local';

  let listToolsCalled = false;
  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => {
    listToolsCalled = true;
    return { tools: [{ name: 'scrape_batch', description: 'Scrape batch of URLs', inputSchema: {} as any }] };
  };
  Client.prototype.callTool = async () => {
    return {
      content: [{ type: 'text', text: JSON.stringify([{ url: 'https://example.com/1', markdown: 'content 1' }]) }]
    } as any;
  };

  const bd = await import(`../server/services/brightdata.ts?t=${Date.now()}-batch-no-short-circuit`);
  await bd.scrapeBatchAsMarkdown(['https://example.com/1']);

  assert.strictEqual(listToolsCalled, true);
});

test('scrape_batch falls back to parallel single-page when scrape_batch is NOT advertised', async (t) => {
  t.after(restoreMocks);
  process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  process.env.BRIGHTDATA_PLAN = 'free';
  process.env.BRIGHTDATA_MCP_TRANSPORT = 'local';

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => {
    return { tools: [{ name: 'scrape_as_markdown', description: 'Scrape single URL', inputSchema: {} as any }] };
  };

  const toolCalls: string[] = [];
  Client.prototype.callTool = async (params) => {
    toolCalls.push(params.name);
    return {
      content: [{ type: 'text', text: 'single page content' }]
    } as any;
  };

  const bd = await import(`../server/services/brightdata.ts?t=${Date.now()}-batch-fallback`);
  const results = await bd.scrapeBatchAsMarkdown(['https://example.com/1', 'https://example.com/2']);

  assert.ok(toolCalls.includes('scrape_as_markdown'));
  assert.strictEqual(toolCalls.includes('scrape_batch'), false);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].content, 'single page content');
  
  const status = bd.getBrightDataStatus();
  assert.strictEqual(status.batchTool.detected, false);
  assert.strictEqual(status.batchTool.fallbackMode, 'single_page_parallel');
});

test('Per-child partial-failure retry in batch scrape path', async (t) => {
  t.after(restoreMocks);
  process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  process.env.BRIGHTDATA_PLAN = 'free';
  process.env.BRIGHTDATA_MCP_TRANSPORT = 'local';

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => {
    return { tools: [{ name: 'scrape_batch', description: 'Scrape batch of URLs', inputSchema: {} as any }] };
  };

  const toolCalls: string[] = [];
  Client.prototype.callTool = async (params) => {
    toolCalls.push(params.name);
    if (params.name === 'scrape_batch') {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify([
            { url: 'https://example.com/1', markdown: 'valid content' },
            { url: 'https://example.com/2', markdown: '' } // failed/empty child
          ])
        }]
      } as any;
    }
    if (params.name === 'scrape_as_markdown') {
      return {
        content: [{ type: 'text', text: 'retried single page content' }]
      } as any;
    }
    return { content: [] } as any;
  };

  const bd = await import(`../server/services/brightdata.ts?t=${Date.now()}-partial-retry`);
  const results = await bd.scrapeBatchAsMarkdown(['https://example.com/1', 'https://example.com/2']);

  assert.ok(toolCalls.includes('scrape_batch'));
  assert.ok(toolCalls.includes('scrape_as_markdown'));
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].url, 'https://example.com/1');
  assert.strictEqual(results[0].content, 'valid content');
  assert.strictEqual(results[1].url, 'https://example.com/2');
  assert.strictEqual(results[1].content, 'retried single page content');

  const status = bd.getBrightDataStatus();
  assert.strictEqual(status.batchTool.partialFailures, 1);
  assert.strictEqual(status.batchTool.partialSuccesses, 2);
});

test('Batch scraping retries a requested URL that the provider omits entirely', async (t) => {
  t.after(restoreMocks);
  process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  process.env.BRIGHTDATA_PLAN = 'free';
  process.env.BRIGHTDATA_MCP_TRANSPORT = 'local';

  Client.prototype.connect = async () => {};
  Client.prototype.listTools = async () => ({
    tools: [{ name: 'scrape_batch', description: 'Scrape batch of URLs', inputSchema: {} as any }]
  });

  const toolCalls: string[] = [];
  Client.prototype.callTool = async (params) => {
    toolCalls.push(params.name);
    if (params.name === 'scrape_batch') {
      return {
        content: [{ type: 'text', text: JSON.stringify([
          { url: 'https://example.com/1', markdown: 'valid content' }
        ]) }]
      } as any;
    }
    return { content: [{ type: 'text', text: 'recovered omitted page' }] } as any;
  };

  const bd = await import(`../server/services/brightdata.ts?t=${Date.now()}-omitted-retry`);
  const results = await bd.scrapeBatchAsMarkdown(['https://example.com/1', 'https://example.com/2']);

  assert.deepStrictEqual(toolCalls, ['scrape_batch', 'scrape_as_markdown']);
  assert.deepStrictEqual(results.map((result: { url: string }) => result.url), ['https://example.com/1', 'https://example.com/2']);
  assert.strictEqual(results[1].content, 'recovered omitted page');

  const status = bd.getBrightDataStatus();
  assert.strictEqual(status.batchTool.partialFailures, 1);
  assert.strictEqual(status.batchTool.partialSuccesses, 2);
});

test('brightDataFreeTierCapabilities unavailable no longer lists scrape_batch', () => {
  const cap = brightDataFreeTierCapabilities();
  assert.strictEqual(cap.unavailable.includes('scrape_batch'), false);
  assert.strictEqual(cap.supported.includes('scrape_batch'), true);
});
