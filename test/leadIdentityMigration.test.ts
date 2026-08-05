import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

test('migration preserves legacy LinkedIn collisions and records their canonical lead', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'apex-identity-migration-'));
  const databasePath = path.join(directory, 'leads.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE leads (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    PRAGMA user_version = 10;
  `);
  const insert = db.prepare('INSERT INTO leads (id, payload, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)');
  const firstCreatedAt = '2026-01-01T00:00:00.000Z';
  const secondCreatedAt = '2026-02-01T00:00:00.000Z';
  insert.run('legacy-first', JSON.stringify({
    id: 'legacy-first', profile: { fullName: 'Legacy First', contactDetails: { linkedinUrl: 'https://linkedin.com/in/legacy-person' } },
  }), firstCreatedAt, firstCreatedAt);
  insert.run('legacy-second', JSON.stringify({
    id: 'legacy-second', profile: { fullName: 'Legacy Second', contactDetails: { linkedinUrl: 'https://www.linkedin.com/in/LEGACY-person/?trk=share' } },
  }), secondCreatedAt, secondCreatedAt);
  db.close();

  try {
    const script = `
      import { getLeadsDb } from './server/db.ts';
      const db = getLeadsDb();
      const identity = db.prepare('SELECT identity_key, lead_id FROM lead_identities').all();
      const conflicts = db.prepare('SELECT identity_key, canonical_lead_id, duplicate_lead_id FROM lead_identity_conflicts').all();
      console.log(JSON.stringify({ identity, conflicts }));
      db.close();
    `;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, APEX_DB_PATH: databasePath },
    });
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1) || '{}');
    assert.deepEqual(result.identity, [{ identity_key: 'linkedin:legacy-person', lead_id: 'legacy-first' }]);
    assert.deepEqual(result.conflicts, [{
      identity_key: 'linkedin:legacy-person',
      canonical_lead_id: 'legacy-first',
      duplicate_lead_id: 'legacy-second',
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
