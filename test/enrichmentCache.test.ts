import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

process.env.APEX_DB_PATH = path.join(os.tmpdir(), `apex-cache-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);

const db = await import('../server/db.ts');

describe('enrichment cache', () => {
  it('returns unexpired cache hits by URL and username', () => {
    const now = new Date('2026-06-25T00:00:00.000Z');
    db.upsertEnrichmentCacheEntry({
      normalizedUrl: 'linkedin.com/in/jane-doe',
      linkedinUsername: 'jane-doe',
      personName: 'Jane Doe',
      companyName: 'Acme Dental Growth',
      evidenceBlock: 'NAME: Jane Doe\nHEADLINE: Founder at Acme Dental Growth',
      scrapeQuality: 'good',
      sourceProvider: 'brightdata'
    }, 7, now);

    const byUrl = db.getEnrichmentCacheEntry({ normalizedUrl: 'linkedin.com/in/jane-doe' }, new Date('2026-06-26T00:00:00.000Z'));
    const byUsername = db.getEnrichmentCacheEntry({ linkedinUsername: 'jane-doe' }, new Date('2026-06-26T00:00:00.000Z'));

    assert.equal(byUrl?.sourceProvider, 'brightdata');
    assert.equal(byUsername?.evidenceBlock.includes('Jane Doe'), true);
  });

  it('uses person and company fallback for URL variants', () => {
    const hit = db.getEnrichmentCacheEntry({ personName: 'Jane Doe', companyName: 'Acme Dental Growth' }, new Date('2026-06-26T00:00:00.000Z'));
    assert.equal(hit?.linkedinUsername, 'jane-doe');
  });

  it('prunes expired cache rows after the TTL', () => {
    const deleted = db.pruneExpiredEnrichmentCache(new Date('2026-07-05T00:00:00.000Z'));
    assert.ok(deleted >= 1);
    const miss = db.getEnrichmentCacheEntry({ linkedinUsername: 'jane-doe' }, new Date('2026-07-05T00:00:00.000Z'));
    assert.equal(miss, null);
  });
});