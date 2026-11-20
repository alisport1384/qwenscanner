/** Multi-engine SERP search — Bing HTML/RSS + DDG + Gerdoo/Zarebin (report §10) */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 8000;

async function timedFetch(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: 'follow',
      cf: { cacheTtl: 0 },
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'fa,en;q=0.8,en;q=0.5',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Bing wraps targets in /ck/a?...&u=a1<base64url> */
function decodeBingUrl(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (/bing\.com$/i.test(u.hostname) && u.pathname.startsWith('/ck/')) {
      const raw = u.searchParams.get('u');
      if (raw && raw.startsWith('a1')) {
        let b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const bin = atob(b64);
        // may be UTF-8 bytes
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
      }
    }
    return u.toString();
  } catch {
    return href;
  }
}

/** DuckDuckGo wraps redirects as /l/?uddg=<encoded> */
function decodeDdgUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    if (u.searchParams.has('uddg')) {
      return decodeURIComponent(u.searchParams.get('uddg'));
    }
    return u.toString();
  } catch {
    return href;
  }
}

function dedupe(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (!h || !h.url) continue;
    const key = h.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** Bing HTML SERP — class="b_algo" blocks (tested: EN works; parse resilient for FA). */
async function searchBingHtml(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&setlang=fa`;
  const res = await timedFetch(url);
  if (!res.ok) return [];
  const html = await res.text();
  if (!html || html.length < 80) return [];

  const hits = [];
  // Split on b_algo occurrences
  const parts = html.split(/class="b_algo"/).slice(1);
  for (const part of parts) {
    const block = part.slice(0, 4000);
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const rawUrl = decodeEntities(a[1]);
    const target = decodeBingUrl(rawUrl);
    if (!/^https?:/i.test(target)) continue;
    const title = stripTags(a[2]);
    const cap = block.match(/<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = cap ? stripTags(cap[1]) : '';
    if (title) hits.push({ url: target, title, snippet, engine: 'bing' });
    if (hits.length >= 10) break;
  }
  return hits;
}

/** Bing RSS — format=rss (stable, no JS). */
async function searchBingRss(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=20`;
  const res = await timedFetch(url);
  if (!res.ok) return [];
  const xml = await res.text();
  const hits = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const item of items.slice(0, 10)) {
    const link = item.match(/<link>([\s\S]*?)<\/link>/i);
    const title = item.match(/<title>([\s\S]*?)<\/title>/i);
    const desc = item.match(/<description>([\s\S]*?)<\/description>/i);
    if (!link) continue;
    const target = decodeEntities(link[1].trim());
    if (!/^https?:/i.test(target)) continue;
    hits.push({
      url: target,
      title: title ? stripTags(title[1]) : '',
      snippet: desc ? stripTags(desc[1]) : '',
      engine: 'bing-rss',
    });
  }
  return hits;
}

/** DuckDuckGo HTML endpoint — POST, no vqd (report /2026 practice). */
async function searchDdg(query) {
  const res = await timedFetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) return [];
  const html = await res.text();
  if (/anomaly|challenge/i.test(html) && !/result__a/i.test(html)) return [];

  const hits = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && hits.length < 10) {
    const target = decodeDdgUrl(decodeEntities(m[1]));
    if (!/^https?:/i.test(target)) continue;
    hits.push({ url: target, title: stripTags(m[2]), snippet: '', engine: 'ddg' });
  }
  // fallback anchors if class missing
  if (hits.length === 0) {
    const links = html.match(/<a[^>]*rel="nofollow"[^>]*href="(https?:[^"]+)"/gi) || [];
    for (const l of links.slice(0, 10)) {
      const href = l.match(/href="([^"]+)"/i)?.[1];
      if (!href) continue;
      const target = decodeDdgUrl(decodeEntities(href));
      if (/duckduckgo\.com/i.test(target)) continue;
      hits.push({ url: target, title: '', snippet: '', engine: 'ddg' });
    }
  }
  return hits;
}

/** Gerdoo — Persian SERP, HTML, key-less (report §10). */
async function searchGerdoo(query) {
  const url = `https://gerdoo.me/search/?query=${encodeURIComponent(query)}`;
  const res = await timedFetch(url);
  if (!res.ok) return [];
  const html = await res.text();
  const hits = [];
  const re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null && hits.length < 10) {
    const target = decodeEntities(m[1]);
    if (/gerdoo\.me/i.test(target)) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    const title = stripTags(m[2]);
    if (!title || title.length < 3) continue;
    hits.push({ url: target, title, snippet: '', engine: 'gerdoo' });
  }
  return hits;
}

/** Zarebin — HTML first, JSON fallback gse/api (report §10). */
async function searchZarebin(query) {
  try {
    const url = `https://zarebin.ir/search?q=${encodeURIComponent(query)}`;
    const res = await timedFetch(url);
    if (res.ok) {
      const html = await res.text();
      const hits = [];
      const re = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      const seen = new Set();
      while ((m = re.exec(html)) !== null && hits.length < 10) {
        const target = decodeEntities(m[1]);
        if (/zarebin\.ir/i.test(target)) continue;
        if (seen.has(target)) continue;
        seen.add(target);
        const title = stripTags(m[2]);
        if (!title || title.length < 3) continue;
        hits.push({ url: target, title, snippet: '', engine: 'zarebin' });
      }
      if (hits.length) return hits;
    }
  } catch { /* fall through to JSON */ }

  try {
    const apiUrl = `https://zarebin.ir/gse/api/search/?q=${encodeURIComponent(query)}&page=1&query_source=user`;
    const res = await timedFetch(apiUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    const list = data?.results || data?.web_results || [];
    return list.slice(0, 10).map((r) => ({
      url: r.web_link || r.link || r.url || '',
      title: r.title || '',
      snippet: r.description || r.snippet || '',
      engine: 'zarebin',
    })).filter((h) => h.url && /^https?:/i.test(h.url));
  } catch {
    return [];
  }
}

const ENGINES = [
  { name: 'bing', fn: searchBingHtml },
  { name: 'bing-rss', fn: searchBingRss },
  { name: 'ddg', fn: searchDdg },
  { name: 'gerdoo', fn: searchGerdoo },
  { name: 'zarebin', fn: searchZarebin },
];

/**
 * Query one or more engines until `minHits` unique URLs collected.
 * Returns { hits, enginesUsed }.
 */
export async function searchWeb(query, { minHits = 8, engineNames = null } = {}) {
  const hits = [];
  const enginesUsed = [];
  for (const eng of ENGINES) {
    if (engineNames && !engineNames.includes(eng.name)) continue;
    if (hits.length >= minHits) break;
    try {
      const got = await eng.fn(query);
      if (got.length) {
        enginesUsed.push(eng.name);
        hits.push(...got);
      }
    } catch {
      // engine failed — continue
    }
  }
  return { hits: dedupe(hits), enginesUsed };
}

/** Diverse selection: max `perDomain` hits per domain (report: diverse(hits)). */
export function diverse(hits, perDomain = 2, limit = 12) {
  const count = new Map();
  const out = [];
  for (const h of hits) {
    let d = '';
    try { d = new URL(h.url).hostname.replace(/^www\./, ''); } catch { continue; }
    const n = count.get(d) || 0;
    if (n >= perDomain) continue;
    count.set(d, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}
