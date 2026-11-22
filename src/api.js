/** HTTP API — scans/batches CRUD, report export, stats, health */

import { toQwenExport, toQwenBatchExport } from './knowledge.js';
import { drainQueue } from './pipeline.js';
import { getRetentionCycleDays, setRetentionCycleDays, deleteOldPrices } from './retention.js';
import { toQwenAllExport, toHushyarExport, filterByTarget } from './knowledge.js';
import { getUsage, refreshUsage } from './usage.js';
import { streamIronpinExport } from './ironpin.js';

function now() {
  return Date.now();
}

function json(data, status = 200, cacheControl = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
  };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

/** Minified JSON for multi-MB feeds: pretty-printed 20MB+ responses stalled
 *  browser tabs on the "JSON" links (white screen while millions of lines
 *  rendered). Same bytes of information, loads and parses immediately. */
export function jsonMin(data, status = 200, cacheControl) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorJson(message, status = 400) {
  return json({ error: message }, status);
}

// ─── Panel payload caches (meta-backed, invalidated on writes) ───
// /api/stats + /api/batches were the top D1 row-read burners: the panel polled
// them every 4-12s and each hit ran 8 COUNTs / 50x4 correlated subqueries.
const CACHE_TTL_MS = 300_000; // 5 min — totals only, mutations bust explicitly

async function readCache(env, key) {
  try {
    const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1')
      .bind(key)
      .first();
    if (!row?.value) return null;
    const v = JSON.parse(row.value);
    if (v && typeof v.exp === 'number' && v.exp > Date.now()) return v.data;
  } catch {
    /* ignore */
  }
  return null;
}

async function writeCache(env, key, data) {
  try {
    await env.DB.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
      .bind(key, JSON.stringify({ exp: Date.now() + CACHE_TTL_MS, data }), Date.now())
      .run();
  } catch {
    /* ignore */
  }
}

async function bustCaches(env) {
  try {
    await env.DB.prepare(
      `DELETE FROM meta WHERE key IN ('stats_cache','batches_cache')`
    ).run();
  } catch {
    /* ignore */
  }
}

function checkAuth(request, url, env) {
  if (!env.AUTH_TOKEN) return true;
  const hdr = request.headers.get('Authorization') || '';
  const q = url.searchParams.get('token') || '';
  const provided = hdr.replace(/^Bearer\s+/i, '') || q;
  return provided === env.AUTH_TOKEN;
}

function validTopic(t) {
  if (typeof t !== 'string') return false;
  const s = t.trim();
  if (s.length < 2 || s.length > 200) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(s)) return false;
  return true;
}

function cleanTopic(t) {
  return String(t ?? '').trim().replace(/\s+/g, ' ');
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method.toUpperCase();

  // AUTH_TOKEN (optional) protects everything except report GETs —
  // report URLs are capability links (unguessable UUID) meant to be shared.
  const isReportGet =
    method === 'GET' &&
    (path.startsWith('/api/report/') ||
      path === '/api/sources' ||
      path === '/api/ironpin' ||
      path === '/api/qwen' ||
      path === '/api/hushyar');
  if (!isReportGet && !checkAuth(request, url, env)) {
    return errorJson('unauthorized', 401);
  }

  // ─── Batches (list mode: one line = one topic → one report link) ───

  if (method === 'POST' && path === '/api/batches') {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorJson('invalid_json');
    }

    let raw = body?.topics;
    if (Array.isArray(raw)) raw = raw.join('\n');
    const lines = String(raw ?? '')
      .split(/\r?\n/)
      .map(cleanTopic)
      .filter(Boolean);

    if (!lines.length) return errorJson('topics_required');
    const MAX_TOPICS = 50;
    if (lines.length > MAX_TOPICS) return errorJson('too_many_topics_max_' + MAX_TOPICS);

    const seen = new Set();
    const topics = [];
    for (const t of lines) {
      if (!validTopic(t)) return errorJson('topic_length_2_to_200');
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      topics.push(t);
    }
    if (!topics.length) return errorJson('topics_required');

    const title = cleanTopic(String(body?.title ?? '')).slice(0, 120) || null;
    const autoRefresh = body?.auto_refresh === false ? 0 : 1;
    let refreshHours = parseInt(body?.refresh_hours ?? 24, 10);
    if (!Number.isFinite(refreshHours) || refreshHours < 1) refreshHours = 24;
    if (refreshHours > 24 * 30) refreshHours = 24 * 30;

    const batchId = crypto.randomUUID();
    const t = now();
    const nextRefresh = autoRefresh ? t + refreshHours * 3600_000 : null;

    const insertScan = env.DB.prepare(
      `INSERT INTO scans (id, batch_id, topic, status, phase, auto_refresh, refresh_hours,
                          next_refresh_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'queued', 'search', ?4, ?5, ?6, ?7, ?7)`
    );
    const stmts = [
      env.DB.prepare(
        `INSERT INTO batches (id, title, topics_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`
      ).bind(batchId, title, topics.length, t),
    ];
    const scanIds = [];
    for (const topic of topics) {
      const sid = crypto.randomUUID();
      scanIds.push(sid);
      stmts.push(insertScan.bind(sid, batchId, topic, autoRefresh, refreshHours, nextRefresh, t));
    }
    await env.DB.batch(stmts);
    await bustCaches(env);

    const batch = await getBatch(env, batchId);
    return json(
      {
        ok: true,
        batch,
        scan_ids: scanIds,
        report_url: '/report/batch/' + batchId,
        api_url: '/api/report/batch/' + batchId,
      },
      201
    );
  }

  if (method === 'GET' && path === '/api/batches') {
    const cachedBatches = await readCache(env, 'batches_cache');
    if (cachedBatches) return json(cachedBatches);
    const rows = await env.DB.prepare(
      `SELECT b.id, b.title, b.topics_count, b.created_at, b.updated_at,
              (SELECT COUNT(*) FROM scans s WHERE s.batch_id = b.id) AS scans_total,
              (SELECT COUNT(*) FROM scans s WHERE s.batch_id = b.id AND s.status = 'done') AS scans_done,
              (SELECT COUNT(*) FROM scans s WHERE s.batch_id = b.id
                 AND s.status IN ('queued','searching','fetching')) AS scans_active,
              (SELECT COALESCE(SUM(s.knowledge_count), 0) FROM scans s WHERE s.batch_id = b.id) AS knowledge_count
       FROM batches b
       ORDER BY b.created_at DESC
       LIMIT 50`
    ).all();
    const out = { ok: true, batches: rows.results || [] };
    await writeCache(env, 'batches_cache', out);
    return json(out);
  }

  if (method === 'GET' && /^\/api\/batches\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop());
    const batch = await getBatch(env, id);
    if (!batch) return errorJson('not_found', 404);
    const scans = await env.DB.prepare(
      `SELECT id, topic, status, phase, pages_total, pages_done, knowledge_count, error, updated_at
       FROM scans WHERE batch_id = ?1 ORDER BY created_at ASC`
    )
      .bind(id)
      .all();
    return json({
      ok: true,
      batch,
      scans: scans.results || [],
      report_url: '/report/batch/' + id,
      api_url: '/api/report/batch/' + id,
    });
  }

  if (method === 'DELETE' && /^\/api\/batches\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop());
    const batch = await getBatch(env, id);
    if (!batch) return errorJson('not_found', 404);
    const scanIds =
      (await env.DB.prepare('SELECT id FROM scans WHERE batch_id = ?1').bind(id).all()).results ||
      [];
    const stmts = [];
    for (const s of scanIds) {
      stmts.push(env.DB.prepare('DELETE FROM knowledge WHERE scan_id = ?1').bind(s.id));
      stmts.push(env.DB.prepare('DELETE FROM pages WHERE scan_id = ?1').bind(s.id));
      stmts.push(env.DB.prepare('DELETE FROM scans WHERE id = ?1').bind(s.id));
    }
    stmts.push(env.DB.prepare('DELETE FROM batches WHERE id = ?1').bind(id));
    await env.DB.batch(stmts);
    await bustCaches(env);
    return json({ ok: true, deleted_scans: scanIds.length });
  }

  // One Qwen-ready JSON for the whole list
  if (method === 'GET' && /^\/api\/report\/batch\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop());
    const batch = await getBatch(env, id);
    if (!batch) return errorJson('not_found', 404);
    const scans =
      (
        await env.DB.prepare(
          `SELECT id, topic, status, pages_total, pages_done, knowledge_count, error
           FROM scans WHERE batch_id = ?1 ORDER BY created_at ASC`
        )
          .bind(id)
          .all()
      ).results || [];
    const items =
      (
        await env.DB.prepare(
          `SELECT k.* FROM knowledge k
           JOIN scans s ON s.id = k.scan_id
           WHERE s.batch_id = ?1
           ORDER BY s.created_at, k.domain,
                    CASE k.kind WHEN 'chunk' THEN 0 ELSE 1 END, k.chunk_index, k.id`
        )
          .bind(id)
          .all()
      ).results || [];
    return json(toQwenBatchExport(batch, scans, items));
  }

  // ─── Single scans ────────────────────────────────────────────────

  if (method === 'POST' && path === '/api/scans') {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorJson('invalid_json');
    }
    const topic = cleanTopic(body?.topic);
    if (!topic) return errorJson('topic_required');
    if (!validTopic(topic)) return errorJson('topic_length_2_to_200');

    const autoRefresh = body?.auto_refresh === false ? 0 : 1;
    let refreshHours = parseInt(body?.refresh_hours ?? 24, 10);
    if (!Number.isFinite(refreshHours) || refreshHours < 1) refreshHours = 24;
    if (refreshHours > 24 * 30) refreshHours = 24 * 30;

    const id = crypto.randomUUID();
    const t = now();
    await env.DB.prepare(
      `INSERT INTO scans (id, topic, status, phase, auto_refresh, refresh_hours,
                          next_refresh_at, created_at, updated_at)
       VALUES (?1, ?2, 'queued', 'search', ?3, ?4, ?5, ?6, ?6)`
    )
      .bind(id, topic, autoRefresh, refreshHours, autoRefresh ? t + refreshHours * 3600_000 : null, t)
      .run();
    await bustCaches(env);

    const scan = await getScan(env, id);
    return json({ ok: true, scan, report_url: '/report/' + id, api_url: '/api/report/' + id }, 201);
  }

  if (method === 'GET' && path === '/api/scans') {
    const rows = await env.DB.prepare(
      `SELECT id, batch_id, topic, status, phase, auto_refresh, refresh_hours, next_refresh_at,
              pages_total, pages_done, knowledge_count, engines_used, error,
              created_at, updated_at
       FROM scans ORDER BY created_at DESC LIMIT 100`
    ).all();
    return json({ ok: true, scans: rows.results || [] });
  }

  if (method === 'GET' && /^\/api\/scans\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop());
    const scan = await getScan(env, id);
    if (!scan) return errorJson('not_found', 404);

    const pages = await env.DB.prepare(
      `SELECT id, url, domain, title, source, status, http_status, error, chars, fetched_at
       FROM pages WHERE scan_id = ?1 ORDER BY id LIMIT 50`
    )
      .bind(id)
      .all();

    const samples = await env.DB.prepare(
      `SELECT id, kind, claim, url, domain, confidence, tokens, tags
       FROM knowledge WHERE scan_id = ?1
       ORDER BY CASE kind WHEN 'chunk' THEN 0 ELSE 1 END, chunk_index, id
       LIMIT 20`
    )
      .bind(id)
      .all();

    return json({
      ok: true,
      scan,
      pages: pages.results || [],
      knowledge_sample: samples.results || [],
      report_url: scan.batch_id ? '/report/batch/' + scan.batch_id : '/report/' + scan.id,
      api_url: scan.batch_id ? '/api/report/batch/' + scan.batch_id : '/api/report/' + scan.id,
    });
  }

  if (method === 'DELETE' && /^\/api\/scans\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop());
    const scan = await getScan(env, id);
    if (!scan) return errorJson('not_found', 404);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM knowledge WHERE scan_id = ?1').bind(id),
      env.DB.prepare('DELETE FROM pages WHERE scan_id = ?1').bind(id),
      env.DB.prepare('DELETE FROM scans WHERE id = ?1').bind(id),
    ]);
    await bustCaches(env);
    return json({ ok: true });
  }

  if (method === 'POST' && /^\/api\/scans\/[^/]+\/refresh$/.test(path)) {
    const id = decodeURIComponent(path.split('/').slice(-2)[0]);
    const scan = await getScan(env, id);
    if (!scan) return errorJson('not_found', 404);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE scans SET status = 'queued', phase = 'search', error = NULL,
           pages_done = 0, knowledge_count = 0, updated_at = ?1,
           next_refresh_at = ?2 WHERE id = ?3`
      ).bind(now(), scan.auto_refresh ? now() + (scan.refresh_hours || 24) * 3600_000 : null, id),
      env.DB.prepare(
        `UPDATE pages SET status = 'pending', claimed_at = NULL, attempts = 0
         WHERE scan_id = ?1`
      ).bind(id),
    ]);
    await bustCaches(env);
    // Start processing immediately (prioritize this scan), don't wait for cron.
    const work = drainQueue(env, { maxSteps: 40, prioritizeId: id }).catch((e) => {
      console.error('refresh drain failed', e);
      return { steps: 0, remaining: -1 };
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(work);
      return json({ ok: true, scan_id: id, status: 'queued', started: true, mode: 'background' });
    }
    const result = await work;
    return json({ ok: true, scan_id: id, status: 'queued', started: true, mode: 'sync', ...result });
  }

  // ─── Settings (retention cycle days etc.) ───
  if (method === 'GET' && path === '/api/settings') {
    const cycleDays = await getRetentionCycleDays(env);
    return json({ ok: true, retention_cycle_days: cycleDays });
  }

  if (method === 'POST' && path === '/api/settings') {
    let body;
    try {
      body = await request.json();
    } catch {
      return errorJson('invalid_json');
    }
    if (body?.retention_cycle_days !== undefined) {
      try {
        await setRetentionCycleDays(env, body.retention_cycle_days);
        await bustCaches(env);
      } catch (e) {
        return errorJson(String(e?.message || e));
      }
    }
    const cycleDays = await getRetentionCycleDays(env);
    return json({ ok: true, retention_cycle_days: cycleDays });
  }

  // ─── ALL knowledge (live link) + qwen/hushyar aliases + target split ───
  // /api/report/all?target=ironpin → only rows IronPin can consume (price,
  // specs, definitions, calculations). /api/qwen → full RAG for the model.
  // /api/hushyar → hushyar-knowledge-v1 (counted sections + link map).
  if (
    method === 'GET' &&
    (path === '/api/report/all' || path === '/api/qwen' || path === '/api/hushyar')
  ) {
    let items = [];
    try {
      const rows = await env.DB.prepare(
        `SELECT * FROM knowledge
         ORDER BY last_verified_at DESC, domain,
                  CASE kind WHEN 'chunk' THEN 0 ELSE 1 END, id
         LIMIT 20000`
      ).all();
      items = rows.results || [];
    } catch {
      items = [];
    }
    const target = url.searchParams.get('target') || '';
    if (target === 'ironpin' || target === 'qwen') items = filterByTarget(items, target);
    // Distinct counts from fetched rows — full-table COUNT(DISTINCT) burned D1 reads.
    const topics = new Set(items.map((i) => i.topic).filter((x) => x != null)).size;
    const sources = new Set(items.map((i) => i.domain).filter((x) => x != null)).size;
    const categories = new Set(items.map((i) => i.category).filter((x) => x != null)).size;
    if (path === '/api/hushyar') {
      return jsonMin(toHushyarExport(items, { topics, sources }), 200, 'public, max-age=120');
    }
    const doc = toQwenAllExport(items, { topics, sources, categories });
    if (path === '/api/qwen') doc.feed = 'qwen-model';
    if (target) doc.target = target;
    return jsonMin(doc, 200, 'public, max-age=120');
  }

  // ─── IronPin Quote.toJson export (since = incremental for external mode) ───
  if (method === 'GET' && path === '/api/ironpin') {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    return await streamIronpinExport(env.DB, { since });
  }

  // ─── Sources list (for IronPin) ───
  if (method === 'GET' && path === '/api/sources') {
    const rows = await env.DB.prepare(
      `SELECT url, domain, kind, part, name, readable, origin, state,
              created_at, last_checked_at
       FROM sources ORDER BY created_at DESC LIMIT 5000`
    ).all();
    const list = rows.results || [];
    const byKind = {};
    for (const s of list) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    return jsonMin({
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
    }, 200, 'public, max-age=120');
  }

  // ─── Daily CF / D1 usage ───
  if (method === 'GET' && path === '/api/usage') {
    const snap = await getUsage(env);
    return json({ ok: true, usage: snap });
  }

  if (method === 'POST' && path === '/api/usage/refresh') {
    const snap = await refreshUsage(env, { force: true });
    return json({ ok: true, usage: snap });
  }

  // ─── MANUAL price deletion (price rows only — never technical knowledge) ───
  if (method === 'POST' && path === '/api/prices/delete') {
    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const days = parseInt(body?.older_than_days ?? '', 10);
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      return errorJson('older_than_days_required_1_to_3650');
    }
    try {
      const result = await deleteOldPrices(env, { olderThanDays: days });
      return json({ ok: true, scope: 'price_only', ...result });
    } catch (e) {
      return errorJson(String(e?.message || e), 500);
    }
  }

  if (method === 'GET' && /^\/api\/report\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop());
    const scan = await getScan(env, id);
    if (!scan) return errorJson('not_found', 404);
    const rows = await env.DB.prepare(
      `SELECT * FROM knowledge WHERE scan_id = ?1
       ORDER BY domain, CASE kind WHEN 'chunk' THEN 0 ELSE 1 END, chunk_index, id`
    )
      .bind(id)
      .all();
    return json(toQwenExport(scan, rows.results || []));
  }

  if (method === 'GET' && path === '/api/stats') {
    const cachedStats = await readCache(env, 'stats_cache');
    if (cachedStats) return json(cachedStats);
    const [scans, knowledge, pages, active, batches, sources, retention, finder] =
      await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS c FROM scans').first(),
        env.DB.prepare('SELECT COUNT(*) AS c FROM knowledge').first(),
        env.DB.prepare('SELECT COUNT(*) AS c FROM pages').first(),
        env.DB.prepare(
          `SELECT COUNT(*) AS c FROM scans WHERE status IN ('queued','searching','fetching')`
        ).first(),
        env.DB.prepare('SELECT COUNT(*) AS c FROM batches').first(),
        env.DB.prepare('SELECT COUNT(*) AS c FROM sources').first().catch(() => ({ c: 0 })),
        env.DB.prepare(`SELECT value FROM meta WHERE key = 'price_retention'`)
          .first()
          .catch(() => null),
        env.DB.prepare(`SELECT value FROM meta WHERE key = 'finder_state'`)
          .first()
          .catch(() => null),
      ]);
    let retentionState = null;
    let finderState = null;
    try {
      retentionState = retention?.value ? JSON.parse(retention.value) : null;
    } catch { /* ignore */ }
    try {
      finderState = finder?.value ? JSON.parse(finder.value) : null;
    } catch { /* ignore */ }
    const out = {
      ok: true,
      scans: scans?.c || 0,
      knowledge: knowledge?.c || 0,
      pages: pages?.c || 0,
      active: active?.c || 0,
      batches: batches?.c || 0,
      sources: sources?.c || 0,
      retention: retentionState,
      finder: finderState,
      db: env.DB_NAME || 'qwen_scanner',
      chunker: { target_chars: 900, overlap_chars: 140, min_chars: 200, target_tokens: 450 },
      ttl_days: 45,
      engines: ['bing', 'bing-rss', 'ddg', 'gerdoo', 'zarebin'],
      crons: ['*/5 * * * *', '0 */6 * * *'],
      max_topics_per_batch: 50,
      price_retention: {
        near_cap_days: 3,
        monthly_cycle_days: await getRetentionCycleDays(env),
        monthly_keep_hours: 24,
      },
      settings: {
        retention_cycle_days: await getRetentionCycleDays(env),
        price_delete_mode: 'manual',
        links: {
          all_knowledge: '/report/all',
          all_knowledge_json: '/api/report/all',
          sources: '/report/sources',
          sources_json: '/api/sources',
        },
      },
    };
    await writeCache(env, 'stats_cache', out);
    return json(out);
  }

  if (method === 'GET' && path === '/api/health') {
    try {
      await env.DB.prepare('SELECT 1').run();
      return json({ ok: true, db: 'up' });
    } catch (e) {
      return json({ ok: false, db: 'down', error: String(e?.message || e) }, 503);
    }
  }

  return errorJson('not_found', 404);
}

async function getScan(env, id) {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  return env.DB.prepare(
    `SELECT id, batch_id, topic, status, phase, auto_refresh, refresh_hours, next_refresh_at,
            pages_total, pages_done, knowledge_count, engines_used, error,
            created_at, updated_at
     FROM scans WHERE id = ?1`
  )
    .bind(id)
    .first();
}

async function getBatch(env, id) {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  return env.DB.prepare(
    `SELECT id, title, topics_count, created_at, updated_at
     FROM batches WHERE id = ?1`
  )
    .bind(id)
    .first();
}
