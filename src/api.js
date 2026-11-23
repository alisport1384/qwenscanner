/**
 * HTTP API Router — Strictly Searcher-2 (هوش جستجوگر ۲) endpoints.
 */

import {
  DEFAULT_RETENTION_MONTHS,
  addCustomProduct,
  deleteCustomProduct,
  getConfig,
  getEngineStats,
  getState,
  purgeSources,
  runTick,
  setConfig,
} from './finder.js';
import { evaluateGuards, getUsage, refreshUsage } from './usage.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
    },
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function formatSourceRow(r) {
  return {
    key: r.key,
    url: r.url,
    kind: r.kind,
    part: Number(r.part),
    readable: Boolean(r.readable),
    host: r.host || '',
    handle: r.handle || '',
    name: r.name || r.site_name || r.title || r.host || r.handle || '',
    title: r.title || '',
    site_name: r.site_name || '',
    city: r.city || 'نامشخص',
    contact: r.contact || '',
    has_table: Boolean(r.has_table),
    matched_product: r.matched_product || '',
    discovered_from: r.discovered_from || '',
    provider: r.provider || '',
    note: r.note || '',
    verified_at: r.verified_at ? new Date(Number(r.verified_at)).toISOString() : null,
  };
}

export async function handleApi(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/health' && request.method === 'GET') {
    return json({ ok: true, mode: 'searcher2-only', version: '2.0.0' });
  }

  // Full sources list endpoint (consumed by IronPin2 & dedicated /sources.html page)
  if (path === '/api/sources' && request.method === 'GET') {
    const onlyReadable = url.searchParams.get('readable') === '1';
    const partParam = url.searchParams.get('part');
    const productParam = (url.searchParams.get('product') || '').trim();
    const customOnly = url.searchParams.get('custom') === '1';
    const state = await getState(env);

    const where = ["state = 'ok'"];
    const binds = [];
    if (onlyReadable) where.push('readable = 1');
    if (partParam !== null && ['0', '1', '2'].includes(partParam)) {
      binds.push(Number(partParam));
      where.push(`part = ?${binds.length}`);
    }
    if (customOnly) {
      where.push("matched_product != ''");
    }
    if (productParam) {
      binds.push(productParam);
      where.push(`instr(matched_product, ?${binds.length}) > 0`);
    }

    const sql = `SELECT key, url, kind, part, readable, host, handle, name, title, site_name,
                        city, contact, has_table, matched_product, discovered_from, provider, note, verified_at
                 FROM sources
                 WHERE ${where.join(' AND ')}
                 ORDER BY part ASC, verified_at DESC
                 LIMIT 1500`;
    const rows = (await env.DB.prepare(sql).bind(...binds).all()).results || [];
    const sources = rows.map(formatSourceRow);

    const counts = {
      total: sources.length,
      readable: sources.filter((s) => s.readable).length,
      sites: sources.filter((s) => s.part === 0).length,
      social: sources.filter((s) => s.part === 1).length,
      domestic: sources.filter((s) => s.part === 2).length,
      custom: sources.filter((s) => Boolean(s.matched_product)).length,
    };

    return json({
      format: 'ironpin-sources-v1',
      generated_at: new Date().toISOString(),
      epoch: state.epoch || 1,
      round: state.round || 0,
      counts,
      sources,
    });
  }

  // Lightweight status endpoint (NO heavy sources array so dashboard loads instantly)
  if (path === '/api/status' && request.method === 'GET') {
    const now = Date.now();
    const config = await getConfig(env);
    const retentionMonths = config.retention_months || DEFAULT_RETENTION_MONTHS;
    const retentionCutoff = now - retentionMonths * 30 * 24 * 3600_000;

    const [state, enginesMap, usage, aggRows, taskCountRow, productsRes, expiredRow] =
      await Promise.all([
        getState(env),
        getEngineStats(env),
        getUsage(env, { now }),
        env.DB.prepare(
          `SELECT state, part, readable, COUNT(*) AS c,
                  SUM(CASE WHEN matched_product != '' THEN 1 ELSE 0 END) AS custom_c
           FROM sources
           GROUP BY state, part, readable`
        ).all(),
        env.DB.prepare(`SELECT COUNT(*) AS c FROM search_tasks WHERE status = 'pending'`).first(),
        env.DB.prepare(`SELECT * FROM custom_products ORDER BY id DESC`).all(),
        env.DB.prepare(
          `SELECT COUNT(*) AS c FROM sources
           WHERE COALESCE(NULLIF(verified_at, 0), NULLIF(discovered_at, 0), updated_at) < ?1`
        )
          .bind(retentionCutoff)
          .first(),
      ]);

    const counts = {
      total_rows: 0,
      ok_total: 0,
      ok_readable: 0,
      ok_sites: 0,
      ok_social: 0,
      ok_domestic: 0,
      ok_custom_sources: 0,
      pending_verify: 0,
      rejected: 0,
      unreachable: 0,
      expired_retention: Number(expiredRow?.c || 0),
      pending_tasks: Number(taskCountRow?.c || 0),
      custom_products: (productsRes.results || []).length,
    };

    for (const r of aggRows.results || []) {
      const c = Number(r.c || 0);
      const customC = Number(r.custom_c || 0);
      counts.total_rows += c;
      if (r.state === 'ok') {
        counts.ok_total += c;
        if (Number(r.readable) === 1) counts.ok_readable += c;
        counts.ok_custom_sources += customC;
        if (r.part === 0) counts.ok_sites += c;
        else if (r.part === 1) counts.ok_social += c;
        else if (r.part === 2) counts.ok_domestic += c;
      } else if (r.state === 'new') {
        counts.pending_verify += c;
      } else if (r.state === 'rejected') {
        counts.rejected += c;
      } else if (r.state === 'unreachable') {
        counts.unreachable += c;
      }
    }

    const guards = usage.guards || evaluateGuards(usage, env);
    const engines = Object.values(enginesMap).map((e) => ({
      ...e,
      cooldown_remaining_sec:
        e.cooldown_until > now ? Math.ceil((e.cooldown_until - now) / 1000) : 0,
    }));

    return json({
      ok: true,
      now,
      config,
      state,
      counts,
      engines,
      products: productsRes.results || [],
      usage,
      guards,
    });
  }

  if (path === '/api/scan/trigger' && request.method === 'POST') {
    const tick = await runTick(env, { now: Date.now(), forceTrigger: true });
    return json({ ok: true, tick });
  }

  if (path === '/api/config' && request.method === 'POST') {
    const body = await readBody(request);
    const config = await setConfig(env, body, Date.now());
    const state = await getState(env);
    return json({ ok: true, config, state });
  }

  // Manual source purge: either 'older' (default 6 months, configurable) or 'all'
  if (path === '/api/sources/purge' && request.method === 'POST') {
    const body = await readBody(request);
    const mode = body.mode === 'all' ? 'all' : 'older';
    const months = body.months != null ? Number(body.months) : undefined;
    const result = await purgeSources(env, { mode, months, now: Date.now() });
    const usage = await refreshUsage(env, { now: Date.now(), force: true });
    return json({ ...result, usage, guards: usage.guards });
  }

  if (path === '/api/products' && request.method === 'GET') {
    const rows = (
      await env.DB.prepare('SELECT * FROM custom_products ORDER BY id DESC').all()
    ).results || [];
    return json({ ok: true, products: rows });
  }

  if (path === '/api/products' && request.method === 'POST') {
    const body = await readBody(request);
    try {
      const product = await addCustomProduct(env, body.name, Date.now());
      let tick = null;
      if (body.immediate !== false) {
        tick = await runTick(env, { now: Date.now(), forceTrigger: false });
      } else if (ctx?.waitUntil) {
        ctx.waitUntil(runTick(env, { now: Date.now(), forceTrigger: false }));
      }
      return json({ ok: true, product, tick }, 201);
    } catch (err) {
      return json({ ok: false, error: err?.message || 'خطا در افزودن محصول' }, 400);
    }
  }

  if (path === '/api/products' && request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ ok: false, error: 'شناسه محصول الزامی است' }, 400);
    const deleted = await deleteCustomProduct(env, id);
    return json({ ok: deleted });
  }

  if (path === '/api/usage/refresh' && request.method === 'POST') {
    const usage = await refreshUsage(env, { now: Date.now(), force: true });
    return json({ ok: true, usage, guards: usage.guards });
  }

  if (path === '/api/reset' && request.method === 'POST') {
    const curState = await getState(env);
    const nextEpoch = (curState.epoch || 1) + 1;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sources'),
      env.DB.prepare('DELETE FROM search_tasks'),
      env.DB.prepare('DELETE FROM custom_products'),
      env.DB.prepare('DELETE FROM meta WHERE key IN (?1, ?2, ?3)')
        .bind('scanner_state', 'engine_stats', 'host_cooldowns'),
    ]);
    const cfg = await getConfig(env);
    await env.DB.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES ('scanner_state', ?1, ?2)`
    )
      .bind(
        JSON.stringify({
          round: 0,
          cycle_id: 0,
          active: false,
          phase: 'idle',
          last_cycle_started_at: 0,
          last_cycle_finished_at: 0,
          next_scan_at: Date.now() + cfg.refresh_hours * 3600_000,
          last_tick_at: Date.now(),
          last_tick_summary: 'پایگاه‌داده بازنشانی شد و آماده اسکن جدید است',
          searches_total: 0,
          pages_verified_total: 0,
          cycle_searches: 0,
          cycle_verifications: 0,
          engine_cursor: 0,
          directory_cursor: 0,
          epoch: nextEpoch,
          last_error: '',
        }),
        Date.now()
      )
      .run();
    return json({ ok: true, epoch: nextEpoch });
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}
