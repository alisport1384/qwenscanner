/**
 * هوش جستجوگر ۲ — Searcher-2 Orchestrator on Cloudflare Worker + D1.
 * Strict source discovery ONLY (websites / social / domestic networks).
 * Zero price-row extraction.
 */

import {
  FINDER_BANKS,
  SEED_HOMEPAGES,
  customProductQueries,
  finderQueries,
  normalizeText,
  sellsGoods,
  tradeEvidence,
  usesSiteOperator,
} from './banks.js';
import {
  FinderPart,
  classifyLink,
  isDirectoryHost,
  previewUrl,
} from './classify.js';
import {
  ALL_PROVIDERS,
  DIRECTORY_PROVIDERS,
  SEARCH_PROVIDERS,
  answersQuestion,
  isChallengeOrBlocked,
  querySearchProvider,
  saysNoResults,
  timedFetch,
} from './engines.js';
import { getRowsReadFresh } from './usage.js';
import { judgePublicPage, parsePublicPage } from './verifier.js';

export const MAX_PER_PART = 500;
export const MAX_PER_HOST = 12;
export const MAX_DEPTH = 2;
const DEFAULT_REFRESH_HOURS = 24;
const ROW_READ_SOFT_CAP = 4_400_000;

async function getMetaJson(env, key, fallback) {
  try {
    const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1')
      .bind(key)
      .first();
    if (row?.value) return { ...fallback, ...JSON.parse(row.value) };
  } catch {
    /* ignore */
  }
  return { ...fallback };
}

async function setMetaJson(env, key, obj, now = Date.now()) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, JSON.stringify(obj), now)
    .run();
}

export function defaultConfig(env) {
  const hours = Number(env?.DEFAULT_REFRESH_HOURS) || DEFAULT_REFRESH_HOURS;
  return {
    refresh_hours: Math.min(168, Math.max(1, Math.round(hours))),
    auto_enabled: true,
  };
}

export async function getConfig(env) {
  return getMetaJson(env, 'scanner_config', defaultConfig(env));
}

export async function setConfig(env, patch = {}, now = Date.now()) {
  const cur = await getConfig(env);
  const hours =
    patch.refresh_hours != null
      ? Math.min(168, Math.max(1, Math.round(Number(patch.refresh_hours) || 24)))
      : cur.refresh_hours;
  const auto_enabled =
    patch.auto_enabled != null ? Boolean(patch.auto_enabled) : cur.auto_enabled;
  const next = { refresh_hours: hours, auto_enabled };
  await setMetaJson(env, 'scanner_config', next, now);

  // Reschedule next_scan_at cleanly relative to last_cycle_started_at or now
  const state = await getState(env);
  if (state.last_cycle_started_at) {
    state.next_scan_at = state.last_cycle_started_at + hours * 3600_000;
  } else {
    state.next_scan_at = now + hours * 3600_000;
  }
  await setMetaJson(env, 'scanner_state', state, now);
  return next;
}

export function defaultState(now = Date.now(), refreshHours = 24) {
  return {
    round: 0,
    cycle_id: 0,
    active: false,
    phase: 'idle',
    last_cycle_started_at: 0,
    last_cycle_finished_at: 0,
    next_scan_at: now + refreshHours * 3600_000,
    last_tick_at: 0,
    last_tick_summary: 'آماده شروع اولین چرخه کشف منابع',
    searches_total: 0,
    pages_verified_total: 0,
    cycle_searches: 0,
    cycle_verifications: 0,
    engine_cursor: 0,
    directory_cursor: 0,
    epoch: 1,
    last_error: '',
  };
}

export async function getState(env) {
  const cfg = await getConfig(env);
  return getMetaJson(env, 'scanner_state', defaultState(Date.now(), cfg.refresh_hours));
}

function defaultEngineStats() {
  const map = {};
  for (const p of ALL_PROVIDERS) {
    map[p.id] = {
      id: p.id,
      title: p.title,
      group: p.group,
      status: 'ready',
      note: 'آماده',
      cooldown_until: 0,
      empty_streak: 0,
      ok_count: 0,
      fail_count: 0,
      last_hits: 0,
      last_run_at: 0,
    };
  }
  return map;
}

export async function getEngineStats(env) {
  const base = defaultEngineStats();
  const saved = await getMetaJson(env, 'engine_stats', {});
  for (const id of Object.keys(base)) {
    if (saved[id]) base[id] = { ...base[id], ...saved[id] };
  }
  return base;
}

function pickProvider(providers, stats, cursor, now, query) {
  const needsSite = usesSiteOperator(query);
  for (let i = 0; i < providers.length; i++) {
    const idx = (cursor + i) % providers.length;
    const p = providers[idx];
    if (needsSite && p.siteOperator === false) continue;
    const st = stats[p.id];
    if ((st?.cooldown_until || 0) <= now) {
      return { provider: p, nextCursor: (idx + 1) % providers.length };
    }
  }
  return null;
}

/**
 * Starts a new 24h (or configured) discovery cycle:
 * - Enqueues the next rotating slice of all 3 FinderPlan banks (sites/social/domestic)
 * - Enqueues rotating directory searches across the 6 Iranian channel directories
 * - Enqueues custom product queries
 * - On round 0, enqueues SEED_HOMEPAGES for inner price & channel link crawling
 * - Re-opens retryable 'unreachable' sources if their retry window expired
 */
export async function startCycle(env, { now = Date.now(), force = false } = {}) {
  const cfg = await getConfig(env);
  const state = await getState(env);

  const cycleId = (state.cycle_id || 0) + 1;
  const round = state.round || 0;
  const tasks = [];

  for (const part of FinderPart.all) {
    for (const q of finderQueries(part, round)) {
      tasks.push({ kind: 'search', part, query: q, product_name: '' });
    }
  }

  // Directory queries for social & domestic channels (rotate 2 keywords per cycle)
  const dirTopics = ['آهن', 'میلگرد', 'ورق', 'تیرآهن', 'پروفیل', 'لوله'];
  const dirTopic = dirTopics[round % dirTopics.length];
  tasks.push({ kind: 'directory', part: FinderPart.social, query: dirTopic, product_name: '' });
  tasks.push({
    kind: 'directory',
    part: FinderPart.social,
    query: dirTopics[(round + 1) % dirTopics.length],
    product_name: '',
  });

  // Seed homepages on first cycle (round 0) or manual force
  if (round === 0) {
    for (const url of SEED_HOMEPAGES) {
      tasks.push({ kind: 'seed', part: FinderPart.sites, query: url, product_name: '' });
    }
  }

  // Custom products
  const productsRes = await env.DB.prepare('SELECT name FROM custom_products ORDER BY id ASC').all();
  for (const row of productsRes.results || []) {
    for (const t of customProductQueries(row.name)) {
      tasks.push(t);
    }
  }

  const insertTask = env.DB.prepare(
    `INSERT INTO search_tasks (kind, part, query, product_name, status, tries, cycle_id, created_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6)
     ON CONFLICT(kind, query) DO UPDATE SET
       status = 'pending',
       tries = 0,
       cycle_id = excluded.cycle_id,
       product_name = CASE
         WHEN excluded.product_name != '' THEN excluded.product_name
         ELSE search_tasks.product_name
       END`
  );

  for (let i = 0; i < tasks.length; i += 40) {
    const batch = tasks.slice(i, i + 40).map((t) =>
      insertTask.bind(t.kind, t.part, t.query, t.product_name || '', cycleId, now)
    );
    await env.DB.batch(batch);
  }

  // On new cycle, allow previously unreachable sources whose retry_at <= now to be re-tried once
  await env.DB.prepare(
    `UPDATE sources SET state = 'new', verify_tries = 0, next_retry_at = 0
     WHERE state = 'unreachable' AND next_retry_at <= ?1`
  )
    .bind(now)
    .run();

  const maxRounds = Math.max(...FINDER_BANKS.map((b) => Math.ceil(b.length / 5)));
  const nextState = {
    ...state,
    round: (round + 1) % (maxRounds * 100),
    cycle_id: cycleId,
    active: true,
    phase: 'search',
    last_cycle_started_at: now,
    next_scan_at: now + cfg.refresh_hours * 3600_000,
    cycle_searches: 0,
    cycle_verifications: 0,
    last_tick_summary: force
      ? `شروع چرخه #${cycleId} (دستی) با ${tasks.length} پرس‌وجو`
      : `شروع چرخه #${cycleId} (خودکار) با ${tasks.length} پرس‌وجو`,
    last_error: '',
  };
  await setMetaJson(env, 'scanner_state', nextState, now);
  return { cycleId, queued: tasks.length, state: nextState };
}

/**
 * Adds a custom product/keyword and immediately queues targeted Searcher-2 queries.
 */
export async function addCustomProduct(env, rawName, now = Date.now()) {
  const name = normalizeText(rawName);
  if (!name || name.length < 2 || name.length > 80) {
    throw new Error('نام محصول باید بین ۲ تا ۸۰ کاراکتر باشد.');
  }
  const normalized = name.toLowerCase();
  const queries = customProductQueries(name);

  await env.DB.prepare(
    `INSERT INTO custom_products (name, normalized, status, queries_done, queries_total, discovered_count, last_scanned_at, created_at)
     VALUES (?1, ?2, 'pending', 0, ?3, 0, 0, ?4)
     ON CONFLICT(normalized) DO UPDATE SET
       name = excluded.name,
       status = 'pending',
       queries_done = 0,
       queries_total = excluded.queries_total`
  )
    .bind(name, normalized, queries.length, now)
    .run();

  const state = await getState(env);
  const cycleId = state.cycle_id || 1;
  const insertTask = env.DB.prepare(
    `INSERT INTO search_tasks (kind, part, query, product_name, status, tries, cycle_id, created_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6)
     ON CONFLICT(kind, query) DO UPDATE SET
       status = 'pending',
       tries = 0,
       product_name = excluded.product_name,
       cycle_id = excluded.cycle_id`
  );
  await env.DB.batch(
    queries.map((q) => insertTask.bind(q.kind, q.part, q.query, name, cycleId, now))
  );

  if (!state.active) {
    state.active = true;
    state.phase = 'search';
    state.last_tick_summary = `افزودن محصول «${name}» و صف ${queries.length} جستجو`;
    await setMetaJson(env, 'scanner_state', state, now);
  }

  return await env.DB.prepare('SELECT * FROM custom_products WHERE normalized = ?1')
    .bind(normalized)
    .first();
}

export async function deleteCustomProduct(env, id) {
  const row = await env.DB.prepare('SELECT * FROM custom_products WHERE id = ?1')
    .bind(Number(id))
    .first();
  if (!row) return false;
  await env.DB.prepare('DELETE FROM search_tasks WHERE product_name = ?1').bind(row.name).run();
  await env.DB.prepare('DELETE FROM custom_products WHERE id = ?1').bind(row.id).run();
  return true;
}

async function loadCapacitySnapshot(env) {
  const perPart = [0, 0, 0];
  const perHost = new Map();
  const known = new Set();

  const [partRows, hostRows, keyRows] = await Promise.all([
    env.DB.prepare(
      `SELECT part, COUNT(*) AS c FROM sources WHERE state IN ('new','ok') GROUP BY part`
    ).all(),
    env.DB.prepare(
      `SELECT host, COUNT(*) AS c FROM sources WHERE kind = 'site' AND state IN ('new','ok') GROUP BY host`
    ).all(),
    env.DB.prepare(`SELECT key FROM sources`).all(),
  ]);

  for (const r of partRows.results || []) {
    if (r.part >= 0 && r.part < 3) perPart[r.part] = Number(r.c || 0);
  }
  for (const r of hostRows.results || []) {
    if (r.host) perHost.set(r.host, Number(r.c || 0));
  }
  for (const r of keyRows.results || []) {
    known.add(r.key);
  }
  return { perPart, perHost, known };
}

function tryAcceptCandidate(link, cap, { depth = 0, isInner = 0, hinted = true, origin = 'search', product = '', from = '', provider = '', name = '' }, now) {
  if (!link) return null;
  if (cap.known.has(link.key)) return { duplicate: true, key: link.key, product };
  if (cap.perPart[link.part] >= MAX_PER_PART) return null;
  if (link.kind === 'site' && link.host) {
    if ((cap.perHost.get(link.host) || 0) >= MAX_PER_HOST) return null;
    cap.perHost.set(link.host, (cap.perHost.get(link.host) || 0) + 1);
  }
  cap.perPart[link.part]++;
  cap.known.add(link.key);
  return {
    key: link.key,
    url: link.url,
    kind: link.kind,
    part: link.part,
    host: link.host || '',
    handle: link.handle || '',
    name: name || '',
    depth,
    is_inner: isInner ? 1 : 0,
    hinted: hinted ? 1 : 0,
    origin,
    matched_product: product || '',
    discovered_from: from || '',
    provider: provider || '',
    now,
  };
}

async function persistCandidates(env, candidates) {
  if (!candidates.length) return 0;
  const fresh = candidates.filter((c) => !c.duplicate);
  const dupProducts = candidates.filter((c) => c.duplicate && c.product);

  const insertStmt = env.DB.prepare(
    `INSERT INTO sources (
       key, url, kind, part, host, handle, name, title, site_name, contact, city,
       has_table, readable, state, verify_tries, depth, is_inner, hinted,
       origin, matched_product, discovered_from, provider, note,
       next_retry_at, discovered_at, verified_at, updated_at
     ) VALUES (
       ?1, ?2, ?3, ?4, ?5, ?6, ?7, '', '', '', 'نامشخص',
       0, ?8, 'new', 0, ?9, ?10, ?11,
       ?12, ?13, ?14, ?15, '',
       0, ?16, 0, ?16
     )
     ON CONFLICT(key) DO NOTHING`
  );

  for (let i = 0; i < fresh.length; i += 35) {
    const batch = fresh.slice(i, i + 35).map((c) => {
      const readable = c.kind === 'site' || ['telegram', 'bale', 'eitaa', 'rubika'].includes(c.kind) ? 1 : 0;
      return insertStmt.bind(
        c.key, c.url, c.kind, c.part, c.host, c.handle, c.name,
        readable, c.depth, c.is_inner, c.hinted,
        c.origin, c.matched_product, c.discovered_from, c.provider, c.now
      );
    });
    await env.DB.batch(batch);
  }

  // Merge product tag on already-known sources when searched via custom product
  if (dupProducts.length) {
    const updStmt = env.DB.prepare(
      `UPDATE sources
       SET matched_product = CASE
         WHEN matched_product = '' THEN ?2
         WHEN instr(matched_product, ?2) = 0 THEN matched_product || '، ' || ?2
         ELSE matched_product
       END
       WHERE key = ?1`
    );
    const seen = new Set();
    const stmts = [];
    for (const d of dupProducts) {
      const k = `${d.key}|${d.product}`;
      if (seen.has(k)) continue;
      seen.add(k);
      stmts.push(updStmt.bind(d.key, d.product));
    }
    for (let i = 0; i < stmts.length; i += 35) {
      await env.DB.batch(stmts.slice(i, i + 35));
    }
  }
  return fresh.length;
}

/**
 * Executes ONE bounded Searcher-2 tick (respecting Cloudflare Free CPU & 50 subrequest limits).
 */
export async function runTick(
  env,
  {
    now = Date.now(),
    forceTrigger = false,
    fetchFn = timedFetch,
  } = {}
) {
  const maxSearches = Math.min(6, Math.max(1, Number(env?.SEARCH_QUERIES_PER_TICK) || 3));
  const maxVerifies = Math.min(12, Math.max(1, Number(env?.VERIFIES_PER_TICK) || 8));
  const maxSubrequests = Math.min(40, Math.max(6, Number(env?.MAX_SUBREQUESTS_PER_TICK) || 28));
  const timeoutMs = Number(env?.FETCH_TIMEOUT_MS) || 9000;

  const cfg = await getConfig(env);
  let state = await getState(env);

  // Fast idle check (only 2-4 D1 row reads when nothing is due!)
  if (!state.active && !forceTrigger) {
    const dueAuto = cfg.auto_enabled && now >= (state.next_scan_at || 0);
    if (!dueAuto) {
      const [pendingTask, pendingVerify] = await Promise.all([
        env.DB.prepare(`SELECT 1 AS ok FROM search_tasks WHERE status = 'pending' LIMIT 1`).first(),
        env.DB.prepare(
          `SELECT 1 AS ok FROM sources WHERE state = 'new' AND next_retry_at <= ?1 LIMIT 1`
        )
          .bind(now)
          .first(),
      ]);
      if (!pendingTask && !pendingVerify) {
        return { idle: true, active: false, searches: 0, verified: 0, added: 0 };
      }
      state.active = true;
    }
  }

  // Budget guard against Cloudflare D1 5M rows/day limit
  const rowsReadToday = await getRowsReadFresh(env, { now });
  if (rowsReadToday != null && rowsReadToday >= ROW_READ_SOFT_CAP) {
    state.last_tick_at = now;
    state.last_tick_summary = `توقف موقت برای حفظ سقف رایگان D1 (${rowsReadToday.toLocaleString('en-US')} ردیف خوانده‌شده)`;
    await setMetaJson(env, 'scanner_state', state, now);
    return { idle: true, budget_paused: true, rows_read: rowsReadToday };
  }

  // Start a new cycle if idle and due (or manually forced when queue is empty)
  const hasPending = await env.DB.prepare(
    `SELECT 1 AS ok FROM search_tasks WHERE status = 'pending' LIMIT 1`
  ).first();
  if (!hasPending && (forceTrigger || (!state.active && cfg.auto_enabled && now >= (state.next_scan_at || 0)))) {
    const started = await startCycle(env, { now, force: forceTrigger });
    state = started.state;
  } else if (forceTrigger && !state.active) {
    state.active = true;
    state.phase = 'search';
  }

  const engineStats = await getEngineStats(env);
  const hostCooldowns = await getMetaJson(env, 'host_cooldowns', {});
  const cap = await loadCapacitySnapshot(env);

  let subrequests = 0;
  let searchesRun = 0;
  let verificationsRun = 0;
  let candidatesAdded = 0;
  let confirmedOk = 0;

  // --------------------------------------------------- 1. Search / Directory / Seed tasks
  const pendingTasks = (
    await env.DB.prepare(
      `SELECT * FROM search_tasks WHERE status = 'pending' ORDER BY id ASC LIMIT ?1`
    )
      .bind(maxSearches)
      .all()
  ).results || [];

  for (const task of pendingTasks) {
    if (subrequests >= maxSubrequests - 4) break;

    if (task.kind === 'seed') {
      subrequests++;
      try {
        const res = await fetchFn(task.query, { timeoutMs });
        if (res.ok) {
          const html = await res.text();
          const page = parsePublicPage(task.query, html);
          const batch = [];
          let siteFollows = 0;
          const seedHost = new URL(task.query).hostname.replace(/^www\./, '');
          for (const a of page.links) {
            const link = classifyLink(a.url);
            if (!link) continue;
            if (link.kind !== 'site') {
              const c = tryAcceptCandidate(
                link,
                cap,
                { depth: 1, hinted: true, origin: 'seed', from: task.query, provider: 'seed', name: a.text },
                now
              );
              if (c) batch.push(c);
            } else if (link.host === seedHost && siteFollows < 8 && (a.text.includes('قیمت') || tradeEvidence(a.text).goods >= 1)) {
              const c = tryAcceptCandidate(
                link,
                cap,
                { depth: 1, isInner: 1, hinted: true, origin: 'seed', from: task.query, provider: 'seed', name: a.text },
                now
              );
              if (c) {
                batch.push(c);
                siteFollows++;
              }
            }
          }
          candidatesAdded += await persistCandidates(env, batch);
        }
      } catch {
        /* ignore dead seed */
      }
      await env.DB.prepare(`UPDATE search_tasks SET status = 'done' WHERE id = ?1`)
        .bind(task.id)
        .run();
      searchesRun++;
      continue;
    }

    if (task.kind === 'directory') {
      const picked = pickProvider(
        DIRECTORY_PROVIDERS,
        engineStats,
        state.directory_cursor || 0,
        now,
        task.query
      );
      if (!picked) {
        await env.DB.prepare(`UPDATE search_tasks SET status = 'done' WHERE id = ?1`)
          .bind(task.id)
          .run();
        continue;
      }
      const { provider, nextCursor } = picked;
      state.directory_cursor = nextCursor;
      const st = engineStats[provider.id];
      st.last_run_at = now;
      subrequests++;

      try {
        const dirUrl = provider.buildUrl(task.query);
        const res = await fetchFn(dirUrl, { timeoutMs: provider.timeoutMs });
        const body = res.ok ? await res.text() : '';
        if (!res.ok || isChallengeOrBlocked(res.status, body)) {
          st.fail_count++;
          st.status = 'cooldown';
          st.cooldown_until = now + 20 * 60_000;
          st.note = `پاسخ ناموفق (${res.status}) — استراحت ۲۰ دقیقه`;
          await env.DB.prepare(`UPDATE search_tasks SET tries = tries + 1, status = CASE WHEN tries + 1 >= 2 THEN 'done' ELSE 'pending' END WHERE id = ?1`)
            .bind(task.id)
            .run();
        } else {
          const page = parsePublicPage(dirUrl, body);
          const batch = [];
          for (const a of page.links) {
            const link = classifyLink(a.url);
            if (!link || link.kind === 'site') continue;
            // Directory links are accepted when the directory page or anchor text speaks of steel/goods
            if (sellsGoods(a.text, task.product_name) || sellsGoods(page.text, task.product_name)) {
              const c = tryAcceptCandidate(
                link,
                cap,
                {
                  depth: 1,
                  hinted: true,
                  origin: 'directory',
                  product: task.product_name,
                  from: `${provider.title}: ${task.query}`,
                  provider: provider.id,
                  name: a.text,
                },
                now
              );
              if (c) batch.push(c);
            }
          }
          const added = await persistCandidates(env, batch);
          candidatesAdded += added;
          st.ok_count++;
          st.status = 'ready';
          st.last_hits = batch.length;
          st.note = `موفق • ${batch.length} کانال دیده‌شده (${added} جدید)`;
          await env.DB.prepare(`UPDATE search_tasks SET status = 'done' WHERE id = ?1`)
            .bind(task.id)
            .run();
        }
      } catch {
        st.fail_count++;
        st.status = 'cooldown';
        st.cooldown_until = now + 10 * 60_000;
        st.note = 'خطای شبکه/مهلت — استراحت ۱۰ دقیقه';
        await env.DB.prepare(`UPDATE search_tasks SET tries = tries + 1, status = CASE WHEN tries + 1 >= 2 THEN 'done' ELSE 'pending' END WHERE id = ?1`)
          .bind(task.id)
          .run();
      }
      searchesRun++;
      continue;
    }

    // Standard SERP search task across 9 engines
    const picked = pickProvider(
      SEARCH_PROVIDERS,
      engineStats,
      state.engine_cursor || 0,
      now,
      task.query
    );
    if (!picked) {
      // All engines cooling down: leave pending or mark done if tries >= 3
      await env.DB.prepare(
        `UPDATE search_tasks SET tries = tries + 1, status = CASE WHEN tries + 1 >= 3 THEN 'done' ELSE 'pending' END WHERE id = ?1`
      )
        .bind(task.id)
        .run();
      continue;
    }

    const { provider, nextCursor } = picked;
    state.engine_cursor = nextCursor;
    const st = engineStats[provider.id];
    st.last_run_at = now;
    subrequests++;

    const outcome = await querySearchProvider(provider, task.query, fetchFn);
    if (outcome.status === 'blocked') {
      st.fail_count++;
      st.status = 'cooldown';
      const mins = outcome.httpStatus === 429 ? 30 : 20;
      st.cooldown_until = now + mins * 60_000;
      st.note = `محدودیت ${outcome.httpStatus || ''} — استراحت ${mins} دقیقه`;
      await env.DB.prepare(
        `UPDATE search_tasks SET tries = tries + 1, status = CASE WHEN tries + 1 >= 3 THEN 'done' ELSE 'pending' END WHERE id = ?1`
      )
        .bind(task.id)
        .run();
    } else if (outcome.status === 'network' || outcome.status === 'http_error') {
      st.fail_count++;
      st.status = 'cooldown';
      st.cooldown_until = now + 8 * 60_000;
      st.note = `${outcome.reason} — استراحت ۸ دقیقه`;
      await env.DB.prepare(
        `UPDATE search_tasks SET tries = tries + 1, status = CASE WHEN tries + 1 >= 3 THEN 'done' ELSE 'pending' END WHERE id = ?1`
      )
        .bind(task.id)
        .run();
    } else {
      const results = outcome.results || [];
      if (!results.length) {
        if (saysNoResults(outcome.body)) {
          st.empty_streak = 0;
          st.status = 'ready';
          st.last_hits = 0;
          st.note = 'پاسخ خالی معتبر (نتیجه‌ای نداشت)';
          await env.DB.prepare(`UPDATE search_tasks SET status = 'done' WHERE id = ?1`)
            .bind(task.id)
            .run();
        } else {
          st.empty_streak = (st.empty_streak || 0) + 1;
          if (st.empty_streak >= 3) {
            st.empty_streak = 0;
            st.status = 'cooldown';
            st.cooldown_until = now + 45 * 60_000;
            st.note = '۳ پاسخ خالی پیاپی — استراحت ۴۵ دقیقه';
          } else {
            st.note = `پاسخ خالی (${st.empty_streak}/3)`;
          }
          await env.DB.prepare(
            `UPDATE search_tasks SET tries = tries + 1, status = CASE WHEN tries + 1 >= 2 THEN 'done' ELSE 'pending' END WHERE id = ?1`
          )
            .bind(task.id)
            .run();
        }
      } else if (!answersQuestion(task.query, results)) {
        st.fail_count++;
        st.status = 'cooldown';
        st.cooldown_until = now + 45 * 60_000;
        st.note = 'پاسخ نامرتبط با پرسش — استراحت ۴۵ دقیقه';
        await env.DB.prepare(
          `UPDATE search_tasks SET tries = tries + 1, status = CASE WHEN tries + 1 >= 3 THEN 'done' ELSE 'pending' END WHERE id = ?1`
        )
          .bind(task.id)
          .run();
      } else {
        st.empty_streak = 0;
        st.ok_count++;
        st.status = 'ready';
        st.last_hits = results.length;
        st.note = `موفق • ${results.length} نتیجه`;
        const batch = [];
        for (const r of results) {
          const link = classifyLink(r.url);
          if (!link) continue;
          if (link.part !== task.part && !task.product_name) {
            // Still allow cross-list discovery if valid, e.g. site query found a t.me channel!
          }
          const hinted = sellsGoods(r.text, task.product_name);
          if (link.kind === 'site' && !hinted) continue;
          const c = tryAcceptCandidate(
            link,
            cap,
            {
              depth: 0,
              hinted,
              origin: task.product_name ? 'custom_product' : 'search',
              product: task.product_name,
              from: `${provider.title}: ${task.query}`,
              provider: provider.id,
            },
            now
          );
          if (c) batch.push(c);
        }
        candidatesAdded += await persistCandidates(env, batch);
        await env.DB.prepare(`UPDATE search_tasks SET status = 'done' WHERE id = ?1`)
          .bind(task.id)
          .run();
      }
    }

    searchesRun++;
    state.searches_total = (state.searches_total || 0) + 1;
    state.cycle_searches = (state.cycle_searches || 0) + 1;
  }

  // --------------------------------------------------- 2. Verify pending candidates one by one
  const candidates = (
    await env.DB.prepare(
      `SELECT * FROM sources
       WHERE state = 'new' AND next_retry_at <= ?1
       ORDER BY depth ASC, discovered_at ASC
       LIMIT ?2`
    )
      .bind(now, maxVerifies * 2)
      .all()
  ).results || [];

  for (const entry of candidates) {
    if (verificationsRun >= maxVerifies || subrequests >= maxSubrequests) break;
    const hostKey = entry.kind === 'site' ? entry.host : entry.kind;
    if ((hostCooldowns[`c:${hostKey}`] || 0) > now) continue;

    // Non-readable platforms (Instagram, WhatsApp, Soroush, iGap, Gap) cannot be fetched publicly without login;
    // when hinted by a verified source or search snippet, list them immediately in Social/Domestic lists!
    if (!entry.readable) {
      await env.DB.prepare(
        `UPDATE sources SET state = 'ok', verified_at = ?2, updated_at = ?2,
         note = 'شبکه بدون پیش‌نمایش عمومی (ثبت‌شده از سرنخ معتبر)'
         WHERE key = ?1`
      )
        .bind(entry.key, now)
        .run();
      confirmedOk++;
      verificationsRun++;
      continue;
    }

    const targetUrl = previewUrl(entry.kind, entry.url);
    subrequests++;
    let res;
    let body = '';
    try {
      res = await fetchFn(targetUrl, { timeoutMs });
      if (res.status === 200) {
        body = await res.text();
      }
    } catch {
      const tries = (entry.verify_tries || 0) + 1;
      const failKey = `f:${hostKey}`;
      const hostFails = (hostCooldowns[failKey] || 0) + 1;
      if (hostFails >= 2) {
        hostCooldowns[failKey] = 0;
        hostCooldowns[`c:${hostKey}`] = now + 10 * 60_000;
      } else {
        hostCooldowns[failKey] = hostFails;
        hostCooldowns[`c:${hostKey}`] = now + 3 * 60_000;
      }
      if (tries >= 3) {
        await env.DB.prepare(
          `UPDATE sources SET state = 'unreachable', verify_tries = ?2, next_retry_at = ?3,
           note = 'در سه نوبت در دسترس نبود', updated_at = ?4 WHERE key = ?1`
        )
          .bind(entry.key, tries, now + 24 * 3600_000, now)
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE sources SET verify_tries = ?2, next_retry_at = ?3,
           note = 'خطای اتصال؛ تلاش مجدد', updated_at = ?4 WHERE key = ?1`
        )
          .bind(entry.key, tries, now + 5 * 60_000, now)
          .run();
      }
      verificationsRun++;
      continue;
    }

    delete hostCooldowns[`f:${hostKey}`];
    delete hostCooldowns[`c:${hostKey}`];

    if (res.status === 404 || res.status === 410) {
      await env.DB.prepare(
        `UPDATE sources SET state = 'rejected', note = ?2, updated_at = ?3 WHERE key = ?1`
      )
        .bind(entry.key, `صفحه موجود نیست (${res.status})`, now)
        .run();
      verificationsRun++;
      continue;
    }

    if (res.status !== 200 || isChallengeOrBlocked(res.status, body)) {
      const tries = (entry.verify_tries || 0) + 1;
      await env.DB.prepare(
        `UPDATE sources SET verify_tries = ?2,
         state = CASE WHEN ?2 >= 3 THEN 'unreachable' ELSE 'new' END,
         next_retry_at = ?3,
         note = ?4, updated_at = ?5 WHERE key = ?1`
      )
        .bind(
          entry.key,
          tries,
          tries >= 3 ? now + 24 * 3600_000 : now + 10 * 60_000,
          `پاسخ عمومی ${res.status}`,
          now
        )
        .run();
      verificationsRun++;
      continue;
    }

    // Check if redirected into a blocked / non-site host
    const finalUrl = res.url || targetUrl;
    if (entry.kind === 'site' && finalUrl !== targetUrl) {
      const reclass = classifyLink(finalUrl);
      if (!reclass || isDirectoryHost(reclass.host)) {
        await env.DB.prepare(
          `UPDATE sources SET state = 'rejected', note = 'ریدایرکت به دامنه نامرتبط', updated_at = ?2 WHERE key = ?1`
        )
          .bind(entry.key, now)
          .run();
        verificationsRun++;
        continue;
      }
    }

    const judged = judgePublicPage(finalUrl, body, entry.matched_product);
    if (!judged.sells) {
      if (entry.kind !== 'site' && entry.hinted && judged.textLength < 200) {
        await env.DB.prepare(
          `UPDATE sources SET state = 'ok', title = ?2, site_name = ?3,
           note = 'پیش‌نمایش عمومی پیام نداشت (ثبت با سرنخ معتبر)',
           verified_at = ?4, updated_at = ?4 WHERE key = ?1`
        )
          .bind(entry.key, judged.title || entry.name, judged.site || '', now)
          .run();
        confirmedOk++;
      } else {
        await env.DB.prepare(
          `UPDATE sources SET state = 'rejected', note = 'شواهد فروش کالاهای فلزی یافت نشد', updated_at = ?2 WHERE key = ?1`
        )
          .bind(entry.key, now)
          .run();
      }
      verificationsRun++;
      continue;
    }

    const displayName = judged.site || judged.title || entry.name || entry.host || entry.handle;
    await env.DB.prepare(
      `UPDATE sources SET
         state = 'ok',
         name = CASE WHEN name = '' THEN ?2 ELSE name END,
         title = ?3,
         site_name = ?4,
         contact = ?5,
         city = ?6,
         has_table = ?7,
         note = ?8,
         verified_at = ?9,
         updated_at = ?9
       WHERE key = ?1`
    )
      .bind(
        entry.key,
        displayName,
        judged.title,
        judged.site,
        judged.contact,
        judged.city,
        judged.table ? 1 : 0,
        judged.table ? 'تاییدشده (دارای جدول قیمت)' : 'تاییدشده (دارای شواهد فروش)',
        now
      )
      .run();

    confirmedOk++;
    verificationsRun++;
    state.pages_verified_total = (state.pages_verified_total || 0) + 1;
    state.cycle_verifications = (state.cycle_verifications || 0) + 1;

    // Follow inner price links & channel links up to depth 2
    if ((entry.depth || 0) < MAX_DEPTH && judged.links.length) {
      const followBatch = [];
      let sitesFollowed = 0;
      for (const a of judged.links) {
        const link = classifyLink(a.url);
        if (!link) continue;
        if (link.kind !== 'site') {
          const c = tryAcceptCandidate(
            link,
            cap,
            {
              depth: (entry.depth || 0) + 1,
              hinted: true,
              origin: entry.origin,
              product: entry.matched_product,
              from: entry.url,
              provider: entry.provider || 'page-link',
              name: a.text,
            },
            now
          );
          if (c) followBatch.push(c);
        } else if (entry.kind === 'site') {
          if (entry.is_inner || link.host !== entry.host) continue;
          if (!a.text.includes('قیمت') || tradeEvidence(a.text, entry.matched_product).goods < 1) {
            continue;
          }
          const c = tryAcceptCandidate(
            link,
            cap,
            {
              depth: (entry.depth || 0) + 1,
              isInner: 1,
              hinted: true,
              origin: entry.origin,
              product: entry.matched_product,
              from: entry.url,
              provider: 'inner-price-link',
              name: a.text,
            },
            now
          );
          if (c) followBatch.push(c);
        } else if (sitesFollowed < 5) {
          const c = tryAcceptCandidate(
            link,
            cap,
            {
              depth: (entry.depth || 0) + 1,
              hinted: true,
              origin: entry.origin,
              product: entry.matched_product,
              from: entry.url,
              provider: 'channel-site-link',
            },
            now
          );
          if (c) {
            followBatch.push(c);
            sitesFollowed++;
          }
        }
      }
      candidatesAdded += await persistCandidates(env, followBatch);
    }
  }

  // Update custom products progress & discovered counts
  await env.DB.prepare(
    `UPDATE custom_products SET
       queries_done = (SELECT COUNT(*) FROM search_tasks WHERE product_name = custom_products.name AND status = 'done'),
       queries_total = (SELECT COUNT(*) FROM search_tasks WHERE product_name = custom_products.name),
       discovered_count = (SELECT COUNT(*) FROM sources WHERE state = 'ok' AND instr(matched_product, custom_products.name) > 0),
       status = CASE
         WHEN EXISTS (SELECT 1 FROM search_tasks WHERE product_name = custom_products.name AND status = 'pending') THEN 'scanning'
         ELSE 'done'
       END,
       last_scanned_at = CASE WHEN ?1 > 0 THEN ?1 ELSE last_scanned_at END`
  )
    .bind(searchesRun > 0 ? now : 0)
    .run();

  // Prune old rejected entries (> 7 days) occasionally to keep DB lean
  if (Math.random() < 0.08) {
    await env.DB.prepare(`DELETE FROM sources WHERE state = 'rejected' AND updated_at < ?1`)
      .bind(now - 7 * 24 * 3600_000)
      .run();
  }

  // Check if cycle is finished
  const [remTasks, remVerify] = await Promise.all([
    env.DB.prepare(`SELECT 1 AS ok FROM search_tasks WHERE status = 'pending' LIMIT 1`).first(),
    env.DB.prepare(
      `SELECT 1 AS ok FROM sources WHERE state = 'new' AND next_retry_at <= ?1 LIMIT 1`
    )
      .bind(now)
      .first(),
  ]);

  const finished = !remTasks && !remVerify;
  state.last_tick_at = now;
  if (finished) {
    state.active = false;
    state.phase = 'idle';
    state.last_cycle_finished_at = now;
    state.next_scan_at =
      (state.last_cycle_started_at || now) + cfg.refresh_hours * 3600_000;
    if (state.next_scan_at <= now) {
      state.next_scan_at = now + cfg.refresh_hours * 3600_000;
    }
    state.last_tick_summary = `چرخه #${state.cycle_id} کامل شد (جستجو: ${searchesRun} • بررسی: ${verificationsRun} • تایید: ${confirmedOk})`;
  } else {
    state.active = true;
    state.phase = remTasks ? 'search' : 'verify';
    state.last_tick_summary = `جستجو: ${searchesRun} • کاندید جدید: ${candidatesAdded} • بررسی: ${verificationsRun} • تایید: ${confirmedOk}`;
  }

  // Prune stale host cooldowns
  for (const [k, v] of Object.entries(hostCooldowns)) {
    if (typeof v === 'number' && v > 1_000_000_000_000 && v < now) {
      delete hostCooldowns[k];
    }
  }

  await Promise.all([
    setMetaJson(env, 'engine_stats', engineStats, now),
    setMetaJson(env, 'host_cooldowns', hostCooldowns, now),
    setMetaJson(env, 'scanner_state', state, now),
  ]);

  return {
    idle: false,
    active: state.active,
    finished,
    searches: searchesRun,
    added: candidatesAdded,
    verified: verificationsRun,
    confirmed: confirmedOk,
    subrequests,
  };
}
