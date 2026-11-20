/** Scan pipeline — search → fetch → extract → chunk → store (cron-driven) */

import { searchWeb, diverse } from './engines.js';
import { extractMainText, extractTitle, detectLang, normalizeUrl, domainOf } from './extract.js';
import { chunk, singleChunk, harvestFacts } from './chunker.js';
import { buildKnowledgeItem } from './knowledge.js';

const MAX_FETCH_MS = 10000;
const HTML_CAP = 250_000; // chars — CPU safety on Workers free (10ms)

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
async function runSearchPhase(scan, env) {
  const maxPages = intVar(env, 'MAX_PAGES_PER_SCAN', 12);
  const qLimit = intVar(env, 'SEARCH_QUERY_LIMIT', 3);
  const queries = queriesForScan(scan, qLimit);

  const existing = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM pages WHERE scan_id = ?1'
  )
    .bind(scan.id)
    .first();

  const room = maxPages - (existing?.c || 0);
  if (room <= 0) {
    await env.DB.prepare(
      "UPDATE scans SET status = 'fetching', phase = 'fetch', updated_at = ?1 WHERE id = ?2"
    )
      .bind(now(), scan.id)
      .run();
    return;
  }

  const allHits = [];
  const enginesUsed = new Set(JSON.parse(scan.engines_used || '[]'));

  for (const q of queries) {
    if (allHits.length >= maxPages + 6) break;
    const { hits, enginesUsed: used } = await searchWeb(q, {
      minHits: Math.min(8, room + 4),
    });
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
    batch.push(
      insertStmt.bind(
        scan.id, url, domainOf(url), h.title || '', h.engine || '', h.query || '', now()
      )
    );
  }
  if (batch.length) await env.DB.batch(batch);

  // Success = any pending work (new hits OR pages left from a refresh reset)
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM pages WHERE scan_id = ?1 AND status = 'pending'`
  )
    .bind(scan.id)
    .first();
  const hasPages = (pending?.c || 0) > 0;

  await env.DB.prepare(
    `UPDATE scans SET status = ?1, phase = ?2, engines_used = ?3, error = ?4,
       pages_total = (SELECT COUNT(*) FROM pages WHERE scan_id = ?5),
       updated_at = ?6
     WHERE id = ?5`
  )
    .bind(
      hasPages ? 'fetching' : 'failed',
      hasPages ? 'fetch' : 'search',
      JSON.stringify([...enginesUsed]),
      hasPages ? null : 'no_search_results',
      scan.id,
      now()
    )
    .run();
}

/** Phase FETCH: claim pending pages, extract, dual-write knowledge. */
async function runFetchPhase(scan, env) {
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
  )
    .bind(now(), scan.id, perTick)
    .all();

  const pages = claimed?.results || [];

  if (pages.length === 0) {
    // Another concurrent invocation may still hold claims — do not finalize yet
    const inFlight = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM pages
       WHERE scan_id = ?1 AND status IN ('pending','claimed')`
    )
      .bind(scan.id)
      .first();
    if ((inFlight?.c || 0) > 0) return;

    const totals = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM knowledge WHERE scan_id = ?1) AS kc,
         (SELECT COUNT(*) FROM pages WHERE scan_id = ?1) AS total,
         (SELECT COUNT(*) FROM pages WHERE scan_id = ?1
            AND status IN ('done','skipped','failed')) AS done`
    )
      .bind(scan.id)
      .first();

    const knowledgeCount = totals?.kc || 0;
    const status = knowledgeCount > 0 ? 'done' : 'failed';
    const refreshMs = (scan.refresh_hours || 24) * 3600_000;

    await env.DB.prepare(
      `UPDATE scans SET status = ?1, phase = 'fetch', error = ?2,
         pages_done = ?3, pages_total = ?4, knowledge_count = ?5,
         next_refresh_at = ?6, updated_at = ?7
       WHERE id = ?8`
    )
      .bind(
        status,
        knowledgeCount > 0 ? null : 'no_knowledge_extracted',
        totals?.done || 0,
        totals?.total || 0,
        knowledgeCount,
        scan.auto_refresh ? now() + refreshMs : null,
        now(),
        scan.id
      )
      .run();
    return;
  }

  const knowledgeStmt = env.DB.prepare(
    `INSERT INTO knowledge (
       id, scan_id, kind, topic, question, claim, category, attribute,
       url, domain, confidence, ttl_days, layer, tags,
       chunk_index, chunk_total, tokens, offset_chars, lang,
       created_at, last_verified_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
       ?9, ?10, ?11, ?12, ?13, ?14,
       ?15, ?16, ?17, ?18, ?19,
       ?20, ?21
     )
     ON CONFLICT(scan_id, id) DO UPDATE SET
       claim = excluded.claim,
       confidence = excluded.confidence,
       tags = excluded.tags,
       tokens = excluded.tokens,
       last_verified_at = excluded.last_verified_at`
  );

  const pageDoneStmt = env.DB.prepare(
    `UPDATE pages SET status = ?1, http_status = ?2, error = ?3, chars = ?4,
       fetched_at = ?5, title = COALESCE(NULLIF(?6, ''), title)
     WHERE id = ?7`
  );

  const nowTs = now();
  let deltaDone = 0;
  let deltaKb = 0;

  for (const page of pages) {
    const { html, status: httpStatus, error: fetchErr } = await fetchPageText(page.url);

    if (fetchErr || !html) {
      const next = (page.attempts || 1) >= 3 ? 'failed' : 'pending';
      await pageDoneStmt
        .bind(next, httpStatus ?? null, fetchErr || 'empty', 0, nowTs, '', page.id)
        .run();
      if (next === 'failed') {
        deltaDone++;
        await syncSourceState(env, page.url, 'failed');
      }
      continue;
    }

    const title = extractTitle(html) || page.title || '';
    const text = extractMainText(html, 6000);

    if (text.length < 100) {
      await pageDoneStmt
        .bind('skipped', httpStatus, 'too_short', text.length, nowTs, title, page.id)
        .run();
      deltaDone++;
      continue;
    }

    const lang = detectLang(text);
    let parts = chunk(text);
    if (parts.length === 0) {
      const sc = singleChunk(text);
      if (sc) parts = [sc];
    }

    const facts = harvestFacts(text, 6);
    const totalChunks = parts.length;
    const items = [];

    for (const p of parts) {
      items.push(
        buildKnowledgeItem({
          kind: 'chunk',
          topic: scan.topic,
          question: scan.topic,
          claim: p.text,
          url: page.url,
          domain: page.domain,
          index: p.index,
          total: totalChunks,
          layer: null,
          lang,
          now: nowTs,
          offset: p.offset,
        })
      );
    }

    facts.forEach((f, i) => {
      items.push(
        buildKnowledgeItem({
          kind: 'fact',
          topic: scan.topic,
          question: scan.topic,
          claim: f.text,
          url: page.url,
          domain: page.domain,
          index: i,
          total: facts.length,
          layer: null,
          lang,
          now: nowTs,
          offset: f.offset,
        })
      );
    });

    if (items.length === 0) {
      await pageDoneStmt
        .bind('skipped', httpStatus, 'no_items', text.length, nowTs, title, page.id)
        .run();
      deltaDone++;
      continue;
    }

    const kb = items.map((it) =>
      knowledgeStmt.bind(
        it.id, scan.id, it.kind, it.topic, it.question, it.claim, it.category,
        it.attribute, it.url, it.domain, it.confidence, it.ttl_days, it.layer,
        it.tags, it.chunk_index, it.chunk_total, it.tokens, it.offset_chars,
        it.lang, it.created_at, it.last_verified_at
      )
    );
    kb.push(
      pageDoneStmt.bind('done', httpStatus, null, text.length, nowTs, title, page.id)
    );
    await env.DB.batch(kb);
    deltaDone++;
    deltaKb += items.length;
    await syncSourceState(env, page.url, 'done');
  }

  // Incremental progress — the old per-step 3xCOUNT scanned thousands of rows
  // every fetch step (top cause of the D1 daily read-limit blowout).
  // Exact totals run once in the finalize branch above (empty claim).
  if (deltaDone > 0 || deltaKb > 0) {
    await env.DB.prepare(
      `UPDATE scans SET pages_done = pages_done + ?1, knowledge_count = knowledge_count + ?2,
         updated_at = ?3
       WHERE id = ?4`
    )
      .bind(deltaDone, deltaKb, nowTs, scan.id)
      .run();
  }
}


/** Sync sources.state from page outcome: dead after repeated failure, live after knowledge. */
async function syncSourceState(env, url, pageStatus) {
  try {
    if (pageStatus === 'failed') {
      await env.DB.prepare(
        `UPDATE sources SET state = 'dead', last_checked_at = ?1
         WHERE url = ?2 AND state != 'dead'
           AND NOT EXISTS (
             SELECT 1 FROM pages p WHERE p.url = ?2 AND p.status = 'done'
           )`
      )
        .bind(now(), url)
        .run();
    } else if (pageStatus === 'done') {
      await env.DB.prepare(
        `UPDATE sources SET state = 'live', last_checked_at = ?1 WHERE url = ?2`
      )
        .bind(now(), url)
        .run();
    }
  } catch {
    /* non-fatal */
  }
}

/** Recover pages stuck in 'claimed' > 10 min (crashed invocation). */
async function recoverStuck(env) {
  const cutoff = now() - 10 * 60_000;
  await env.DB.prepare(
    `UPDATE pages SET status = 'pending', claimed_at = NULL
     WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?1`
  )
    .bind(cutoff)
    .run();
}

/** 6-hour cron: requeue due auto-refresh scans (scans while user is away).
 *  Resets stored pages to pending so content is re-verified (REFRESH semantics). */
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
  )
    .bind(t)
    .all();
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

/** One tick step: recover → fair pick (queued vs fetching by wait time) → advance.
 *  Long fetch jobs (e.g. 800+ page harvest) must not starve the queue.
 *  Returns true if work was performed. */
export async function runTick(env) {
  await recoverStuck(env);

  const [fetching, queued] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM scans WHERE status = 'fetching' ORDER BY updated_at ASC LIMIT 1`
    ).first(),
    env.DB.prepare(
      `SELECT * FROM scans WHERE status IN ('queued','searching') ORDER BY updated_at ASC LIMIT 1`
    ).first(),
  ]);

  if (!fetching && !queued) return false;

  // Both waiting: advance whichever has waited longer (smaller updated_at).
  // A just-searched scan gets updated_at=now → next tick prefers older queued.
  if (fetching && queued) {
    if ((queued.updated_at || 0) <= (fetching.updated_at || 0)) {
      await markSearchingAndSearch(queued, env);
    } else {
      await runFetchPhase(fetching, env);
    }
    return true;
  }

  if (queued) {
    await markSearchingAndSearch(queued, env);
    return true;
  }

  await runFetchPhase(fetching, env);
  return true;
}

async function markSearchingAndSearch(scan, env) {
  if (scan.status === 'queued') {
    await env.DB.prepare(
      "UPDATE scans SET status = 'searching', updated_at = ?1 WHERE id = ?2"
    )
      .bind(now(), scan.id)
      .run();
    scan.status = 'searching';
  }
  await runSearchPhase(scan, env);
}

/** Advance a single scan one step (search or fetch). Returns true if worked. */
async function advanceOne(scan, env) {
  if (!scan) return false;
  if (scan.status === 'fetching') {
    await runFetchPhase(scan, env);
    return true;
  }
  if (scan.status === 'queued' || scan.status === 'searching') {
    if (scan.status === 'queued') {
      await env.DB.prepare(
        "UPDATE scans SET status = 'searching', updated_at = ?1 WHERE id = ?2"
      )
        .bind(now(), scan.id)
        .run();
      scan.status = 'searching';
    }
    await runSearchPhase(scan, env);
    return true;
  }
  return false;
}

/**
 * Drain the queue: optionally finish `prioritizeId` first, then loop runTick.
 * Used by refresh button (immediate) and cron (batch).
 * @param {{maxSteps?:number, prioritizeId?:string|null}} opts
 */
export async function drainQueue(env, { maxSteps = 24, prioritizeId = null } = {}) {
  let steps = 0;

  if (prioritizeId) {
    while (steps < maxSteps) {
      const scan = await env.DB.prepare('SELECT * FROM scans WHERE id = ?1')
        .bind(prioritizeId)
        .first();
      if (!scan || !['queued', 'searching', 'fetching'].includes(scan.status)) break;
      const worked = await advanceOne(scan, env);
      if (!worked) break;
      steps++;
      // re-read status each loop; stop when terminal
      const after = await env.DB.prepare('SELECT status FROM scans WHERE id = ?1')
        .bind(prioritizeId)
        .first();
      if (!after || ['done', 'failed'].includes(after.status)) break;
    }
  }

  while (steps < maxSteps) {
    const worked = await runTick(env);
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
