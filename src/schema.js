/** Idempotent schema bootstrap — CREATE TABLE IF NOT EXISTS (safe every tick). */

const DDL = `
CREATE TABLE IF NOT EXISTS batches (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  topics_count  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scans (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT,
  topic         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  phase         TEXT NOT NULL DEFAULT 'search',
  auto_refresh  INTEGER NOT NULL DEFAULT 1,
  refresh_hours INTEGER NOT NULL DEFAULT 24,
  next_refresh_at INTEGER,
  pages_total   INTEGER NOT NULL DEFAULT 0,
  pages_done    INTEGER NOT NULL DEFAULT 0,
  knowledge_count INTEGER NOT NULL DEFAULT 0,
  engines_used  TEXT NOT NULL DEFAULT '[]',
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id     TEXT NOT NULL,
  url         TEXT NOT NULL,
  domain      TEXT NOT NULL,
  title       TEXT,
  source      TEXT,
  query       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  http_status INTEGER,
  error       TEXT,
  chars       INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  claimed_at  INTEGER,
  fetched_at  INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (scan_id, url)
);
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL,
  domain      TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'site',
  part        INTEGER NOT NULL DEFAULT 0,
  name        TEXT,
  key         TEXT NOT NULL UNIQUE,
  readable    INTEGER NOT NULL DEFAULT 1,
  origin      TEXT NOT NULL DEFAULT 'seed',
  state       TEXT NOT NULL DEFAULT 'new',
  created_at  INTEGER NOT NULL,
  last_checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ironpin_quotes (
  scan_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  source_last_verified_at INTEGER NOT NULL,
  quote_json TEXT NOT NULL,
  PRIMARY KEY (scan_id, knowledge_id)
);
CREATE INDEX IF NOT EXISTS idx_ironpin_quotes_verified ON ironpin_quotes (source_last_verified_at);
CREATE INDEX IF NOT EXISTS idx_scans_status ON scans (status, phase, next_refresh_at);
CREATE INDEX IF NOT EXISTS idx_scans_batch ON scans (batch_id);
CREATE INDEX IF NOT EXISTS idx_pages_scan_status ON pages (scan_id, status);
CREATE INDEX IF NOT EXISTS idx_pages_claimed ON pages (status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_pages_url ON pages (url);
CREATE INDEX IF NOT EXISTS idx_sources_url ON sources (url);
`;

// One-shot migration for DBs created before batches / sources existed
const MIGRATIONS = [
  'ALTER TABLE scans ADD COLUMN batch_id TEXT',
  'CREATE INDEX IF NOT EXISTS idx_scans_batch ON scans (batch_id)',
  'CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, title TEXT, topics_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'site',
    part INTEGER NOT NULL DEFAULT 0,
    name TEXT,
    key TEXT NOT NULL UNIQUE,
    readable INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL DEFAULT 'seed',
    state TEXT NOT NULL DEFAULT 'new',
    created_at INTEGER NOT NULL,
    last_checked_at INTEGER
  )`,
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_sources_part ON sources (part, kind)',
  'CREATE INDEX IF NOT EXISTS idx_pages_url ON pages (url)',
  'CREATE INDEX IF NOT EXISTS idx_sources_url ON sources (url)',
  'CREATE INDEX IF NOT EXISTS idx_ironpin_quotes_verified ON ironpin_quotes (source_last_verified_at)',
];

let ensured = false;

export async function ensureSchema(env) {
  if (ensured) return;
  try {
    // Split on semicolons at statement boundaries (no triggers/procedures here)
    const stmts = DDL.split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) {
      await env.DB.prepare(stmt).run();
    }
    // Migrations are best-effort (duplicate column / missing table are fine)
    for (const m of MIGRATIONS) {
      try {
        await env.DB.prepare(m).run();
      } catch {
        /* already applied */
      }
    }
    ensured = true;
  } catch (e) {
    console.error('ensureSchema failed', e);
    // don't rethrow — first concurrent request may race; next will retry
  }
}

/** Test helper: allow re-run of ensureSchema in the same process. */
export function resetSchemaCache() {
  ensured = false;
}
