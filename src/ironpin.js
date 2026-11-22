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

const CITIES = ['بوئین زهرا', 'شهرکرد', 'نیشابور', 'اصفهان', 'شیراز', 'مشهد', 'تهران', 'تبریز', 'همدان', 'کاشان', 'اهواز', 'سیرجان', 'کرمان', 'شهرضا', 'ابرکوه', 'قزوین', 'تاکستان', 'بناب', 'میانه', 'رشت', 'ساری', 'یزد', 'ابهر', 'دزفول', 'شاهرود', 'سمنان', 'اردبیل', 'قم', 'اراک'];

/** آدرس‌یابی از شماره تلفن — پیش‌شماره‌های جغرافیایی همراه اول. */
const PHONE_CITY = { '0910': 'تهران', '0911': 'ساری', '0912': 'تهران', '0913': 'اصفهان', '0914': 'تبریز', '0915': 'مشهد', '0916': 'اهواز', '0917': 'شیراز', '0918': 'همدان', '0919': 'تهران' };

export function cityFromPhone(text) {
  const t = normalizeText(String(text || ''));
  const m = /(?:\+98|0098|0)?(9\d{9})(?!\d)/.exec(t);
  if (!m) return null;
  const phone = '0' + m[1];
  const city = PHONE_CITY[phone.slice(0, 4)];
  return city ? { city, prefix: phone.slice(0, 4), phone } : null;
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
  // Title cap: only product + specs + price — never long prose/SEO text.
  if (typeof q.title === 'string' && q.title.length > 120) {
    q.title = q.title.slice(0, 120).replace(/[,،;；]$/, '').trim();
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
    if (conv.basis) q.details['مبنای تبدیل واحد'] = conv.basis;
    // Rial → Toman conversion recorded for honesty.
    if (q.currency === 'ریال' && q.amount != null) {
      q.amount = +(q.amount / 10).toFixed(2);
      q.currency = 'تومان';
      q.details['مبنای تبدیل ارز'] = 'ریال÷۱۰ از متن منبع';
    }
    const fixed = repairQuote(q);
    if (!fixed) continue;
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

/** Serve pre-serialized Quote rows as a streamed single JSON response.
 *  `since` (ms) = incremental mode for the app's external scanner: only rows
 *  with source_last_verified_at > since (new OR updated), no candidates
 *  payload, and `cursor` = max timestamp served. */
export async function streamIronpinExport(db, { since = 0 } = {}) {
  const sinceN = Number(since) > 0 ? Number(since) : 0;
  const incremental = sinceN > 0;
  const [qres, state] = await Promise.all([
    incremental
      ? db.prepare('SELECT quote_json, source_last_verified_at FROM ironpin_quotes WHERE source_last_verified_at > ?1 ORDER BY source_last_verified_at, rowid').bind(sinceN).all()
      : db.prepare('SELECT quote_json, source_last_verified_at FROM ironpin_quotes ORDER BY rowid').all(),
    db.prepare('SELECT value FROM meta WHERE key = ?1').bind(BACKFILL_KEY).first(),
  ]);
  const raws = qres.results || [];
  let ready = false;
  try { ready = JSON.parse(state?.value || '{}').done === true; } catch { /* ignore */ }
  let cursor = sinceN;
  const qs = [];
  const seen = new Set();
  for (const r of raws) {
    const t = Number(r.source_last_verified_at) || 0;
    if (t > cursor) cursor = t;
    let q = null;
    try { q = JSON.parse(r.quote_json); } catch { continue; }
    const fixed = repairQuote(q);
    if (!fixed) continue;
    const key = String(fixed.title || '').slice(0, 80) + '|' + fixed.amount + '|' + fixed.unit;
    if (seen.has(key)) continue;
    seen.add(key);
    qs.push(fixed);
  }
  const generated = new Date(Math.max(Date.now(), ...raws.map((x) => Number(x.source_last_verified_at) || 0))).toISOString();
  const enc = new TextEncoder();
  let i = 0, first = true, phase = 0;
  const tail = `],"cursor":${cursor}}`;
  const head = `{"format":"ironpin-quotes-v1","generated_at":${JSON.stringify(generated)},"count":${qs.length},"complete":${ready},${incremental ? `"since":${sinceN},` : ''}"quotes":[`;
  const body = new ReadableStream({
    pull(controller) {
      if (phase === 0) { controller.enqueue(enc.encode(head)); phase = 1; return; }
      if (phase === 1) {
        const end = Math.min(i + 50, qs.length);
        let chunk = '';
        for (; i < end; i++) {
          if (!first) chunk += ',';
          first = false;
          chunk += JSON.stringify(qs[i]);
        }
        if (chunk) controller.enqueue(enc.encode(chunk));
        if (i < qs.length) return;
        controller.enqueue(enc.encode(tail));
        phase = 2;
        controller.close();
        return;
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': ready && !incremental ? 'public, max-age=900' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Full / incremental IronPin export for the panel API. `since` (ms) returns
 * only rows verified after that cursor; `cursor` echoes the max timestamp so
 * the app can page forward.
 */
export async function buildIronpinExport(db, { since = 0, limit = 1000 } = {}) {
  const sinceN = Number(since) > 0 ? Number(since) : 0;
  const inc = sinceN > 0;
  const sql = inc
    ? 'SELECT quote_json, source_last_verified_at FROM ironpin_quotes WHERE source_last_verified_at > ?1 ORDER BY source_last_verified_at, rowid LIMIT ?2'
    : 'SELECT quote_json, source_last_verified_at FROM ironpin_quotes ORDER BY rowid LIMIT ?1';
  const rows = inc
    ? await db.prepare(sql).bind(sinceN, limit).all()
    : await db.prepare(sql).bind(limit).all();
  const quotes = [];
  const seen = new Set();
  let cursor = sinceN;
  for (const r of rows.results || []) {
    const t = Number(r.source_last_verified_at) || 0;
    if (t > cursor) cursor = t;
    let q = null;
    try { q = repairQuote(JSON.parse(r.quote_json)); } catch { continue; }
    if (!q) continue;
    const key = String(q.title || '').slice(0, 80) + '|' + q.amount + '|' + q.unit;
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push(q);
  }
  return {
    format: 'ironpin-quotes-v1',
    generated_at: new Date().toISOString(),
    count: quotes.length,
    cursor,
    complete: true,
    quotes,
  };
}
