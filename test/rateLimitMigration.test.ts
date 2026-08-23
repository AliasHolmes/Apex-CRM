import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scrubRateLimitPollution } from '../server/db.ts';

describe('Rate Limit Migration v15', () => {
  it('scrubs polluted lead payloads and deletes polluted enrichment cache entries idempotently', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'apex-rate-limit-migration-'));
    const dbPath = path.join(tempDir, 'test.sqlite');
    const db = new DatabaseSync(dbPath);

    db.exec(`
      CREATE TABLE leads (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        full_name TEXT,
        company TEXT,
        title TEXT,
        stage TEXT NOT NULL DEFAULT 'NEW',
        review_status TEXT NOT NULL DEFAULT 'UNREVIEWED',
        next_action TEXT NOT NULL DEFAULT 'NONE',
        score REAL,
        email TEXT
      );

      CREATE TABLE enrichment_cache (
        id TEXT PRIMARY KEY,
        normalized_url TEXT,
        linkedin_username TEXT,
        person_name TEXT,
        company_name TEXT,
        public_email TEXT,
        evidence_block TEXT NOT NULL,
        scrape_quality TEXT NOT NULL,
        source_provider TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);

    const insertLead = db.prepare(`
      INSERT INTO leads (id, payload, created_at, updated_at, revision, full_name, company, title)
      VALUES (?, ?, datetime('now'), datetime('now'), 1, ?, ?, ?)
    `);

    const insertCache = db.prepare(`
      INSERT INTO enrichment_cache (id, normalized_url, linkedin_username, person_name, company_name, public_email, evidence_block, scrape_quality, source_provider, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+7 days'))
    `);

    // Polluted Lead 1
    const pollutedPayload1 = JSON.stringify({
      id: 'lead-1',
      fullName: 'Sarah Connor',
      currentTitle: 'Founder',
      currentCompany: 'Skynet Defense',
      headline: 'Your system is sending too many of this type of request. If you need to send more, contact your Account Manager.',
      profile: {
        fullName: 'Sarah Connor',
        headline: 'Your system is sending too many of this type of request. If you need to send more, contact your Account Manager.',
        currentCompany: 'Skynet Defense'
      },
      evidence: {
        evidenceBlock: 'NAME: Sarah Connor\nHEADLINE: Your system is sending too many of this type of request. If you need to send more, contact your Account Manager.'
      }
    });
    insertLead.run('lead-1', pollutedPayload1, 'Sarah Connor', 'Skynet Defense', 'Founder');

    // Polluted Lead 2
    const pollutedPayload2 = JSON.stringify({
      id: 'lead-2',
      fullName: 'John Connor',
      currentTitle: 'CEO',
      currentCompany: 'Resistance Automation',
      summary: 'Experienced leader. Your system is sending too many of this type of request. Contact your account manager.'
    });
    insertLead.run('lead-2', pollutedPayload2, 'John Connor', 'Resistance Automation', 'CEO');

    // Clean Lead 3
    const cleanPayload3 = JSON.stringify({
      id: 'lead-3',
      fullName: 'Kyle Reese',
      currentTitle: 'Head of Operations',
      currentCompany: 'Tech Studio'
    });
    insertLead.run('lead-3', cleanPayload3, 'Kyle Reese', 'Tech Studio', 'Head of Operations');

    // Polluted Cache 1
    insertCache.run('c-1', 'linkedin.com/in/sarah-connor', 'sarah-connor', 'Sarah Connor', 'Skynet Defense', null, 'Your system is sending too many of this type of request. If you need to send more, contact your Account Manager.', 'good', 'brightdata');

    // Polluted Cache 2
    insertCache.run('c-2', 'linkedin.com/in/john-connor', 'john-connor', 'John Connor', 'Resistance', null, 'Rate limit notice: please contact your Account Manager', 'good', 'brightdata');

    // Clean Cache 3
    insertCache.run('c-3', 'linkedin.com/in/kyle-reese', 'kyle-reese', 'Kyle Reese', 'Tech Studio', null, 'NAME: Kyle Reese\nTITLE: Head of Operations\nEXPERIENCE: Tech Studio', 'good', 'brightdata');

    // Run 1: First Migration Scrub
    const run1 = scrubRateLimitPollution(db);
    assert.equal(run1.cacheDeleted, 2);
    assert.equal(run1.leadsScrubbed, 2);

    // Verify cache rows
    const remainingCache = db.prepare('SELECT id FROM enrichment_cache').all() as { id: string }[];
    assert.equal(remainingCache.length, 1);
    assert.equal(remainingCache[0].id, 'c-3');

    // Verify lead payloads cleaned
    const lead1Row = db.prepare('SELECT payload FROM leads WHERE id = ?').get('lead-1') as { payload: string };
    const lead1 = JSON.parse(lead1Row.payload);
    assert.equal(lead1.headline, '');
    assert.equal(lead1.profile.headline, '');
    assert.doesNotMatch(lead1.evidence.evidenceBlock, /your system is sending too many/i);

    const lead2Row = db.prepare('SELECT payload FROM leads WHERE id = ?').get('lead-2') as { payload: string };
    const lead2 = JSON.parse(lead2Row.payload);
    assert.doesNotMatch(lead2.summary, /your system is sending too many/i);

    // Run 2: Idempotency check (no-op)
    const run2 = scrubRateLimitPollution(db);
    assert.equal(run2.cacheDeleted, 0);
    assert.equal(run2.leadsScrubbed, 0);

    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
});
