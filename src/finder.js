/** هوش جستجوگر ۲ — source discovery port from IronPin source_finder.dart.
 *  Pure classify + round planner; runFinderRound does network + D1 writes.
 *  Builds three lists only (sites / social / domestic); never reads prices.
 */

import { searchWeb } from './engines.js';
import {
  FINDER_BANKS,
  FINDER_PART_TITLES,
  FINDER_PER_ROUND,
} from './ironpin_data.js';

export const FinderPart = {
  sites: 0,
  social: 1,
  domestic: 2,
  all: [0, 1, 2],
  titles: FINDER_PART_TITLES,
};

const MESSENGERS = {
  't.me': ['telegram', 1, true],
  'telegram.me': ['telegram', 1, true],
  'instagram.com': ['instagram', 1, false],
  'whatsapp.com': ['whatsapp', 1, false],
  'eitaa.com': ['eitaa', 2, true],
  'ble.ir': ['bale', 2, true],
  'rubika.ir': ['rubika', 2, true],
  'splus.ir': ['soroush', 2, false],
  'igap.net': ['igap', 2, false],
  'gap.im': ['gap', 2, false],
};

const CANONICAL_HOST = {
  telegram: 't.me',
  instagram: 'www.instagram.com',
  eitaa: 'eitaa.com',
  bale: 'ble.ir',
  rubika: 'rubika.ir',
  soroush: 'splus.ir',
  igap: 'igap.net',
  gap: 'gap.im',
};

const RESERVED = new Set([
  'share', 'join', 'joinchat', 'joing', 'joinc', 's', 'search', 'proxy',
  'socks', 'addstickers', 'addemoji', 'addlist', 'iv', 'c', 'login', 'contact',
  'setlanguage', 'boost', 'giftcode', 'invoice', 'confirmphone', 'k', 'a', 'z',
  'web', 'download', 'apps', 'faq', 'privacy', 'blog', 'dl', 'about', 'app',
  'home', 'index', 'channel', 'channels', 'terms', 'support', 'help', 'tos',
  'static', 'assets', 'api', 'auth', 'p', 'reel', 'reels', 'explore',
  'accounts', 'stories', 'tv', 'direct', 'developer', 'legal', 'tags',
  'locations', 'challenge', 'landing', 'rules', 'features', 'security',
]);

const NOT_SITES = [
  'google.com', 'google.ir', 'bing.com', 'duckduckgo.com', 'yahoo.com',
  'yimg.com', 'yandex.com', 'yandex.ru', 'naver.com', 'naver.net',
  'pstatic.net', 'seznam.cz', 'qwant.com', 'dogpile.com', 'ecosia.org',
  'metager.org', 'mojeek.com', 'rismoon.com', 'microsoft.com', 'msn.com',
  'live.com', 'apple.com', 'facebook.com', 'fb.com', 'twitter.com', 'x.com',
  'youtube.com', 'youtu.be', 'linkedin.com', 'pinterest.com', 'aparat.com',
  'wikipedia.org', 'wikimedia.org', 'github.com', 'cafebazaar.ir', 'myket.ir',
  'enamad.ir', 'samandehi.ir', 'zarinpal.com', 'shaparak.ir', 'neshan.org',
  'balad.ir', 'waze.com', 'wa.me', 'telegram.org', 'w3.org', 'schema.org',
  'gravatar.com', 'wordpress.org', 'wordpress.com', 'cloudflare.com',
  'googleapis.com', 'gstatic.com', 'googletagmanager.com', 'bale.ai',
  'eitaa.ir', 'rubika.app', 'archive.org', 'zarebin.ir', 'gerdoo.me',
  'tgstat.com', 'telegram.dog',
];

const FILE_LIKE =
  /\.(?:jpe?g|png|gif|svg|webp|ico|pdf|zip|rar|apk|mp4|mp3|css|js|xml|json|xlsx?|docx?)$/i;
const HANDLE = /^[a-zA-Z][a-zA-Z0-9_]{2,63}$/;
const IG_HANDLE = /^[a-zA-Z0-9._]{2,30}$/;
const TRACKING = new Set([
  'fbclid', 'gclid', 'srsltid', 'yclid', 'msclkid', 'igshid', 'igsh',
  'ref', 'share', '_ga', '_gl',
]);

function canonicalPathKey(path) {
  try {
    return decodeURIComponent(path).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
}

/**
 * Port of classifyLink — decides which list a public address belongs to,
 * or null when it is not a place this searcher lists.
 * @returns {{url:string,kind:string,key:string,part:number,readable:boolean,host:string}|null}
 */
export function classifyLink(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 400) return null;

  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port) return null;
  if (!u.hostname) return null;

  let host = u.hostname.toLowerCase();
  if (host.startsWith('web.')) return null;
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  const seg = u.pathname.split('/').filter(Boolean);
  const messenger = MESSENGERS[host];
  if (messenger) {
    const [kind, part, readable] = messenger;
    if (kind === 'whatsapp') {
      if (seg.length < 2 || seg[0] !== 'channel') return null;
      const id = seg[1];
      if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return null;
      return {
        url: `https://whatsapp.com/channel/${id}`,
        kind,
        key: `whatsapp:${id}`,
        part,
        readable: false,
        host: '',
      };
    }
    const path = seg[0] === 's' ? seg.slice(1) : seg.slice();
    if (!path.length) return null;
    let h = path[0];
    if (h.startsWith('@')) h = h.slice(1);
    const low = h.toLowerCase();
    if (RESERVED.has(low)) return null;
    if (kind === 'instagram') {
      if (!IG_HANDLE.test(h) || h.startsWith('.')) return null;
      return {
        url: `https://www.instagram.com/${low}/`,
        kind,
        key: `instagram:${low}`,
        part,
        readable: false,
        host: '',
      };
    }
    if (path.length > 2 || (path.length === 2 && !/^\d+$/.test(path[1]))) {
      return null;
    }
    if (
      !HANDLE.test(h) ||
      low.endsWith('bot') ||
      low.includes('admin') ||
      low.includes('marketing')
    ) {
      return null;
    }
    return {
      url: `https://${CANONICAL_HOST[kind]}/${h}`,
      kind,
      key: `${kind}:${low}`,
      part,
      readable,
      host: '',
    };
  }

  if (NOT_SITES.some((x) => host === x || host.endsWith(`.${x}`))) return null;
  if (FILE_LIKE.test(u.pathname)) return null;

  const rawQuery = {};
  for (const [k, v] of u.searchParams.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING.has(lk)) continue;
    rawQuery[k] = v;
  }
  const sortedKeys = Object.keys(rawQuery).sort();
  const qs = sortedKeys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(rawQuery[k])}`).join('&');

  let path = u.pathname ? u.pathname.replace(/\/+/g, '/') : '/';
  const lowerPath = path.toLowerCase();
  for (const idx of ['/index.html', '/index.htm', '/index.php']) {
    if (lowerPath.endsWith(idx)) {
      path = path.slice(0, path.length - idx.length);
      if (!path) path = '/';
      break;
    }
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const url = `https://${host}${path}${qs ? `?${qs}` : ''}`;
  if (url.length > 220) return null;
  const keyPath = canonicalPathKey(path);
  const queryPart = qs ? `?${qs.toLowerCase()}` : '';
  return {
    url,
    kind: 'site',
    key: `site:${host}${keyPath}${queryPart}`,
    part: FinderPart.sites,
    readable: true,
    host,
  };
}

/** Canonical de-dup key for any URL (fallback when classify rejects). */
export function canonicalUrlKey(rawUrl) {
  const link = classifyLink(rawUrl);
  if (link) return link.key;
  try {
    const u = new URL(String(rawUrl || '').trim());
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `raw:${host}${canonicalPathKey(path)}${u.search ? `?${u.search.toLowerCase()}` : ''}`;
  } catch {
    return String(rawUrl || '').trim().toLowerCase();
  }
}

/** Public reader URL: Telegram/Bale show posts under /s/. */
export function previewUrl(kind, url) {
  if (kind !== 'telegram' && kind !== 'bale') return url;
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    return `https://${u.host}/s/${seg}`;
  } catch {
    return url;
  }
}

/** FinderPlan.queries — next perRound questions of one bank, wrapping. */
export function finderQueries(part, round) {
  const all = FINDER_BANKS[part] || [];
  if (!all.length) return [];
  const start = (round * FINDER_PER_ROUND) % all.length;
  const out = [];
  for (let i = 0; i < FINDER_PER_ROUND; i++) {
    out.push(all[(start + i) % all.length]);
  }
  return out;
}

async function getMeta(env, key) {
  try {
    return await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first();
  } catch {
    return null;
  }
}

async function setMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, Date.now())
    .run();
}

async function knownKeys(env) {
  try {
    const rows = await env.DB.prepare('SELECT key FROM sources').all();
    return new Set((rows.results || []).map((r) => r.key));
  } catch {
    return new Set();
  }
}

/** IronPin round rest: 20 min between discovery rounds. */
const ROUND_REST_MS = 20 * 60_000;

/**
 * One discovery round across the three lists (5 queries each).
 * Inserts new classified sources; enqueues readable ones for price scan.
 * Returns { round, added, scanned_queries, skipped_rest }.
 */
export async function runFinderRound(env, { now = Date.now(), force = false } = {}) {
  const meta = await getMeta(env, 'finder_state');
  let state = { round: 0, last_run: 0, added: 0, total: 0 };
  try {
    if (meta?.value) state = { ...state, ...JSON.parse(meta.value) };
  } catch {
    /* fresh state */
  }

  if (!force && state.last_run && now - state.last_run < ROUND_REST_MS) {
    return { round: state.round, added: 0, scanned_queries: 0, skipped_rest: true };
  }

  const known = await knownKeys(env);
  const insertSrc = env.DB.prepare(
    `INSERT INTO sources (url, domain, kind, part, name, key, readable, origin, state, created_at, last_checked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'finder', 'new', ?8, ?8)
     ON CONFLICT(key) DO UPDATE SET last_checked_at = excluded.last_checked_at`
  );

  let added = 0;
  let queriesRun = 0;
  const newLinks = [];

  for (const part of FinderPart.all) {
    const qs = finderQueries(part, state.round);
    for (const q of qs) {
      queriesRun++;
      let hits = [];
      try {
        const res = await searchWeb(q, { minHits: 8 });
        hits = res.hits || [];
      } catch {
        continue;
      }
      for (const h of hits) {
        const link = classifyLink(h.url);
        if (!link || link.part !== part) continue;
        if (known.has(link.key)) continue;
        // Unreadable only listed when the query already hinted selling goods
        // (price/channel queries in banks are treated as hinted).
        if (!link.readable && !/قیمت|فروش|خرید|پخش|آهن|کانال|site:/.test(q)) {
          continue;
        }
        known.add(link.key);
        newLinks.push({ link, from: q });
        if (newLinks.length >= 30) break;
      }
      if (newLinks.length >= 30) break;
    }
    if (newLinks.length >= 30) break;
  }

  // Persist new sources (batch)
  if (newLinks.length) {
    const stmts = newLinks.map(({ link }) =>
      insertSrc.bind(
        link.url,
        link.host || (link.kind === 'site' ? new URL(link.url).hostname.replace(/^www\./, '') : link.kind),
        link.kind,
        link.part,
        '',
        link.key,
        link.readable ? 1 : 0,
        now
      )
    );
    try {
      await env.DB.batch(stmts);
      added = newLinks.length;
    } catch (e) {
      console.error('finder insert failed', e);
    }
  }

  // Enqueue readable new sources onto the standing harvest scan
  try {
    await enqueueReadable(env, newLinks.map((x) => x.link), now);
  } catch (e) {
    console.error('finder enqueue failed', e);
  }

  state.round = (state.round + 1) % 100000;
  state.last_run = now;
  state.added = (state.added || 0) + added;
  state.total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM sources').first())?.c || state.total;
  await setMeta(env, 'finder_state', JSON.stringify(state));

  return { round: state.round, added, scanned_queries: queriesRun, skipped_rest: false };
}

/** Standing scan that harvests discovered + seed source URLs as pages. */
export async function ensureHarvestScan(env, now = Date.now()) {
  const meta = await getMeta(env, 'harvest_scan_id');
  if (meta?.value) {
    try {
      const id = JSON.parse(meta.value).id;
      const row = await env.DB.prepare('SELECT id FROM scans WHERE id = ?1').bind(id).first();
      if (row) return id;
    } catch {
      /* recreate */
    }
  }
  const id = crypto.randomUUID();
  const next = now + 24 * 3600_000;
  await env.DB.prepare(
    `INSERT INTO scans (id, batch_id, topic, status, phase, auto_refresh, refresh_hours,
                        next_refresh_at, engines_used, created_at, updated_at)
     VALUES (?1, NULL, ?2, 'fetching', 'fetch', 1, 24, ?3, '[]', ?4, ?4)`
  )
    .bind(id, 'منابع قیمت آهن — جستجوگر ۲', next, now)
    .run();
  await setMeta(env, 'harvest_scan_id', JSON.stringify({ id }));
  return id;
}

async function enqueueReadable(env, links, now) {
  // Never re-enqueue dead sources — only live/new readable ones
  let dead = new Set();
  try {
    const rows = await env.DB.prepare(
      `SELECT url FROM sources WHERE state = 'dead'`
    ).all();
    dead = new Set((rows.results || []).map((r) => r.url));
  } catch {
    /* ignore */
  }
  const readable = links.filter((l) => l.readable && !dead.has(l.url));
  if (!readable.length) return;
  const scanId = await ensureHarvestScan(env, now);
  const insert = env.DB.prepare(
    `INSERT INTO pages (scan_id, url, domain, title, source, query, status, created_at)
     VALUES (?1, ?2, ?3, '', 'finder', 'jostjoo2', 'pending', ?4)
     ON CONFLICT(scan_id, url) DO NOTHING`
  );
  const stmts = readable.map((l) => {
    const fetchUrl = previewUrl(l.kind, l.url);
    let domain = l.host || '';
    if (!domain) {
      try {
        domain = new URL(fetchUrl).hostname.replace(/^www\./, '');
      } catch {
        domain = l.kind;
      }
    }
    return insert.bind(scanId, fetchUrl, domain, now);
  });
  // keep batch small
  for (let i = 0; i < stmts.length; i += 40) {
    await env.DB.batch(stmts.slice(i, i + 40));
  }
}

export async function getFinderState(env) {
  const meta = await getMeta(env, 'finder_state');
  try {
    return JSON.parse(meta?.value || 'null');
  } catch {
    return null;
  }
}
