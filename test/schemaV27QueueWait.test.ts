import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Schema v27 adds llm_stage_logs.queue_wait_ms so slot starvation is separable from
// generation time in latency analysis (docs/adr/0012-*).
describe('Schema v27: llm_stage_logs.queue_wait_ms', () => {
  it('adds the column to a pre-v27 database and preserves existing rows', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'apex-v27-migration-'));
    const dbPath = path.join(tempDir, 'test.sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      // Pre-v27 shape: no queue_wait_ms column.
      db.exec(`
        CREATE TABLE llm_stage_logs (
          id TEXT PRIMARY KEY,
          search_log_id TEXT,
          stage TEXT NOT NULL,
          round INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          model_name TEXT,
          provider TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO llm_stage_logs (id, search_log_id, stage, round, status, latency_ms, created_at)
         VALUES ('l1', 's1', 'extraction', 1, 'success', 4200, '2026-10-09T00:00:00.000Z')`,
      ).run();

      // The migration under test (mirrors server/db.ts runMigrations v27 block).
      const cols = db.prepare("PRAGMA table_info(llm_stage_logs)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "queue_wait_ms")) {
        db.exec(
          "ALTER TABLE llm_stage_logs ADD COLUMN queue_wait_ms INTEGER NOT NULL DEFAULT 0",
        );
      }

      const after = db.prepare("PRAGMA table_info(llm_stage_logs)").all() as Array<{ name: string }>;
      assert.ok(after.some((c) => c.name === "queue_wait_ms"), "column must exist after migration");

      // Existing rows default to 0 and remain readable.
      const row = db.prepare("SELECT * FROM llm_stage_logs WHERE id = 'l1'").get() as any;
      assert.equal(row.queue_wait_ms, 0, "legacy rows must default to 0");
      assert.equal(row.latency_ms, 4200, "legacy latency must be preserved");

      // New writes persist the queue wait.
      db.prepare(
        `INSERT INTO llm_stage_logs (id, search_log_id, stage, round, status, latency_ms, queue_wait_ms, created_at)
         VALUES ('l2', 's1', 'judge', 1, 'success', 9000, 2300, '2026-10-09T00:01:00.000Z')`,
      ).run();
      const row2 = db.prepare("SELECT queue_wait_ms FROM llm_stage_logs WHERE id = 'l2'").get() as any;
      assert.equal(row2.queue_wait_ms, 2300);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
