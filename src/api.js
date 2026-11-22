/**
 * REST panel API — IronPin-only.
 *
 * The Qwen knowledge and Hushyar routes are removed (marked حذف). The app
 * (IronPin2) consumes the scanner exclusively through /api/ironpin.
 */

import { drainQueue } from './pipeline.js';
import { getPanelReport } from './report.js';
import { readCounters } from './guardian.js';
import { buildIronpinExport } from './ironpin.js';
import { deleteQuotesForUrls, clearMeta, getRetentionState, getRetentionCycleDays, setRetentionCycleDays, deleteOldPrices } from './retention.js';
import { getUsage } from './usage.js';
import { ensureIronPinSeed } from './seed.js';

const TOKEN_RE = /^[a-z0-9_-]{8,}$/i;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad_json')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function isValidToken(t) {
  return typeof t === 'string' && TOKEN_RE.test(t);
}

function scopedEnv(env, token) {
  return { DB: env.DB, token };
}

/**
 * Parse `SELECT ... FROM <table> WHERE id = ?` with table-name allowlist.
 * Used to sandbox panel report queries to known D1 tables.
 */
const TABLES = new Set(['scans', 'batches', 'pages', 'sources', 'ironpin_quotes', 'meta']);
function parseScopedSelect(raw) {
  const m = /^\s*select\s+(.+?)\s+from\s+([a-z_][a-z0-9_]*)(?:\s+where\s+id\s*=\s*([0-9]+))?\s*;?\s*$/i.exec(raw || '');
  if (!m) throw new Error('bad_select');
  const table = m[2];
  if (!TABLES.has(table)) throw new Error('bad_table');
  const whereId = m[3] != null ? Number(m[3]) : null;
  return { table, whereId };
}

/** GET /api/stats — counters + scan counts + sources + storage. */
export async function handleStats(req, env) {
  const now = Date.now();
  // Edge-cache the stats snapshot when a KV binding exists; skip otherwise.
  let cached = null;
  if (env.CACHE) {
    try { cached = await env.CACHE.get('stats'); } catch { /* no cache */ }
  }
  if (cached) return json(new Response(cached), 200, await JSON.parse(cached));

  const counters = readCounters(env);

  const [active, doneToday, allScans, sources] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(knowledge_count),0) AS quotes
       FROM scans WHERE status IN ('queued','searching','fetching')`
    ).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM scans WHERE status = 'done' AND updated_at >= ?`
    ).bind(now - 86_400_000).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c, COALESCE(MAX(knowledge_count),0) AS maxQuotes FROM scans`
    ).first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS c,
         SUM(CASE WHEN state='live' THEN 1 ELSE 0 END) AS live,
         SUM(CASE WHEN state='dead' THEN 1 ELSE 0 END) AS dead
       FROM sources`
    ).first(),
  ]);

  const scans = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM pages p WHERE p.scan_id = s.id) AS pages
     FROM scans s
     ORDER BY s.id DESC LIMIT 12`
  ).all();

  const storage = await env.DB.prepare(
    `SELECT COUNT(*) AS pages FROM pages;
     SELECT COUNT(*) AS quotes FROM ironpin_quotes;
     SELECT COUNT(*) AS sources FROM sources;`
  ).all();

  const [batches, retention, settings] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS c FROM batches').first(),
    getRetentionState(env),
    getRetentionCycleDays(env),
  ]);

  const body = {
    counters,
    scans: (scans?.results || []).length,
    active: active?.c || 0,
    pages: storage?.[0]?.pages || 0,
    quotes: storage?.[1]?.quotes || 0,
    knowledge: storage?.[1]?.quotes || 0,
    batches: batches?.c || 0,
    sources: sources?.c || 0,
    db: env.DB?.name || 'D1',
    engines: JSON.parse(scans?.results?.[0]?.engines_used || '[]'),
    crons: ['* * * * *', '0 */6 * * *', '0 3 * * *'],
    settings: { retention_cycle_days: settings },
    price_retention: retention,
    storage: {
      pages: storage?.[0]?.pages || 0,
      quotes: storage?.[1]?.quotes || 0,
      sources: storage?.[2]?.sources || 0,
    },
    scans_list: (scans?.results || []).map((s) => ({
      id: s.id, topic: s.topic, status: s.status, phase: s.phase,
      token: s.token, auto_refresh: s.auto_refresh,
      knowledge_count: s.knowledge_count || 0,
      pages_total: s.pages_total || 0, pages_done: s.pages_done || 0,
      pages: s.pages || 0, error: s.error,
      next_refresh_at: s.next_refresh_at, updated_at: s.updated_at, created_at: s.created_at,
    })),
  };
  if (env.CACHE) {
    try { await env.CACHE.put('stats', JSON.stringify(body), 300); } catch { /* no cache */ }
  }
  return json(new Response(JSON.stringify(body)), 200, body);
}

/** GET /api/scans — recent scans list. */
export async function handleScans(req, env) {
  const scans = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM pages p WHERE p.scan_id = s.id) AS pages
     FROM scans s ORDER BY s.id DESC LIMIT 50`
  ).all();
  const rows = (scans?.results || []).map((s) => ({
    id: s.id, topic: s.topic, status: s.status, phase: s.phase,
    token: s.token, auto_refresh: s.auto_refresh,
    knowledge_count: s.knowledge_count || 0,
    pages_total: s.pages_total || 0, pages_done: s.pages_done || 0,
    pages: s.pages || 0, error: s.error,
    next_refresh_at: s.next_refresh_at, updated_at: s.updated_at, created_at: s.created_at,
  }));
  return json(new Response(JSON.stringify({ scans: rows })), 200, { scans: rows });
}

/** GET /api/scans/:id — one scan detail (quotes + pages + guardian counters). */
export async function handleScanDetail(req, env, scanId) {
  const scan = await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(Number(scanId)).first();
  if (!scan) return json(null, 404, { error: 'not_found' });

  const quotes = await env.DB.prepare(
    `SELECT id, seller, title, category, unit, currency, amount, source_url, published_at,
        piece_kg, length_m, area_m2, size, thickness, details, quality, material,
        brand, load_type, load_city, terms, source_date_raw
     FROM ironpin_quotes WHERE scan_id = ? ORDER BY id DESC LIMIT 200`
  ).bind(scan.id).all();

  const pages = await env.DB.prepare(
    `SELECT id, url, domain, title, status, error, http_status, chars, attempts, fetched_at
     FROM pages WHERE scan_id = ? ORDER BY id DESC LIMIT 200`
  ).bind(scan.id).all();

  const counters = readCounters(env);
  const body = {
    scan: {
      id: scan.id, topic: scan.topic, status: scan.status, phase: scan.phase,
      token: scan.token, auto_refresh: scan.auto_refresh,
      knowledge_count: scan.knowledge_count, pages_total: scan.pages_total,
      pages_done: scan.pages_done, error: scan.error,
      next_refresh_at: scan.next_refresh_at, updated_at: scan.updated_at,
    },
    quotes: quotes?.results || [],
    pages: pages?.results || [],
    counters,
  };
  return json(new Response(JSON.stringify(body)), 200, body);
}

/** POST /api/scans — queue a scan for a topic. */
export async function handleCreateScan(req, env) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(null, 400, { error: 'bad_json' }); }

  const topic = (body.topic || '').trim();
  if (!topic) return json(null, 400, { error: 'topic_required' });
  if (topic.length > 100) return json(null, 400, { error: 'topic_too_long' });

  const token = (body.token || '').trim();
  if (token && !isValidToken(token)) return json(null, 400, { error: 'bad_token' });

  const scan = await env.DB.prepare(
    `INSERT INTO scans (topic, token, auto_refresh, refresh_hours, status, phase, next_refresh_at)
     VALUES (?1, ?2, ?3, ?4, 'queued', 'search', ?5)`
  ).bind(
    topic, token || null,
    body.auto_refresh === false ? 0 : 1,
    Math.min(240, Math.max(1, Number(body.refresh_hours) || 24)),
    (body.auto_refresh === false ? null : Date.now() + (Number(body.refresh_hours) || 24) * 3600_000)
  ).run();

  const id = Number(scan.last_row_id);
  await env.DB.prepare(
    `INSERT INTO batches (scan_id, topic, status, stats, created_at, updated_at)
     VALUES (?1, ?2, 'running', '{}', ?3, ?3)`
  ).bind(id, topic, Date.now()).run();

  if (body.start === true) {
    const started = await drainQueue(env, { prioritizeId: id, maxSteps: 3 });
    return json(new Response(JSON.stringify(started)), 200, started);
  }
  return json(new Response(JSON.stringify({ id })), 202, { id });
}

/** POST /api/scans/:id/pause — stop auto-refresh for a scan. */
export async function handlePauseScan(req, env, scanId) {
  const r = await env.DB.prepare(
    'UPDATE scans SET auto_refresh = 0, next_refresh_at = NULL, updated_at = ?1 WHERE id = ?2'
  ).bind(Date.now(), Number(scanId)).run();
  if (r.changes === 0) return json(null, 404, { error: 'not_found' });
  return json(new Response(JSON.stringify({ ok: true })), 200, { ok: true });
}

/** POST /api/scans/:id/resume — re-enable auto-refresh. */
export async function handleResumeScan(req, env, scanId) {
  const r = await env.DB.prepare(
    'UPDATE scans SET auto_refresh = 1, next_refresh_at = ?1, updated_at = ?1 WHERE id = ?2'
  ).bind(Date.now(), Number(scanId)).run();
  if (r.changes === 0) return json(null, 404, { error: 'not_found' });
  return json(new Response(JSON.stringify({ ok: true })), 200, { ok: true });
}

/** POST /api/scans/:id/refresh — queue a fresh re-scan now. */
export async function handleRefreshScan(req, env, scanId) {
  const scan = await env.DB.prepare('SELECT id FROM scans WHERE id = ?').bind(Number(scanId)).first();
  if (!scan) return json(null, 404, { error: 'not_found' });
  await env.DB.prepare(
    `UPDATE scans SET status='queued', phase='search', error=NULL, pages_done=0, knowledge_count=0,
       pages_total=0, updated_at=?1, next_refresh_at=NULL
     WHERE id=?2`
  ).bind(Date.now(), scan.id).run();
  await env.DB.prepare(
    `UPDATE pages SET status='pending', claimed_at=NULL, attempts=0 WHERE scan_id=?1`
  ).bind(scan.id).run();
  const done = await drainQueue(env, { prioritizeId: scan.id, maxSteps: 3 });
  return json(new Response(JSON.stringify(done)), 200, done);
}

/** POST /api/scans/:id/cancel — remove the scan and its pages/quotes. */
export async function handleCancelScan(req, env, scanId) {
  const r = await env.DB.prepare('SELECT id FROM scans WHERE id = ?').bind(Number(scanId)).first();
  if (!r) return json(null, 404, { error: 'not_found' });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ironpin_quotes WHERE scan_id = ?1').bind(scanId),
    env.DB.prepare('DELETE FROM pages WHERE scan_id = ?1').bind(scanId),
    env.DB.prepare('DELETE FROM batches WHERE scan_id = ?1').bind(scanId),
    env.DB.prepare('DELETE FROM scans WHERE id = ?1').bind(scanId),
  ]);
  await env.DB.prepare('DELETE FROM meta WHERE key LIKE ?1').bind(`sources:${scanId}:%`).run();
  return json(new Response(JSON.stringify({ ok: true, now })), 200, { ok: true, now });
}

/** GET /api/report/:token — public token report (scan summary + quotes + pages). */
export async function handleReport(req, env, token) {
  const scan = await env.DB.prepare('SELECT * FROM scans WHERE token = ?').bind(token).first();
  if (!scan) return json(null, 404, new Response(JSON.stringify({ error: 'not_found' })));

  const body = await getPanelReport(scopedEnv(env, token), scan.id);
  if (!body) return json(null, 404, new Response(JSON.stringify({ error: 'not_found' })));

  return json(new Response(JSON.stringify(body)), 200, body);
}

/** GET /api/report/all — full scans list (no token scoping — public page). */
export async function handleReportAll(req, env) {
  const scans = await env.DB.prepare(
    `SELECT id, topic, status, phase, knowledge_count, pages_total, pages_done, error,
        auto_refresh, next_refresh_at, updated_at
     FROM scans ORDER BY id DESC`
  ).all();
  const body = {
    scans: (scans?.results || []).map((s) => ({
      id: s.id, topic: s.topic, status: s.status, phase: s.phase,
      knowledge_count: s.knowledge_count || 0,
      pages_total: s.pages_total || 0, pages_done: s.pages_done || 0,
      error: s.error, auto_refresh: s.auto_refresh,
      next_refresh_at: s.next_refresh_at, updated_at: s.updated_at,
    })),
  };
  return json(new Response(JSON.stringify(body)), 200, body);
}

/** GET /api/ironpin — IronPin-native quotes feed for the external app (IronPin2). */
export async function handleIronpinExport(req, env, url) {
  const params = new URL(url).searchParams;
  const since = Math.max(0, parseInt(params.get('since') || '0', 10));
  const limit = Math.min(4000, Math.max(50, parseInt(params.get('limit') || '1000', 10)));
  const body = await buildIronpinExport(env.DB, { since, limit });
  const res = new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
  return res;
}

/** GET /api/sources — sources list for IronPin (ironpin-sources-v1). */
export async function handleSources(req, env) {
  const rows = await env.DB.prepare(
    `SELECT url, domain, kind, part, name, readable, origin, state,
            created_at, last_checked_at
     FROM sources ORDER BY created_at DESC LIMIT 5000`
  ).all();
  const list = rows?.results || [];
  const byKind = {};
  for (const s of list) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  const body = {
    ok: true,
    format: 'ironpin-sources-v1',
    generated_at: new Date().toISOString(),
    total: list.length,
    by_kind: byKind,
    sources: list.map((s) => ({
      url: s.url,
      domain: s.domain,
      kind: s.kind,
      part: s.part,
      name: s.name || null,
      readable: !!s.readable,
      origin: s.origin,
      state: s.state || 'new',
      created_at: s.created_at,
      last_checked_at: s.last_checked_at,
    })),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=120' },
  });
}

/** GET /api/usage — this worker's own D1 usage counters. */
export async function handleUsage(req, env) {
  const body = await getUsage(env);
  return json(new Response(JSON.stringify(body)), 200, body);
}

/** GET /api/settings — deployment settings (no secrets). */
export async function handleSettings(req, env) {
  return json(new Response(JSON.stringify({
    MAX_PAGES_PER_SCAN: env.MAX_PAGES_PER_SCAN,
    PAGES_PER_TICK: env.PAGES_PER_TICK,
    SEARCH_QUERY_LIMIT: env.SEARCH_QUERY_LIMIT,
    TICK_BUDGET_MS: env.TICK_BUDGET_MS,
    DAILY_FETCH_LIMIT: env.DAILY_FETCH_LIMIT,
    IMAGE_EXTRACT_LIMIT: env.IMAGE_EXTRACT_LIMIT,
    CRON: env.CRON,
    WRANGLER_BOT_ID: env.WRANGLER_BOT_ID,
  })), 200, {
    MAX_PAGES_PER_SCAN: env.MAX_PAGES_PER_SCAN,
    PAGES_PER_TICK: env.PAGES_PER_TICK,
    SEARCH_QUERY_LIMIT: env.SEARCH_QUERY_LIMIT,
    TICK_BUDGET_MS: env.TICK_BUDGET_MS,
    DAILY_FETCH_LIMIT: env.DAILY_FETCH_LIMIT,
    IMAGE_EXTRACT_LIMIT: env.IMAGE_EXTRACT_LIMIT,
    CRON: env.CRON,
    WRANGLER_BOT_ID: env.WRANGLER_BOT_ID,
  });
}

/** POST /api/prices/delete — delete quotes for source URLs (admin cleanup). */
export async function handlePricesDelete(req, env) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(null, 400, { error: 'bad_json' }); }
  const adminToken = (body.admin_token || '').trim();
  if (!isValidToken(adminToken)) return json(null, 401, { error: 'bad_token' });

  const urls = Array.isArray(body.urls) ? body.urls.map((u) => String(u)).slice(0, 500) : [];
  if (!urls.length) return json(null, 400, { error: 'urls_required' });

  const stats = await deleteQuotesForUrls(env, urls);
  await clearMeta(env, 'report_cache:*');
  return json(new Response(JSON.stringify(stats)), 200, stats);
}

/** POST /api/dev/tick — drain queue once (local test only). */
export async function handleDevTick(req, env) {
  const out = await drainQueue(env, { maxSteps: 3 });
  return json(new Response(JSON.stringify(out)), 200, out);
}


/** GET /api/health — D1 connectivity probe. */
export async function handleHealth(req, env) {
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return json(new Response(JSON.stringify({ ok: true })), 200, { ok: true });
  } catch (e) {
    return json(new Response(JSON.stringify({ ok: false, error: String(e?.message || e) })), 500, { ok: false });
  }
}

/** GET /api/batches — list batches with per-batch scan counts. */
export async function handleBatches(req, env) {
  const batches = await env.DB.prepare(
    `SELECT b.*,
       (SELECT COUNT(*) FROM scans s WHERE s.batch_id = b.id) AS scans_total,
       (SELECT COUNT(*) FROM scans s WHERE s.batch_id = b.id AND s.status IN ('queued','searching','fetching')) AS scans_active,
       (SELECT COUNT(*) FROM scans s WHERE s.batch_id = b.id AND s.status = 'done') AS scans_done,
       (SELECT COALESCE(SUM(knowledge_count),0) FROM scans s WHERE s.batch_id = b.id) AS knowledge_count
     FROM batches b ORDER BY b.id DESC`
  ).all();
  const rows = (batches?.results || []).map((b) => ({
    id: b.id, title: b.title, created_at: b.created_at, updated_at: b.updated_at,
    scans_total: b.scans_total || 0, scans_active: b.scans_active || 0,
    scans_done: b.scans_done || 0, knowledge_count: b.knowledge_count || 0,
  }));
  return json(new Response(JSON.stringify({ batches: rows })), 200, { batches: rows });
}

/** POST /api/batches — queue many scans for one batch; returns the report URL. */
export async function handleCreateBatch(req, env) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(null, 400, { error: 'bad_json' }); }
  const topics = (Array.isArray(body.topics) ? body.topics : String(body.topics || '').split('\n'))
    .map((t) => String(t).trim()).filter(Boolean).slice(0, 50);
  if (!topics.length) return json(null, 400, { error: 'topics_required' });

  const now = Date.now();
  const id = 'b' + now.toString(36);
  const refreshHours = Math.min(240, Math.max(1, Number(body.refresh_hours) || 24));
  const autoRefresh = body.auto_refresh === false ? 0 : 1;
  const insertScan = env.DB.prepare(
    `INSERT INTO scans (id, batch_id, topic, token, auto_refresh, refresh_hours, status, phase, next_refresh_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'queued', 'search', ?6, ?7, ?7)`
  );
  const insertBatch = env.DB.prepare(
    `INSERT INTO batches (id, title, topics_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)`
  );
  const batch = [];
  const scanIds = [];
  for (const t of topics) {
    const sid = 's' + now.toString(36) + scanIds.length.toString(36);
    scanIds.push(sid);
    batch.push(insertScan.bind(sid, id, t, autoRefresh, refreshHours, autoRefresh ? now + refreshHours * 3600_000 : null, now));
  }
  batch.push(insertBatch.bind(id, body.title || null, topics.length, now));
  await env.DB.batch(batch);

  return json(new Response(JSON.stringify({
    batch: { id, title: body.title || null, topics_count: topics.length },
    scan_ids: scanIds,
    report_url: '/report/batch/' + id,
  })), 202, {
    batch: { id, title: body.title || null, topics_count: topics.length },
    scan_ids: scanIds,
    report_url: '/report/batch/' + id,
  });
}

/** DELETE /api/batches/:id — remove a batch and its scans/pages/quotes. */
export async function handleDeleteBatch(req, env, batchId) {
  const r = await env.DB.prepare('SELECT id FROM batches WHERE id = ?').bind(batchId).first();
  if (!r) return json(null, 404, { error: 'not_found' });
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ironpin_quotes WHERE scan_id IN (SELECT id FROM scans WHERE batch_id = ?1)').bind(batchId),
    env.DB.prepare('DELETE FROM pages WHERE scan_id IN (SELECT id FROM scans WHERE batch_id = ?1)').bind(batchId),
    env.DB.prepare('DELETE FROM scans WHERE batch_id = ?1').bind(batchId),
    env.DB.prepare('DELETE FROM batches WHERE id = ?1').bind(batchId),
  ]);
  return json(new Response(JSON.stringify({ ok: true })), 200, { ok: true });
}

/** POST /api/usage/refresh — force a usage counter refresh. */
export async function handleUsageRefresh(req, env) {
  const { refreshUsage } = await import('./usage.js');
  const body = await refreshUsage(env, { force: true });
  return json(new Response(JSON.stringify(body)), 200, body);
}

/** POST /api/settings — panel settings (retention_cycle_days). */
export async function handleSettingsPost(req, env) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(null, 400, { error: 'bad_json' }); }
  if (body.retention_cycle_days != null) {
    const d = await setRetentionCycleDays(env, body.retention_cycle_days);
    return json(new Response(JSON.stringify({ retention_cycle_days: d })), 200, { retention_cycle_days: d });
  }
  if (body.delete_old_prices != null) {
    const out = await deleteOldPrices(env, { olderThanDays: body.delete_old_prices });
    return json(new Response(JSON.stringify(out)), 200, out);
  }
  return json(null, 400, { error: 'unknown_setting' });
}

/** POST /api/prices/delete — delete price quotes older than N days (admin). */
export async function handlePricesDeleteDays(req, env) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(null, 400, { error: 'bad_json' }); }
  const adminToken = (body.admin_token || '').trim();
  if (!isValidToken(adminToken)) return json(null, 401, { error: 'bad_token' });
  const out = await deleteOldPrices(env, { olderThanDays: Number(body.older_than_days) || 31 });
  return json(new Response(JSON.stringify(out)), 200, out);
}

/** Route /api/* to handlers. */
export async function handleApi(req, env, ctx) {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const path = url.pathname;

  if (method === 'GET' && path === '/api/stats') return handleStats(req, env);
  if (method === 'GET' && path === '/api/health') return handleHealth(req, env);
  if (method === 'GET' && path === '/api/batches') return handleBatches(req, env);
  if (method === 'POST' && path === '/api/batches') return handleCreateBatch(req, env);
  if (method === 'POST' && path === '/api/usage/refresh') return handleUsageRefresh(req, env);
  if (method === 'POST' && path === '/api/settings') return handleSettingsPost(req, env);
  if (method === 'GET' && path === '/api/scans') return handleScans(req, env);
  if (method === 'GET' && path === '/api/ironpin') return handleIronpinExport(req, env, url);
  if (method === 'GET' && path === '/api/sources') return handleSources(req, env);
  if (method === 'GET' && path === '/api/usage') return handleUsage(req, env);
  if (method === 'GET' && path === '/api/settings') return handleSettings(req, env);
  if (method === 'GET' && path === '/api/report/all') return handleReportAll(req, env);

  if (path.startsWith('/api/report/')) {
    const token = decodeURIComponent(path.slice('/api/report/'.length));
    if (method === 'GET') return handleReport(req, env, token);
  }

  let m = /^\/api\/scans\/(\d+)\/(pause|resume|refresh|cancel)$/.exec(path);
  if (m) {
    if (method === 'POST') {
      if (m[2] === 'pause') return handlePauseScan(req, env, m[1]);
      if (m[2] === 'resume') return handleResumeScan(req, env, m[1]);
      if (m[2] === 'refresh') return handleRefreshScan(req, env, m[1]);
      if (m[2] === 'cancel') return handleCancelScan(req, env, m[1]);
    }
  }
  m = /^\/api\/batches\/(\w+)$/.exec(path);
  if (m) {
    if (method === 'DELETE') return handleDeleteBatch(req, env, m[1]);
  }
  m = /^\/api\/scans\/(\d+)$/.exec(path);
  if (m) {
    if (method === 'GET') return handleScanDetail(req, env, m[1]);
    if (method === 'DELETE') return handleCancelScan(req, env, m[1]);
  }

  if (method === 'POST' && path === '/api/scans') return handleCreateScan(req, env);
  if (method === 'POST' && path === '/api/prices/delete') {
    const p = new URL(req.url).searchParams;
    if (p.has('older_than_days')) return handlePricesDeleteDays(req, env);
    return handlePricesDelete(req, env);
  }
  if (method === 'POST' && path === '/api/dev/tick') return handleDevTick(req, env);

  return json(null, 404, { error: 'not_found', path });
}
