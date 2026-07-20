import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { clampSearchLogRetentionLimit, setLlmStageLogger, type LlmStageLogEntry } from './leadSearch/telemetry.js';
import { REVIEW_STATUS_SET as REVIEW_STATUSES, NEXT_ACTION_SET as NEXT_ACTIONS } from '../src/types.js';

dotenv.config();

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.apex-data');
const LATEST_SCHEMA_VERSION = 9;
export const LEADS_DB_PATH = process.env.APEX_DB_PATH
  ? path.resolve(process.env.APEX_DB_PATH)
  : path.join(DEFAULT_DATA_DIR, 'apex-crm.sqlite');

let leadsDb: DatabaseSync | null = null;


const isUsableEmail = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

function normalizeStoredLead(lead: Record<string, any>) {
  const profile = lead.profile && typeof lead.profile === 'object' ? { ...lead.profile } : {};
  const contactDetails = profile.contactDetails && typeof profile.contactDetails === 'object'
    ? { ...profile.contactDetails }
    : {};
  const legacyEmail = lead.emailDiscovery?.bestEmail || profile.emailDiscovery?.bestEmail;
  if (!isUsableEmail(contactDetails.email) && isUsableEmail(legacyEmail)) {
    contactDetails.email = legacyEmail.trim().toLowerCase();
  } else if (isUsableEmail(contactDetails.email)) {
    contactDetails.email = contactDetails.email.trim().toLowerCase();
  }

  delete contactDetails.emailStatus;
  delete contactDetails.emailConfidence;
  delete contactDetails.emailSources;
  delete contactDetails.fallbackChannels;
  delete profile.emailDiscovery;

  const normalized: Record<string, any> = {
    ...lead,
    profile: { ...profile, contactDetails },
    reviewStatus: REVIEW_STATUSES.has(lead.reviewStatus) ? lead.reviewStatus : 'UNREVIEWED',
    nextAction: NEXT_ACTIONS.has(lead.nextAction) ? lead.nextAction : 'NONE',
  };
  delete normalized.emailDiscovery;
  return normalized;
}

function getTableColumns(db: DatabaseSync, tableName: string) {
  return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]).map((column) => column.name));
}

function addColumnIfMissing(db: DatabaseSync, tableName: string, columnName: string, definition: string) {
  if (!getTableColumns(db, tableName).has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function backupDatabaseBeforeMigration(previousVersion: number) {
  if (previousVersion >= LATEST_SCHEMA_VERSION || !fs.existsSync(LEADS_DB_PATH)) return;

  const stats = fs.statSync(LEADS_DB_PATH);
  if (stats.size === 0) return;

  const backupDir = path.join(path.dirname(LEADS_DB_PATH), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `apex-crm.pre-migration-v${previousVersion}.${timestamp}.sqlite`);

  // Use VACUUM INTO instead of fs.copyFileSync. When SQLite is in WAL mode,
  // a raw file copy may miss pages that are in the .wal sidecar but not yet
  // checkpointed into the main file, producing a corrupt backup. VACUUM INTO
  // always produces a complete, self-contained snapshot regardless of WAL state.
  try {
    const srcDb = new DatabaseSync(LEADS_DB_PATH, { open: true });
    srcDb.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    srcDb.close();
    console.log(`WAL-safe database backup created before migration: ${backupPath}`);
  } catch (vacuumError) {
    // Fallback to raw copy if VACUUM INTO is unavailable (very old Node.js versions).
    console.warn('VACUUM INTO failed, falling back to file copy for backup:', vacuumError);
    fs.copyFileSync(LEADS_DB_PATH, backupPath);
    console.log(`(Fallback) Database backup created before migration: ${backupPath}`);
  }
}

function runMigrations(db: DatabaseSync) {
  const currentVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version || 0);
  if (currentVersion >= LATEST_SCHEMA_VERSION) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (currentVersion < 1) {
      db.exec(`
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

        CREATE TABLE IF NOT EXISTS enrichment_cache (
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
        CREATE INDEX IF NOT EXISTS idx_enrichment_cache_url ON enrichment_cache(normalized_url);
        CREATE INDEX IF NOT EXISTS idx_enrichment_cache_username ON enrichment_cache(linkedin_username);
        CREATE INDEX IF NOT EXISTS idx_enrichment_cache_person_company ON enrichment_cache(person_name, company_name);
        CREATE INDEX IF NOT EXISTS idx_enrichment_cache_expires ON enrichment_cache(expires_at);

        CREATE TABLE IF NOT EXISTS search_logs (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          prompt TEXT NOT NULL,
          generated_queries TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          raw_results_count INTEGER,
          leads_found INTEGER,
          detailed_logs TEXT,
          debug_logs TEXT,
          trace_events TEXT,
          provider_summary TEXT,
          cost_summary TEXT,
          phase_timeline TEXT,
          schema_version INTEGER
        );
      `);
    }

    if (currentVersion < 2) {
      addColumnIfMissing(db, 'search_logs', 'detailed_logs', 'detailed_logs TEXT');
      addColumnIfMissing(db, 'search_logs', 'debug_logs', 'debug_logs TEXT');
      addColumnIfMissing(db, 'search_logs', 'trace_events', 'trace_events TEXT');
      addColumnIfMissing(db, 'search_logs', 'provider_summary', 'provider_summary TEXT');
      addColumnIfMissing(db, 'search_logs', 'cost_summary', 'cost_summary TEXT');
      addColumnIfMissing(db, 'search_logs', 'phase_timeline', 'phase_timeline TEXT');
      addColumnIfMissing(db, 'search_logs', 'schema_version', 'schema_version INTEGER');
      db.exec(`
        INSERT OR IGNORE INTO enrichment_cache (
          id, normalized_url, linkedin_username, person_name, company_name,
          evidence_block, scrape_quality, source_provider, created_at, expires_at
        )
        SELECT
          'legacy-mcp-' || username, NULL, lower(username), NULL, NULL,
          enriched_data, 'partial', 'brightdata', timestamp, datetime(timestamp, '+7 days')
        FROM mcp_profile_cache
        WHERE username IS NOT NULL AND enriched_data IS NOT NULL;
      `);
    }

    if (currentVersion < 3) {
      addColumnIfMissing(db, 'leads', 'revision', 'revision INTEGER NOT NULL DEFAULT 1');
      db.exec(`
        CREATE TABLE IF NOT EXISTS mining_sessions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          prompt TEXT NOT NULL,
          requested_limit INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          cancellation_requested_at TEXT,
          error_message TEXT,
          stats_json TEXT,
          trace_summary_json TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_mining_sessions_updated_at ON mining_sessions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mining_sessions_status ON mining_sessions(status);

        UPDATE mining_sessions
        SET status = 'interrupted',
            error_message = COALESCE(error_message, 'The local process stopped before this mining session completed.'),
            completed_at = COALESCE(completed_at, updated_at),
            updated_at = datetime('now')
        WHERE status IN ('running', 'cancellation_requested');
      `);
    }

    if (currentVersion < 4) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lead_activities (
          id         TEXT    PRIMARY KEY,
          lead_id    TEXT    NOT NULL,
          type       TEXT    NOT NULL,
          from_value TEXT,
          to_value   TEXT    NOT NULL,
          actor      TEXT    NOT NULL DEFAULT 'user',
          created_at TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id
          ON lead_activities(lead_id);
        CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at
          ON lead_activities(created_at DESC);

        CREATE TABLE IF NOT EXISTS outreach_drafts (
          id            TEXT    PRIMARY KEY,
          lead_id       TEXT    NOT NULL,
          lead_name     TEXT    NOT NULL,
          company_name  TEXT,
          tone          TEXT    NOT NULL,
          medium        TEXT    NOT NULL,
          sequence_step TEXT    NOT NULL,
          word_count    INTEGER NOT NULL DEFAULT 0,
          body          TEXT    NOT NULL,
          created_at    TEXT    NOT NULL,
          updated_at    TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_outreach_drafts_lead_id
          ON outreach_drafts(lead_id);
        CREATE INDEX IF NOT EXISTS idx_outreach_drafts_created_at
          ON outreach_drafts(created_at DESC);
      `);
    }

    if (currentVersion < 5) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS saved_searches (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          query TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          mode TEXT NOT NULL,
          max_per_company INTEGER NOT NULL DEFAULT 2,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_run_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_saved_searches_updated_at
          ON saved_searches(updated_at DESC);

        CREATE TABLE IF NOT EXISTS query_performance (
          scope_key TEXT PRIMARY KEY,
          family TEXT NOT NULL,
          lane TEXT NOT NULL,
          provider TEXT NOT NULL,
          runs INTEGER NOT NULL DEFAULT 0,
          raw_candidates INTEGER NOT NULL DEFAULT 0,
          unique_candidates INTEGER NOT NULL DEFAULT 0,
          extracted_candidates INTEGER NOT NULL DEFAULT 0,
          accepted_candidates INTEGER NOT NULL DEFAULT 0,
          duplicate_candidates INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_query_performance_updated_at
          ON query_performance(updated_at DESC);

        CREATE TABLE IF NOT EXISTS provider_usage (
          provider TEXT NOT NULL,
          period TEXT NOT NULL,
          units INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(provider, period)
        );
      `);
    }

    if (currentVersion < 6) {
      addColumnIfMissing(db, 'enrichment_cache', 'public_email', 'public_email TEXT');
      const rows = db.prepare('SELECT id, payload FROM leads').all() as { id: string; payload: string }[];
      const updatePayload = db.prepare('UPDATE leads SET payload = ? WHERE id = ?');
      for (const row of rows) {
        try {
          updatePayload.run(JSON.stringify(normalizeStoredLead(JSON.parse(row.payload))), row.id);
        } catch (error) {
          console.warn(`Skipping legacy lead cleanup for ${row.id}:`, error);
        }
      }
      db.exec('DROP TABLE IF EXISTS email_discovery_cache');
    }

    if (currentVersion < 7) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS llm_stage_logs (
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
        CREATE INDEX IF NOT EXISTS idx_llm_stage_logs_search
          ON llm_stage_logs(search_log_id);
        CREATE INDEX IF NOT EXISTS idx_llm_stage_logs_stage
          ON llm_stage_logs(stage);
      `);
    }

    if (currentVersion < 8) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prospect_contract_cache (
          cache_key TEXT PRIMARY KEY,
          raw_brief TEXT NOT NULL,
          policy_version TEXT NOT NULL,
          contract_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_prospect_contract_cache_expires
          ON prospect_contract_cache(expires_at);
      `);
    }

    if (currentVersion < 9) {
      addColumnIfMissing(db, 'query_performance', 'outcome_runs', 'outcome_runs INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'query_performance', 'qualified_candidates', 'qualified_candidates INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'query_performance', 'rescued_candidates', 'rescued_candidates INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'query_performance', 'returned_candidates', 'returned_candidates INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'query_performance', 'search_latency_ms', 'search_latency_ms INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'query_performance', 'provider_units', 'provider_units INTEGER NOT NULL DEFAULT 0');
    }

    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('SQLite migration rollback failed:', rollbackError);
    }
    throw error;
  }
}

export type EnrichmentCacheQuality = 'good' | 'partial' | 'bad';

export type EnrichmentCacheEntry = {
  id?: string;
  normalizedUrl?: string;
  linkedinUsername?: string;
  personName?: string;
  companyName?: string;
  publicEmail?: string;
  evidenceBlock: string;
  scrapeQuality: EnrichmentCacheQuality;
  sourceProvider: 'brightdata' | 'tavily';
  createdAt?: string;
  expiresAt?: string;
};

export type EnrichmentCacheLookup = {
  normalizedUrl?: string;
  linkedinUsername?: string;
  personName?: string;
  companyName?: string;
};

export function getLeadsDb() {
  if (!leadsDb) {
    fs.mkdirSync(path.dirname(LEADS_DB_PATH), { recursive: true });
    leadsDb = new DatabaseSync(LEADS_DB_PATH);
    const currentVersion = Number((leadsDb.prepare('PRAGMA user_version').get() as { user_version?: number }).user_version || 0);
    backupDatabaseBeforeMigration(currentVersion);
    leadsDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 10000;
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

      CREATE TABLE IF NOT EXISTS enrichment_cache (
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

      CREATE INDEX IF NOT EXISTS idx_enrichment_cache_url ON enrichment_cache(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_enrichment_cache_username ON enrichment_cache(linkedin_username);
      CREATE INDEX IF NOT EXISTS idx_enrichment_cache_person_company ON enrichment_cache(person_name, company_name);
      CREATE INDEX IF NOT EXISTS idx_enrichment_cache_expires ON enrichment_cache(expires_at);

      INSERT OR IGNORE INTO enrichment_cache (
        id,
        normalized_url,
        linkedin_username,
        person_name,
        company_name,
        evidence_block,
        scrape_quality,
        source_provider,
        created_at,
        expires_at
      )
      SELECT
        'legacy-mcp-' || username,
        NULL,
        lower(username),
        NULL,
        NULL,
        enriched_data,
        'partial',
        'brightdata',
        timestamp,
        datetime(timestamp, '+7 days')
      FROM mcp_profile_cache
      WHERE username IS NOT NULL AND enriched_data IS NOT NULL;

      CREATE TABLE IF NOT EXISTS search_logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        prompt TEXT NOT NULL,
        generated_queries TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        raw_results_count INTEGER,
        leads_found INTEGER,
        detailed_logs TEXT,
        debug_logs TEXT,
        trace_events TEXT,
        provider_summary TEXT,
        cost_summary TEXT,
        phase_timeline TEXT,
        schema_version INTEGER
      );

      CREATE TABLE IF NOT EXISTS llm_stage_logs (
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
      CREATE INDEX IF NOT EXISTS idx_llm_stage_logs_search
        ON llm_stage_logs(search_log_id);
      CREATE INDEX IF NOT EXISTS idx_llm_stage_logs_stage
        ON llm_stage_logs(stage);

      CREATE TABLE IF NOT EXISTS icp_hypothesis_cache (
        query_hash TEXT PRIMARY KEY,
        raw_query TEXT NOT NULL,
        hypothesis_json TEXT NOT NULL,
        synthesized_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_icp_hypothesis_expires
        ON icp_hypothesis_cache(expires_at);

      CREATE TABLE IF NOT EXISTS prospect_contract_cache (
        cache_key TEXT PRIMARY KEY,
        raw_brief TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prospect_contract_cache_expires
        ON prospect_contract_cache(expires_at);
    `);
    runMigrations(leadsDb);
  }

  setLlmStageLogger(insertLlmStageLog);
  return leadsDb;
}

export function normalizeIncomingLeads(input: unknown) {
  if (!Array.isArray(input)) {
    return null;
  }

  return input
    .filter((lead): lead is Record<string, any> => !!lead && typeof lead === 'object')
    .map((lead) => normalizeStoredLead({
      ...lead,
      id: typeof lead.id === 'string' && lead.id.trim() ? lead.id : crypto.randomUUID(),
      createdAt: typeof lead.createdAt === 'string' && lead.createdAt ? lead.createdAt : new Date().toISOString()
    }));
}

export function readStoredLeads() {
  const rows = getLeadsDb()
    .prepare('SELECT payload, revision FROM leads ORDER BY datetime(COALESCE(created_at, updated_at)) DESC')
    .all() as { payload: string; revision: number }[];

  return rows
    .map((row) => {
      try {
        return { ...normalizeStoredLead(JSON.parse(row.payload)), revision: Number(row.revision || 1) };
      } catch (error) {
        console.warn('Skipping unreadable lead record from SQLite:', error);
        return null;
      }
    })
    .filter(Boolean);
}

export function readStoredLeadById(id: string) {
  const row = getLeadsDb()
    .prepare('SELECT payload, revision FROM leads WHERE id = ?')
    .get(id) as { payload: string; revision: number } | undefined;

  if (!row) return null;
  try {
    return { ...normalizeStoredLead(JSON.parse(row.payload)), revision: Number(row.revision || 1) } as Record<string, any>;
  } catch (error) {
    console.warn(`Skipping unreadable lead ${id} from SQLite:`, error);
    return null;
  }
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
    INSERT INTO leads (id, payload, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM leads').run();

    for (const lead of leads) {
      const revision = Number.isInteger(lead.revision) && lead.revision > 0 ? lead.revision : 1;
      const storedLead: Record<string, any> = { ...normalizeStoredLead(lead), revision };
      insertLead.run(
        storedLead.id,
        JSON.stringify(storedLead),
        typeof storedLead.createdAt === 'string' ? storedLead.createdAt : now,
        now,
        revision
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

export class LeadRevisionConflictError extends Error {
  constructor(public readonly currentLead: Record<string, any>) {
    super('This lead was changed by a newer request. Reload it before saving again.');
    this.name = 'LeadRevisionConflictError';
  }
}

export class LeadNotFoundError extends Error {
  constructor(public readonly leadId: string) {
    super('This lead was removed before the update completed.');
    this.name = 'LeadNotFoundError';
  }
}

export function upsertLead(
  lead: Record<string, any>,
  options: { requireExisting?: boolean } = {},
) {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT payload, revision FROM leads WHERE id = ?').get(lead.id) as { payload: string; revision: number } | undefined;
  if (!existing && options.requireExisting) {
    throw new LeadNotFoundError(String(lead.id || ''));
  }
  const expectedRevision = Number.isInteger(lead.revision) ? Number(lead.revision) : undefined;
  if (existing && expectedRevision !== undefined && expectedRevision !== Number(existing.revision || 1)) {
    let currentLead: Record<string, any> = { ...lead, revision: Number(existing.revision || 1) };
    try {
      currentLead = { ...JSON.parse(existing.payload), revision: Number(existing.revision || 1) };
    } catch {
      // Preserve a useful conflict payload even when a legacy payload is malformed.
    }
    throw new LeadRevisionConflictError(currentLead);
  }
  const revision = existing ? Number(existing.revision || 1) + 1 : 1;
  const storedLead: Record<string, any> = { ...normalizeStoredLead(lead), revision };
  const stmt = db.prepare(`
    INSERT INTO leads (id, payload, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      revision = excluded.revision
  `);

  stmt.run(
    storedLead.id,
    JSON.stringify(storedLead),
    typeof storedLead.createdAt === 'string' ? storedLead.createdAt : now,
    now,
    revision
  );

  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES ('leads_initialized', 'true', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(now);
  return storedLead;
}

export function deleteLead(id: string) {
  const db = getLeadsDb();
  db.prepare('DELETE FROM leads WHERE id = ?').run(id);
}

export function upsertLeads(
  leads: Record<string, any>[],
  options: { requireExisting?: boolean } = {},
) {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO leads (id, payload, created_at, updated_at, revision)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      revision = excluded.revision
  `);
  const selectExisting = db.prepare('SELECT payload, revision FROM leads WHERE id = ?');
  const storedLeads: Record<string, any>[] = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const lead of leads) {
      const existing = selectExisting.get(lead.id) as { payload: string; revision: number } | undefined;
      if (!existing && options.requireExisting) {
        throw new LeadNotFoundError(String(lead.id || ''));
      }
      const expectedRevision = Number.isInteger(lead.revision) ? Number(lead.revision) : undefined;
      if (existing && expectedRevision !== undefined && expectedRevision !== Number(existing.revision || 1)) {
        let currentLead: Record<string, any> = { ...lead, revision: Number(existing.revision || 1) };
        try {
          currentLead = { ...JSON.parse(existing.payload), revision: Number(existing.revision || 1) };
        } catch {
          // The caller still receives a conflict response for legacy malformed data.
        }
        throw new LeadRevisionConflictError(currentLead);
      }
      const revision = existing ? Number(existing.revision || 1) + 1 : 1;
      const storedLead: Record<string, any> = { ...normalizeStoredLead(lead), revision };
      stmt.run(
        storedLead.id,
        JSON.stringify(storedLead),
        typeof storedLead.createdAt === 'string' ? storedLead.createdAt : now,
        now,
        revision
      );
      storedLeads.push(storedLead);
    }

    db.prepare(`
      INSERT INTO app_meta (key, value, updated_at)
      VALUES ('leads_initialized', 'true', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(now);

    db.exec('COMMIT');
    return storedLeads;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      console.error('SQLite rollback failed:', rollbackError);
    }
    throw error;
  }
}


const normalizeCacheValue = (value?: string) => (value || '').trim().toLowerCase();

const toCacheRow = (row: any): EnrichmentCacheEntry | null => {
  if (!row) return null;
  return {
    id: row.id,
    normalizedUrl: row.normalized_url || undefined,
    linkedinUsername: row.linkedin_username || undefined,
    personName: row.person_name || undefined,
    companyName: row.company_name || undefined,
    publicEmail: row.public_email || undefined,
    evidenceBlock: row.evidence_block,
    scrapeQuality: row.scrape_quality,
    sourceProvider: row.source_provider,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
};

export function pruneExpiredEnrichmentCache(now = new Date()) {
  const db = getLeadsDb();
  const cutoff = now.toISOString();
  const result = db.prepare('DELETE FROM enrichment_cache WHERE datetime(expires_at) <= datetime(?)').run(cutoff);
  return Number(result.changes || 0);
}

export function getEnrichmentCacheEntry(lookup: EnrichmentCacheLookup, now = new Date()) {
  const db = getLeadsDb();
  const cutoff = now.toISOString();
  const normalizedUrl = normalizeCacheValue(lookup.normalizedUrl);
  const linkedinUsername = normalizeCacheValue(lookup.linkedinUsername);
  const personName = normalizeCacheValue(lookup.personName);
  const companyName = normalizeCacheValue(lookup.companyName);

  if (normalizedUrl || linkedinUsername) {
    const row = db.prepare(`
      SELECT * FROM enrichment_cache
      WHERE datetime(expires_at) > datetime(?)
        AND scrape_quality IN ('good', 'partial')
        AND (
          (? != '' AND normalized_url = ?)
          OR (? != '' AND linkedin_username = ?)
        )
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(cutoff, normalizedUrl, normalizedUrl, linkedinUsername, linkedinUsername);
    const match = toCacheRow(row);
    if (match) return match;
  }

  if (personName && companyName) {
    const row = db.prepare(`
      SELECT * FROM enrichment_cache
      WHERE datetime(expires_at) > datetime(?)
        AND scrape_quality IN ('good', 'partial')
        AND person_name = ?
        AND company_name = ?
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(cutoff, personName, companyName);
    return toCacheRow(row);
  }

  return null;
}

export function upsertEnrichmentCacheEntry(entry: EnrichmentCacheEntry, ttlDays = 7, now = new Date()) {
  if (!entry.evidenceBlock) return null;

  const db = getLeadsDb();
  const createdAt = entry.createdAt || now.toISOString();
  const expiresAt = entry.expiresAt || new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const normalizedUrl = normalizeCacheValue(entry.normalizedUrl);
  const linkedinUsername = normalizeCacheValue(entry.linkedinUsername);
  const personName = normalizeCacheValue(entry.personName);
  const companyName = normalizeCacheValue(entry.companyName);
  const id = entry.id || crypto.createHash('sha256')
    .update([normalizedUrl, linkedinUsername, personName, companyName].filter(Boolean).join('|') || crypto.randomUUID())
    .digest('hex');

  db.prepare(`
    INSERT INTO enrichment_cache (
      id,
      normalized_url,
      linkedin_username,
      person_name,
      company_name,
      public_email,
      evidence_block,
      scrape_quality,
      source_provider,
      created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      normalized_url = excluded.normalized_url,
      linkedin_username = excluded.linkedin_username,
      person_name = excluded.person_name,
      company_name = excluded.company_name,
      public_email = excluded.public_email,
      evidence_block = excluded.evidence_block,
      scrape_quality = excluded.scrape_quality,
      source_provider = excluded.source_provider,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).run(
    id,
    normalizedUrl || null,
    linkedinUsername || null,
    personName || null,
    companyName || null,
    isUsableEmail(entry.publicEmail) ? entry.publicEmail.trim().toLowerCase() : null,
    entry.evidenceBlock,
    entry.scrapeQuality,
    entry.sourceProvider,
    createdAt,
    expiresAt
  );

  pruneExpiredEnrichmentCache(now);
  return { ...entry, id, createdAt, expiresAt };
}

export function getNegativeEnrichmentCacheEntry(lookup: EnrichmentCacheLookup, now = new Date()) {
  const db = getLeadsDb();
  const cutoff = now.toISOString();
  const normalizedUrl = normalizeCacheValue(lookup.normalizedUrl);
  const linkedinUsername = normalizeCacheValue(lookup.linkedinUsername);

  if (normalizedUrl || linkedinUsername) {
    const row = db.prepare(`
      SELECT * FROM enrichment_cache
      WHERE datetime(expires_at) > datetime(?)
        AND scrape_quality = 'bad'
        AND source_provider = 'brightdata'
        AND (
          (? != '' AND normalized_url = ?)
          OR (? != '' AND linkedin_username = ?)
        )
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(cutoff, normalizedUrl, normalizedUrl, linkedinUsername, linkedinUsername);
    const match = toCacheRow(row);
    if (match) return match;
  }

  return null;
}

export function upsertNegativeEnrichmentCacheEntry(entry: EnrichmentCacheEntry, ttlHours = 24, now = new Date()) {
  return upsertEnrichmentCacheEntry({
    ...entry,
    scrapeQuality: 'bad',
    sourceProvider: 'brightdata'
  }, ttlHours / 24, now);
}

export function insertSearchLog(log: any) {
  try {
    const db = getLeadsDb();
    const insertStmt = db.prepare(`
      INSERT INTO search_logs (
        id,
        timestamp,
        prompt,
        generated_queries,
        status,
        error_message,
        raw_results_count,
        leads_found,
        detailed_logs,
        debug_logs,
        trace_events,
        provider_summary,
        cost_summary,
        phase_timeline,
        schema_version
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        timestamp = excluded.timestamp,
        prompt = excluded.prompt,
        generated_queries = excluded.generated_queries,
        status = excluded.status,
        error_message = excluded.error_message,
        raw_results_count = excluded.raw_results_count,
        leads_found = excluded.leads_found,
        detailed_logs = excluded.detailed_logs,
        debug_logs = excluded.debug_logs,
        trace_events = excluded.trace_events,
        provider_summary = excluded.provider_summary,
        cost_summary = excluded.cost_summary,
        phase_timeline = excluded.phase_timeline,
        schema_version = excluded.schema_version
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
      log.detailedLogs || '',
      log.debugLogs || '',
      JSON.stringify(log.traceEvents || []),
      JSON.stringify(log.providerSummary || {}),
      JSON.stringify(log.costSummary || {}),
      JSON.stringify(log.phaseTimeline || []),
      Number(log.schemaVersion || 1)
    );

    const retentionLimit = clampSearchLogRetentionLimit();
    const cullStmt = db.prepare(`
      DELETE FROM search_logs
      WHERE id NOT IN (
        SELECT id FROM search_logs
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `);
    cullStmt.run(retentionLimit);
  } catch (err) {
    console.error('Failed to write search log to DB:', err);
  }
}

const parseJSONField = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const toSearchLogRecord = (row: any) => ({
  id: row.id,
  timestamp: row.timestamp,
  prompt: row.prompt,
  generatedQueries: parseJSONField<string[]>(row.generated_queries, []),
  status: row.status,
  errorMessage: row.error_message,
  rawResultsCount: Number(row.raw_results_count || 0),
  leadsFound: Number(row.leads_found || 0),
  detailedLogs: row.detailed_logs || '',
  debugLogs: row.debug_logs || '',
  traceEvents: parseJSONField<any[]>(row.trace_events, []),
  providerSummary: parseJSONField<Record<string, any>>(row.provider_summary, {}),
  costSummary: parseJSONField<Record<string, any>>(row.cost_summary, {}),
  phaseTimeline: parseJSONField<any[]>(row.phase_timeline, []),
  schemaVersion: Number(row.schema_version || 1)
});

export function readSearchLogs() {
  const rows = getLeadsDb()
    .prepare('SELECT * FROM search_logs ORDER BY timestamp DESC')
    .all() as any[];
  return rows.map(toSearchLogRecord);
}

export function readSearchLogById(id: string) {
  const row = getLeadsDb()
    .prepare('SELECT * FROM search_logs WHERE id = ?')
    .get(id) as any | undefined;
  return row ? toSearchLogRecord(row) : null;
}

export function insertLlmStageLog(entry: LlmStageLogEntry) {
  try {
    const db = getLeadsDb();
    const insertStmt = db.prepare(`
      INSERT INTO llm_stage_logs (
        id, search_log_id, stage, round, status,
        input_tokens, output_tokens, latency_ms, model_name, provider, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(
      crypto.randomUUID(),
      entry.searchLogId || null,
      entry.stage || 'unknown',
      Number(entry.round || 1),
      entry.status || 'unknown',
      Number(entry.inputTokens || 0),
      Number(entry.outputTokens || 0),
      Number(entry.latencyMs || 0),
      entry.modelName || null,
      entry.provider || 'llm',
      entry.createdAt || new Date().toISOString()
    );
  } catch (error) {
    console.warn('Failed to insert llm_stage_log:', error);
  }
}

export function readLlmStageLogs(searchLogId?: string): LlmStageLogEntry[] {
  const db = getLeadsDb();
  if (searchLogId) {
    const rows = db.prepare('SELECT * FROM llm_stage_logs WHERE search_log_id = ? ORDER BY created_at ASC').all(searchLogId) as any[];
    return rows.map(mapLlmStageLogRow);
  }
  const rows = db.prepare('SELECT * FROM llm_stage_logs ORDER BY created_at DESC LIMIT 500').all() as any[];
  return rows.map(mapLlmStageLogRow);
}

function mapLlmStageLogRow(row: any): LlmStageLogEntry {
  return {
    searchLogId: row.search_log_id || undefined,
    stage: row.stage,
    round: Number(row.round || 1),
    status: row.status,
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    latencyMs: Number(row.latency_ms || 0),
    modelName: row.model_name || undefined,
    provider: row.provider || undefined,
    createdAt: row.created_at
  };
}

export function getIcpHypothesisCache(query: string): any | null {
  try {
    const db = getLeadsDb();
    const queryHash = crypto.createHash('sha256').update(query.trim().toLowerCase()).digest('hex');
    const now = new Date().toISOString();
    const row = db.prepare('SELECT hypothesis_json FROM icp_hypothesis_cache WHERE query_hash = ? AND expires_at > ?').get(queryHash, now) as any | undefined;
    if (!row) return null;
    return JSON.parse(row.hypothesis_json);
  } catch (err) {
    return null;
  }
}

export function upsertIcpHypothesisCache(query: string, hypothesis: any, ttlDays = 7) {
  try {
    const db = getLeadsDb();
    const queryHash = crypto.createHash('sha256').update(query.trim().toLowerCase()).digest('hex');
    const now = new Date();
    const expires = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO icp_hypothesis_cache (query_hash, raw_query, hypothesis_json, synthesized_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(query_hash) DO UPDATE SET
        raw_query = excluded.raw_query,
        hypothesis_json = excluded.hypothesis_json,
        synthesized_at = excluded.synthesized_at,
        expires_at = excluded.expires_at
    `).run(
      queryHash,
      query.trim(),
      JSON.stringify(hypothesis),
      now.toISOString(),
      expires
    );
  } catch (err) {
    console.warn('Failed to cache ICP hypothesis:', err);
  }
}

export function getProspectContractCache(cacheKey: string, policyVersion: string): any | null {
  try {
    const db = getLeadsDb();
    const row = db.prepare(`
      SELECT contract_json FROM prospect_contract_cache
      WHERE cache_key = ? AND policy_version = ? AND expires_at > ?
    `).get(cacheKey, policyVersion, new Date().toISOString()) as { contract_json?: string } | undefined;
    return row?.contract_json ? JSON.parse(row.contract_json) : null;
  } catch (error) {
    return null;
  }
}

export function upsertProspectContractCache(cacheKey: string, rawBrief: string, policyVersion: string, contract: any, ttlDays = 7) {
  try {
    const db = getLeadsDb();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + Math.min(Math.max(ttlDays, 1), 30) * 24 * 60 * 60 * 1000);
    db.prepare(`
      INSERT INTO prospect_contract_cache (cache_key, raw_brief, policy_version, contract_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        raw_brief = excluded.raw_brief,
        policy_version = excluded.policy_version,
        contract_json = excluded.contract_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(cacheKey, rawBrief.slice(0, 2000), policyVersion, JSON.stringify(contract), createdAt.toISOString(), expiresAt.toISOString());
  } catch (error) {
    console.warn('[db] Failed to cache prospect contract:', error);
  }
}

export type SavedSearchRecord = {
  id: string;
  name: string;
  query: string;
  spec: Record<string, unknown>;
  mode: string;
  maxPerCompany: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
};

const toSavedSearchRecord = (row: any): SavedSearchRecord => ({
  id: row.id,
  name: row.name,
  query: row.query,
  spec: parseJSONField<Record<string, unknown>>(row.spec_json, {}),
  mode: row.mode,
  maxPerCompany: Math.max(1, Number(row.max_per_company || 2)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastRunAt: row.last_run_at || undefined
});

export function readSavedSearches(limit = 50) {
  const rows = getLeadsDb().prepare(`
    SELECT * FROM saved_searches ORDER BY datetime(updated_at) DESC LIMIT ?
  `).all(Math.min(Math.max(Math.floor(limit) || 50, 1), 100)) as any[];
  return rows.map(toSavedSearchRecord);
}

export function readSavedSearchById(id: string) {
  const row = getLeadsDb().prepare('SELECT * FROM saved_searches WHERE id = ?').get(id) as any | undefined;
  return row ? toSavedSearchRecord(row) : null;
}

export function upsertSavedSearch(input: Omit<SavedSearchRecord, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt'> & { id?: string }) {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  const existing = input.id ? readSavedSearchById(input.id) : null;
  const record: SavedSearchRecord = {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || '').trim().slice(0, 120),
    query: String(input.query || '').trim().slice(0, 1000),
    spec: input.spec && typeof input.spec === 'object' ? input.spec : {},
    mode: String(input.mode || 'person_first').trim().slice(0, 40),
    maxPerCompany: Math.min(Math.max(Math.floor(Number(input.maxPerCompany) || 2), 1), 10),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt
  };
  if (!record.name || !record.query) throw new Error('A saved search needs a name and a query.');

  db.prepare(`
    INSERT INTO saved_searches (
      id, name, query, spec_json, mode, max_per_company, created_at, updated_at, last_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      query = excluded.query,
      spec_json = excluded.spec_json,
      mode = excluded.mode,
      max_per_company = excluded.max_per_company,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.name,
    record.query,
    JSON.stringify(record.spec),
    record.mode,
    record.maxPerCompany,
    record.createdAt,
    record.updatedAt,
    record.lastRunAt || null
  );
  return record;
}

export function deleteSavedSearch(id: string) {
  return Number(getLeadsDb().prepare('DELETE FROM saved_searches WHERE id = ?').run(id).changes || 0);
}

export function markSavedSearchRun(id: string, now = new Date().toISOString()) {
  getLeadsDb().prepare(`
    UPDATE saved_searches SET last_run_at = ?, updated_at = ? WHERE id = ?
  `).run(now, now, id);
}

export type QueryPerformanceUpdate = {
  family: string;
  lane: string;
  provider: string;
  runs?: number;
  outcomeRuns?: number;
  rawCandidates?: number;
  uniqueCandidates?: number;
  extractedCandidates?: number;
  acceptedCandidates?: number;
  duplicateCandidates?: number;
  qualifiedCandidates?: number;
  rescuedCandidates?: number;
  returnedCandidates?: number;
  searchLatencyMs?: number;
  providerUnits?: number;
};

export function recordQueryPerformance(update: QueryPerformanceUpdate) {
  const family = String(update.family || 'general').slice(0, 80);
  const lane = String(update.lane || 'person').slice(0, 80);
  const provider = String(update.provider || 'tavily').slice(0, 80);
  const scopeKey = [family, lane, provider].join('|').toLowerCase();
  getLeadsDb().prepare(`
    INSERT INTO query_performance (
      scope_key, family, lane, provider, runs, raw_candidates, unique_candidates,
      extracted_candidates, accepted_candidates, duplicate_candidates, outcome_runs,
      qualified_candidates, rescued_candidates, returned_candidates, search_latency_ms,
      provider_units, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      runs = query_performance.runs + excluded.runs,
      raw_candidates = query_performance.raw_candidates + excluded.raw_candidates,
      unique_candidates = query_performance.unique_candidates + excluded.unique_candidates,
      extracted_candidates = query_performance.extracted_candidates + excluded.extracted_candidates,
      accepted_candidates = query_performance.accepted_candidates + excluded.accepted_candidates,
      duplicate_candidates = query_performance.duplicate_candidates + excluded.duplicate_candidates,
      outcome_runs = query_performance.outcome_runs + excluded.outcome_runs,
      qualified_candidates = query_performance.qualified_candidates + excluded.qualified_candidates,
      rescued_candidates = query_performance.rescued_candidates + excluded.rescued_candidates,
      returned_candidates = query_performance.returned_candidates + excluded.returned_candidates,
      search_latency_ms = query_performance.search_latency_ms + excluded.search_latency_ms,
      provider_units = query_performance.provider_units + excluded.provider_units,
      updated_at = excluded.updated_at
  `).run(
    scopeKey,
    family,
    lane,
    provider,
    Math.max(0, Math.floor(update.runs ?? 1)),
    Math.max(0, Math.floor(update.rawCandidates || 0)),
    Math.max(0, Math.floor(update.uniqueCandidates || 0)),
    Math.max(0, Math.floor(update.extractedCandidates || 0)),
    Math.max(0, Math.floor(update.acceptedCandidates || 0)),
    Math.max(0, Math.floor(update.duplicateCandidates || 0)),
    Math.max(0, Math.floor(update.outcomeRuns || 0)),
    Math.max(0, Math.floor(update.qualifiedCandidates || 0)),
    Math.max(0, Math.floor(update.rescuedCandidates || 0)),
    Math.max(0, Math.floor(update.returnedCandidates || 0)),
    Math.max(0, Math.floor(update.searchLatencyMs || 0)),
    Math.max(0, Math.floor(update.providerUnits || 0)),
    new Date().toISOString()
  );
}

export function readQueryPerformance(limit = 100) {
  return getLeadsDb().prepare(`
    SELECT * FROM query_performance ORDER BY datetime(updated_at) DESC LIMIT ?
  `).all(Math.min(Math.max(Math.floor(limit) || 100, 1), 500)) as any[];
}

const usagePeriod = (date = new Date()) => date.toISOString().slice(0, 7);

export function readProviderUsage(provider?: string, period = usagePeriod()) {
  const db = getLeadsDb();
  if (provider) {
    const row = db.prepare('SELECT * FROM provider_usage WHERE provider = ? AND period = ?').get(provider, period) as any | undefined;
    return row ? { provider: row.provider, period: row.period, units: Number(row.units || 0), updatedAt: row.updated_at } : null;
  }
  return (db.prepare('SELECT * FROM provider_usage WHERE period = ? ORDER BY provider').all(period) as any[])
    .map((row) => ({ provider: row.provider, period: row.period, units: Number(row.units || 0), updatedAt: row.updated_at }));
}

/**
 * Record provider units after a chargeable call. Never blocks discovery -
 * multi-key rotation handles exhausted credits.
 */
export function recordProviderUsage(provider: string, units: number) {
  const requested = Math.max(0, Math.floor(units || 0));
  if (!requested) {
    const used = Number((getLeadsDb().prepare('SELECT units FROM provider_usage WHERE provider = ? AND period = ?')
      .get(provider, usagePeriod()) as { units?: number } | undefined)?.units || 0);
    return { recorded: false, used, requested };
  }
  const period = usagePeriod();
  const db = getLeadsDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT units FROM provider_usage WHERE provider = ? AND period = ?')
      .get(provider, period) as { units?: number } | undefined;
    const used = Number(current?.units || 0);
    db.prepare(`
      INSERT INTO provider_usage (provider, period, units, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, period) DO UPDATE SET
        units = excluded.units,
        updated_at = excluded.updated_at
    `).run(provider, period, used + requested, new Date().toISOString());
    db.exec('COMMIT');
    return { recorded: true, used: used + requested, requested };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no-op */ }
    throw error;
  }
}

/**
 * Prefer recordProviderUsage. Hard monthly caps apply only when
 * PROVIDER_CREDIT_RESERVATION=true and monthlyLimit is set; otherwise always
 * allows and records so multi-key rotation can run.
 */
export function reserveProviderUsage(provider: string, units: number, monthlyLimit?: number) {
  const reservationEnabled = String(process.env.PROVIDER_CREDIT_RESERVATION || '').trim().toLowerCase() === 'true';
  const requested = Math.max(0, Math.floor(units || 0));
  if (!reservationEnabled || monthlyLimit === undefined || monthlyLimit === null) {
    const recorded = recordProviderUsage(provider, requested);
    return {
      allowed: true,
      used: recorded.used - (recorded.recorded ? requested : 0),
      requested,
      remaining: undefined as number | undefined
    };
  }
  const period = usagePeriod();
  const db = getLeadsDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT units FROM provider_usage WHERE provider = ? AND period = ?')
      .get(provider, period) as { units?: number } | undefined;
    const used = Number(current?.units || 0);
    const allowed = used + requested <= monthlyLimit;
    if (allowed && requested) {
      db.prepare(`
        INSERT INTO provider_usage (provider, period, units, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(provider, period) DO UPDATE SET
          units = excluded.units,
          updated_at = excluded.updated_at
      `).run(provider, period, used + requested, new Date().toISOString());
    }
    db.exec('COMMIT');
    return { allowed, used, requested, remaining: Math.max(0, monthlyLimit - used - (allowed ? requested : 0)) };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no-op */ }
    throw error;
  }
}

export type MiningSessionStatus = 'running' | 'cancellation_requested' | 'success' | 'error' | 'cancelled' | 'interrupted';

export type MiningSessionRecord = {
  id: string;
  status: MiningSessionStatus;
  prompt: string;
  requestedLimit: number;
  startedAt: string;
  completedAt?: string;
  cancellationRequestedAt?: string;
  errorMessage?: string;
  stats?: Record<string, unknown>;
  traceSummary?: Record<string, unknown>;
  updatedAt: string;
};

const toMiningSessionRecord = (row: any): MiningSessionRecord => ({
  id: row.id,
  status: row.status,
  prompt: row.prompt,
  requestedLimit: Number(row.requested_limit || 0),
  startedAt: row.started_at,
  completedAt: row.completed_at || undefined,
  cancellationRequestedAt: row.cancellation_requested_at || undefined,
  errorMessage: row.error_message || undefined,
  stats: parseJSONField<Record<string, unknown> | undefined>(row.stats_json, undefined),
  traceSummary: parseJSONField<Record<string, unknown> | undefined>(row.trace_summary_json, undefined),
  updatedAt: row.updated_at
});

export function readMiningSessionById(id: string) {
  const row = getLeadsDb()
    .prepare('SELECT * FROM mining_sessions WHERE id = ?')
    .get(id) as any | undefined;
  return row ? toMiningSessionRecord(row) : null;
}

export function readMiningSessions(limit = 25) {
  const boundedLimit = Math.min(Math.max(Math.floor(limit) || 25, 1), 100);
  const rows = getLeadsDb()
    .prepare('SELECT * FROM mining_sessions ORDER BY datetime(updated_at) DESC LIMIT ?')
    .all(boundedLimit) as any[];
  return rows.map(toMiningSessionRecord);
}

export function upsertMiningSession(update: Pick<MiningSessionRecord, 'id'> & Partial<Omit<MiningSessionRecord, 'id' | 'updatedAt'>> & { updatedAt?: string }) {
  const db = getLeadsDb();
  const existing = readMiningSessionById(update.id);
  const now = update.updatedAt || new Date().toISOString();
  const record: MiningSessionRecord = {
    id: update.id,
    status: update.status || existing?.status || 'running',
    prompt: update.prompt ?? existing?.prompt ?? '',
    requestedLimit: Number(update.requestedLimit ?? existing?.requestedLimit ?? 0),
    startedAt: update.startedAt ?? existing?.startedAt ?? now,
    completedAt: update.completedAt ?? existing?.completedAt,
    cancellationRequestedAt: update.cancellationRequestedAt ?? existing?.cancellationRequestedAt,
    errorMessage: update.errorMessage ?? existing?.errorMessage,
    stats: update.stats ?? existing?.stats,
    traceSummary: update.traceSummary ?? existing?.traceSummary,
    updatedAt: now
  };

  db.prepare(`
    INSERT INTO mining_sessions (
      id, status, prompt, requested_limit, started_at, completed_at,
      cancellation_requested_at, error_message, stats_json, trace_summary_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      prompt = excluded.prompt,
      requested_limit = excluded.requested_limit,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      cancellation_requested_at = excluded.cancellation_requested_at,
      error_message = excluded.error_message,
      stats_json = excluded.stats_json,
      trace_summary_json = excluded.trace_summary_json,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.status,
    record.prompt,
    record.requestedLimit,
    record.startedAt,
    record.completedAt || null,
    record.cancellationRequestedAt || null,
    record.errorMessage || null,
    record.stats ? JSON.stringify(record.stats) : null,
    record.traceSummary ? JSON.stringify(record.traceSummary) : null,
    record.updatedAt
  );

  return record;
}

// -- Lead Activities ----------------------------------------------------------

export type LeadActivityType = 'stage_change' | 'note' | 'enrichment' | 'import' | 'merge';

export type LeadActivityRecord = {
  id: string;
  leadId: string;
  type: LeadActivityType;
  fromValue?: string;
  toValue: string;
  actor: string;
  createdAt: string;
};

// -- Lead Activity Helpers ----------------------------------------------------

export function insertLeadActivity(entry: Omit<LeadActivityRecord, 'id'> & { id?: string }): void {
  try {
    const db = getLeadsDb();
    const id = entry.id || crypto.randomUUID();
    db.prepare(`
      INSERT OR IGNORE INTO lead_activities (id, lead_id, type, from_value, to_value, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.leadId,
      entry.type,
      entry.fromValue || null,
      entry.toValue,
      entry.actor || 'user',
      entry.createdAt || new Date().toISOString()
    );
  } catch (err) {
    // Activity logging must never fail silently in a way that breaks the main write path.
    console.warn('[db] Failed to insert lead activity:', err instanceof Error ? err.message : err);
  }
}

export function readLeadActivities(leadId: string, limit = 100): LeadActivityRecord[] {
  const db = getLeadsDb();
  const rows = db.prepare(`
    SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(leadId, Math.min(limit, 500)) as any[];
  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    type: row.type as LeadActivityType,
    fromValue: row.from_value || undefined,
    toValue: row.to_value,
    actor: row.actor,
    createdAt: row.created_at
  }));
}

// -- Outreach Draft Helpers ---------------------------------------------------

export type OutreachDraftRecord = {
  id: string;
  leadId: string;
  leadName: string;
  companyName?: string;
  tone: string;
  medium: string;
  sequenceStep: string;
  wordCount: number;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export function upsertOutreachDraft(draft: OutreachDraftRecord): OutreachDraftRecord {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO outreach_drafts (id, lead_id, lead_name, company_name, tone, medium, sequence_step, word_count, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      lead_name     = excluded.lead_name,
      company_name  = excluded.company_name,
      tone          = excluded.tone,
      medium        = excluded.medium,
      sequence_step = excluded.sequence_step,
      word_count    = excluded.word_count,
      body          = excluded.body,
      updated_at    = excluded.updated_at
  `).run(
    draft.id,
    draft.leadId,
    draft.leadName,
    draft.companyName || null,
    draft.tone,
    draft.medium,
    draft.sequenceStep,
    Math.round(draft.wordCount || 0),
    draft.body,
    draft.createdAt || now,
    now
  );
  return { ...draft, updatedAt: now };
}

export function readOutreachDrafts(limit = 50): OutreachDraftRecord[] {
  const db = getLeadsDb();
  const rows = db.prepare(`
    SELECT * FROM outreach_drafts ORDER BY created_at DESC LIMIT ?
  `).all(Math.min(limit, 200)) as any[];
  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    leadName: row.lead_name,
    companyName: row.company_name || undefined,
    tone: row.tone,
    medium: row.medium,
    sequenceStep: row.sequence_step,
    wordCount: Number(row.word_count || 0),
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function deleteOutreachDraft(id: string): void {
  getLeadsDb().prepare('DELETE FROM outreach_drafts WHERE id = ?').run(id);
}
