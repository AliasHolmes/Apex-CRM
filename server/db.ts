import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.apex-data');
export const LEADS_DB_PATH = process.env.APEX_DB_PATH
  ? path.resolve(process.env.APEX_DB_PATH)
  : path.join(DEFAULT_DATA_DIR, 'apex-crm.sqlite');

let leadsDb: DatabaseSync | null = null;

export function getLeadsDb() {
  if (!leadsDb) {
    fs.mkdirSync(path.dirname(LEADS_DB_PATH), { recursive: true });
    leadsDb = new DatabaseSync(LEADS_DB_PATH);
    leadsDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_profile_cache (
        username TEXT PRIMARY KEY,
        enriched_data TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        prompt TEXT NOT NULL,
        generated_queries TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        raw_results_count INTEGER,
        leads_found INTEGER,
        detailed_logs TEXT
      );
    `);

    try {
      leadsDb.exec('ALTER TABLE search_logs ADD COLUMN detailed_logs TEXT;');
    } catch (e) {
      // Ignore if column already exists
    }
  }

  return leadsDb;
}

export function normalizeIncomingLeads(input: unknown) {
  if (!Array.isArray(input)) {
    return null;
  }

  return input
    .filter((lead): lead is Record<string, any> => !!lead && typeof lead === 'object')
    .map((lead) => ({
      ...lead,
      id: typeof lead.id === 'string' && lead.id.trim() ? lead.id : crypto.randomUUID(),
      createdAt: typeof lead.createdAt === 'string' && lead.createdAt ? lead.createdAt : new Date().toISOString()
    }));
}

export function readStoredLeads() {
  const rows = getLeadsDb()
    .prepare('SELECT payload FROM leads ORDER BY datetime(COALESCE(created_at, updated_at)) DESC')
    .all() as { payload: string }[];

  return rows
    .map((row) => {
      try {
        return JSON.parse(row.payload);
      } catch (error) {
        console.warn('Skipping unreadable lead record from SQLite:', error);
        return null;
      }
    })
    .filter(Boolean);
}

export function hasLeadStoreBeenInitialized() {
  const row = getLeadsDb()
    .prepare("SELECT value FROM app_meta WHERE key = 'leads_initialized'")
    .get() as { value: string } | undefined;

  return row?.value === 'true';
}

export function replaceStoredLeads(leads: Record<string, any>[]) {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  const insertLead = db.prepare(`
    INSERT INTO leads (id, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM leads').run();

    for (const lead of leads) {
      insertLead.run(
        lead.id,
        JSON.stringify(lead),
        typeof lead.createdAt === 'string' ? lead.createdAt : now,
        now
      );
    }

    db.prepare(`
      INSERT INTO app_meta (key, value, updated_at)
      VALUES ('leads_initialized', 'true', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(now);

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('SQLite rollback failed:', rollbackError);
    }
    throw error;
  }
}

export function insertSearchLog(log: any) {
  try {
    const db = getLeadsDb();
    const insertStmt = db.prepare(`
      INSERT INTO search_logs (id, timestamp, prompt, generated_queries, status, error_message, raw_results_count, leads_found, detailed_logs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(
      log.id,
      log.timestamp,
      log.prompt,
      JSON.stringify(log.generatedQueries || []),
      log.status,
      log.errorMessage || '',
      log.rawResultsCount || 0,
      log.leadsFound || 0,
      log.detailedLogs || ''
    );

    // Keep only last 20
    const cullStmt = db.prepare(`
      DELETE FROM search_logs 
      WHERE id NOT IN (
        SELECT id FROM search_logs 
        ORDER BY timestamp DESC 
        LIMIT 20
      )
    `);
    cullStmt.run();
  } catch (err) {
    console.error('Failed to write search log to DB:', err);
  }
}
