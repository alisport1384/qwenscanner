/**
 * Attribute inference helpers — IronPin product attribute extraction.
 *
 * The Qwen RAG/knowledge path is removed (حذف): no KnowledgeItem builders,
 * no chunk/export functions. This module keeps the pure text-classification
 * helpers (inferAttribute) used to inspect a claim's nature, and an
 * IronPin-only target filter retained for compatibility.
 */

/** Non-crypto stable hash (FNV-1a 32 → 16 hex chars with second seed). */
export function hashId(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Rough token estimate (inline; the Qwen chunker that provided this is removed). */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

/** Attribute/layer heuristic (price/specs/reviews/updates/basics).
 *  Price branch also uses IronPin product vocabulary (steel goods + amount). */
const IRONPIN_PRICE_RE =
  /(قیمت|نرخ|price|تومان|ریال|تومن|خرید|فروش|ارزان|گران|استعلام|بنگاه|بازار آهن)/i;
const IRONPIN_PRODUCT_RE =
  /(میلگرد|تیر\s*آهن|تیراهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|مانیسمان|اسپیرال|\bERW\b|\bAPI\b|ورق|پلیت|شیت|چهارپهلو|شش\s*پر|مفتول|تسمه|سپری|رابیتس|توری|گابیون|حصاری|مش\s*جوشی|شمش|بیلت|بلوم|اسلب|قراضه|انکر\s*بولت|رول\s*بولت|\bbolt\b|گندله|بریکت|فرو\s*آلیاژ|\bDRI\b|آهن\s*اسفنجی|آهن\s*آلات|مقاطع\s*فولادی)/i;
const AMOUNT_RE = /[0-9۰-۹][0-9۰-۹.,٬\s]{2,}/;

export function inferAttribute(text) {
  const t = (text || '').toLowerCase();
  // نرخ تبدیل / فرمول‌ها اول: عبارت‌های «نرخ تبدیل» قیمت بازار نیستند
  if (/(نرخ تبدیل|نرخ ارز|نرخ بهره|تبدیل واحد|کیلوگرم بر متر|هر متر چند|قیمت هر واحد تبدیل)/i.test(t)) {
    return 'calculation';
  }
  if (IRONPIN_PRICE_RE.test(t)) return 'price';
  // product name + numeric amount without the word قیمت still counts as price row
  if (IRONPIN_PRODUCT_RE.test(t) && AMOUNT_RE.test(t) && /(تومان|ریال|خرید|فروش)/.test(t)) {
    return 'price';
  }
  // تعاریف — پاسخ به «چیست / به چه می‌گویند»
  if (
    /(تعریف|تعاریف|عبارت است از|منظور از|به چه می‌گویند|معنای|تعریف می‌شود|تعریف شده|definition|defined as|means of|refers to)/i.test(
      t
    )
  ) {
    return 'definition';
  }
  // محاسبات — فرمول/معادله/نرخ تبدیل با اعداد و عملگر
  if (
    /(فرمول|محاسبه|محاسبات|نرخ تبدیل|چگالی|وزن هر|معادله|قانون [وژ]|تقسیم بر|ضرب در)/i.test(t) ||
    (/\d\s*[×x*÷\/+]\s*\d/.test(t) && /=\s*\d/.test(t))
  ) {
    return 'calculation';
  }
  if (/(مشخصات|spec|وزن|ابعاد|جنس|فناوری|dimension|material|technical|capacity)/.test(t)) return 'specs';
  if (/(نظر|review|امتیاز|تجربه|کیفیت|rating|opinion)/.test(t)) return 'reviews';
  if (/(اخبار|جدید|به‌روز|آخرین|update|news|202[5-9]|140[4-6])/.test(t)) return 'updates';
  return 'basics';
}

/** Alias kept for callers that used the plural name. */
export const inferAttributes = inferAttribute;

/** IronPin-only target filter (Qwen target removed — returns input unchanged). */
export function ironpinTargetFilter(rows) {
  return rows;
}
