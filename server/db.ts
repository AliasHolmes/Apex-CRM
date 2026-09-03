import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DatabaseSync, StatementSync } from "node:sqlite";
import dotenv from "dotenv";
import {
  clampSearchLogRetentionLimit,
  setLlmStageLogger,
  type LlmStageLogEntry,
} from "./leadSearch/telemetry.js";
import {
  REVIEW_STATUS_SET as REVIEW_STATUSES,
  NEXT_ACTION_SET as NEXT_ACTIONS,
} from "../src/types.js";
import {
  canonicalLinkedInIdentity,
  normalizeDedupeValue,
} from "../src/utils/leadDedupe.js";

dotenv.config();

const DEFAULT_DATA_DIR = path.join(process.cwd(), ".apex-data");
const LATEST_SCHEMA_VERSION = 20;
export const LEADS_DB_PATH = process.env.APEX_DB_PATH
  ? path.resolve(process.env.APEX_DB_PATH)
  : path.join(DEFAULT_DATA_DIR, "apex-crm.sqlite");

let leadsDb: DatabaseSync | null = null;
const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function getCachedStatement(db: DatabaseSync, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

let pruneEnrichmentCounter = 0;
let searchLogInsertCounter = 0;

const isUsableEmail = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

function normalizeStoredLead(lead: Record<string, any>) {
  if (!lead) return lead;

  const profile =
    lead.profile && typeof lead.profile === "object" ? lead.profile : undefined;
  const contactDetails =
    profile?.contactDetails && typeof profile.contactDetails === "object"
      ? profile.contactDetails
      : undefined;
  const hasLegacyEmail = Boolean(
    lead.emailDiscovery || profile?.emailDiscovery,
  );
  const hasLegacyContactStatus = Boolean(
    contactDetails &&
    ("emailStatus" in contactDetails ||
      "emailConfidence" in contactDetails ||
      "emailSources" in contactDetails ||
      "fallbackChannels" in contactDetails),
  );

  // Fast path: if already normalized without legacy emailDiscovery / status fields
  if (
    !hasLegacyEmail &&
    !hasLegacyContactStatus &&
    REVIEW_STATUSES.has(lead.reviewStatus) &&
    NEXT_ACTIONS.has(lead.nextAction)
  ) {
    return lead;
  }

  const cleanProfile = profile ? { ...profile } : {};
  const cleanContactDetails = contactDetails ? { ...contactDetails } : {};
  const legacyEmail =
    lead.emailDiscovery?.bestEmail || cleanProfile.emailDiscovery?.bestEmail;
  if (!isUsableEmail(cleanContactDetails.email) && isUsableEmail(legacyEmail)) {
    cleanContactDetails.email = legacyEmail.trim().toLowerCase();
  } else if (isUsableEmail(cleanContactDetails.email)) {
    cleanContactDetails.email = cleanContactDetails.email.trim().toLowerCase();
  }

  delete cleanContactDetails.emailStatus;
  delete cleanContactDetails.emailConfidence;
  delete cleanContactDetails.emailSources;
  delete cleanContactDetails.fallbackChannels;
  delete cleanProfile.emailDiscovery;

  const normalized: Record<string, any> = {
    ...lead,
    profile: { ...cleanProfile, contactDetails: cleanContactDetails },
    reviewStatus: REVIEW_STATUSES.has(lead.reviewStatus)
      ? lead.reviewStatus
      : "UNREVIEWED",
    nextAction: NEXT_ACTIONS.has(lead.nextAction) ? lead.nextAction : "NONE",
  };
  delete normalized.emailDiscovery;
  return normalized;
}

export function extractPromotedLeadColumns(storedLead: Record<string, any>) {
  const profile =
    storedLead.profile && typeof storedLead.profile === "object"
      ? storedLead.profile
      : {};
  const contactDetails =
    profile.contactDetails && typeof profile.contactDetails === "object"
      ? profile.contactDetails
      : {};
  const fullName =
    typeof profile.fullName === "string" && profile.fullName.trim()
      ? profile.fullName.trim()
      : typeof storedLead.fullName === "string" && storedLead.fullName.trim()
        ? storedLead.fullName.trim()
        : null;
  const company =
    typeof profile.currentCompany === "string" && profile.currentCompany.trim()
      ? profile.currentCompany.trim()
      : typeof storedLead.company === "string" && storedLead.company.trim()
        ? storedLead.company.trim()
        : typeof storedLead.currentCompany === "string" &&
            storedLead.currentCompany.trim()
          ? storedLead.currentCompany.trim()
          : null;
  const title =
    typeof profile.currentTitle === "string" && profile.currentTitle.trim()
      ? profile.currentTitle.trim()
      : typeof storedLead.title === "string" && storedLead.title.trim()
        ? storedLead.title.trim()
        : typeof storedLead.currentTitle === "string" &&
            storedLead.currentTitle.trim()
          ? storedLead.currentTitle.trim()
          : null;
  const stage =
    typeof storedLead.stage === "string" && storedLead.stage.trim()
      ? storedLead.stage.trim()
      : "NEW";
  const reviewStatus =
    typeof storedLead.reviewStatus === "string" &&
    storedLead.reviewStatus.trim()
      ? storedLead.reviewStatus.trim()
      : "UNREVIEWED";
  const nextAction =
    typeof storedLead.nextAction === "string" && storedLead.nextAction.trim()
      ? storedLead.nextAction.trim()
      : "NONE";
  const rawScore =
    storedLead.qualificationScore ??
    storedLead.predictiveScore ??
    storedLead.compositeScore ??
    storedLead.score;
  const score =
    typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null;
  const email =
    typeof contactDetails.email === "string" && contactDetails.email.trim()
      ? contactDetails.email.trim().toLowerCase()
      : typeof storedLead.email === "string" && storedLead.email.trim()
        ? storedLead.email.trim().toLowerCase()
        : null;

  return {
    fullName,
    company,
    title,
    stage,
    reviewStatus,
    nextAction,
    score,
    email,
  };
}

function getTableColumns(db: DatabaseSync, tableName: string) {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[]
    ).map((column) => column.name),
  );
}

function tableExists(db: DatabaseSync, tableName: string) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName);
  return Boolean(row);
}

function addColumnIfMissing(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string,
) {
  if (
    tableExists(db, tableName) &&
    !getTableColumns(db, tableName).has(columnName)
  ) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
  }
}

function backupDatabaseBeforeMigration(previousVersion: number) {
  if (previousVersion >= LATEST_SCHEMA_VERSION || !fs.existsSync(LEADS_DB_PATH))
    return;

  const stats = fs.statSync(LEADS_DB_PATH);
  if (stats.size === 0) return;

  const backupDir = path.join(path.dirname(LEADS_DB_PATH), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    backupDir,
    `apex-crm.pre-migration-v${previousVersion}.${timestamp}.sqlite`,
  );

  // Use VACUUM INTO instead of fs.copyFileSync. When SQLite is in WAL mode,
  // a raw file copy may miss pages that are in the .wal sidecar but not yet
  // checkpointed into the main file, producing a corrupt backup. VACUUM INTO
  // always produces a complete, self-contained snapshot regardless of WAL state.
  try {
    const srcDb = new DatabaseSync(LEADS_DB_PATH, { open: true });
    srcDb.exec("PRAGMA busy_timeout = 10000;");
    srcDb.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    srcDb.close();
    console.log(
      `WAL-safe database backup created before migration: ${backupPath}`,
    );
  } catch (vacuumError) {
    // Fallback to raw copy if VACUUM INTO is unavailable (very old Node.js versions).
    console.warn(
      "VACUUM INTO failed, falling back to file copy for backup:",
      vacuumError,
    );
    fs.copyFileSync(LEADS_DB_PATH, backupPath);
    console.log(
      `(Fallback) Database backup created before migration: ${backupPath}`,
    );
  }
}

/**
 * Run a row-by-row backfill in bounded sub-transactions so a large leads table
 * cannot hold the write lock (and block WAL readers) for one long pass.
 * Runs inside the outer migration transaction via SAVEPOINT semantics.
 */
function batchedBackfill(
  db: DatabaseSync,
  rows: { id: string }[],
  applyRow: (row: any) => void,
  batchSize = 500,
) {
  for (let i = 0; i < rows.length; i += batchSize) {
    db.exec("SAVEPOINT backfill_batch");
    try {
      for (const row of rows.slice(i, i + batchSize)) {
        applyRow(row);
      }
      db.exec("RELEASE backfill_batch");
    } catch (error) {
      try {
        db.exec("ROLLBACK TO backfill_batch");
      } catch {
        /* ignore */
      }
      throw error;
    }
  }
}

function runMigrations(db: DatabaseSync) {
  const currentVersion = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: number })
      .user_version || 0,
  );
  if (currentVersion >= LATEST_SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
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
        CREATE INDEX IF NOT EXISTS idx_search_logs_timestamp ON search_logs(timestamp DESC);
      `);
    }

    if (currentVersion < 2) {
      addColumnIfMissing(
        db,
        "search_logs",
        "detailed_logs",
        "detailed_logs TEXT",
      );
      addColumnIfMissing(db, "search_logs", "debug_logs", "debug_logs TEXT");
      addColumnIfMissing(
        db,
        "search_logs",
        "trace_events",
        "trace_events TEXT",
      );
      addColumnIfMissing(
        db,
        "search_logs",
        "provider_summary",
        "provider_summary TEXT",
      );
      addColumnIfMissing(
        db,
        "search_logs",
        "cost_summary",
        "cost_summary TEXT",
      );
      addColumnIfMissing(
        db,
        "search_logs",
        "phase_timeline",
        "phase_timeline TEXT",
      );
      addColumnIfMissing(
        db,
        "search_logs",
        "schema_version",
        "schema_version INTEGER",
      );
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
      addColumnIfMissing(
        db,
        "leads",
        "revision",
        "revision INTEGER NOT NULL DEFAULT 1",
      );
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
      addColumnIfMissing(
        db,
        "enrichment_cache",
        "public_email",
        "public_email TEXT",
      );
      const rows = db.prepare("SELECT id, payload FROM leads").all() as {
        id: string;
        payload: string;
      }[];
      const updatePayload = db.prepare(
        "UPDATE leads SET payload = ? WHERE id = ?",
      );
      batchedBackfill(db, rows, (row) => {
        try {
          updatePayload.run(
            JSON.stringify(normalizeStoredLead(JSON.parse(row.payload))),
            row.id,
          );
        } catch (error) {
          console.warn(`Skipping legacy lead cleanup for ${row.id}:`, error);
        }
      });
      db.exec("DROP TABLE IF EXISTS email_discovery_cache");
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
      addColumnIfMissing(
        db,
        "query_performance",
        "outcome_runs",
        "outcome_runs INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "query_performance",
        "qualified_candidates",
        "qualified_candidates INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "query_performance",
        "rescued_candidates",
        "rescued_candidates INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "query_performance",
        "returned_candidates",
        "returned_candidates INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "query_performance",
        "search_latency_ms",
        "search_latency_ms INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "query_performance",
        "provider_units",
        "provider_units INTEGER NOT NULL DEFAULT 0",
      );
    }

    if (currentVersion < 10) {
      addColumnIfMissing(
        db,
        "query_performance",
        "judged_candidates",
        "judged_candidates INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "query_performance",
        "hard_failed_candidates",
        "hard_failed_candidates INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(
        db,
        "query_performance",
        "unknown_candidates",
        "unknown_candidates INTEGER NOT NULL DEFAULT 0",
      );
    }

    if (currentVersion < 11) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lead_identities (
          identity_key TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_lead_identities_lead_id ON lead_identities(lead_id);

        CREATE TABLE IF NOT EXISTS lead_identity_conflicts (
          identity_key TEXT NOT NULL,
          canonical_lead_id TEXT NOT NULL,
          duplicate_lead_id TEXT NOT NULL,
          detected_at TEXT NOT NULL,
          PRIMARY KEY (identity_key, duplicate_lead_id)
        );
      `);

      const rows = db
        .prepare(
          `
        SELECT id, payload, created_at
        FROM leads
        ORDER BY datetime(COALESCE(created_at, '9999-12-31T23:59:59.999Z')) ASC, id ASC
      `,
        )
        .all() as { id: string; payload: string; created_at?: string }[];
      const insertIdentity = db.prepare(`
        INSERT OR IGNORE INTO lead_identities (identity_key, lead_id, created_at)
        VALUES (?, ?, ?)
      `);
      const findIdentity = db.prepare(
        "SELECT lead_id FROM lead_identities WHERE identity_key = ?",
      );
      const recordConflict = db.prepare(`
        INSERT OR IGNORE INTO lead_identity_conflicts
          (identity_key, canonical_lead_id, duplicate_lead_id, detected_at)
        VALUES (?, ?, ?, ?)
      `);
      const detectedAt = new Date().toISOString();

      for (const row of rows) {
        try {
          const lead = JSON.parse(row.payload) as Record<string, any>;
          const identityKey = canonicalLinkedInIdentity(
            lead?.profile?.contactDetails?.linkedinUrl ||
              lead?.contactDetails?.linkedinUrl ||
              lead?.linkedinUrl ||
              lead?.sourceUrl,
          );
          if (!identityKey) continue;
          insertIdentity.run(identityKey, row.id, row.created_at || detectedAt);
          const mapped = findIdentity.get(identityKey) as
            | { lead_id?: string }
            | undefined;
          if (mapped?.lead_id && mapped.lead_id !== row.id) {
            recordConflict.run(identityKey, mapped.lead_id, row.id, detectedAt);
          }
        } catch (error) {}
      }
    }

    if (currentVersion < 12) {
      addColumnIfMissing(
        db,
        "enrichment_cache",
        "intent_fingerprint",
        "intent_fingerprint TEXT",
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_enrichment_cache_intent ON enrichment_cache(normalized_url, intent_fingerprint) WHERE intent_fingerprint IS NOT NULL;`,
      );
    }

    if (currentVersion < 13) {
      addColumnIfMissing(db, "leads", "full_name", "full_name TEXT");
      addColumnIfMissing(db, "leads", "company", "company TEXT");
      addColumnIfMissing(db, "leads", "title", "title TEXT");
      addColumnIfMissing(
        db,
        "leads",
        "stage",
        "stage TEXT NOT NULL DEFAULT 'NEW'",
      );
      addColumnIfMissing(
        db,
        "leads",
        "review_status",
        "review_status TEXT NOT NULL DEFAULT 'UNREVIEWED'",
      );
      addColumnIfMissing(
        db,
        "leads",
        "next_action",
        "next_action TEXT NOT NULL DEFAULT 'NONE'",
      );
      addColumnIfMissing(db, "leads", "score", "score REAL");
      addColumnIfMissing(db, "leads", "email", "email TEXT");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
        CREATE INDEX IF NOT EXISTS idx_leads_review_status ON leads(review_status);
        CREATE INDEX IF NOT EXISTS idx_leads_next_action ON leads(next_action);
        CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
        CREATE INDEX IF NOT EXISTS idx_leads_created_updated ON leads(created_at DESC, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_leads_stage_updated ON leads(stage, datetime(updated_at) DESC);
        CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);
      `);

      const rows = db.prepare("SELECT id, payload FROM leads").all() as {
        id: string;
        payload: string;
      }[];
      const updateStmt = db.prepare(`
        UPDATE leads
        SET full_name = ?, company = ?, title = ?, stage = ?, review_status = ?, next_action = ?, score = ?, email = ?
        WHERE id = ?
      `);

      batchedBackfill(db, rows, (row) => {
        try {
          const lead = JSON.parse(row.payload);
          const cols = extractPromotedLeadColumns(lead);
          updateStmt.run(
            cols.fullName,
            cols.company,
            cols.title,
            cols.stage,
            cols.reviewStatus,
            cols.nextAction,
            cols.score,
            cols.email,
            row.id,
          );
        } catch {
          // ignore corrupted payload on backfill
        }
      });
    }

    if (currentVersion < 14) {
      addColumnIfMissing(
        db,
        "mining_sessions",
        "checkpoint_json",
        "checkpoint_json TEXT",
      );
    }

    if (currentVersion < 15) {
      scrubRateLimitPollution(db);
    }

    if (currentVersion < 16) {
      addColumnIfMissing(
        db,
        "query_performance",
        "requirement_fail_digest",
        "requirement_fail_digest TEXT",
      );
      addColumnIfMissing(
        db,
        "saved_searches",
        "exclude_list_json",
        "exclude_list_json TEXT",
      );
    }

    if (currentVersion < 17) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS leads_fts USING fts5(
          id UNINDEXED,
          full_name,
          company,
          title,
          email,
          notes,
          tags,
          tokenize='porter unicode61'
        );

        CREATE TRIGGER IF NOT EXISTS leads_ai AFTER INSERT ON leads BEGIN
          INSERT INTO leads_fts(id, full_name, company, title, email, notes, tags)
          VALUES (
            new.id,
            COALESCE(new.full_name, ''),
            COALESCE(new.company, ''),
            COALESCE(new.title, ''),
            COALESCE(new.email, ''),
            COALESCE(json_extract(new.payload, '$.notes'), ''),
            COALESCE(json_extract(new.payload, '$.tags'), '')
          );
        END;

        CREATE TRIGGER IF NOT EXISTS leads_ad AFTER DELETE ON leads BEGIN
          DELETE FROM leads_fts WHERE id = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS leads_au AFTER UPDATE ON leads BEGIN
          DELETE FROM leads_fts WHERE id = old.id;
          INSERT INTO leads_fts(id, full_name, company, title, email, notes, tags)
          VALUES (
            new.id,
            COALESCE(new.full_name, ''),
            COALESCE(new.company, ''),
            COALESCE(new.title, ''),
            COALESCE(new.email, ''),
            COALESCE(json_extract(new.payload, '$.notes'), ''),
            COALESCE(json_extract(new.payload, '$.tags'), '')
          );
        END;
      `);

      const rows = db
        .prepare(
          "SELECT id, full_name, company, title, email, payload FROM leads",
        )
        .all() as {
        id: string;
        full_name?: string;
        company?: string;
        title?: string;
        email?: string;
        payload: string;
      }[];
      const insertFts = db.prepare(`
        INSERT OR REPLACE INTO leads_fts(id, full_name, company, title, email, notes, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      batchedBackfill(db, rows, (row) => {
        try {
          let notes = "";
          let tags = "";
          try {
            const parsed = JSON.parse(row.payload);
            notes = typeof parsed.notes === "string" ? parsed.notes : "";
            tags = Array.isArray(parsed.tags) ? parsed.tags.join(" ") : "";
          } catch {}
          insertFts.run(
            row.id,
            row.full_name || "",
            row.company || "",
            row.title || "",
            row.email || "",
            notes,
            tags,
          );
        } catch {}
      });
    }

    if (currentVersion < 18) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS discovered_companies (
          normalized_name TEXT PRIMARY KEY,
          company_name TEXT NOT NULL,
          signal_count INTEGER NOT NULL DEFAULT 1,
          strongest_signal TEXT NOT NULL,
          source_urls_json TEXT NOT NULL DEFAULT '[]',
          confidence REAL NOT NULL DEFAULT 0.7,
          last_seen_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_discovered_companies_last_seen
          ON discovered_companies(last_seen_at DESC);
      `);
    }

    if (currentVersion < 19) {
      addColumnIfMissing(
        db,
        "query_performance",
        "domain_cluster",
        "domain_cluster TEXT NOT NULL DEFAULT 'global'",
      );
      const qpTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'query_performance'").get();
      if (qpTable) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_query_performance_domain_cluster
            ON query_performance(domain_cluster, updated_at DESC);
        `);
      }
    }

    if (currentVersion < 20) {
      const leadsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'leads'").get();
      if (leadsTable) {
        db.exec(`
          DROP INDEX IF EXISTS idx_leads_stage_updated;
          CREATE INDEX IF NOT EXISTS idx_leads_stage_created
            ON leads(stage, created_at DESC, updated_at DESC);
        `);
      }
      const llmTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_stage_logs'").get();
      if (llmTable) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_llm_stage_logs_created_at
            ON llm_stage_logs(created_at DESC);
        `);
      }
    }

    db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.error("SQLite migration rollback failed:", rollbackError);
    }
    throw error;
  }
}

export function scrubRateLimitPollution(db: DatabaseSync): {
  leadsScrubbed: number;
  cacheDeleted: number;
} {
  let cacheDeleted = 0;
  let leadsScrubbed = 0;

  // 1. Delete polluted enrichment_cache entries
  if (tableExists(db, "enrichment_cache")) {
    const cacheResult = db
      .prepare(
        `
      DELETE FROM enrichment_cache
      WHERE LOWER(evidence_block) LIKE '%your system is sending too many%'
         OR LOWER(evidence_block) LIKE '%sending too many of this type%'
         OR LOWER(evidence_block) LIKE '%contact your account manager%'
    `,
      )
      .run();
    cacheDeleted = Number(cacheResult.changes || 0);
  }

  // 2. Scrub polluted strings in leads table payloads
  if (tableExists(db, "leads")) {
    const rows = db.prepare("SELECT id, payload FROM leads").all() as {
      id: string;
      payload: string;
    }[];
    const updateLead = db.prepare(
      "UPDATE leads SET payload = ?, full_name = ?, company = ?, title = ? WHERE id = ?",
    );

    const noticeRegex1 = /your system is sending too many[^."\n]*(\.|\s|$)/gi;
    const noticeRegex2 = /if you need to send more[^."\n]*(\.|\s|$)/gi;
    const noticeRegex3 = /contact your account manager[^."\n]*(\.|\s|$)/gi;

    const scrubValue = (val: any): any => {
      if (typeof val === "string") {
        if (
          /your system is sending too many|sending too many of this type|contact your account manager/i.test(
            val,
          )
        ) {
          return val
            .replace(noticeRegex1, "")
            .replace(noticeRegex2, "")
            .replace(noticeRegex3, "")
            .trim();
        }
        return val;
      }
      if (Array.isArray(val)) {
        return val.map(scrubValue);
      }
      if (val !== null && typeof val === "object") {
        const cleanedObj: Record<string, any> = {};
        for (const [k, v] of Object.entries(val)) {
          cleanedObj[k] = scrubValue(v);
        }
        return cleanedObj;
      }
      return val;
    };

    for (const row of rows) {
      if (
        /your system is sending too many|sending too many of this type|contact your account manager/i.test(
          row.payload,
        )
      ) {
        try {
          const parsed = JSON.parse(row.payload);
          const cleaned = scrubValue(parsed);
          const newPayload = JSON.stringify(cleaned);
          if (newPayload !== row.payload) {
            const cols = extractPromotedLeadColumns(cleaned);
            updateLead.run(
              newPayload,
              cols.fullName,
              cols.company,
              cols.title,
              row.id,
            );
            leadsScrubbed++;
          }
        } catch {
          // ignore malformed payloads
        }
      }
    }
  }

  return { leadsScrubbed, cacheDeleted };
}

export type EnrichmentCacheQuality = "good" | "partial" | "weak" | "bad";

export type EnrichmentCacheEntry = {
  id?: string;
  normalizedUrl?: string;
  linkedinUsername?: string;
  personName?: string;
  companyName?: string;
  publicEmail?: string;
  evidenceBlock: string;
  scrapeQuality: EnrichmentCacheQuality;
  sourceProvider: "brightdata" | "tavily" | "site_probe" | string;
  intentFingerprint?: string;
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
    const currentVersion = Number(
      (
        leadsDb.prepare("PRAGMA user_version").get() as {
          user_version?: number;
        }
      ).user_version || 0,
    );
    backupDatabaseBeforeMigration(currentVersion);
    leadsDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 10000;
      PRAGMA foreign_keys = ON;
      PRAGMA optimize;
      PRAGMA cache_size = -16000;
      PRAGMA mmap_size = 268435456;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS leads (
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

      CREATE INDEX IF NOT EXISTS idx_leads_created_updated ON leads(created_at DESC, updated_at DESC);
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
      CREATE INDEX IF NOT EXISTS idx_search_logs_timestamp ON search_logs(timestamp DESC);

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
    if (getTableColumns(leadsDb, "leads").has("stage")) {
      leadsDb.exec(
        "CREATE INDEX IF NOT EXISTS idx_leads_stage_created ON leads(stage, created_at DESC);",
      );
    }
    setLlmStageLogger(insertLlmStageLog);
  }

  return leadsDb;
}

export function normalizeIncomingLeads(input: unknown) {
  if (!Array.isArray(input)) {
    return null;
  }

  return input
    .filter(
      (lead): lead is Record<string, any> => !!lead && typeof lead === "object",
    )
    .map((lead) =>
      normalizeStoredLead({
        ...lead,
        id:
          typeof lead.id === "string" && lead.id.trim()
            ? lead.id
            : crypto.randomUUID(),
        createdAt:
          typeof lead.createdAt === "string" && lead.createdAt
            ? lead.createdAt
            : new Date().toISOString(),
      }),
    );
}

export function sanitizeFtsQuery(search: string): string | null {
  if (!search || typeof search !== "string") return null;
  const cleaned = search
    .replace(/[^\p{L}\p{N}\s_@.-]/gu, " ")
    .replace(/\b(AND|OR|NOT|MATCH|NEAR)\b/gi, " ")
    .trim();
  if (!cleaned) return null;
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim())
    .filter((t) => t.length > 0 && /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

export type ReadLeadsOptions = {
  stage?: string;
  reviewStatus?: string;
  nextAction?: string;
  search?: string;
  limit?: number;
  offset?: number;
  summaryOnly?: boolean;
  orderBy?: "score" | "recency";
};

export type LeadSummary = {
  id: string;
  fullName: string | null;
  company: string | null;
  title: string | null;
  stage: string;
  reviewStatus: string;
  nextAction: string;
  score: number | null;
  email: string | null;
  revision: number;
  createdAt?: string;
  updatedAt: string;
};

export function readLeadsSummary(options: ReadLeadsOptions = {}): {
  leads: any[];
  total: number;
} {
  const db = getLeadsDb();
  const {
    stage,
    reviewStatus,
    nextAction,
    search,
    limit,
    offset,
    summaryOnly,
    orderBy,
  } = options;
  const conditions: string[] = [];
  const params: any[] = [];

  if (stage && stage !== "All") {
    conditions.push("leads.stage = ?");
    params.push(stage);
  }
  if (reviewStatus && reviewStatus !== "All") {
    conditions.push("leads.review_status = ?");
    params.push(reviewStatus);
  }
  if (nextAction && nextAction !== "All") {
    conditions.push("leads.next_action = ?");
    params.push(nextAction);
  }

  let fromClause = "FROM leads";
  const ftsQuery = search && search.trim() ? sanitizeFtsQuery(search) : null;
  if (search && search.trim()) {
    if (ftsQuery) {
      fromClause = "FROM leads JOIN leads_fts ON leads.id = leads_fts.id";
      conditions.push("leads_fts MATCH ?");
      params.push(ftsQuery);
    } else {
      conditions.push("0 = 1");
    }
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total ${fromClause} ${where}`)
    .get(...params) as { total?: number } | undefined;
  const total = Number(totalRow?.total || 0);

  let orderClause = "leads.created_at DESC, leads.updated_at DESC";
  if (orderBy === "score") {
    orderClause = "leads.score DESC, leads.created_at DESC";
  } else if (ftsQuery) {
    orderClause = "leads_fts.rank, leads.created_at DESC, leads.updated_at DESC";
  }

  const selectCols = summaryOnly
    ? "leads.id, leads.full_name, leads.company, leads.title, leads.stage, leads.review_status, leads.next_action, leads.score, leads.email, leads.revision, leads.created_at, leads.updated_at"
    : "leads.payload, leads.revision";

  let query = `SELECT ${selectCols} ${fromClause} ${where} ORDER BY ${orderClause}`;

  const queryParams = [...params];
  if (typeof limit === "number" && limit > 0) {
    query += " LIMIT ?";
    queryParams.push(limit);
    if (typeof offset === "number" && offset > 0) {
      query += " OFFSET ?";
      queryParams.push(offset);
    }
  }

  const rows = db.prepare(query).all(...queryParams) as any[];

  if (summaryOnly) {
    return {
      leads: rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        company: r.company,
        title: r.title,
        stage: r.stage,
        reviewStatus: r.review_status,
        nextAction: r.next_action,
        score: r.score,
        email: r.email,
        revision: Number(r.revision || 1),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      total,
    };
  }

  const leads = rows
    .map((row) => {
      try {
        const parsed = JSON.parse(row.payload);
        parsed.revision = Number(row.revision || parsed.revision || 1);
        return normalizeStoredLead(parsed);
      } catch (error) {
        console.warn("Skipping unreadable lead record from SQLite:", error);
        return null;
      }
    })
    .filter(Boolean);

  return { leads, total };
}

export function readStoredLeads() {
  return readLeadsSummary().leads;
}

export type LeadsStats = {
  total: number;
  stageCounts: Record<string, number>;
  averageQualification: number;
  conversionRate: number;
  initialized: boolean;
};

export function readLeadsStats(): LeadsStats {
  const db = getLeadsDb();
  const summaryRow = db
    .prepare(
      `SELECT 
        COUNT(*) AS total,
        AVG(CASE WHEN score IS NOT NULL AND score > 0 THEN (CASE WHEN score <= 10 THEN score * 10 ELSE score END) ELSE NULL END) AS avgScore
      FROM leads`,
    )
    .get() as { total?: number; avgScore?: number | null } | undefined;

  const total = Number(summaryRow?.total || 0);
  const rawAvg = Number(summaryRow?.avgScore || 0);
  const averageQualification = Math.round(rawAvg * 10) / 10;

  const stageRows = db
    .prepare("SELECT stage, COUNT(*) as count FROM leads GROUP BY stage")
    .all() as { stage: string; count: number }[];

  const stageCounts: Record<string, number> = {};
  for (const s of [
    "SCRAPED",
    "ENRICHED",
    "SEQUENCE ACTIVE",
    "REPLIED",
    "MEETING BOOKED",
    "NEGOTIATING",
    "CONVERTED",
    "LOST",
    "NURTURE",
  ]) {
    stageCounts[s] = 0;
  }
  for (const row of stageRows) {
    if (row.stage) {
      stageCounts[row.stage] = Number(row.count || 0);
    }
  }

  const convertedCount = stageCounts["CONVERTED"] || 0;
  const conversionRate =
    total > 0 ? Math.round((convertedCount / total) * 100) : 0;

  return {
    total,
    stageCounts,
    averageQualification,
    conversionRate,
    initialized: hasLeadStoreBeenInitialized(),
  };
}

export function readExistingIdentityKeys(): Set<string> {
  const db = getLeadsDb();
  const keys = new Set<string>();

  const idRows = db
    .prepare("SELECT identity_key FROM lead_identities")
    .all() as { identity_key: string }[];
  for (const r of idRows) {
    if (r.identity_key) keys.add(r.identity_key);
  }

  const leadRows = db
    .prepare(
      "SELECT email, full_name, company FROM leads WHERE email IS NOT NULL OR full_name IS NOT NULL",
    )
    .all() as {
    email: string | null;
    full_name: string | null;
    company: string | null;
  }[];
  for (const row of leadRows) {
    if (row.email) {
      const normEmail = normalizeDedupeValue(row.email);
      if (normEmail) keys.add(`email:${normEmail}`);
    }
    const name = normalizeDedupeValue(row.full_name || undefined);
    const comp = normalizeDedupeValue(row.company || undefined);
    if (name && comp) {
      keys.add(`name_company:${name}::${comp}`);
    }
  }

  return keys;
}

export function readLeadsStageSummary(): {
  count: number;
  stageCounts: Record<string, number>;
} {
  const rows = getLeadsDb()
    .prepare("SELECT stage, COUNT(*) as n FROM leads GROUP BY stage")
    .all() as { stage: string; n: number }[];
  const stageCounts = Object.fromEntries(
    rows.map((r) => [r.stage, Number(r.n)]),
  );
  return { count: rows.reduce((s, r) => s + Number(r.n), 0), stageCounts };
}

export function readStoredLeadById(id: string) {
  const row = getLeadsDb()
    .prepare("SELECT payload, revision FROM leads WHERE id = ?")
    .get(id) as { payload: string; revision: number } | undefined;

  if (!row) return null;
  try {
    return {
      ...normalizeStoredLead(JSON.parse(row.payload)),
      revision: Number(row.revision || 1),
    } as Record<string, any>;
  } catch (error) {
    console.warn(`Skipping unreadable lead ${id} from SQLite:`, error);
    return null;
  }
}

export function hasLeadStoreBeenInitialized() {
  const row = getLeadsDb()
    .prepare("SELECT value FROM app_meta WHERE key = 'leads_initialized'")
    .get() as { value: string } | undefined;

  return row?.value === "true";
}

export function replaceStoredLeads(leads: Record<string, any>[]) {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  const insertLead = db.prepare(`
    INSERT INTO leads (
      id, payload, created_at, updated_at, revision,
      full_name, company, title, stage, review_status, next_action, score, email
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM leads").run();
    db.prepare("DELETE FROM lead_identity_conflicts").run();

    const claimIdentity = db.prepare(`
      INSERT OR IGNORE INTO lead_identities (identity_key, lead_id, created_at)
      VALUES (?, ?, ?)
    `);
    const findIdentity = db.prepare(
      "SELECT lead_id FROM lead_identities WHERE identity_key = ?",
    );
    const recordConflict = db.prepare(`
      INSERT OR IGNORE INTO lead_identity_conflicts
        (identity_key, canonical_lead_id, duplicate_lead_id, detected_at)
      VALUES (?, ?, ?, ?)
    `);

    for (const lead of leads) {
      const revision =
        Number.isInteger(lead.revision) && lead.revision > 0
          ? lead.revision
          : 1;
      const storedLead: Record<string, any> = {
        ...normalizeStoredLead(lead),
        revision,
      };
      const cols = extractPromotedLeadColumns(storedLead);
      insertLead.run(
        storedLead.id,
        JSON.stringify(storedLead),
        typeof storedLead.createdAt === "string" ? storedLead.createdAt : now,
        now,
        revision,
        cols.fullName,
        cols.company,
        cols.title,
        cols.stage,
        cols.reviewStatus,
        cols.nextAction,
        cols.score,
        cols.email,
      );
      const identityKey = leadIdentityKey(storedLead);
      if (identityKey) {
        claimIdentity.run(
          identityKey,
          storedLead.id,
          typeof storedLead.createdAt === "string" ? storedLead.createdAt : now,
        );
        const mapped = findIdentity.get(identityKey) as
          | { lead_id?: string }
          | undefined;
        if (mapped?.lead_id && mapped.lead_id !== storedLead.id) {
          recordConflict.run(identityKey, mapped.lead_id, storedLead.id, now);
        }
      }
    }

    db.prepare(
      `
      INSERT INTO app_meta (key, value, updated_at)
      VALUES ('leads_initialized', 'true', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    ).run(now);

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.error("SQLite rollback failed:", rollbackError);
    }
    throw error;
  }
}

export class LeadRevisionConflictError extends Error {
  constructor(public readonly currentLead: Record<string, any>) {
    super(
      "This lead was changed by a newer request. Reload it before saving again.",
    );
    this.name = "LeadRevisionConflictError";
  }
}

export class LeadNotFoundError extends Error {
  constructor(public readonly leadId: string) {
    super("This lead was removed before the update completed.");
    this.name = "LeadNotFoundError";
  }
}

export type LeadWriteDisposition = "created" | "updated" | "duplicate";

export type LeadWriteResult = {
  disposition: LeadWriteDisposition;
  lead: Record<string, any>;
  incomingLeadId: string;
  identityKey?: string;
};

type LeadWriteOptions = { requireExisting?: boolean };

const leadIdentityKey = (lead: Record<string, any>) =>
  canonicalLinkedInIdentity(
    lead?.profile?.contactDetails?.linkedinUrl ||
      lead?.contactDetails?.linkedinUrl ||
      lead?.linkedinUrl ||
      lead?.sourceUrl,
  );

const readLeadFromRow = (
  row: { payload: string; revision: number } | undefined,
) => {
  if (!row) return null;
  try {
    return {
      ...normalizeStoredLead(JSON.parse(row.payload)),
      revision: Number(row.revision || 1),
    } as Record<string, any>;
  } catch (error) {
    console.warn(
      "Skipping unreadable canonical lead record from SQLite:",
      error,
    );
    return null;
  }
};

export function upsertLeadInExistingTransaction(
  db: DatabaseSync,
  lead: Record<string, any>,
  options: LeadWriteOptions = {},
): LeadWriteResult {
  const now = new Date().toISOString();
  const incomingLeadId = String(lead.id || "");
  const existing = getCachedStatement(
    db,
    "SELECT payload, revision FROM leads WHERE id = ?",
  ).get(incomingLeadId) as { payload: string; revision: number } | undefined;
  if (!existing && options.requireExisting) {
    throw new LeadNotFoundError(incomingLeadId);
  }

  const identityKey = leadIdentityKey(lead);
  if (identityKey) {
    const identity = getCachedStatement(
      db,
      "SELECT lead_id FROM lead_identities WHERE identity_key = ?",
    ).get(identityKey) as { lead_id?: string } | undefined;
    if (identity?.lead_id && identity.lead_id !== incomingLeadId) {
      const canonicalRow = getCachedStatement(
        db,
        "SELECT payload, revision FROM leads WHERE id = ?",
      ).get(identity.lead_id) as
        | { payload: string; revision: number }
        | undefined;
      const canonicalLead = readLeadFromRow(canonicalRow);
      if (canonicalLead) {
        return {
          disposition: "duplicate",
          lead: canonicalLead,
          incomingLeadId,
          identityKey,
        };
      }
      // A stale mapping should never survive a normal delete, but recovering it
      // here keeps a corrupted legacy database from blocking the valid lead.
      getCachedStatement(
        db,
        "DELETE FROM lead_identities WHERE identity_key = ?",
      ).run(identityKey);
    }
  }

  const expectedRevision = Number.isInteger(lead.revision)
    ? Number(lead.revision)
    : undefined;
  if (
    existing &&
    expectedRevision !== undefined &&
    expectedRevision !== Number(existing.revision || 1)
  ) {
    throw new LeadRevisionConflictError(
      readLeadFromRow(existing) || {
        ...lead,
        revision: Number(existing.revision || 1),
      },
    );
  }

  const revision = existing ? Number(existing.revision || 1) + 1 : 1;
  const storedLead: Record<string, any> = {
    ...normalizeStoredLead(lead),
    revision,
  };
  const cols = extractPromotedLeadColumns(storedLead);

  getCachedStatement(
    db,
    `
    INSERT INTO leads (
      id, payload, created_at, updated_at, revision,
      full_name, company, title, stage, review_status, next_action, score, email
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      revision = excluded.revision,
      full_name = excluded.full_name,
      company = excluded.company,
      title = excluded.title,
      stage = excluded.stage,
      review_status = excluded.review_status,
      next_action = excluded.next_action,
      score = excluded.score,
      email = excluded.email
  `,
  ).run(
    storedLead.id,
    JSON.stringify(storedLead),
    typeof storedLead.createdAt === "string" ? storedLead.createdAt : now,
    now,
    revision,
    cols.fullName,
    cols.company,
    cols.title,
    cols.stage,
    cols.reviewStatus,
    cols.nextAction,
    cols.score,
    cols.email,
  );

  getCachedStatement(
    db,
    "DELETE FROM lead_identities WHERE lead_id = ? AND identity_key <> ?",
  ).run(storedLead.id, identityKey || "");
  if (identityKey) {
    getCachedStatement(
      db,
      `
      INSERT INTO lead_identities (identity_key, lead_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(identity_key) DO UPDATE SET lead_id = excluded.lead_id
    `,
    ).run(identityKey, storedLead.id, now);
  }

  getCachedStatement(
    db,
    `
    INSERT INTO app_meta (key, value, updated_at)
    VALUES ('leads_initialized', 'true', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `,
  ).run(now);

  return {
    disposition: existing ? "updated" : "created",
    lead: storedLead,
    incomingLeadId,
    identityKey: identityKey || undefined,
  };
}

export function upsertLeadWithIdentity(
  lead: Record<string, any>,
  options: LeadWriteOptions = {},
): LeadWriteResult {
  const db = getLeadsDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = upsertLeadInExistingTransaction(db, lead, options);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw error;
  }
}

export function upsertLead(
  lead: Record<string, any>,
  options: LeadWriteOptions = {},
) {
  return upsertLeadWithIdentity(lead, options).lead;
}

export function deleteLead(id: string) {
  const db = getLeadsDb();
  db.prepare("DELETE FROM leads WHERE id = ?").run(id);
}

export function transferLeadIdentities(
  db: DatabaseSync,
  fromLeadId: string,
  toLeadId: string,
) {
  db.prepare("UPDATE lead_identities SET lead_id = ? WHERE lead_id = ?").run(
    toLeadId,
    fromLeadId,
  );
}

export function upsertLeadsWithIdentity(
  leads: Record<string, any>[],
  options: LeadWriteOptions = {},
): LeadWriteResult[] {
  const db = getLeadsDb();
  const results: LeadWriteResult[] = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const lead of leads) {
      results.push(upsertLeadInExistingTransaction(db, lead, options));
    }
    db.exec("COMMIT");
    return results;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      console.error("SQLite rollback failed:", rollbackError);
    }
    throw error;
  }
}

export function upsertLeads(
  leads: Record<string, any>[],
  options: LeadWriteOptions = {},
) {
  return upsertLeadsWithIdentity(leads, options).map((result) => result.lead);
}

const normalizeCacheValue = (value?: string) =>
  (value || "").trim().toLowerCase();

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
    intentFingerprint: row.intent_fingerprint || undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
};

export function pruneExpiredEnrichmentCache(now = new Date()) {
  const db = getLeadsDb();
  const cutoff = now.toISOString();
  const result = db
    .prepare("DELETE FROM enrichment_cache WHERE expires_at <= ?")
    .run(cutoff);
  return Number(result.changes || 0);
}

export function getEnrichmentCacheEntry(
  lookup: EnrichmentCacheLookup,
  now = new Date(),
) {
  const db = getLeadsDb();
  const cutoff = now.toISOString();
  const normalizedUrl = normalizeCacheValue(lookup.normalizedUrl);
  const linkedinUsername = normalizeCacheValue(lookup.linkedinUsername);
  const personName = normalizeCacheValue(lookup.personName);
  const companyName = normalizeCacheValue(lookup.companyName);

  if (normalizedUrl || linkedinUsername) {
    const row = db
      .prepare(
        `
      SELECT * FROM enrichment_cache
      WHERE expires_at > ?
        AND scrape_quality IN ('good', 'partial')
        AND (
          (? != '' AND normalized_url = ?)
          OR (? != '' AND linkedin_username = ?)
        )
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(
        cutoff,
        normalizedUrl,
        normalizedUrl,
        linkedinUsername,
        linkedinUsername,
      );
    const match = toCacheRow(row);
    if (match) return match;
  }

  if (personName && companyName) {
    const row = db
      .prepare(
        `
      SELECT * FROM enrichment_cache
      WHERE expires_at > ?
        AND scrape_quality IN ('good', 'partial')
        AND person_name = ?
        AND company_name = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(cutoff, personName, companyName);
    return toCacheRow(row);
  }

  return null;
}

export function upsertEnrichmentCacheEntry(
  entry: EnrichmentCacheEntry,
  ttlDays = 7,
  now = new Date(),
) {
  if (!entry.evidenceBlock) return null;

  const db = getLeadsDb();
  const createdAt = entry.createdAt || now.toISOString();
  const expiresAt =
    entry.expiresAt ||
    new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const normalizedUrl = normalizeCacheValue(entry.normalizedUrl);
  const linkedinUsername = normalizeCacheValue(entry.linkedinUsername);
  const personName = normalizeCacheValue(entry.personName);
  const companyName = normalizeCacheValue(entry.companyName);
  const intentFingerprint = entry.intentFingerprint
    ? entry.intentFingerprint.trim()
    : null;
  const id =
    entry.id ||
    crypto
      .createHash("sha256")
      .update(
        [
          normalizedUrl,
          linkedinUsername,
          personName,
          companyName,
          intentFingerprint,
        ]
          .filter(Boolean)
          .join("|") || crypto.randomUUID(),
      )
      .digest("hex");

  db.prepare(
    `
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
      intent_fingerprint,
      created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      normalized_url = excluded.normalized_url,
      linkedin_username = excluded.linkedin_username,
      person_name = excluded.person_name,
      company_name = excluded.company_name,
      public_email = excluded.public_email,
      evidence_block = excluded.evidence_block,
      scrape_quality = excluded.scrape_quality,
      source_provider = excluded.source_provider,
      intent_fingerprint = excluded.intent_fingerprint,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `,
  ).run(
    id,
    normalizedUrl || null,
    linkedinUsername || null,
    personName || null,
    companyName || null,
    isUsableEmail(entry.publicEmail)
      ? entry.publicEmail.trim().toLowerCase()
      : null,
    entry.evidenceBlock,
    entry.scrapeQuality,
    entry.sourceProvider,
    intentFingerprint,
    createdAt,
    expiresAt,
  );

  if (++pruneEnrichmentCounter % 50 === 0) {
    pruneExpiredEnrichmentCache(now);
  }
  return { ...entry, id, createdAt, expiresAt };
}

export function getIntentCacheEntry(
  normalizedUrl: string,
  intentFingerprint: string,
  now = new Date(),
): EnrichmentCacheEntry | null {
  const db = getLeadsDb();
  const cutoff = now.toISOString();
  const cleanUrl = normalizeCacheValue(normalizedUrl);
  const cleanFp = (intentFingerprint || "").trim();

  if (!cleanUrl || !cleanFp) return null;

  const row = db
    .prepare(
      `
    SELECT * FROM enrichment_cache
    WHERE expires_at > ?
      AND normalized_url = ?
      AND intent_fingerprint = ?
    ORDER BY created_at DESC
    LIMIT 1
  `,
    )
    .get(cutoff, cleanUrl, cleanFp);

  return toCacheRow(row);
}

export function upsertIntentCacheEntry(
  entry: EnrichmentCacheEntry & { intentFingerprint: string },
  ttlDays = 7,
  now = new Date(),
) {
  return upsertEnrichmentCacheEntry(entry, ttlDays, now);
}

export function getIntentCacheEntriesBatch(
  keys: Array<{ normalizedUrl: string; intentFingerprint: string }>,
  now = new Date(),
): Map<string, EnrichmentCacheEntry> {
  const result = new Map<string, EnrichmentCacheEntry>();
  if (!keys.length) return result;

  const validKeys = keys
    .map((k) => ({
      url: normalizeCacheValue(k.normalizedUrl),
      fp: (k.intentFingerprint || "").trim(),
    }))
    .filter((k) => k.url && k.fp);

  if (!validKeys.length) return result;

  const urls = Array.from(new Set(validKeys.map((k) => k.url)));
  const fps = Array.from(new Set(validKeys.map((k) => k.fp)));

  const rows = getLeadsDb()
    .prepare(
      `
    SELECT * FROM enrichment_cache
    WHERE expires_at > ?
      AND normalized_url IN (${urls.map(() => "?").join(",")})
      AND intent_fingerprint IN (${fps.map(() => "?").join(",")})
    ORDER BY created_at DESC
  `,
    )
    .all(now.toISOString(), ...urls, ...fps) as any[];

  for (const row of rows) {
    const entry = toCacheRow(row);
    if (!entry || !entry.normalizedUrl || !row.intent_fingerprint) continue;
    const compoundKey = `${entry.normalizedUrl}::${row.intent_fingerprint}`;
    if (!result.has(compoundKey)) {
      result.set(compoundKey, entry);
    }
  }
  return result;
}

/**
 * Batch positive-cache lookup: one query for many targets. Returns a map
 * keyed by both normalized_url and linkedin_username forms pointing at the
 * best (newest) entry per key. Semantically equivalent to calling
 * getEnrichmentCacheEntry per lookup, minus the N+1 round-trips.
 */
export function getEnrichmentCacheEntriesBatch(
  lookups: EnrichmentCacheLookup[],
  now = new Date(),
): Map<string, EnrichmentCacheEntry> {
  const result = new Map<string, EnrichmentCacheEntry>();
  if (!lookups.length) return result;

  const urls = Array.from(
    new Set(
      lookups.map((l) => normalizeCacheValue(l.normalizedUrl)).filter(Boolean),
    ),
  );
  const usernames = Array.from(
    new Set(
      lookups
        .map((l) => normalizeCacheValue(l.linkedinUsername))
        .filter(Boolean),
    ),
  );
  if (!urls.length && !usernames.length) return result;

  const clauses: string[] = [];
  const params: any[] = [now.toISOString()];
  if (urls.length) {
    clauses.push(`normalized_url IN (${urls.map(() => "?").join(",")})`);
    params.push(...urls);
  }
  if (usernames.length) {
    clauses.push(
      `linkedin_username IN (${usernames.map(() => "?").join(",")})`,
    );
    params.push(...usernames);
  }

  const rows = getLeadsDb()
    .prepare(
      `
      SELECT * FROM enrichment_cache
      WHERE expires_at > ?
        AND scrape_quality IN ('good', 'partial')
        AND (${clauses.join(" OR ")})
      ORDER BY created_at DESC
    `,
    )
    .all(...params) as any[];

  for (const row of rows) {
    const entry = toCacheRow(row);
    if (!entry) continue;
    // Rows are newest-first; first write per key wins.
    if (entry.normalizedUrl && !result.has(entry.normalizedUrl)) {
      result.set(entry.normalizedUrl, entry);
    }
    if (entry.linkedinUsername && !result.has(entry.linkedinUsername)) {
      result.set(entry.linkedinUsername, entry);
    }
  }
  return result;
}

/**
 * Batch negative-cache lookup: one query for many targets, keyed the same way
 * as getEnrichmentCacheEntriesBatch.
 */
export function getNegativeEnrichmentCacheEntriesBatch(
  lookups: EnrichmentCacheLookup[],
  now = new Date(),
  sourceProvider = "brightdata",
): Map<string, EnrichmentCacheEntry> {
  const result = new Map<string, EnrichmentCacheEntry>();
  if (!lookups.length) return result;

  const urls = Array.from(
    new Set(
      lookups.map((l) => normalizeCacheValue(l.normalizedUrl)).filter(Boolean),
    ),
  );
  const usernames = Array.from(
    new Set(
      lookups
        .map((l) => normalizeCacheValue(l.linkedinUsername))
        .filter(Boolean),
    ),
  );
  if (!urls.length && !usernames.length) return result;

  const clauses: string[] = [];
  const params: any[] = [now.toISOString(), sourceProvider];
  if (urls.length) {
    clauses.push(`normalized_url IN (${urls.map(() => "?").join(",")})`);
    params.push(...urls);
  }
  if (usernames.length) {
    clauses.push(
      `linkedin_username IN (${usernames.map(() => "?").join(",")})`,
    );
    params.push(...usernames);
  }

  const rows = getLeadsDb()
    .prepare(
      `
      SELECT * FROM enrichment_cache
      WHERE expires_at > ?
        AND scrape_quality = 'bad'
        AND source_provider = ?
        AND (${clauses.join(" OR ")})
      ORDER BY created_at DESC
    `,
    )
    .all(...params) as any[];

  for (const row of rows) {
    const entry = toCacheRow(row);
    if (!entry) continue;
    if (entry.normalizedUrl && !result.has(entry.normalizedUrl)) {
      result.set(entry.normalizedUrl, entry);
    }
    if (entry.linkedinUsername && !result.has(entry.linkedinUsername)) {
      result.set(entry.linkedinUsername, entry);
    }
  }
  return result;
}

export function getNegativeEnrichmentCacheEntry(
  lookup: EnrichmentCacheLookup,
  now = new Date(),
  sourceProvider = "brightdata",
) {
  const db = getLeadsDb();
  const cutoff = now.toISOString();
  const normalizedUrl = normalizeCacheValue(lookup.normalizedUrl);
  const linkedinUsername = normalizeCacheValue(lookup.linkedinUsername);

  if (normalizedUrl || linkedinUsername) {
    const row = db
      .prepare(
        `
      SELECT * FROM enrichment_cache
      WHERE expires_at > ?
        AND scrape_quality = 'bad'
        AND source_provider = ?
        AND (
          (? != '' AND normalized_url = ?)
          OR (? != '' AND linkedin_username = ?)
        )
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .get(
        cutoff,
        sourceProvider,
        normalizedUrl,
        normalizedUrl,
        linkedinUsername,
        linkedinUsername,
      );
    const match = toCacheRow(row);
    if (match) return match;
  }

  return null;
}

export function upsertNegativeEnrichmentCacheEntry(
  entry: EnrichmentCacheEntry,
  ttlHours = 24,
  now = new Date(),
) {
  let effectiveHours = ttlHours;
  const anyEntry = entry as any;
  const reason = String(anyEntry.rawPayload?.error || anyEntry.rawPayload?.reason || entry.evidenceBlock || '').toLowerCase();
  const isTransient = /rate.?limit|429|timeout|etimedout|econnreset|5\d\d|service unavailable|overloaded/i.test(reason);

  if (isTransient) {
    // If transient error, only cache for 15 minutes (0.25 hours) instead of 24h/14d
    effectiveHours = Math.min(ttlHours, 0.25);
  }

  return upsertEnrichmentCacheEntry(
    {
      ...entry,
      scrapeQuality: "bad",
      sourceProvider: entry.sourceProvider || "brightdata",
    },
    effectiveHours / 24,
    now,
  );
}

export function insertSearchLog(log: any) {
  try {
    const db = getLeadsDb();
    const insertStmt = getCachedStatement(
      db,
      `
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
    `,
    );
    insertStmt.run(
      log.id,
      log.timestamp,
      log.prompt,
      JSON.stringify(log.generatedQueries || []),
      log.status,
      log.errorMessage || "",
      log.rawResultsCount || 0,
      log.leadsFound || 0,
      log.detailedLogs || "",
      log.debugLogs || "",
      JSON.stringify(log.traceEvents || []),
      JSON.stringify(log.providerSummary || {}),
      JSON.stringify(log.costSummary || {}),
      JSON.stringify(log.phaseTimeline || []),
      Number(log.schemaVersion || 1),
    );

    const retentionLimit = clampSearchLogRetentionLimit();
    const cullStmt = getCachedStatement(
      db,
      `
      DELETE FROM search_logs
      WHERE id NOT IN (
        SELECT id FROM search_logs
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `,
    );
    cullStmt.run(retentionLimit);
  } catch (err) {
    console.error("Failed to write search log to DB:", err);
  }
}

const parseJSONField = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== "string" || !value.trim()) return fallback;
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
  detailedLogs: row.detailed_logs || "",
  debugLogs: row.debug_logs || "",
  traceEvents: parseJSONField<any[]>(row.trace_events, []),
  providerSummary: parseJSONField<Record<string, any>>(
    row.provider_summary,
    {},
  ),
  costSummary: parseJSONField<Record<string, any>>(row.cost_summary, {}),
  phaseTimeline: parseJSONField<any[]>(row.phase_timeline, []),
  schemaVersion: Number(row.schema_version || 1),
});

export function readSearchLogs(limit = 30) {
  const rows = getLeadsDb()
    .prepare(
      "SELECT id, timestamp, prompt, generated_queries, status, error_message, raw_results_count, leads_found, detailed_logs, debug_logs, trace_events, provider_summary, cost_summary, phase_timeline, schema_version FROM search_logs ORDER BY timestamp DESC LIMIT ?",
    )
    .all(limit) as any[];
  return rows.map(toSearchLogRecord);
}

export function readSearchLogById(id: string) {
  const row = getLeadsDb()
    .prepare("SELECT * FROM search_logs WHERE id = ?")
    .get(id) as any | undefined;
  return row ? toSearchLogRecord(row) : null;
}

export function insertLlmStageLog(entry: LlmStageLogEntry) {
  try {
    const db = getLeadsDb();
    const insertStmt = getCachedStatement(
      db,
      `
      INSERT INTO llm_stage_logs (
        id, search_log_id, stage, round, status,
        input_tokens, output_tokens, latency_ms, model_name, provider, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    insertStmt.run(
      crypto.randomUUID(),
      entry.searchLogId || null,
      entry.stage || "unknown",
      Number(entry.round || 1),
      entry.status || "unknown",
      Number(entry.inputTokens || 0),
      Number(entry.outputTokens || 0),
      Number(entry.latencyMs || 0),
      entry.modelName || null,
      entry.provider || "llm",
      entry.createdAt || new Date().toISOString(),
    );
  } catch (error) {
    console.warn("Failed to insert llm_stage_log:", error);
  }
}

export function readLlmStageLogs(searchLogId?: string): LlmStageLogEntry[] {
  const db = getLeadsDb();
  if (searchLogId) {
    const rows = db
      .prepare(
        "SELECT * FROM llm_stage_logs WHERE search_log_id = ? ORDER BY created_at ASC",
      )
      .all(searchLogId) as any[];
    return rows.map(mapLlmStageLogRow);
  }
  const rows = db
    .prepare("SELECT * FROM llm_stage_logs ORDER BY created_at DESC LIMIT 500")
    .all() as any[];
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
    createdAt: row.created_at,
  };
}

export function getIcpHypothesisCache(query: string): any | null {
  try {
    const db = getLeadsDb();
    const queryHash = crypto
      .createHash("sha256")
      .update(query.trim().toLowerCase())
      .digest("hex");
    const now = new Date().toISOString();
    const row = db
      .prepare(
        "SELECT hypothesis_json FROM icp_hypothesis_cache WHERE query_hash = ? AND expires_at > ?",
      )
      .get(queryHash, now) as any | undefined;
    if (!row) return null;
    return JSON.parse(row.hypothesis_json);
  } catch (err) {
    return null;
  }
}

export function upsertIcpHypothesisCache(
  query: string,
  hypothesis: any,
  ttlDays = 7,
) {
  try {
    const db = getLeadsDb();
    const queryHash = crypto
      .createHash("sha256")
      .update(query.trim().toLowerCase())
      .digest("hex");
    const now = new Date();
    const expires = new Date(
      now.getTime() + ttlDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.prepare(
      `
      INSERT INTO icp_hypothesis_cache (query_hash, raw_query, hypothesis_json, synthesized_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(query_hash) DO UPDATE SET
        raw_query = excluded.raw_query,
        hypothesis_json = excluded.hypothesis_json,
        synthesized_at = excluded.synthesized_at,
        expires_at = excluded.expires_at
    `,
    ).run(
      queryHash,
      query.trim(),
      JSON.stringify(hypothesis),
      now.toISOString(),
      expires,
    );
  } catch (err) {
    console.warn("Failed to cache ICP hypothesis:", err);
  }
}

export function getProspectContractCache(
  cacheKey: string,
  policyVersion: string,
): any | null {
  try {
    const db = getLeadsDb();
    const row = db
      .prepare(
        `
      SELECT contract_json FROM prospect_contract_cache
      WHERE cache_key = ? AND policy_version = ? AND expires_at > ?
    `,
      )
      .get(cacheKey, policyVersion, new Date().toISOString()) as
      | { contract_json?: string }
      | undefined;
    return row?.contract_json ? JSON.parse(row.contract_json) : null;
  } catch (error) {
    return null;
  }
}

export function upsertProspectContractCache(
  cacheKey: string,
  rawBrief: string,
  policyVersion: string,
  contract: any,
  ttlDays = 7,
) {
  try {
    const db = getLeadsDb();
    const createdAt = new Date();
    const expiresAt = new Date(
      createdAt.getTime() +
        Math.min(Math.max(ttlDays, 1), 30) * 24 * 60 * 60 * 1000,
    );
    db.prepare(
      `
      INSERT INTO prospect_contract_cache (cache_key, raw_brief, policy_version, contract_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        raw_brief = excluded.raw_brief,
        policy_version = excluded.policy_version,
        contract_json = excluded.contract_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `,
    ).run(
      cacheKey,
      rawBrief.slice(0, 2000),
      policyVersion,
      JSON.stringify(contract),
      createdAt.toISOString(),
      expiresAt.toISOString(),
    );
  } catch (error) {
    console.warn("[db] Failed to cache prospect contract:", error);
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
  lastRunAt: row.last_run_at || undefined,
});

export function readSavedSearches(limit = 50) {
  const rows = getLeadsDb()
    .prepare(
      `
    SELECT * FROM saved_searches ORDER BY updated_at DESC LIMIT ?
  `,
    )
    .all(Math.min(Math.max(Math.floor(limit) || 50, 1), 100)) as any[];
  return rows.map(toSavedSearchRecord);
}

export function readSavedSearchById(id: string) {
  const row = getLeadsDb()
    .prepare("SELECT * FROM saved_searches WHERE id = ?")
    .get(id) as any | undefined;
  return row ? toSavedSearchRecord(row) : null;
}

export function upsertSavedSearch(
  input: Omit<
    SavedSearchRecord,
    "id" | "createdAt" | "updatedAt" | "lastRunAt"
  > & { id?: string },
) {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  const existing = input.id ? readSavedSearchById(input.id) : null;
  const record: SavedSearchRecord = {
    id: input.id || crypto.randomUUID(),
    name: String(input.name || "")
      .trim()
      .slice(0, 120),
    query: String(input.query || "")
      .trim()
      .slice(0, 1000),
    spec: input.spec && typeof input.spec === "object" ? input.spec : {},
    mode: String(input.mode || "person_first")
      .trim()
      .slice(0, 40),
    maxPerCompany: Math.min(
      Math.max(Math.floor(Number(input.maxPerCompany) || 2), 1),
      10,
    ),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
  };
  if (!record.name || !record.query)
    throw new Error("A saved search needs a name and a query.");

  db.prepare(
    `
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
  `,
  ).run(
    record.id,
    record.name,
    record.query,
    JSON.stringify(record.spec),
    record.mode,
    record.maxPerCompany,
    record.createdAt,
    record.updatedAt,
    record.lastRunAt || null,
  );
  return record;
}

export function deleteSavedSearch(id: string) {
  return Number(
    getLeadsDb().prepare("DELETE FROM saved_searches WHERE id = ?").run(id)
      .changes || 0,
  );
}

export function markSavedSearchRun(id: string, now = new Date().toISOString()) {
  getLeadsDb()
    .prepare(
      `
    UPDATE saved_searches SET last_run_at = ?, updated_at = ? WHERE id = ?
  `,
    )
    .run(now, now, id);
}

export function getSavedSearchExcludeList(id: string): string[] {
  try {
    const row = getLeadsDb()
      .prepare("SELECT exclude_list_json FROM saved_searches WHERE id = ?")
      .get(id) as { exclude_list_json?: string } | undefined;
    if (!row?.exclude_list_json) return [];
    const parsed = JSON.parse(row.exclude_list_json);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function updateSavedSearchExcludeList(
  id: string,
  newIdentities: string[],
  maxLimit = 5000,
) {
  try {
    const existing = getSavedSearchExcludeList(id);
    const set = new Set(existing);
    for (const identity of newIdentities) {
      if (identity && typeof identity === "string") {
        set.add(identity.trim().toLowerCase());
      }
    }
    const combined = Array.from(set).slice(-maxLimit);
    getLeadsDb()
      .prepare(
        "UPDATE saved_searches SET exclude_list_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(combined), new Date().toISOString(), id);
  } catch (error) {
    console.warn("Failed to update saved search exclude list:", error);
  }
}

export type QueryPerformanceUpdate = {
  domainCluster?: string;
  scopeKey?: string;
  family?: string;
  lane?: string;
  provider?: string;
  runs?: number;
  rawCandidates?: number;
  uniqueCandidates?: number;
  extractedCandidates?: number;
  acceptedCandidates?: number;
  duplicateCandidates?: number;
  outcomeRuns?: number;
  qualifiedCandidates?: number;
  rescuedCandidates?: number;
  returnedCandidates?: number;
  judgedCandidates?: number;
  hardFailedCandidates?: number;
  unknownCandidates?: number;
  searchLatencyMs?: number;
  providerUnits?: number;
  requirementFailDigest?: string;
};

export function recordQueryPerformance(update: QueryPerformanceUpdate) {
  const domainCluster = String(update.domainCluster || "global").trim().toLowerCase().slice(0, 80) || "global";
  const family = String(update.family || "general").slice(0, 80);
  const lane = String(update.lane || "person").slice(0, 80);
  const provider = String(update.provider || "tavily").slice(0, 80);
  const scopeKey = update.scopeKey && update.scopeKey.includes("|")
    ? update.scopeKey.toLowerCase()
    : [domainCluster !== "global" ? domainCluster : "", family, lane, provider].filter(Boolean).join("|").toLowerCase();

  getLeadsDb()
    .prepare(
      `
    INSERT INTO query_performance (
      scope_key, domain_cluster, family, lane, provider, runs, raw_candidates, unique_candidates,
      extracted_candidates, accepted_candidates, duplicate_candidates, outcome_runs,
      qualified_candidates, rescued_candidates, returned_candidates, search_latency_ms,
      provider_units, judged_candidates, hard_failed_candidates, unknown_candidates,
      requirement_fail_digest, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET
      domain_cluster = excluded.domain_cluster,
      runs = CAST(ROUND(query_performance.runs * 0.95 + excluded.runs) AS INTEGER),
      raw_candidates = CAST(ROUND(query_performance.raw_candidates * 0.95 + excluded.raw_candidates) AS INTEGER),
      unique_candidates = CAST(ROUND(query_performance.unique_candidates * 0.95 + excluded.unique_candidates) AS INTEGER),
      extracted_candidates = CAST(ROUND(query_performance.extracted_candidates * 0.95 + excluded.extracted_candidates) AS INTEGER),
      accepted_candidates = CAST(ROUND(query_performance.accepted_candidates * 0.95 + excluded.accepted_candidates) AS INTEGER),
      duplicate_candidates = CAST(ROUND(query_performance.duplicate_candidates * 0.95 + excluded.duplicate_candidates) AS INTEGER),
      outcome_runs = CAST(ROUND(query_performance.outcome_runs * 0.95 + excluded.outcome_runs) AS INTEGER),
      qualified_candidates = CAST(ROUND(query_performance.qualified_candidates * 0.95 + excluded.qualified_candidates) AS INTEGER),
      rescued_candidates = CAST(ROUND(query_performance.rescued_candidates * 0.95 + excluded.rescued_candidates) AS INTEGER),
      returned_candidates = CAST(ROUND(query_performance.returned_candidates * 0.95 + excluded.returned_candidates) AS INTEGER),
      search_latency_ms = CASE WHEN excluded.search_latency_ms > 0 THEN CAST(ROUND(query_performance.search_latency_ms * 0.95 + excluded.search_latency_ms) AS INTEGER) ELSE query_performance.search_latency_ms END,
      provider_units = CAST(ROUND(query_performance.provider_units * 0.95 + excluded.provider_units) AS INTEGER),
      judged_candidates = CAST(ROUND(query_performance.judged_candidates * 0.95 + excluded.judged_candidates) AS INTEGER),
      hard_failed_candidates = CAST(ROUND(query_performance.hard_failed_candidates * 0.95 + excluded.hard_failed_candidates) AS INTEGER),
      unknown_candidates = CAST(ROUND(query_performance.unknown_candidates * 0.95 + excluded.unknown_candidates) AS INTEGER),
      requirement_fail_digest = COALESCE(excluded.requirement_fail_digest, query_performance.requirement_fail_digest),
      updated_at = excluded.updated_at
  `,
    )
    .run(
      scopeKey,
      domainCluster,
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
      Math.max(0, Math.floor(update.judgedCandidates || 0)),
      Math.max(0, Math.floor(update.hardFailedCandidates || 0)),
      Math.max(0, Math.floor(update.unknownCandidates || 0)),
      update.requirementFailDigest || null,
      new Date().toISOString(),
    );
}

export function readQueryPerformance(limit = 100, domainCluster?: string) {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 100, 1), 500);
  const db = getLeadsDb();
  if (domainCluster && domainCluster !== "global") {
    try {
      const clusterRows = db
        .prepare(
          `SELECT * FROM query_performance WHERE domain_cluster = ? OR domain_cluster = 'global' ORDER BY updated_at DESC LIMIT ?`
        )
        .all(domainCluster.toLowerCase(), safeLimit) as any[];
      if (clusterRows.length > 0) return clusterRows;
    } catch {}
  }
  return db
    .prepare(
      `SELECT * FROM query_performance ORDER BY updated_at DESC LIMIT ?`
    )
    .all(safeLimit) as any[];
}

const usagePeriod = (date = new Date()) => date.toISOString().slice(0, 7);

export function readProviderUsage(provider?: string, period = usagePeriod()) {
  const db = getLeadsDb();
  if (provider) {
    const row = db
      .prepare("SELECT * FROM provider_usage WHERE provider = ? AND period = ?")
      .get(provider, period) as any | undefined;
    return row
      ? {
          provider: row.provider,
          period: row.period,
          units: Number(row.units || 0),
          updatedAt: row.updated_at,
        }
      : null;
  }
  return (
    db
      .prepare(
        "SELECT * FROM provider_usage WHERE period = ? ORDER BY provider",
      )
      .all(period) as any[]
  ).map((row) => ({
    provider: row.provider,
    period: row.period,
    units: Number(row.units || 0),
    updatedAt: row.updated_at,
  }));
}

/**
 * Record provider units after a chargeable call. Never blocks discovery -
 * multi-key rotation handles exhausted credits.
 */
export function recordProviderUsage(provider: string, units: number) {
  const requested = Math.max(0, Math.floor(units || 0));
  if (!requested) {
    const used = Number(
      (
        getLeadsDb()
          .prepare(
            "SELECT units FROM provider_usage WHERE provider = ? AND period = ?",
          )
          .get(provider, usagePeriod()) as { units?: number } | undefined
      )?.units || 0,
    );
    return { recorded: false, used, requested };
  }
  const period = usagePeriod();
  const db = getLeadsDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare(
        "SELECT units FROM provider_usage WHERE provider = ? AND period = ?",
      )
      .get(provider, period) as { units?: number } | undefined;
    const used = Number(current?.units || 0);
    db.prepare(
      `
      INSERT INTO provider_usage (provider, period, units, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider, period) DO UPDATE SET
        units = excluded.units,
        updated_at = excluded.updated_at
    `,
    ).run(provider, period, used + requested, new Date().toISOString());
    db.exec("COMMIT");
    return { recorded: true, used: used + requested, requested };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no-op */
    }
    throw error;
  }
}

/**
 * Prefer recordProviderUsage. Hard monthly caps apply only when
 * PROVIDER_CREDIT_RESERVATION=true and monthlyLimit is set; otherwise always
 * allows and records so multi-key rotation can run.
 */
export function reserveProviderUsage(
  provider: string,
  units: number,
  monthlyLimit?: number,
) {
  const reservationEnabled =
    String(process.env.PROVIDER_CREDIT_RESERVATION || "")
      .trim()
      .toLowerCase() === "true";
  const requested = Math.max(0, Math.floor(units || 0));
  if (
    !reservationEnabled ||
    monthlyLimit === undefined ||
    monthlyLimit === null
  ) {
    const recorded = recordProviderUsage(provider, requested);
    return {
      allowed: true,
      used: recorded.used - (recorded.recorded ? requested : 0),
      requested,
      remaining: undefined as number | undefined,
    };
  }
  const period = usagePeriod();
  const db = getLeadsDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = db
      .prepare(
        "SELECT units FROM provider_usage WHERE provider = ? AND period = ?",
      )
      .get(provider, period) as { units?: number } | undefined;
    const used = Number(current?.units || 0);
    const allowed = used + requested <= monthlyLimit;
    if (allowed && requested) {
      db.prepare(
        `
        INSERT INTO provider_usage (provider, period, units, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(provider, period) DO UPDATE SET
          units = excluded.units,
          updated_at = excluded.updated_at
      `,
      ).run(provider, period, used + requested, new Date().toISOString());
    }
    db.exec("COMMIT");
    return {
      allowed,
      used,
      requested,
      remaining: Math.max(0, monthlyLimit - used - (allowed ? requested : 0)),
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no-op */
    }
    throw error;
  }
}

export type MiningSessionStatus =
  | "running"
  | "cancellation_requested"
  | "success"
  | "error"
  | "cancelled"
  | "interrupted";

export type MiningSessionCheckpoint = {
  sessionId: string;
  round: number;
  stage: string;
  promptQuery: string;
  targetLimit: number;
  contract: any;
  searchSpec?: any;
  queryRuns: any[];
  acceptedLeads: any[];
  qualifiedLeads: any[];
  finalLeads: any[];
  rejectionCounts: Record<string, number>;
  failureCounts: Record<string, number>;
  brightDataStats: any;
  previousRoundSummary?: any;
  evidenceByUrl?: Record<string, any>;
  leadQueryRunMap?: Record<string, any>;
  /** Runs added since the previous checkpoint (delta serialization). */
  queryRunsDelta?: any[];
  /** Last N debug-log entries, persisted so crash context survives resume. */
  debugLogsTail?: any[];
  signalStoreState?: any;
  recoveryAttempts?: number;
  updatedAt: string;
};

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
  checkpoint?: MiningSessionCheckpoint;
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
  stats: parseJSONField<Record<string, unknown> | undefined>(
    row.stats_json,
    undefined,
  ),
  traceSummary: parseJSONField<Record<string, unknown> | undefined>(
    row.trace_summary_json,
    undefined,
  ),
  checkpoint: parseJSONField<MiningSessionCheckpoint | undefined>(
    row.checkpoint_json,
    undefined,
  ),
  updatedAt: row.updated_at,
});

export function readMiningSessionById(id: string) {
  const row = getLeadsDb()
    .prepare("SELECT * FROM mining_sessions WHERE id = ?")
    .get(id) as any | undefined;
  return row ? toMiningSessionRecord(row) : null;
}

export function readMiningSessionSummaryById(id: string): MiningSessionRecord | null {
  const row = getLeadsDb()
    .prepare(
      "SELECT id, status, prompt, requested_limit, started_at, completed_at, cancellation_requested_at, error_message, stats_json, trace_summary_json, updated_at FROM mining_sessions WHERE id = ?",
    )
    .get(id) as any | undefined;
  return row ? toMiningSessionRecord(row) : null;
}

export function readMiningSessions(limit = 25) {
  const boundedLimit = Math.min(Math.max(Math.floor(limit) || 25, 1), 100);
  const rows = getLeadsDb()
    .prepare(
      "SELECT id, status, prompt, requested_limit, started_at, completed_at, cancellation_requested_at, error_message, stats_json, trace_summary_json, updated_at FROM mining_sessions ORDER BY updated_at DESC LIMIT ?",
    )
    .all(boundedLimit) as any[];
  return rows.map(toMiningSessionRecord);
}

export function readResumableMiningSessions(): MiningSessionRecord[] {
  const rows = getLeadsDb()
    .prepare(
      `
      SELECT * FROM mining_sessions
      WHERE status = 'interrupted' AND checkpoint_json IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 20
    `,
    )
    .all() as any[];
  return rows.map(toMiningSessionRecord);
}

export function saveMiningSessionCheckpoint(
  sessionId: string,
  checkpoint: MiningSessionCheckpoint,
) {
  const db = getLeadsDb();
  const now = checkpoint.updatedAt || new Date().toISOString();
  let payload = JSON.stringify(checkpoint);
  // Size guard: evidence blocks dominate checkpoint weight. If the serialized
  // snapshot exceeds ~512KB, degrade to metadata-only evidence (the resume
  // path's fallback-evidence builder tolerates missing entries gracefully).
  const evidenceCount = checkpoint.evidenceByUrl
    ? Object.keys(checkpoint.evidenceByUrl).length
    : 0;
  if (payload.length > 512_000 && evidenceCount > 0) {
    payload = JSON.stringify({ ...checkpoint, evidenceByUrl: {} });
    console.warn(
      `[checkpoint] ${sessionId}: exceeded 512KB; stripped evidenceByUrl (${evidenceCount} entries).`,
    );
  }
  db.prepare(
    `
    UPDATE mining_sessions
    SET checkpoint_json = ?,
        updated_at = ?
    WHERE id = ?
  `,
  ).run(payload, now, sessionId);
}

export type EngineMetrics = {
  sessionsAnalyzed: number;
  stopReasons: Record<string, number>;
  persistenceStatuses: Record<string, number>;
  avgLeadsFound: number;
  stageTotals: {
    stage: string;
    calls: number;
    totalLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
  }[];
};

/**
 * Aggregate engine health over the last N search logs + their LLM stage
 * entries. Pure SQL over existing tables; no new tables required.
 */
export function readEngineMetrics(limit = 20): EngineMetrics {
  const db = getLeadsDb();
  const boundedLimit = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);

  const sessionRows = db
    .prepare(
      `
    SELECT status, error_message, stats_json, trace_summary_json
    FROM mining_sessions
    ORDER BY updated_at DESC
    LIMIT ?
  `,
    )
    .all(boundedLimit) as any[];

  const stopReasons: Record<string, number> = {};
  const persistenceStatuses: Record<string, number> = {};
  let leadsSum = 0;
  let analyzed = 0;

  for (const row of sessionRows) {
    analyzed++;
    const status = String(row.status || "unknown");
    persistenceStatuses[status] = (persistenceStatuses[status] || 0) + 1;
    try {
      const stats = parseJSONField<Record<string, any>>(row.stats_json, {});
      const stopReason = String(stats?.stopReason || "unknown");
      stopReasons[stopReason] = (stopReasons[stopReason] || 0) + 1;
      leadsSum += Number(stats?.persistedCount || 0);
    } catch {
      // skip malformed stats
    }
  }

  const stageRows = db
    .prepare(
      `
    SELECT stage,
           COUNT(*) AS calls,
           SUM(latency_ms) AS total_latency_ms,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens
    FROM llm_stage_logs
    WHERE created_at >= COALESCE(
      (SELECT MIN(created_at) FROM (
        SELECT created_at FROM llm_stage_logs ORDER BY created_at DESC LIMIT ?
      )),
      datetime('now')
    )
    GROUP BY stage
    ORDER BY calls DESC
  `,
    )
    .all(boundedLimit * 50) as any[];

  return {
    sessionsAnalyzed: analyzed,
    stopReasons,
    persistenceStatuses,
    avgLeadsFound:
      analyzed > 0 ? Math.round((leadsSum / analyzed) * 10) / 10 : 0,
    stageTotals: stageRows.map((row) => ({
      stage: String(row.stage || "unknown"),
      calls: Number(row.calls || 0),
      totalLatencyMs: Number(row.total_latency_ms || 0),
      inputTokens: Number(row.input_tokens || 0),
      outputTokens: Number(row.output_tokens || 0),
    })),
  };
}

export function readMiningSessionCheckpoint(
  sessionId: string,
): MiningSessionCheckpoint | null {
  const db = getLeadsDb();
  const row = db
    .prepare("SELECT checkpoint_json FROM mining_sessions WHERE id = ?")
    .get(sessionId) as { checkpoint_json: string | null } | undefined;
  return row?.checkpoint_json
    ? parseJSONField<MiningSessionCheckpoint | null>(row.checkpoint_json, null)
    : null;
}

export function upsertMiningSession(
  update: Pick<MiningSessionRecord, "id"> &
    Partial<Omit<MiningSessionRecord, "id" | "updatedAt">> & {
      updatedAt?: string;
    },
) {
  const db = getLeadsDb();
  const existing = readMiningSessionById(update.id);
  const now = update.updatedAt || new Date().toISOString();
  const record: MiningSessionRecord = {
    id: update.id,
    status: update.status || existing?.status || "running",
    prompt: update.prompt ?? existing?.prompt ?? "",
    requestedLimit: Number(
      update.requestedLimit ?? existing?.requestedLimit ?? 0,
    ),
    startedAt: update.startedAt ?? existing?.startedAt ?? now,
    completedAt: update.completedAt ?? existing?.completedAt,
    cancellationRequestedAt:
      update.cancellationRequestedAt ?? existing?.cancellationRequestedAt,
    errorMessage: update.errorMessage ?? existing?.errorMessage,
    stats: update.stats ?? existing?.stats,
    traceSummary: update.traceSummary ?? existing?.traceSummary,
    checkpoint: update.checkpoint ?? existing?.checkpoint,
    updatedAt: now,
  };

  db.prepare(
    `
    INSERT INTO mining_sessions (
      id, status, prompt, requested_limit, started_at, completed_at,
      cancellation_requested_at, error_message, stats_json, trace_summary_json, checkpoint_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      checkpoint_json = COALESCE(excluded.checkpoint_json, mining_sessions.checkpoint_json),
      updated_at = excluded.updated_at
  `,
  ).run(
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
    record.checkpoint ? JSON.stringify(record.checkpoint) : null,
    record.updatedAt,
  );

  return record;
}

export function reconcileOrphanedMiningSessions(reason?: string): number {
  const db = getLeadsDb();
  const defaultMessage =
    "Session was active when server process stopped (interrupted).";
  const rows = db
    .prepare(
      `
    SELECT id, checkpoint_json, error_message
    FROM mining_sessions
    WHERE status IN ('running', 'cancellation_requested')
  `,
    )
    .all() as {
    id: string;
    checkpoint_json: string | null;
    error_message: string | null;
  }[];

  for (const row of rows) {
    let msg = reason || row.error_message || defaultMessage;
    if (!reason && row.checkpoint_json) {
      try {
        const cp = JSON.parse(row.checkpoint_json);
        if (cp?.round) {
          msg = `${defaultMessage} Resumable from round ${cp.round}.`;
        }
      } catch {
        // ignore parse error
      }
    }
    getCachedStatement(
      db,
      `
      UPDATE mining_sessions
      SET status = 'interrupted',
          error_message = ?,
          completed_at = COALESCE(completed_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `,
    ).run(msg, row.id);
  }

  return rows.length;
}

export function deleteMiningSession(sessionId: string): boolean {
  const db = getLeadsDb();
  const info = db
    .prepare("DELETE FROM mining_sessions WHERE id = ?")
    .run(sessionId);
  return Number(info.changes) > 0;
}

export function deleteMiningSessions(sessionIds: string[]): number {
  if (!sessionIds.length) return 0;
  const db = getLeadsDb();
  const placeholders = sessionIds.map(() => "?").join(",");
  const info = db
    .prepare(`DELETE FROM mining_sessions WHERE id IN (${placeholders})`)
    .run(...sessionIds);
  return Number(info.changes);
}

export function clearInterruptedMiningSessions(): number {
  const db = getLeadsDb();
  const info = db
    .prepare("DELETE FROM mining_sessions WHERE status = 'interrupted'")
    .run();
  return Number(info.changes);
}

// -- Lead Activities ----------------------------------------------------------

export type LeadActivityType =
  | "stage_change"
  | "note"
  | "enrichment"
  | "import"
  | "merge";

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

export function insertLeadActivity(
  entry: Omit<LeadActivityRecord, "id"> & { id?: string },
): void {
  try {
    const db = getLeadsDb();
    const id = entry.id || crypto.randomUUID();
    db.prepare(
      `
      INSERT OR IGNORE INTO lead_activities (id, lead_id, type, from_value, to_value, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      entry.leadId,
      entry.type,
      entry.fromValue || null,
      entry.toValue,
      entry.actor || "user",
      entry.createdAt || new Date().toISOString(),
    );
  } catch (err) {
    // Activity logging must never fail silently in a way that breaks the main write path.
    console.warn(
      "[db] Failed to insert lead activity:",
      err instanceof Error ? err.message : err,
    );
  }
}

export function readLeadActivities(
  leadId: string,
  limit = 100,
): LeadActivityRecord[] {
  const db = getLeadsDb();
  const rows = db
    .prepare(
      `
    SELECT * FROM lead_activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?
  `,
    )
    .all(leadId, Math.min(limit, 500)) as any[];
  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    type: row.type as LeadActivityType,
    fromValue: row.from_value || undefined,
    toValue: row.to_value,
    actor: row.actor,
    createdAt: row.created_at,
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

export function upsertOutreachDraft(
  draft: OutreachDraftRecord,
): OutreachDraftRecord {
  const db = getLeadsDb();
  const now = new Date().toISOString();
  db.prepare(
    `
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
  `,
  ).run(
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
    now,
  );
  return { ...draft, updatedAt: now };
}

export function readOutreachDrafts(limit = 50): OutreachDraftRecord[] {
  const db = getLeadsDb();
  const rows = db
    .prepare(
      `
    SELECT * FROM outreach_drafts ORDER BY created_at DESC LIMIT ?
  `,
    )
    .all(Math.min(limit, 200)) as any[];
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
    updatedAt: row.updated_at,
  }));
}

export function readOutreachDraftsByLeadId(leadId: string): OutreachDraftRecord[] {
  if (!leadId) return [];
  const db = getLeadsDb();
  const rows = db
    .prepare(
      `
    SELECT * FROM outreach_drafts WHERE lead_id = ? ORDER BY created_at ASC
  `,
    )
    .all(leadId) as any[];
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
    updatedAt: row.updated_at,
  }));
}

export function deleteOutreachDraft(id: string): void {
  getLeadsDb().prepare("DELETE FROM outreach_drafts WHERE id = ?").run(id);
}

export function upsertDiscoveredCompanies(
  companies: Array<{
    companyName: string;
    signalCount?: number;
    strongestSignal?: string;
    sourceUrls?: string[];
    confidence?: number;
  }>,
) {
  if (!Array.isArray(companies) || companies.length === 0) return;
  try {
    const db = getLeadsDb();
    const now = new Date().toISOString();
    const stmt = getCachedStatement(
      db,
      `
      INSERT INTO discovered_companies (
        normalized_name, company_name, signal_count, strongest_signal, source_urls_json, confidence, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(normalized_name) DO UPDATE SET
        signal_count = discovered_companies.signal_count + excluded.signal_count,
        strongest_signal = CASE WHEN length(excluded.strongest_signal) > length(discovered_companies.strongest_signal) THEN excluded.strongest_signal ELSE discovered_companies.strongest_signal END,
        source_urls_json = excluded.source_urls_json,
        confidence = MAX(discovered_companies.confidence, excluded.confidence),
        last_seen_at = excluded.last_seen_at
    `,
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const c of companies) {
        const cleanName = String(c.companyName || '').trim();
        const norm = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!norm || norm.length < 2) continue;
        stmt.run(
          norm,
          cleanName,
          Math.max(1, c.signalCount || 1),
          String(c.strongestSignal || '').slice(0, 300),
          JSON.stringify(c.sourceUrls || []),
          c.confidence ?? 0.7,
          now,
        );
      }
      db.exec("COMMIT");
    } catch (innerErr) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw innerErr;
    }
  } catch (err) {
    console.warn("Failed to upsert discovered companies:", err);
  }
}

export function readDiscoveredCompanyNames(limit = 20): string[] {
  try {
    const db = getLeadsDb();
    const rows = db.prepare(`
      SELECT company_name FROM discovered_companies
      ORDER BY signal_count DESC, last_seen_at DESC
      LIMIT ?
    `).all(limit) as { company_name?: string }[];
    return rows.map(r => r.company_name).filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
}
