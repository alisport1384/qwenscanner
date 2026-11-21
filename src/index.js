/** Qwen Scanner — Cloudflare Worker entry (fetch + scheduled) */

import { handleApi } from './api.js';
import { runTick, requeueDueScans, drainQueue } from './pipeline.js';
import { renderReportPage, renderBatchReportPage, renderAllReportPage, renderSourcesPage } from './report.js';
import { ensureSchema } from './schema.js';
import { runFinderRound } from './finder.js';
import { ensureIronPinSeed } from './seed.js';
import { getRowsReadFresh } from './usage.js';
import { processIronpinBatch } from './ironpin.js';

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

/** Edge-cache public report GETs 120s — skipped when AUTH_TOKEN set (private). */
async function cachedGet(request, env, ctx, fn, ttl = 120) {
  const cacheable = request.method === 'GET' && !env.AUTH_TOKEN;
  if (!cacheable) return await fn();
  try {
    const hit = await caches.default.match(request);
    if (hit) return hit;
  } catch {
    /* ignore */
  }
  const res = await fn();
  try {
    if (res && res.ok && !/\\bno-store\\b/i.test(res.headers.get('Cache-Control') || '')) {
      const clone = res.clone();
      const p = caches.default.put(request, clone, { expirationTtl: ttl });
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p.catch(() => {}));
      else await p.catch(() => {});
    }
  } catch {
    /* ignore */
  }
  return res;
}

async function runScheduledWork(env, cron) {
  await ensureSchema(env);
  // IronPin seed once (sources + product price batch + harvest pages)
  try {
    await ensureIronPinSeed(env);
  } catch (e) {
    console.error('ironpin seed failed', e);
  }
  // Price retention is MANUAL-ONLY (user command) — no auto purge.

  // D1 read-budget guard: near/over the free-tier daily cap → skip heavy work.
  try {
    const rowsRead = await getRowsReadFresh(env);
    if (rowsRead != null && rowsRead > 4_500_000) {
      console.warn(
        'read-budget guard: rows_read=' + rowsRead + ' — skipping finder/drain/requeue'
      );
      return;
    }
  } catch (e) {
    console.error('read-budget guard failed', e);
  }

  // Incremental IronPin materialization: at most 10 indexed knowledge rows per tick.
  // Parsing is removed from the public GET path; cursor advances only after the
  // upserts commit, and newer source versions are naturally picked up later.
  try {
    const result = await processIronpinBatch(env.DB);
    if (result.processed) console.log('ironpin materialized', result);
  } catch (e) {
    console.error('ironpin materialization failed', e);
  }

  if (cron === '0 */6 * * *') {
    await requeueDueScans(env);
  }
  // Searcher-2 discovery round (20 min rest between rounds)
  try {
    await runFinderRound(env);
  } catch (e) {
    console.error('finder failed', e);
  }
  // Drain queue in batch (was: single runTick — left items stuck in صف)
  try {
    await drainQueue(env, { maxSteps: 30 });
  } catch (e) {
    console.error('drain failed', e);
    await runTick(env);
  }
}

async function handleScheduled(event, env, ctx) {
  const cron = (event && event.cron) || '';
  console.log('scheduled fired', cron);
  const work = runScheduledWork(env, cron)
    .then(() => console.log('scheduled done', cron))
    .catch((e) => {
      console.error('scheduled error', e);
      throw e;
    });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(work);
    return;
  }
  await work;
}

const worker = {
  async fetch(request, env, ctx) {
    let path = '/';
    let method = 'GET';
    try {
      const url = new URL(request.url);
      path = url.pathname;
      method = request.method.toUpperCase();
      // Manual pipeline trigger (local/dev + emergency re-run without waiting cron)
      if (method === 'POST' && path === '/api/dev/tick') {
        await ensureSchema(env);
        const cron = url.searchParams.get('cron') || '';
        await runScheduledWork(env, cron);
        return new Response(JSON.stringify({ ok: true, cron }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path.startsWith('/api/') || path.startsWith('/report/')) {
        await ensureSchema(env);
      }

      if (path.startsWith('/api/')) {
        if (method === 'GET' && path === '/api/ironpin') {
          return await cachedGet(request, env, ctx, () => handleApi(request, env, ctx), 900);
        }
        if (method === 'GET' && (path === '/api/report/all' || path === '/api/sources')) {
          return await cachedGet(request, env, ctx, () => handleApi(request, env, ctx));
        }
        return await handleApi(request, env, ctx);
      }

      if (path.startsWith('/report/')) {
        return await cachedGet(request, env, ctx, async () => {
          if (path.startsWith('/report/batch/')) {
            const id = decodeURIComponent(path.split('/')[3] || '');
            return await renderBatchReportPage(id, env);
          }
          if (path === '/report/all') return await renderAllReportPage(env);
          if (path === '/report/sources') return await renderSourcesPage(env);
          const id = decodeURIComponent(path.split('/')[2] || '');
          return await renderReportPage(id, env);
        });
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      const msg = String(e?.message || e);
      console.error('fetch error', path, msg, e?.stack);
      if (path.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      return new Response('Internal error: ' + msg, { status: 500, headers: HTML_HEADERS });
    }
  },

  scheduled: handleScheduled,
};

// Single module export: default { fetch, scheduled }
export default worker;
