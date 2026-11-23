/**
 * Scan pipeline — search → fetch → Searcher-1 extract → store Quotes.
 *
 * This is the online mirror of IronPin's internal scanner. The Qwen
 * RAG/chunk dual-write is removed: every fetched page is read by Searcher-1
 * (text_engine.analyzeText + image_extract) and the resulting Quote rows are
 * stored directly into ironpin_quotes. No knowledge/chunk table is written.
 */

import { searchWeb, diverse } from './engines.js';
import { extractMainText, extractTitle, detectLang, normalizeUrl, domainOf } from './extract.js';
import { extractQuotesFromPage, extractTableQuotes, storeQuotes } from './ironpin.js';
import { extractFromPage } from './image_extract.js';

const MAX_FETCH_MS = 10000;
/** Body cap for parsing. 250k used to cut ahanmelal's page in half (334 priced
 *  rows → ~170); IronPin's own reader accepts up to 8 MB. Chosen to cover full
 *  price lists; the fetch cap of 10s and the daily fetch limit bound the cost. */
const HTML_CAP = 750_000;

function now() {
  return Date.now();
}

function intVar(env, name, fallback) {
  const v = parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function queriesForScan(scan, limit) {
  const topic = scan.topic.trim();
  const qs = [topic, `${topic} راهنمای جامع`, `${topic} آخرین اطلاعات`];
  return [...new Set(qs)].slice(0, limit);
}

async function fetchPageText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), MAX_FETCH_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      cf: { cacheTtl: 0 },
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fa,en;q=0.8',
      },
    });
    if (!res.ok) return { error: `http_${res.status}`, status: res.status };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !/html|text\/plain|xml/.test(ct)) return { error: 'content_type', status: res.status };
    let html = await res.text();
    if (html.length > HTML_CAP) html = html.slice(0, HTML_CAP);
    return { html, status: res.status };
  } catch (e) {
    return { error: e?.name === 'AbortError' ? 'timeout' : 'fetch_error', status: null };
  } finally {
    clearTimeout(t);
  }
}

/** Phase SEARCH: expand queries → engines → diverse pages → insert queue. */
export async function runSearchPhase(scan, env, opts = {}) {
  const g = opts.guardian;
  const search = opts.search || searchWeb;
  if (g && g.expired()) return;
  const maxPages = intVar(env, 'MAX_PAGES_PER_SCAN', 12);
  const qLimit = intVar(env, 'SEARCH_QUERY_LIMIT', 3);
  const queries = queriesForScan(scan, qLimit);

  const existing = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM pages WHERE scan_id = ?1'
  ).bind(scan.id).first();

  const room = maxPages - (existing?.c || 0);
  if (room <= 0) {
    await env.DB.prepare(
      "UPDATE scans SET status = 'fetching', phase = 'fetch', updated_at = ?1 WHERE id = ?2"
    ).bind(now(), scan.id).run();
    return;
  }

  const allHits = [];
  const enginesUsed = new Set(JSON.parse(scan.engines_used || '[]'));

  for (const q of queries) {
    if (g && g.expired()) break;
    if (allHits.length >= maxPages + 6) break;
    const { hits, enginesUsed: used } = await search(q, { minHits: Math.min(8, room + 4) });
    used.forEach((e) => enginesUsed.add(e));
    for (const h of hits) allHits.push({ ...h, query: q });
  }

  const picked = diverse(allHits, 2, maxPages);

  const insertStmt = env.DB.prepare(
    `INSERT INTO pages (scan_id, url, domain, title, source, query, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)
     ON CONFLICT(scan_id, url) DO NOTHING`
  );
  const batch = [];
  for (const h of picked) {
    const url = normalizeUrl(h.url);
    if (!url) continue;
    batch.push(insertStmt.bind(scan.id, url, domainOf(url), h.title || '', h.engine || '', h.query || '', now()));
  }
  if (batch.length) await env.DB.batch(batch);

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM pages WHERE scan_id = ?1 AND status = 'pending'`
  ).bind(scan.id).first();
  const hasPages = (pending?.c || 0) > 0;

  await env.DB.prepare(
    `UPDATE scans SET status = ?1, phase = ?2, engines_used = ?3, error = ?4,
       pages_total = (SELECT COUNT(*) FROM pages WHERE scan_id = ?5),
       updated_at = ?6
     WHERE id = ?5`
  ).bind(
    hasPages ? 'fetching' : 'failed',
    hasPages ? 'fetch' : 'search',
    JSON.stringify([...enginesUsed]),
    hasPages ? null : 'no_search_results',
    scan.id,
    now()
  ).run();
}

/** Phase FETCH: claim pending pages, Searcher-1 extract, store Quotes. */
export async function runFetchPhase(scan, env, opts = {}) {
  const g = opts.guardian;
  if (g && g.expired()) return;
  const perTick = intVar(env, 'PAGES_PER_TICK', 5);

  const claimed = await env.DB.prepare(
    `UPDATE pages SET status = 'claimed', claimed_at = ?1, attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM pages
       WHERE scan_id = ?2 AND status = 'pending'
       ORDER BY id
       LIMIT ?3
     )
     RETURNING id, url, domain, title, attempts`
  ).bind(now(), scan.id, perTick).all();

  const pages = claimed?.results || [];

  if (pages.length === 0) {
    const inFlight = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM pages WHERE scan_id = ?1 AND status IN ('pending','claimed')`
    ).bind(scan.id).first();
    if ((inFlight?.c || 0) > 0) return;

    const totals = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM ironpin_quotes WHERE scan_id = ?1) AS qc,
         (SELECT COUNT(*) FROM pages WHERE scan_id = ?1) AS total,
         (SELECT COUNT(*) FROM pages WHERE scan_id = ?1 AND status IN ('done','skipped','failed')) AS done`
    ).bind(scan.id).first();

    const quoteCount = totals?.qc || 0;
    const status = quoteCount > 0 ? 'done' : 'failed';
    const refreshMs = (scan.refresh_hours || 24) * 3600_000;

    await env.DB.prepare(
      `UPDATE scans SET status = ?1, phase = 'fetch', error = ?2,
         pages_done = ?3, pages_total = ?4, knowledge_count = ?5,
         next_refresh_at = ?6, updated_at = ?7
       WHERE id = ?8`
    ).bind(
      status,
      quoteCount > 0 ? null : 'no_quotes_extracted',
      totals?.done || 0,
      totals?.total || 0,
      quoteCount,
      scan.auto_refresh ? now() + refreshMs : null,
      now(),
      scan.id
    ).run();
    return;
  }

  const pageDoneStmt = env.DB.prepare(
    `UPDATE pages SET status = ?1, http_status = ?2, error = ?3, chars = ?4,
       fetched_at = ?5, title = COALESCE(NULLIF(?6, ''), title)
     WHERE id = ?7`
  );

  const nowTs = now();
  let deltaDone = 0;
  let deltaQuotes = 0;

  for (const page of pages) {
    if (g && g.expired()) break;
    if (g && !g.allowFetch(1)) break;
    if (g) g.spendFetch(1);
    const { html, status: httpStatus, error: fetchErr } = await fetchPageText(page.url);

    if (fetchErr || !html) {
      const next = (page.attempts || 1) >= 3 ? 'failed' : 'pending';
      await pageDoneStmt.bind(next, httpStatus ?? null, fetchErr || 'empty', 0, nowTs, '', page.id).run();
      if (next === 'failed') {
        deltaDone++;
        await syncSourceState(env, page.url, 'failed');
      }
      continue;
    }

    const title = extractTitle(html) || page.title || '';
    const text = extractMainText(html, 6000);

    if (text.length < 100) {
      await pageDoneStmt.bind('skipped', httpStatus, 'too_short', text.length, nowTs, title, page.id).run();
      deltaDone++;
      continue;
    }

    const lang = detectLang(text);

    // Price rows from the page price TABLES (div-grid/tables) — mirror of
    // IronPin's PublicTables reader; the richest source for price-list pages.
    const tableQuotes = extractTableQuotes(html, {
      endpoint: 'qwen-scanner',
      seller: title || page.domain,
      sellerCity: 'نامشخص',
      sourceUrl: page.url,
      fetchedAt: nowTs,
      category: scan.topic || 'عمومی',
      defaultCurrency: 'نامشخص',
    });

    // Text-line rows (claim-style lines) — the online line reader.
    const quotes = extractQuotesFromPage(text, {
      endpoint: 'qwen-scanner',
      seller: title || page.domain,
      sourceUrl: page.url,
      fetchedAt: nowTs,
      sellerCity: 'نامشخص',
      defaultCurrency: 'نامشخص',
    });

    // Image extraction (Clairic typed) — bounded by guardian, never blocks.
    let imgQuotes = [];
    if (g && !g.expired() && g.allowAi(1)) {
      try {
        imgQuotes = await extractFromPage(env, {
          html,
          pageUrl: page.url,
          domain: page.domain,
          text,
          scan: scan,
          lang,
          now: nowTs,
          guardian: g,
        });
      } catch (e) {
        console.error('image extract failed', e?.message || e);
      }
    }

    const allQuotes = [...tableQuotes, ...quotes, ...imgQuotes];
    if (allQuotes.length === 0) {
      await pageDoneStmt.bind('skipped', httpStatus, 'no_quotes', text.length, nowTs, title, page.id).run();
      deltaDone++;
      continue;
    }

    const stored = await storeQuotes(env.DB, scan.id, allQuotes, nowTs);
    await pageDoneStmt.bind('done', httpStatus, null, text.length, nowTs, title, page.id).run();
    deltaDone++;
    deltaQuotes += stored;
    await syncSourceState(env, page.url, 'done');
  }

  if (deltaDone > 0 || deltaQuotes > 0) {
    await env.DB.prepare(
      `UPDATE scans SET pages_done = pages_done + ?1, knowledge_count = knowledge_count + ?2,
         updated_at = ?3
       WHERE id = ?4`
    ).bind(deltaDone, deltaQuotes, nowTs, scan.id).run();
  }
}

/** Sync sources.state from page outcome: dead after repeated failure, live after quotes. */
async function syncSourceState(env, url, pageStatus) {
  try {
    if (pageStatus === 'failed') {
      await env.DB.prepare(
        `UPDATE sources SET state = 'dead', last_checked_at = ?1
         WHERE url = ?2 AND state != 'dead'
           AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.url = ?2 AND p.status = 'done')`
      ).bind(now(), url).run();
    } else if (pageStatus === 'done') {
      await env.DB.prepare(
        `UPDATE sources SET state = 'live', last_checked_at = ?1 WHERE url = ?2`
      ).bind(now(), url).run();
    }
  } catch { /* non-fatal */ }
}

/** Recover pages stuck in 'claimed' > 10 min (crashed invocation). */
async function recoverStuck(env) {
  const cutoff = now() - 10 * 60_000;
  await env.DB.prepare(
    `UPDATE pages SET status = 'pending', claimed_at = NULL
     WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?1`
  ).bind(cutoff).run();
}

/** 6-hour cron: requeue due auto-refresh scans (scans while user is away). */
export async function requeueDueScans(env) {
  const t = now();
  const due = await env.DB.prepare(
    `UPDATE scans
     SET status = 'queued', phase = 'search', error = NULL,
         pages_done = 0, knowledge_count = 0, updated_at = ?1,
         next_refresh_at = ?1 + refresh_hours * 3600000
     WHERE auto_refresh = 1 AND status IN ('done','failed')
       AND next_refresh_at IS NOT NULL AND next_refresh_at <= ?1
     RETURNING id`
  ).bind(t).all();
  const ids = (due?.results || []).map((r) => r.id);
  if (!ids.length) return;
  const resetPages = ids.map((id) =>
    env.DB.prepare(
      `UPDATE pages SET status = 'pending', claimed_at = NULL, attempts = 0
       WHERE scan_id = ?1`
    ).bind(id)
  );
  await env.DB.batch(resetPages);
}

/** One tick step: recover → fair pick (queued vs fetching by wait time) → advance. */
export async function runTick(env, opts = {}) {
  await recoverStuck(env);

  const [fetching, queued] = await Promise.all([
    env.DB.prepare(`SELECT * FROM scans WHERE status = 'fetching' ORDER BY updated_at ASC LIMIT 1`).first(),
    env.DB.prepare(`SELECT * FROM scans WHERE status IN ('queued','searching') ORDER BY updated_at ASC LIMIT 1`).first(),
  ]);

  if (!fetching && !queued) return false;

  if (fetching && queued) {
    if ((queued.updated_at || 0) <= (fetching.updated_at || 0)) {
      await markSearchingAndSearch(queued, env, opts);
    } else {
      await runFetchPhase(fetching, env, opts);
    }
    return true;
  }

  if (queued) {
    await markSearchingAndSearch(queued, env, opts);
    return true;
  }

  await runFetchPhase(fetching, env, opts);
  return true;
}

async function markSearchingAndSearch(scan, env, opts = {}) {
  if (scan.status === 'queued') {
    await env.DB.prepare(
      "UPDATE scans SET status = 'searching', updated_at = ?1 WHERE id = ?2"
    ).bind(now(), scan.id).run();
    scan.status = 'searching';
  }
  await runSearchPhase(scan, env, opts);
}

/** Advance a single scan one step (search or fetch). */
async function advanceOne(scan, env, opts = {}) {
  if (!scan) return false;
  if (scan.status === 'fetching') {
    await runFetchPhase(scan, env, opts);
    return true;
  }
  if (scan.status === 'queued' || scan.status === 'searching') {
    if (scan.status === 'queued') {
      await env.DB.prepare(
        "UPDATE scans SET status = 'searching', updated_at = ?1 WHERE id = ?2"
      ).bind(now(), scan.id).run();
      scan.status = 'searching';
    }
    await runSearchPhase(scan, env, opts);
    return true;
  }
  return false;
}

/**
 * Drain the queue: optionally finish `prioritizeId` first, then loop runTick.
 */
export async function drainQueue(env, { maxSteps = 24, prioritizeId = null, guardian = null } = {}) {
  let steps = 0;
  const opts = { guardian };

  if (prioritizeId) {
    while (steps < maxSteps) {
      if (guardian && guardian.expired()) break;
      const scan = await env.DB.prepare('SELECT * FROM scans WHERE id = ?1').bind(prioritizeId).first();
      if (!scan || !['queued', 'searching', 'fetching'].includes(scan.status)) break;
      const worked = await advanceOne(scan, env, opts);
      if (!worked) break;
      steps++;
      const after = await env.DB.prepare('SELECT status FROM scans WHERE id = ?1').bind(prioritizeId).first();
      if (!after || ['done', 'failed'].includes(after.status)) break;
    }
  }

  while (steps < maxSteps) {
    if (guardian && guardian.expired()) break;
    const worked = await runTick(env, opts);
    if (!worked) break;
    steps++;
  }

  return { steps, remaining: await countActive(env) };
}

async function countActive(env) {
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM scans WHERE status IN ('queued','searching','fetching')`
    ).first();
    return r?.c || 0;
  } catch {
    return 0;
  }
}
