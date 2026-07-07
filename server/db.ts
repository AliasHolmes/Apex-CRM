import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { clampSearchLogRetentionLimit } from './leadSearch/telemetry.js';

dotenv.config();

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.apex-data');
export const LEADS_DB_PATH = process.env.APEX_DB_PATH
  ? path.resolve(process.env.APEX_DB_PATH)
  : path.join(DEFAULT_DATA_DIR, 'apex-crm.sqlite');

let leadsDb: DatabaseSync | null = null;

export type EnrichmentCacheQuality = 'good' | 'partial' | 'bad';

export type EnrichmentCacheEntry = {
  id?: string;
  normalizedUrl?: string;
  linkedinUsername?: string;
  personName?: string;
  companyName?: string;
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

export type EmailDiscoveryStatus = 'confirmed_public' | 'company_public' | 'pattern_likely' | 'domain_only' | 'not_found' | 'not_searched';

export type EmailDiscoveryCacheEntry = {
  id?: string;
  normalizedUrl?: string;
  linkedinUsername?: string;
  personName?: string;
  companyName?: string;
  companyDomain?: string;
  discoveredEmail?: string;
  status: EmailDiscoveryStatus;
  confidence: number;
  evidence: string;
  createdAt?: string;
  expiresAt?: string;
};

export type EmailDiscoveryCacheLookup = {
  normalizedUrl?: string;
  linkedinUsername?: string;
  personName?: string;
  companyName?: string;
  companyDomain?: string;
};

export function getLeadsDb() {
  if (!leadsDb) {
    fs.mkdirSync(path.dirname(LEADS_DB_PATH), { recursive: true });
    leadsDb = new DatabaseSync(LEADS_DB_PATH);
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

      CREATE TABLE IF NOT EXISTS email_discovery_cache (
        id TEXT PRIMARY KEY,
        normalized_url TEXT,
        linkedin_username TEXT,
        person_name TEXT,
        company_name TEXT,
        company_domain TEXT,
        discovered_email TEXT,
        status TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        evidence TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_email_cache_url ON email_discovery_cache(normalized_url);
      CREATE INDEX IF NOT EXISTS idx_email_cache_username ON email_discovery_cache(linkedin_username);
      CREATE INDEX IF NOT EXISTS idx_email_cache_person_company_domain ON email_discovery_cache(person_name, company_name, company_domain);
      CREATE INDEX IF NOT EXISTS idx_email_cache_expires ON email_discovery_cache(expires_at);

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
    `);

    for (const statement of [
      'ALTER TABLE search_logs ADD COLUMN detailed_logs TEXT;',
      'ALTER TABLE search_logs ADD COLUMN debug_logs TEXT;',
      'ALTER TABLE search_logs ADD COLUMN trace_events TEXT;',
      'ALTER TABLE search_logs ADD COLUMN provider_summary TEXT;',
      'ALTER TABLE search_logs ADD COLUMN cost_summary TEXT;',
      'ALTER TABLE search_logs ADD COLUMN phase_timeline TEXT;',
      'ALTER TABLE search_logs ADD COLUMN schema_version INTEGER;'
    ]) {
      try {
        leadsDb.exec(statement);
      } catch {
        // Ignore if column already exists.
      }
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

export function upsertLead(lead: Record<string, any>) {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO leads (id, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    lead.id,
    JSON.stringify(lead),
    typeof lead.createdAt === 'string' ? lead.createdAt : now,
    now
  );

  db.prepare(`
    INSERT INTO app_meta (key, value, updated_at)
    VALUES ('leads_initialized', 'true', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(now);
}

export function deleteLead(id: string) {
  const db = getLeadsDb();
  db.prepare('DELETE FROM leads WHERE id = ?').run(id);
}

export function upsertLeads(leads: Record<string, any>[]) {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO leads (id, payload, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const lead of leads) {
      stmt.run(
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


const normalizeCacheValue = (value?: string) => (value || '').trim().toLowerCase();

const toCacheRow = (row: any): EnrichmentCacheEntry | null => {
  if (!row) return null;
  return {
    id: row.id,
    normalizedUrl: row.normalized_url || undefined,
    linkedinUsername: row.linkedin_username || undefined,
    personName: row.person_name || undefined,
    companyName: row.company_name || undefined,
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
      evidence_block,
      scrape_quality,
      source_provider,
      created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      normalized_url = excluded.normalized_url,
      linkedin_username = excluded.linkedin_username,
      person_name = excluded.person_name,
      company_name = excluded.company_name,
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

const toEmailCacheRow = (row: any): EmailDiscoveryCacheEntry | null => {
  if (!row) return null;
  return {
    id: row.id,
    normalizedUrl: row.normalized_url || undefined,
    linkedinUsername: row.linkedin_username || undefined,
    personName: row.person_name || undefined,
    companyName: row.company_name || undefined,
    companyDomain: row.company_domain || undefined,
    discoveredEmail: row.discovered_email || undefined,
    status: row.status,
    confidence: Number(row.confidence || 0),
    evidence: row.evidence || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
};

export function pruneExpiredEmailDiscoveryCache(now = new Date()) {
  const db = getLeadsDb();
  const result = db.prepare('DELETE FROM email_discovery_cache WHERE datetime(expires_at) <= datetime(?)').run(now.toISOString());
  return Number(result.changes || 0);
}

export function getEmailDiscoveryCacheEntry(lookup: EmailDiscoveryCacheLookup, now = new Date()) {
  const db = getLeadsDb();
  const cutoff = now.toISOString();
  const normalizedUrl = normalizeCacheValue(lookup.normalizedUrl);
  const linkedinUsername = normalizeCacheValue(lookup.linkedinUsername);
  const personName = normalizeCacheValue(lookup.personName);
  const companyName = normalizeCacheValue(lookup.companyName);
  const companyDomain = normalizeCacheValue(lookup.companyDomain);

  if (normalizedUrl || linkedinUsername) {
    const row = db.prepare(`
      SELECT * FROM email_discovery_cache
      WHERE datetime(expires_at) > datetime(?)
        AND (
          (? != '' AND normalized_url = ?)
          OR (? != '' AND linkedin_username = ?)
        )
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(cutoff, normalizedUrl, normalizedUrl, linkedinUsername, linkedinUsername);
    const match = toEmailCacheRow(row);
    if (match) return match;
  }

  if (personName && (companyDomain || companyName)) {
    const row = db.prepare(`
      SELECT * FROM email_discovery_cache
      WHERE datetime(expires_at) > datetime(?)
        AND person_name = ?
        AND ((? != '' AND company_domain = ?) OR (? != '' AND company_name = ?))
      ORDER BY datetime(created_at) DESC
      LIMIT 1
    `).get(cutoff, personName, companyDomain, companyDomain, companyName, companyName);
    return toEmailCacheRow(row);
  }

  return null;
}

export function upsertEmailDiscoveryCacheEntry(entry: EmailDiscoveryCacheEntry, ttlDays = 14, now = new Date()) {
  const db = getLeadsDb();
  const createdAt = entry.createdAt || now.toISOString();
  const expiresAt = entry.expiresAt || new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const normalizedUrl = normalizeCacheValue(entry.normalizedUrl);
  const linkedinUsername = normalizeCacheValue(entry.linkedinUsername);
  const personName = normalizeCacheValue(entry.personName);
  const companyName = normalizeCacheValue(entry.companyName);
  const companyDomain = normalizeCacheValue(entry.companyDomain);
  const id = entry.id || crypto.createHash('sha256')
    .update([normalizedUrl, linkedinUsername, personName, companyName, companyDomain].filter(Boolean).join('|') || crypto.randomUUID())
    .digest('hex');

  db.prepare(`
    INSERT INTO email_discovery_cache (
      id,
      normalized_url,
      linkedin_username,
      person_name,
      company_name,
      company_domain,
      discovered_email,
      status,
      confidence,
      evidence,
      created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      normalized_url = excluded.normalized_url,
      linkedin_username = excluded.linkedin_username,
      person_name = excluded.person_name,
      company_name = excluded.company_name,
      company_domain = excluded.company_domain,
      discovered_email = excluded.discovered_email,
      status = excluded.status,
      confidence = excluded.confidence,
      evidence = excluded.evidence,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).run(
    id,
    normalizedUrl || null,
    linkedinUsername || null,
    personName || null,
    companyName || null,
    companyDomain || null,
    entry.discoveredEmail || null,
    entry.status,
    Math.round(entry.confidence || 0),
    entry.evidence || '',
    createdAt,
    expiresAt
  );

  pruneExpiredEmailDiscoveryCache(now);
  return { ...entry, id, createdAt, expiresAt };
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