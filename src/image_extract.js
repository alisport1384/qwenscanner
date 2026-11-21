/**
 * استخراج تایپ‌شده از صفحه و تصاویر — Cloudflare Clairic.
 *
 * Spec: «تعیین تمام موارد گفته شده از روی عکس» — one typed pass over the
 * page text plus up to MAX_IMAGES_PER_PAGE embedded images. Every answer
 * carries confidence; only confident non-null values become knowledge rows,
 * and a row is registered ONLY when it carries a price, or product+contact —
 * never prose. Bounded by the guardian (IMAGE_EXTRACT_LIMIT/day, fetch budget,
 * wall-clock), skipped entirely when env.AI is not bound.
 */

import { buildKnowledgeItem } from './knowledge.js';

const IMG_SRC_RE = /<img[^>]+src=["']([^"']+)["']/gi;
const IMG_EXT_RE = /\.(png|jpe?g|webp)(\?|#|$)/i;
const MAX_IMAGES_PER_PAGE = 2;
const MAX_IMG_BYTES = 4 * 1024 * 1024; // Clairic limit per image
const STATE_CAP = 12_000; // chars of page text handed to the model
const MIN_CONFIDENCE = 0.6;

/** Typed field map — ASCII names per Clairic schema, Persian instructions. */
export const EXTRACTION_FIELDS = {
  product: {
    type: 'text',
    instructions: 'نام دقیق محصول (میلگرد، تیرآهن، ورق، لوله، نبشی، پروفیل، ...) اگر در ورودی باشد',
  },
  amount: {
    type: 'number',
    unit: 'تومان',
    instructions: 'مبلغ قیمت اعلام‌شده به تومان؛ اگر قیمتی نیست null برگردان',
  },
  price_basis: {
    type: 'text',
    instructions: 'مبنای فروش دقیقا كما در متن: هر کیلو، هر شاخه، هر متر، هر تن، هر برگ، هر دسته، هر عدد',
  },
  dimensions: {
    type: 'text',
    instructions: 'ابعاد/سایز/ضخامت اعلام‌شده (مثلا 14، IPE20، 1000x2000، ضخامت 3)',
  },
  grade: {
    type: 'text',
    instructions: 'کیفیت/گرید/جنس/استاندارد اعلام‌شده (A3، ST37، درجه یک، ...)',
  },
  tax: {
    type: 'text',
    instructions: 'مالیات ارزش افزوده: با ارزش افزوده یا بدون ارزش افزوده؛ نامشخص = null',
  },
  city: {
    type: 'text',
    instructions: 'شهر یا استان فروشنده یا آدرس اعلام‌شده در ورودی',
  },
  phone: {
    type: 'text',
    instructions: 'شماره تماس فارسی یا بین‌المللی اعلام‌شده (مثلا 09121234567)',
  },
  published_on: {
    type: 'date',
    instructions: 'تاریخ انتشار قیمت یا آگهی به شمسی یا میلادی؛ نامشخص = null',
  },
  piece_weight_kg: {
    type: 'number',
    unit: 'kg',
    integer: false,
    instructions: 'وزن اعلامی هر شاخه/قطعه/برگ به کیلوگرم؛ فقط اگر صریحا ذکر شده باشد',
  },
};

/** Collect same-origin-ish, sized image candidates from raw HTML (bounded). */
export function pickImages(html, pageUrl, max = MAX_IMAGES_PER_PAGE) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  let m;
  IMG_SRC_RE.lastIndex = 0;
  while ((m = IMG_SRC_RE.exec(html)) && out.length < max * 3) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('data:')) continue;
    let abs;
    try {
      abs = new URL(raw, pageUrl).toString();
    } catch {
      continue;
    }
    if (!IMG_EXT_RE.test(abs)) continue;
    if (/logo|icon|avatar|sprite|banner-?ad|emoji|tracking|pixel/i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  // Prefer larger-looking assets later in the pipeline; order kept as-is (bounded).
  return out.slice(0, max);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function txt(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 160) : null;
}

/**
 * Build knowledge claims from Clairic answers. Pure function (unit-tested).
 * Returns [] unless there is a confident price row, or a product+contact row.
 * Claim text is field data only — no prose, no filler (spec: بدون جمله اضافی).
 */
export function claimsFromAnswers(answers, { url, domain, topic, scanId }) {
  if (!answers || typeof answers !== 'object') return [];
  const a = (k) => answers[k] || {};
  const conf = (k) => num(a(k).confidence) ?? 0;
  const val = (k) => (conf(k) >= MIN_CONFIDENCE ? a(k).value : null);

  const product = txt(val('product'));
  const amount = num(val('amount'));
  const basis = txt(val('price_basis'));
  const dims = txt(val('dimensions'));
  const grade = txt(val('grade'));
  const taxRaw = txt(val('tax'));
  const city = txt(val('city'));
  const phone = txt(val('phone'));
  const date = txt(val('published_on'));
  const pieceKg = num(val('piece_weight_kg'));

  const out = [];

  if (amount != null && amount > 0) {
    const parts = [`قیمت ${product || topic}: ${amount} تومان`];
    if (basis) parts.push(`مبنای واحد: ${basis}`);
    if (dims) parts.push(`ابعاد: ${dims}`);
    if (grade) parts.push(`کیفیت: ${grade}`);
    if (pieceKg != null && pieceKg > 0) parts.push(`وزن هر قطعه: ${pieceKg} کیلوگرم`);
    if (taxRaw && /ارزش افزوده/.test(taxRaw)) parts.push(`مالیات: ${taxRaw}`);
    if (city) parts.push(`شهر: ${city}`);
    if (date) parts.push(`تاریخ: ${date}`);
    if (phone) parts.push(`تماس: ${phone}`);
    const confAvg = Math.min(
      0.99,
      ['amount', 'product', 'price_basis'].reduce((s, k) => s + Math.min(conf(k), 1), 0) / 3
    );
    out.push({
      claim: parts.join('، '),
      attribute: 'price',
      confidence: Number(confAvg.toFixed(2)),
      meta: { amount, basis: basis || '', piece_kg: pieceKg, via: 'image-extract' },
    });
  } else if (product && (phone || city)) {
    // No price → contact/source row only when both product and reachability exist.
    const parts = [`${product}`];
    if (city) parts.push(`شهر: ${city}`);
    if (phone) parts.push(`تماس: ${phone}`);
    if (grade) parts.push(`کیفیت: ${grade}`);
    if (date) parts.push(`تاریخ: ${date}`);
    out.push({
      claim: parts.join('، '),
      attribute: 'specs',
      confidence: Number(Math.min(0.98, conf('product')).toFixed(2)),
      meta: { via: 'image-extract' },
    });
  }

  return out.map((c) => ({
    ...c,
    source: { url, domain, scanId },
  }));
}

/** Fetch image bytes → {b64, mime} (≤4 MiB), guarded by the guardian fetch budget. */
async function loadImageData(env, src, guardian) {
  if (guardian && !guardian.allowFetch(1)) return null;
  try {
    const res = await fetch(src, { redirect: 'follow', cf: { cacheTtl: 300 } });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const mimeMatch = ct.match(/image\/(png|jpeg|webp)/);
    if (ct && !mimeMatch) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > MAX_IMG_BYTES) return null;
    if (guardian) guardian.spendFetch(1);
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const mime = mimeMatch ? `image/${mimeMatch[1]}` : 'image/png';
    return { b64: bin, mime };
  } catch {
    return null;
  }
}

/**
 * Extract typed facts for one fetched page. Returns knowledge-ready objects
 * ([] on any failure — never blocks the pipeline).
 */
export async function extractFromPage(env, { html, pageUrl, domain, text, scan, lang, now, guardian }) {
  try {
    if (!env?.AI) return [];
    if (!guardian || !guardian.allowAi(1)) return [];
    if (guardian.expired()) return [];

    const srcs = pickImages(html, pageUrl);
    if (!srcs.length) return [];

    const images = [];
    for (const s of srcs) {
      if (images.length >= MAX_IMAGES_PER_PAGE) break;
      if (guardian.expired()) break;
      const img = await loadImageData(env, s, guardian);
      if (img) images.push(`data:${img.mime};base64,${img.b64}`);
    }
    if (!images.length) return [];

    const state = String(text || '').slice(0, STATE_CAP);
    if (!state.trim()) return [];

    const res = await env.AI.run('@cf/cloudflare/clairic', {
      model: 'clairic',
      state,
      images,
      fields: EXTRACTION_FIELDS,
    });
    guardian.spendAi(1);

    const answers = res?.answers || res?.result?.answers;
    const rows = claimsFromAnswers(answers, {
      url: pageUrl,
      domain,
      topic: scan.topic,
      scanId: scan.id,
    });
    if (!rows.length) return [];

    return rows.map((r, i) =>
      buildKnowledgeItem({
        kind: 'fact',
        topic: scan.topic,
        question: scan.topic,
        claim: r.claim,
        url: pageUrl,
        domain,
        index: 1000 + i, // distinct namespace from text facts (hash input)
        total: rows.length,
        layer: r.attribute,
        lang,
        now,
        offset: null,
      })
    );
  } catch (e) {
    console.error('image extract failed', e?.message || e);
    return [];
  }
}
