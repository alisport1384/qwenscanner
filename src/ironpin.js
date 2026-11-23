/**
 * IronPin Quote export — online mirror of IronPin's internal scanner.
 *
 * Searcher-1 extraction is delegated to text_engine.js (faithful port of
 * IronPin's TextPriceEngine.analyze). This module owns:
 *  - the IronPin Quote.toJson-compatible shape served to IronPin2,
 *  - the read-time repair gate (repairQuote): every served quote carries a
 *    real تومان amount inside honest per-unit bounds, from a claim that
 *    names a steel product; junk context, decade-old claims, priceless rows
 *    and impossible amounts are dropped (never export an invented price),
 *  - the streamed /api/ironpin response (full snapshot + incremental `since`),
 *  - direct storage of extracted quotes into ironpin_quotes (no RAG/knowledge
 *    intermediate — the Qwen RAG/chunk pipeline is removed).
 */

import { analyzeText, normalizeText } from './text_engine.js';
import { phonesIn } from './city.js';
import { readTables } from './table_reader.js';

/**
 * آدرس‌یابی از شماره تلفن ثابت — شماره همراه شهر نمی‌سازد (فقط اپراتور).
 * Returns { city, prefix, phone } or null when no landline names a place.
 */
export function cityFromPhone(text) {
  const phones = phonesIn(String(text || '')).filter((p) => p.city);
  if (!phones.length) return null;
  phones.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    return b.digits.length - a.digits.length;
  });
  const best = phones[0];
  return { city: best.city, prefix: best.areaCode || '', phone: best.digits };
}

/**
 * geometric unit conversions — explicit text first, then geometric formulas.
 * No density inference beyond the standard steel constant 7.85; no nominal
 * size tables are guessed (a beam height without a catalogue weight stays
 * null — the same rule as IronPin's calculator.dart).
 */
export function computeConversions(text = '', { unit = 'unknown', size = '', thickness = '', dims = '' } = {}) {
  const t = normalizeText(text);
  const out = { pieceKg: null, lengthM: null, areaM2: null, kgm: null, basis: null };
  const n = (s) => { const v = parseFloat(String(s).replace(',', '.')); return Number.isFinite(v) ? v : null; };
  const lenM = t.match(/(\d+(?:[.,]\d+)?)\s*متری/) || t.match(/طول\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*متر/);
  const kgPiece = t.match(/(?:وزن\s*)?(?:هر\s*)?(?:شاخه|قطعه|عدد|برگ|رول)\s*(?:به\s*)?(?:حدود\s*)?(\d+(?:[.,]\d+)?)\s*کیلو/i)
    || t.match(/(\d+(?:[.,]\d+)?)\s*کیلوگرم\s*(?:به ازای|هر)?\s*(?:شاخه|قطعه|عدد|برگ)/i);
  if (kgPiece) { const v = n(kgPiece[1]); if (v && v > 0) out.pieceKg = v; }
  if (out.pieceKg == null) {
    const wm = t.match(/وزن\s*(?:شاخه\s*)?(?:حدود\s*)?(\d+(?:[.,]\d+)?)\s*کیلو(?:گرم)?/);
    if (wm && !/هر\s*متر/.test(t.slice(t.indexOf(wm[0]), t.indexOf(wm[0]) + 60))) { const v = n(wm[1]); if (v && v > 0) out.pieceKg = v; }
  }
  if (lenM) { const v = n(lenM[1]); if (v && v > 0) out.lengthM = v; }
  if (out.pieceKg != null || out.lengthM != null) out.basis = 'صریح از متن';
  const kgmExplicit = t.match(/(\d+(?:[.,]\d+)?)\s*کیلوگرم\s*(?:به ازای|هر)\s*1?\s*متر/);
  let kgm = kgmExplicit ? n(kgmExplicit[1]) : null;
  const isRound = /میلگرد|مفتول|گرد\s*توپر/.test(t);
  const isPipe = /لوله|مانیسمان|اسپیرال/.test(t);
  const isProfile = /قوطی|پروفیل/.test(t);
  const isAngle = /نبشی/.test(t);
  const isPlate = /ورق|پلیت|شیت/.test(t);
  const parts = (String(dims) || '').split(/[x×*]/).map((s) => n(s)).filter((v) => v != null && v > 0);
  if (kgm == null && isRound && size) { const d = n(size); if (d != null && d > 0 && d < 300) kgm = +(d * d / 162.2).toFixed(3); }
  if (kgm == null && isPipe && parts.length >= 2) { const [D, tt] = parts; if (D > tt && tt < 40) kgm = +((D - tt) * tt * 0.02466).toFixed(3); }
  if (kgm == null && isProfile && parts.length >= 3) { const [h, b, tt] = parts; kgm = +(((h + b) * 2 - 4 * tt) * tt * 0.00785).toFixed(3); }
  if (kgm == null && isAngle && parts.length >= 2) { const b = parts[0]; const tt = n(thickness) || parts[1] || null; if (tt) kgm = +((2 * b - tt) * tt * 0.00785).toFixed(3); }
  if (kgm != null && out.basis == null) out.basis = 'فرمول هندسی تقریبی';
  if (kgm != null) out.kgm = kgm;
  if (isPlate && thickness) {
    const tt = n(thickness);
    if (tt != null && tt > 0 && tt < 100) {
      const kgm2 = +(tt * 7.85).toFixed(2);
      const sheet = t.match(/(\d{3,4})\s*[x×*]\s*(\d{3,4})/);
      if (sheet) {
        const a = (n(sheet[1]) / 1000) * (n(sheet[2]) / 1000);
        if (a > 0) {
          out.areaM2 = +a.toFixed(3);
          if ((unit === 'sheet' || unit === 'piece' || unit === 'roll') && out.pieceKg == null) out.pieceKg = +(a * kgm2).toFixed(1);
          if (out.basis == null) out.basis = 'فرمول هندسی تقریبی';
        }
      }
    }
  }
  if (out.pieceKg == null && kgm != null && out.lengthM != null) out.pieceKg = +(kgm * out.lengthM).toFixed(1);
  return out;
}

/** Honest per-unit amount bounds (تومان) measured on the live feed. */
const FENCES = { kg: [15000, 2000000], piece: [2000, 150000000], sheet: [20000, 150000000], m2: [5000, 50000000], roll: [10000, 100000000], ton: [1000000, 300000000], m: [1000, 20000000] };

/** Range indicators: «بازه/محدوده/رنج» describe a span, never one price. */
const RANGE_WITNESS_RE = /بازه|محدوده|رنج/;

/** Navigation/menu markers: three or more in one claim = page chrome, not an offer. */
const MENU_MARKERS = [
  'تماس با ما', 'درباره ما', 'نقشه سایت', 'حریم خصوصی', 'وبلاگ',
  'خبرنامه', 'سبد خرید', 'افزودن به علاقه', 'علاقه مندی', 'جستجو در سایت',
  'ثبت سفارش', 'ورود کاربران', 'فراموشی رمز', 'کلیه حقوق', 'تمامی حقوق',
];
/** True when the claim announces a price range, not one comparable amount. */
export function isRangeWitness(t) {
  return RANGE_WITNESS_RE.test(String(t || ''));
}
/** True when the claim is page chrome (navigation/footer boilerplate). */
export function isMenuWitness(t) {
  const s = String(t || '');
  let n = 0;
  for (const k of MENU_MARKERS) if (s.includes(k) && ++n >= 3) return true;
  return false;
}

/**
 * Short product-anchored title for the feed. A price-list cell yields a short
 * clean title; the text engine may hand us a long SEO line — we then anchor on
 * the first product word and cut everything that is obviously page chrome.
 */
const TRAILING_CHROME_RE =
  /(?:تماس\s*با\s*ما|درباره\s*ما|وبلاگ|نقشه\s*سایت|حریم\s*خصوصی|خبرنامه|سبد\s*خرید|ثبت\s*سفارش|افزودن\s*به\s*علاقه|علاقه\s*مندی|مشاهده|دانلود|کلیه\s*حقوق|تمامی\s*حقوق|ورود|عضویت|ثبت\s*نام|خانه\s*[>›»])/;
export function trimQuoteTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  const m = /میلگرد|میل\s*استیل|تیر\s*آهن|تیراهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|مانیسمان|اسپیرال|ورق|پلیت|شیت|چهارپهلو|شش\s*پر|مفتول|تسمه|سپری|رابیتس|توری|گابیون|مش\s*جوشی|شمش|بیلت|بلوم|اسلب|قراضه|بولت|انکر\s*بولت|گندله|بریکت|فرو\s*آلیاژ|آهن\s*اسفنجی/i.exec(t);
  if (m && m.index > 0) t = t.slice(m.index);
  const chrome = TRAILING_CHROME_RE.exec(t);
  if (chrome && chrome.index > 12) t = t.slice(0, chrome.index).trim();
  return t.slice(0, 160).replace(/[,،;؛|·•\-–—\s]+$/, '').trim();
}

/** Identity used to collapse the same offer within one Iran day. */
function exportIdentity(q, dayKey) {
  const norm = (s) => String(s || '')
    .replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c))
    .replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
    .replace(/\s+/g, '').toLowerCase();
  return [q.category || '', norm(q.title), q.size || '', q.thickness || '',
    q.dimensions || '', q.grade || '', q.unit || '', dayKey].join('|');
}
function tehranDay(ts) {
  const d = new Date(Number(ts) || Date.now());
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Two or more of these in one claim = news/portal context, not a price. */
const JUNK_MARKERS = ['کد خبر', 'کد مطلب', 'لینک کوتاه', 'خبرگزاری', 'تسنیم', 'ایسنا', 'فارس نیوز', 'به گزارش', 'بازی بعدی', 'رانندگی', 'استعلام', 'پرسپولیس', 'سخنگوی', 'مجلس شورا', 'تاریخ انتشار', 'صفحه نخست', 'اسرائیل', 'آمریکا', 'حمله', 'توافق', 'کنگره', 'قطعنامه', 'سازمان ملل', 'انتخابات', 'جنگ'];

function junkClaim(t) {
  let n = 0;
  for (const k of JUNK_MARKERS) { if (t.includes(k) && ++n >= 2) return true; }
  return false;
}

/** Read-time contract guard: every served quote carries a real تومان amount
 *  inside honest per-unit bounds, from a claim that names a steel product. */
export function repairQuote(q) {
  if (!q || typeof q !== 'object') return null;
  const d = (q.details && typeof q.details === 'object') ? q.details : null;
  const raw = (d && d['شاهد ردیف']) || q.title || '';
  const t = normalizeText(raw);
  if (t) {
    if (!/میلگرد|میل\s*استیل|تیر\s*آهن|تیرآهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|مانیسمان|اسپیرال|ورق|پلیت|شیت|چهارپهلو|مفتول|تسمه|سپری|رابیتس|توری|گابیون|مش\s*جوشی|شمش|بیلت|بلوم|اسلب|قراضه|بولت|انکر\s*بولت|گندله|بریکت|فرو\s*آلیاژ|آهن\s*اسفنجی/i.test(t)) return null;
    if (junkClaim(t)) return null;
    if (isRangeWitness(t)) return null;
    if (isMenuWitness(t)) return null;
    const published = String((d && d['زمان انتشار پیام']) || '');
    const py = Number(published.slice(0, 4));
    if (published && py && py < 2023) return null;
  }
  if (!(typeof q.amount === 'number' && q.amount >= 1000 && q.amount <= 1e9 && q.currency === 'تومان')) {
    return null;
  }
  if (q.unit === 'kg' && q.amount > 2000000) {
    let pk = (typeof q.pieceKg === 'number' && q.pieceKg > 0) ? q.pieceKg : 0;
    if (!pk && t) pk = computeConversions(t, { unit: 'kg' }).pieceKg || 0;
    if (pk > 0) {
      const per = q.amount / pk;
      if (per >= 15000 && per <= 2000000) { q.unit = 'piece'; if (d) d['مبنای واحد'] = 'piece'; }
    }
  }
  const f = FENCES[q.unit];
  if (f && !(q.amount >= f[0] && q.amount <= f[1])) return null;
  // Title: product-anchored, specs only — never long prose/SEO text.
  if (typeof q.title === 'string' && q.title) {
    q.title = trimQuoteTitle(q.title);
    if (!q.title) return null;
  }
  return q;
}

/**
 * Extract Quote rows from one fetched page's visible text — the online
 * Searcher-1. Returns Quote-compatible plain objects ready to store.
 * The repair gate is applied at extraction time so junk never reaches D1.
 */
export function extractQuotesFromPage(text, meta) {
  const quotes = analyzeText({
    text,
    endpoint: meta.endpoint || 'qwen-scanner',
    seller: meta.seller || '',
    sourceUrl: meta.sourceUrl || '',
    fetchedAt: meta.fetchedAt || Date.now(),
    sellerCity: meta.sellerCity || 'نامشخص',
    publishedAt: meta.publishedAt || null,
    defaultCurrency: meta.defaultCurrency || 'نامشخص',
  });
  const out = [];
  for (const q of quotes) {
    const conv = computeConversions(q.details['شاهد ردیف'] || q.title, { unit: q.unit, size: q.size, thickness: q.thickness, dims: q.dimensions });
    q.pieceKg = q.pieceKg != null ? q.pieceKg : conv.pieceKg;
    q.lengthM = q.lengthM != null ? q.lengthM : conv.lengthM;
    q.areaM2 = q.areaM2 != null ? q.areaM2 : conv.areaM2;
    // kg per metre: lets the app convert m-priced rows to kg and back.
    q.kgm = q.kgm != null ? q.kgm : conv.kgm;
    if (conv.basis) q.details['مبنای تبدیل واحد'] = conv.basis;
    // Rial → Toman conversion recorded for honesty.
    if (q.currency === 'ریال' && q.amount != null) {
      q.amount = +(q.amount / 10).toFixed(2);
      q.currency = 'تومان';
      q.details['مبنای تبدیل ارز'] = 'ریال÷۱۰ از متن منبع';
    }
    const fixed = repairQuote(q);
    if (!fixed) continue;
    if (!fixed.sellerCity || fixed.sellerCity === 'نامشخص') {
      try { fixed.sellerCity = resolveCity(text).city; } catch { /* keep نامشخص */ }
    }
    out.push(fixed);
  }
  return out;
}

/**
 * Extract Quote rows from the price TABLES of one HTML page — the online
 * mirror of IronPin's PublicTables reader (heading-owned generic seller
 * tables + div-grid price grids). Rial amounts are converted to Toman here so
 * every stored row is comparable. Returns Quote-compatible rows ready to store.
 */
export function extractTableQuotes(html, meta) {
  if (!html) return [];
  const nowTs = meta.fetchedAt || Date.now();
  const sellerCity = meta.sellerCity || 'نامشخص';
  const rows = readTables(html, {
    endpoint: meta.endpoint || 'qwen-scanner',
    seller: meta.seller || '',
    sellerCity,
    sourceUrl: meta.sourceUrl || '',
    fetchedAt: nowTs,
    category: meta.category || 'عمومی',
    defaultCurrency: meta.defaultCurrency || 'نامشخص',
  });
  const out = [];
  for (const q of rows) {
    const witness = q.details?.['شاهد ردیف'] || q.title;
    const conv = computeConversions(witness, { unit: q.unit, size: q.size, thickness: q.thickness, dims: q.dimensions });
    q.pieceKg = q.pieceKg != null ? q.pieceKg : conv.pieceKg;
    q.lengthM = q.lengthM != null ? q.lengthM : conv.lengthM;
    q.areaM2 = q.areaM2 != null ? q.areaM2 : conv.areaM2;
    q.kgm = q.kgm != null ? q.kgm : conv.kgm;
    if (conv.basis) q.details['مبنای تبدیل واحد'] = conv.basis;
    // Rial → Toman, recorded for honesty (mirror of the text path).
    if (q.currency === 'ریال' && q.amount != null) {
      q.amount = +(q.amount / 10).toFixed(2);
      q.currency = 'تومان';
      q.details['مبنای تبدیل ارز'] = 'ریال÷۱۰ از متن منبع';
    }
    const fixed = repairQuote(q);
    if (!fixed) continue;
    if (!fixed.sellerCity || fixed.sellerCity === 'نامشخص') {
      const witness = [q.details?.['شاهد ردیف'] || '', q.title].join(' ');
      try { fixed.sellerCity = resolveCity(witness).city; } catch { /* keep نامشخص */ }
    }
    out.push(fixed);
  }
  return out;
}

const BACKFILL_KEY = 'ironpin_backfill_v1';
const BATCH_SIZE = 300;

/** Store extracted quotes into ironpin_quotes (direct — no knowledge table). */
export async function storeQuotes(db, scanId, quotes, now = Date.now()) {
  if (!quotes.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO ironpin_quotes (scan_id, knowledge_id, source_last_verified_at, quote_json)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(scan_id, knowledge_id) DO UPDATE SET
       quote_json = excluded.quote_json,
       source_last_verified_at = MAX(ironpin_quotes.source_last_verified_at, excluded.source_last_verified_at)`
  );
  const list = [];
  for (const q of quotes) {
    if (!q || !q.id) continue;
    list.push(stmt.bind(scanId, q.id, now, JSON.stringify(q)));
  }
  for (let i = 0; i < list.length; i += 50) {
    await db.batch(list.slice(i, i + 50));
  }
  return list.length;
}

/** GET /api/ironpin — same-day deduped, freshest window, full snapshot. */
export async function buildIronpinExport(db, { since = 0, limit = 1000 } = {}) {
  const sinceN = Number(since) > 0 ? Number(since) : 0;
  const inc = sinceN > 0;
  // Full snapshot: take the FRESHEST `limit` rows, not the oldest.
  const sql = inc
    ? 'SELECT quote_json, source_last_verified_at FROM ironpin_quotes WHERE source_last_verified_at > ?1 ORDER BY source_last_verified_at, rowid LIMIT ?2'
    : 'SELECT quote_json, source_last_verified_at FROM ironpin_quotes ORDER BY rowid DESC LIMIT ?1';
  const rows = inc
    ? await db.prepare(sql).bind(sinceN, limit).all()
    : await db.prepare(sql).bind(limit).all();
  const best = new Map();
  let cursor = sinceN;
  for (const r of rows.results || []) {
    const t = Number(r.source_last_verified_at) || 0;
    if (t > cursor) cursor = t;
    let q = null;
    try { q = repairQuote(JSON.parse(r.quote_json)); } catch { continue; }
    if (!q) continue;
    const verifiedAt = Number(q.fetchedAt ? Date.parse(q.fetchedAt) : 0) || t;
    const key = exportIdentity(q, tehranDay(verifiedAt || t));
    const prev = best.get(key);
    if (!prev || (prev._t || 0) < t) best.set(key, { ...q, _t: t });
  }
  let quotes = [...best.values()].map(({ _t, ...q }) => q);
  if (quotes.length > limit && !inc) quotes = quotes.slice(quotes.length - limit);
  return {
    format: 'ironpin-quotes-v1',
    generated_at: new Date().toISOString(),
    count: quotes.length,
    cursor,
    complete: true,
    quotes,
  };
}

/** Compatibility shim: the old knowledge-based backfill is removed; the
 *  pipeline now stores quotes directly via storeQuotes. Returns done. */
export async function processIronpinBatch(db) {
  const flag = 'ironpin_backfill_v1';
  try {
    await db.prepare(
      `INSERT INTO meta(key, value, updated_at) VALUES(?1,?2,?3)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).bind(flag, JSON.stringify({ done: true, at: Date.now() }), Date.now()).run();
  } catch { /* ignore */ }
  return { processed: 0, quotes: 0, done: true };
}

/**
 * One-shot maintenance: delete stored quotes that fail the CURRENT repair
 * gate (junk/news/range/menu rows that only look valid to an older gate).
 * Rows are invisible at serve time anyway; this just stops them wasting D1
 * storage. Idempotent via meta flag `purge_junk_v2_done`.
 */
export async function purgeJunkQuotes(db, { flag = 'purge_junk_v2_done', now = Date.now() } = {}) {
  try {
    const row = await db.prepare('SELECT value FROM meta WHERE key = ?1').bind(flag).first();
    if (row?.value && JSON.parse(row.value).done) return { done: true, deleted: 0 };
  } catch { /* meta table may not exist yet — try anyway */ }
  let deleted = 0;
  try {
    const all = await db.prepare('SELECT scan_id, knowledge_id, quote_json FROM ironpin_quotes').all();
    const rows = all.results || [];
    const bad = [];
    for (const r of rows) {
      let ok = true;
      try { ok = repairQuote(JSON.parse(r.quote_json)) != null; } catch { ok = false; }
      if (!ok) bad.push(r);
    }
    for (let i = 0; i < bad.length; i += 50) {
      const stmt = db.prepare('DELETE FROM ironpin_quotes WHERE scan_id = ?1 AND knowledge_id = ?2');
      const slice = bad.slice(i, i + 50);
      await db.batch(slice.map((r) => stmt.bind(r.scan_id, r.knowledge_id)));
      deleted += slice.length;
    }
    try {
      await db.prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(flag, JSON.stringify({ done: true, deleted, at: now }), now).run();
    } catch { /* non-fatal */ }
    return { done: true, deleted };
  } catch (e) {
    console.error('purgeJunkQuotes failed', e?.message || e);
    return { done: false, deleted };
  }
}
