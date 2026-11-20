/** HTML main-text extraction — port of Html.mainText / PageExtractor (report §4) */

const BLOCK_RE =
  /<(script|style|noscript|svg|iframe|form|nav|footer|header|aside)[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const TAG_RE = /<\/?(?:p|div|br|li|tr|h[1-6]|section|article|blockquote|dd|dt|figcaption)[^>]*>/gi;
const ANY_TAG_RE = /<[^>]+>/g;
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  zwnj: '‌', zwj: '‍', lm: '(', rm: ')',
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function collapse(s) {
  return s
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract page title (og:title → h1 → title). */
export function extractTitle(html) {
  if (!html) return '';
  const og = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  ) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og && og[1]) return decodeEntities(og[1]).trim().slice(0, 200);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = collapse(decodeEntities(h1[1].replace(ANY_TAG_RE, ' ')));
    if (t) return t.slice(0, 200);
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return collapse(decodeEntities(title[1].replace(ANY_TAG_RE, ' '))).slice(0, 200);
  return '';
}

/**
 * Main text extraction: strip chrome, prefer <main>/<article>, keep up to `limit` chars.
 * Mirrors Html.mainText(html, 6000) from the report.
 */
export function extractMainText(html, limit = 6000) {
  if (!html) return '';
  let s = html;
  s = s.replace(COMMENT_RE, ' ');
  s = s.replace(BLOCK_RE, ' ');

  const main = s.match(/<main[\s\S]*?<\/main>/i);
  const article = s.match(/<article[\s\S]*?<\/article>/i);
  const pick =
    main && main[0].length > 400 ? main[0] :
    article && article[0].length > 400 ? article[0] :
    s;
  s = pick;

  s = s.replace(TAG_RE, '\n');
  s = s.replace(ANY_TAG_RE, ' ');
  s = decodeEntities(s);
  s = collapse(s);

  if (s.length > limit) s = s.slice(0, limit);
  return s;
}

/** Detect language tag: fa / en / mixed (report metadata `langTag`). */
export function detectLang(text) {
  if (!text) return 'und';
  const fa = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const en = (text.match(/[A-Za-z]/g) || []).length;
  if (fa === 0 && en === 0) return 'und';
  if (fa > en * 0.3 && fa > 20) return en > fa * 0.5 ? 'mixed' : 'fa';
  return 'en';
}

/** Strip common tracking params + fragment for URL dedup. */
export function normalizeUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref'];
    for (const k of drop) u.searchParams.delete(k);
    let href = u.toString();
    if (href.endsWith('?')) href = href.slice(0, -1);
    return href;
  } catch {
    return null;
  }
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}
