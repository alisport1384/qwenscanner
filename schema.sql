-- IronPin Searcher-2 (هوش جستجوگر ۲) — Strict Source Discovery Schema

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  queries_done INTEGER NOT NULL DEFAULT 0,
  queries_total INTEGER NOT NULL DEFAULT 0,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  part INTEGER NOT NULL,
  host TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  site_name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT 'نامشخص',
  has_table INTEGER NOT NULL DEFAULT 0,
  readable INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'new',
  verify_tries INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 0,
  is_inner INTEGER NOT NULL DEFAULT 0,
  hinted INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'search',
  matched_product TEXT NOT NULL DEFAULT '',
  discovered_from TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  discovered_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sources_state_retry
  ON sources(state, next_retry_at, depth, discovered_at);

CREATE INDEX IF NOT EXISTS idx_sources_part_state
  ON sources(part, state, verified_at DESC);

CREATE INDEX IF NOT EXISTS idx_sources_host
  ON sources(host);

CREATE INDEX IF NOT EXISTS idx_sources_product
  ON sources(matched_product);

CREATE INDEX IF NOT EXISTS idx_sources_updated
  ON sources(updated_at);

CREATE TABLE IF NOT EXISTS search_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  part INTEGER NOT NULL,
  query TEXT NOT NULL,
  product_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  tries INTEGER NOT NULL DEFAULT 0,
  cycle_id INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(kind, query)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON search_tasks(status, id);
