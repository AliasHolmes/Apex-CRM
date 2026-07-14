import test from 'node:test';
import assert from 'node:assert';
import { verifyDecisionMakerFromEvidence } from '../server/leadSearch/verification.js';
import { findCompanyWebsite } from '../server/leadSearch/companyIntent.js';
import { getNegativeEnrichmentCacheEntry, upsertNegativeEnrichmentCacheEntry } from '../server/db.js';
import { baseMaxRetries, baseTimeoutSeconds, BRIGHTDATA_SCRAPE_BATCH_MAX_URLS, BrightDataError, buildBrightDataSearchArguments, classifyBrightDataError, normalizeBrightDataGeoLocation, normalizeBrightDataUrl } from '../server/services/brightdata.js';

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

test('Bright Data classifies target gateway failures as retryable target transients', () => {
  for (const message of ['HTTP 502 Bad Gateway', 'status 503 Service Unavailable', '504 Gateway Timeout', 'fetch failed', 'Bright Data scrape_as_markdown returned empty body']) {
    const classified = classifyBrightDataError(new Error(message));
    assert.strictEqual(classified.reasonCode, 'target_transient');
    assert.strictEqual(classified.retryable, true);
    assert.strictEqual(classified.providerDisabled, false);
    assert.strictEqual(classified.clearClient, false);
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

test('Bright Data search arguments match the installed MCP search_engine schema', () => {
  assert.strictEqual(normalizeBrightDataGeoLocation('US'), 'us');
  assert.strictEqual(normalizeBrightDataGeoLocation('United States'), '');
  assert.deepStrictEqual(
    buildBrightDataSearchArguments('AI founders', { country: 'US', cursor: 'next-page' }),
    { query: 'AI founders', engine: 'google', cursor: 'next-page', geo_location: 'us' }
  );
});
