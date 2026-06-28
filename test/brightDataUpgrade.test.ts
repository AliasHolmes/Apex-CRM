import test from 'node:test';
import assert from 'node:assert';
import { verifyDecisionMakerFromEvidence } from '../server/leadSearch/verification.js';
import { findCompanyWebsite } from '../server/leadSearch/companyIntent.js';
import { getNegativeEnrichmentCacheEntry, upsertNegativeEnrichmentCacheEntry } from '../server/db.js';

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