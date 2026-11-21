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

CREATE TABLE IF NOT EXISTS knowledge (
  id              TEXT NOT NULL,
  scan_id         TEXT NOT NULL,
  kind            TEXT NOT NULL,
  topic           TEXT NOT NULL,
  question        TEXT NOT NULL,
  claim           TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'rag',
  attribute       TEXT,
  url             TEXT NOT NULL,
  domain          TEXT NOT NULL,
  confidence      REAL NOT NULL,
  ttl_days        INTEGER NOT NULL DEFAULT 45,
  layer           TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  chunk_index     INTEGER,
  chunk_total     INTEGER,
  tokens          INTEGER,
  offset_chars    INTEGER,
  lang            TEXT,
  created_at      INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL,
  PRIMARY KEY (scan_id, id)
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

CREATE INDEX IF NOT EXISTS idx_scans_status ON scans (status, phase, next_refresh_at);
CREATE INDEX IF NOT EXISTS idx_scans_batch ON scans (batch_id);
CREATE INDEX IF NOT EXISTS idx_pages_scan_status ON pages (scan_id, status);
CREATE INDEX IF NOT EXISTS idx_pages_claimed ON pages (status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_scan ON knowledge (scan_id, kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_attr ON knowledge (attribute, last_verified_at);
CREATE INDEX IF NOT EXISTS idx_sources_part ON sources (part, kind);
CREATE INDEX IF NOT EXISTS idx_pages_url ON pages (url);
CREATE INDEX IF NOT EXISTS idx_sources_url ON sources (url);
CREATE INDEX IF NOT EXISTS idx_ironpin_quotes_verified ON ironpin_quotes (source_last_verified_at);
