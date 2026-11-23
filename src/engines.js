/**
 * هوش جستجوگر ۲ — Multi-engine SERP & Iranian Channel Directory clients.
 * Faithful port of IronPin2 `lib/data/source_finder_io.dart`:
 * 9 search engines (ddg-lite, yahoo, bing, ddg, naver, bing-html, yahoo-ca, gerdoo, zarebin)
 * + 6 channel directories (mychannels.ir, canaljoo.ir, canalha.ir, joinchannel.ir, cafechannel.ir, linkdoniwebsit.ir).
 */

import { queryTokens, normalizeText, usesSiteOperator } from './banks.js';
import { webAddressOf } from './classify.js';

export const SEARCH_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export const SEARCH_PROVIDERS = [
  {
    id: 'ddg-lite',
    title: 'داک‌داک‌گو سبک',
    group: 'engine',
    siteOperator: true,
    timeoutMs: 9000,
    buildUrl: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'yahoo',
    title: 'یاهو',
    group: 'engine',
    siteOperator: true,
    timeoutMs: 10000,
    buildUrl: (q) => `https://uk.search.yahoo.com/search?p=${encodeURIComponent(q)}`,
  },
  {
    id: 'bing',
    title: 'بینگ RSS',
    group: 'engine',
    siteOperator: true,
    timeoutMs: 9000,
    buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss`,
  },
  {
    id: 'ddg',
    title: 'داک‌داک‌گو',
    group: 'engine',
    siteOperator: true,
    timeoutMs: 9000,
    buildUrl: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'naver',
    title: 'نیور',
    group: 'engine',
    siteOperator: false,
    timeoutMs: 10000,
    buildUrl: (q) => `https://search.naver.com/search.naver?where=web&query=${encodeURIComponent(q)}`,
  },
  {
    id: 'bing-html',
    title: 'بینگ وب',
    group: 'engine',
    siteOperator: true,
    timeoutMs: 10000,
    buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=fa`,
  },
  {
    id: 'yahoo-ca',
    title: 'یاهو ۲',
    group: 'engine',
    siteOperator: true,
    timeoutMs: 10000,
    buildUrl: (q) => `https://ca.search.yahoo.com/search?p=${encodeURIComponent(q)}`,
  },
  {
    id: 'gerdoo',
    title: 'گردو',
    group: 'engine',
    siteOperator: false,
    timeoutMs: 12000,
    buildUrl: (q) => `https://gerdoo.me/search/?query=${encodeURIComponent(q)}`,
  },
  {
    id: 'zarebin',
    title: 'ذره‌بین',
    group: 'engine',
    siteOperator: true,
    timeoutMs: 11000,
    buildUrl: (q) =>
      `https://zarebin.ir/gse/api/search/?q=${encodeURIComponent(q)}&page=1&query_source=user`,
    fallbackUrl: (q) => `https://zarebin.ir/search?q=${encodeURIComponent(q)}`,
  },
];

export const DIRECTORY_PROVIDERS = [
  {
    id: 'dir:mychannels.ir',
    title: 'مای‌چنلز',
    group: 'directory',
    host: 'mychannels.ir',
    timeoutMs: 10000,
    buildUrl: (q) => `https://mychannels.ir/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'dir:canaljoo.ir',
    title: 'کانال‌جو',
    group: 'directory',
    host: 'canaljoo.ir',
    timeoutMs: 10000,
    buildUrl: (q) => `https://canaljoo.ir/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'dir:canalha.ir',
    title: 'کانال‌ها',
    group: 'directory',
    host: 'canalha.ir',
    timeoutMs: 10000,
    buildUrl: (q) => `https://canalha.ir/search?q=${encodeURIComponent(q)}`,
  },
  {
    id: 'dir:joinchannel.ir',
    title: 'جوین‌چنل',
    group: 'directory',
    host: 'joinchannel.ir',
    timeoutMs: 10000,
    buildUrl: (q) => `https://joinchannel.ir/?s=${encodeURIComponent(q)}`,
  },
  {
    id: 'dir:cafechannel.ir',
    title: 'کافه‌چنل',
    group: 'directory',
    host: 'cafechannel.ir',
    timeoutMs: 10000,
    buildUrl: (q) => `https://cafechannel.ir/?s=${encodeURIComponent(q)}`,
  },
  {
    id: 'dir:linkdoniwebsit.ir',
    title: 'لینکدونی وب‌سایت',
    group: 'directory',
    host: 'linkdoniwebsit.ir',
    timeoutMs: 10000,
    buildUrl: (q) => `https://linkdoniwebsit.ir/?s=${encodeURIComponent(q)}`,
  },
];

export const ALL_PROVIDERS = [...SEARCH_PROVIDERS, ...DIRECTORY_PROVIDERS];

const ENGINE_HOSTS = [
  'duckduckgo.com', 'bing.com', 'microsoft.com', 'msn.com', 'live.com',
  'gerdoo.me', 'zarebin.ir', 'yahoo.com', 'yimg.com', 'yahooapis.com',
  'naver.com', 'naver.net', 'pstatic.net', 'google.com', 'gstatic.com',
];

const YAHOO_RU_RE = /\/RU=([^/]+)\/R[KO]=/;

export function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]{0,400}>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function oneLine(s, max = 280) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max);
}

/**
 * Unwraps SERP redirect/tracking URLs (DuckDuckGo uddg, Yahoo RU=, Bing /ck/a).
 */
export function unwrapResultLink(href) {
  let h = decodeEntities(String(href || '').trim());
  if (!h) return null;
  if (h.startsWith('//')) h = `https:${h}`;
  const deep = webAddressOf(h);
  if (deep) return deep;

  let u;
  try {
    u = new URL(h);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();

  if (host.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) {
    const target = u.searchParams.get('uddg');
    return target ? target : null;
  }
  if (host.endsWith('yahoo.com')) {
    const m = u.pathname.match(YAHOO_RU_RE);
    if (m) {
      try {
        const decoded = decodeURIComponent(m[1]);
        return decoded.startsWith('http') ? decoded : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  if (host.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
    const raw = u.searchParams.get('u');
    if (!raw || !raw.startsWith('a1')) return null;
    try {
      let b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const decoded = new TextDecoder('utf-8').decode(bytes);
      return decoded.startsWith('http') ? decoded : null;
    } catch {
      return null;
    }
  }
  return h;
}

function collectJsonAnchors(node, add, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 60)) {
      collectJsonAnchors(item, add, depth + 1);
    }
    return;
  }
  if (typeof node === 'object') {
    const pick = (keys) => {
      for (const k of keys) {
        if (typeof node[k] === 'string' && node[k].trim()) return node[k].trim();
      }
      return '';
    };
    const link = pick(['web_link', 'url', 'link', 'href']);
    const title = pick(['title', 'name', 'heading']);
    const desc = pick(['description', 'snippet', 'content', 'summary', 'text']);
    if (link.startsWith('http')) {
      add(link, `${title} ${desc}`);
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') collectJsonAnchors(v, add, depth + 1);
    }
  }
}

/**
 * Fast, bounded SERP parser supporting HTML, Bing RSS XML, and Zarebin JSON.
 */
export function readSearchResults(body, providerId = '') {
  const raw = String(body || '').slice(0, 220_000);
  const out = [];
  const index = new Map();

  function add(href, text) {
    const url = unwrapResultLink(href);
    if (!url) return;
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    if (!host || ENGINE_HOSTS.some((e) => host === e || host.endsWith(`.${e}`))) {
      return;
    }
    const clean = oneLine(text, 280);
    const idx = index.get(url);
    if (idx == null) {
      index.set(url, out.length);
      out.push({ url, text: clean });
    } else if (clean.length > out[idx].text.length) {
      out[idx].text = clean;
    }
  }

  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      collectJsonAnchors(parsed, add);
      if (out.length) return out;
    } catch {
      /* fall through to HTML/XML */
    }
  }

  // Bing RSS / XML feed
  if (trimmed.startsWith('<?xml') || raw.includes('<rss') || raw.includes('<item>')) {
    const items = raw.match(/<item\b[^>]*>[\s\S]{0,3000}?<\/item>/gi) || [];
    for (const item of items.slice(0, 30)) {
      const link = item.match(/<link>([\s\S]{0,500}?)<\/link>/i);
      const title = item.match(/<title>([\s\S]{0,500}?)<\/title>/i);
      const desc = item.match(/<description>([\s\S]{0,1200}?)<\/description>/i);
      if (link) {
        add(
          decodeEntities(link[1].trim()),
          `${title ? stripTags(title[1]) : ''} ${desc ? stripTags(desc[1]) : ''}`
        );
      }
    }
    if (out.length) return out;
  }

  // Yahoo search: skip srpcache links and pull block context around anchors
  if (providerId === 'bing-html' || providerId === 'bing') {
    const blocks = raw.split(/class=["'][^"']*b_algo[^"']*["']/).slice(1, 25);
    for (const block of blocks) {
      const chunk = block.slice(0, 3500);
      const a = chunk.match(/<h2[^>]{0,200}>\s*<a[^>]{0,300}href=["']([^"']{1,500})["'][^>]{0,200}>([\s\S]{0,400}?)<\/a>/i);
      if (!a) continue;
      const snippet = chunk.match(/<p[^>]{0,200}>([\s\S]{0,600}?)<\/p>/i);
      add(a[1], `${stripTags(a[2])} ${snippet ? stripTags(snippet[1]) : ''}`);
    }
    if (out.length) return out;
  }

  // Generic bounded anchor extraction (DDG, DDG-lite, Yahoo, Naver, Gerdoo, Zarebin HTML)
  const anchorRe = /<a\b[^>]{0,350}href=["']([^"']{1,500})["'][^>]{0,250}>([\s\S]{0,450}?)<\/a>/gi;
  let m;
  let count = 0;
  while ((m = anchorRe.exec(raw)) !== null && count < 120 && out.length < 30) {
    count++;
    const href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    if (/search\.yahoo\.com\/search\/srpcache/i.test(href)) continue;
    const label = stripTags(m[2]);
    // Grab a tiny trailing window for snippet context
    const tail = stripTags(raw.slice(m.index + m[0].length, m.index + m[0].length + 320));
    add(href, `${label} ${tail.slice(0, 140)}`);
  }

  return out;
}

const NO_RESULTS_RE =
  /no\s+results\s+found|did\s+not\s+match\s+any|نتیجه‌ای\s+یافت\s+نشد|هیچ\s+نتیجه‌ای|یافت\s+نشد/i;

export function saysNoResults(body) {
  return NO_RESULTS_RE.test(String(body || '').slice(0, 80_000));
}

/**
 * Checks whether SERP results actually relate to the query tokens (prevents
 * bot-challenge / homepage-redirect junk from poisoning engine streak).
 */
export function answersQuestion(query, results) {
  if (!results || !results.length) return false;
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  let matches = 0;
  for (const r of results) {
    const norm = normalizeText(`${r.url} ${r.text}`);
    if (tokens.some((t) => norm.includes(t))) matches++;
  }
  return matches > 0;
}

export function isChallengeOrBlocked(status, body) {
  if (status === 429 || status === 403 || status === 202 || status === 503) return true;
  const head = String(body || '').slice(0, 30_000);
  return /anomaly-modal|cc=captcha|captcha-delivery|cf-browser-verification|please verify you are a human|unusual traffic|bot detection/i.test(
    head
  );
}

export async function timedFetch(url, { timeoutMs = 9000, headers = {}, method = 'GET', body = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      body,
      signal: ctrl.signal,
      redirect: 'follow',
      cf: { cacheTtl: 0 },
      headers: {
        'User-Agent': SEARCH_UA,
        'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.7',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Queries a specific search engine provider with optional fallback (for Zarebin HTML).
 */
export async function querySearchProvider(provider, query, fetchFn = timedFetch) {
  if (usesSiteOperator(query) && !provider.siteOperator) {
    return { status: 'skipped', results: [], reason: 'no_site_op' };
  }
  const target = provider.buildUrl(query);
  let res;
  try {
    res = await fetchFn(target, {
      timeoutMs: provider.timeoutMs,
      headers: provider.id === 'zarebin' ? { Accept: 'application/json,text/html;q=0.8' } : {},
    });
  } catch (err) {
    return { status: 'network', results: [], reason: err?.name === 'AbortError' ? 'timeout' : 'network' };
  }

  let text = '';
  try {
    text = await res.text();
  } catch {
    return { status: 'network', results: [], reason: 'read_error' };
  }

  if (isChallengeOrBlocked(res.status, text)) {
    return {
      status: 'blocked',
      httpStatus: res.status,
      results: [],
      reason: res.status === 429 ? 'rate_limit_429' : `blocked_${res.status}`,
    };
  }

  if (res.status >= 400) {
    // Try HTML fallback if Zarebin API failed
    if (provider.fallbackUrl) {
      try {
        const fb = await fetchFn(provider.fallbackUrl(query), { timeoutMs: provider.timeoutMs });
        if (fb.ok) {
          const fbText = await fb.text();
          if (!isChallengeOrBlocked(fb.status, fbText)) {
            const hits = readSearchResults(fbText, provider.id);
            return { status: 'ok', httpStatus: fb.status, results: hits, body: fbText };
          }
        }
      } catch {
        /* ignore fallback error */
      }
    }
    return { status: 'http_error', httpStatus: res.status, results: [], reason: `http_${res.status}` };
  }

  let results = readSearchResults(text, provider.id);
  if (!results.length && provider.fallbackUrl) {
    try {
      const fb = await fetchFn(provider.fallbackUrl(query), { timeoutMs: provider.timeoutMs });
      if (fb.ok) {
        const fbText = await fb.text();
        if (!isChallengeOrBlocked(fb.status, fbText)) {
          results = readSearchResults(fbText, provider.id);
          text = fbText;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return { status: 'ok', httpStatus: res.status, results, body: text };
}
