/** KnowledgeItem builders — schema from QWEN-PIPELINE-REPORT §6 */

import { estimateTokens } from './chunker.js';

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

/** Attribute/layer heuristic (report §6: price/specs/reviews/updates/basics).
 *  Price branch also uses IronPin product vocabulary (steel goods + amount). */
const IRONPIN_PRICE_RE =
  /(قیمت|نرخ|price|تومان|ریال|تومن|خرید|فروش|ارزان|گران|استعلام|بنگاه|بازار آهن)/i;
const IRONPIN_PRODUCT_RE =
  /(میلگرد|تیر\s*آهن|تیراهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|مانیسمان|اسپیرال|\bERW\b|\bAPI\b|ورق|پلیت|شیت|چهارپهلو|شش\s*پر|مفتول|تسمه|سپری|رابیتس|توری|گابیون|حصاری|مش\s*جوشی|شمش|بیلت|بلوم|اسلب|قراضه|انکر\s*بولت|رول\s*بولت|\bbolt\b|گندله|بریکت|فرو\s*آلیاژ|\bDRI\b|آهن\s*اسفنجی|آهن\s*آلات|مقاطع\s*فولادی)/i;
const AMOUNT_RE = /[0-9\u06F0-\u06F9][0-9\u06F0-\u06F9.,\u066C\u066B\s]{2,}/;

export function inferAttribute(text) {
  const t = (text || '').toLowerCase();
  if (IRONPIN_PRICE_RE.test(t)) return 'price';
  // product name + numeric amount without the word قیمت still counts as price row
  if (IRONPIN_PRODUCT_RE.test(t) && AMOUNT_RE.test(t) && /(تومان|ریال|خرید|فروش)/.test(t)) {
    return 'price';
  }
  if (/(مشخصات|spec|وزن|ابعاد|جنس|فناوری|dimension|material|technical|capacity)/.test(t)) return 'specs';
  if (/(نظر|review|امتیاز|تجربه|کیفیت|rating|opinion)/.test(t)) return 'reviews';
  if (/(اخبار|جدید|به‌روز|آخرین|update|news|202[5-9]|140[4-6])/.test(t)) return 'updates';
  return 'basics';
}

function hasNumeric(text) {
  return /[0-9\u06F0-\u06F9]/.test(text || '');
}

/**
 * Build one KnowledgeItem (chunk or fact).
 * id = hash("rag:{topic}:{url}#{tag}:{claim-prefix}") per report §6.
 */
export function buildKnowledgeItem({
  kind,          // 'chunk' | 'fact'
  topic,
  question,
  claim,
  url,
  domain,
  index,
  total,
  layer,
  lang,
  now,
  offset = null,
}) {
  const attribute = layer || inferAttribute(`${topic} ${claim.slice(0, 200)}`);
  const tag = kind === 'chunk' ? `chunk:${index}/${total}` : `fact:${index}`;
  const id = hashId(`rag:${topic}:${url}#${tag}:${claim.slice(0, 120)}`);

  let confidence;
  if (kind === 'chunk') confidence = 0.68;
  else if (hasNumeric(claim)) confidence = 0.62;
  else confidence = 0.55;

  const tokens = estimateTokens(claim);
  const tags = ['rag', tag, `tok:${tokens}`, attribute, url];
  if (lang) tags.push(`lang:${lang}`);

  return {
    id,
    kind,
    topic,
    question: question || topic,
    claim,
    category: 'rag',
    attribute,
    url,
    domain,
    confidence,
    ttl_days: 45, // web research TTL per report
    layer: attribute,
    tags: JSON.stringify(tags),
    chunk_index: kind === 'chunk' ? index : null,
    chunk_total: kind === 'chunk' ? total : null,
    tokens,
    offset_chars: offset,
    lang: lang || 'und',
    created_at: now,
    last_verified_at: now,
  };
}

/** Export format for Qwen (report §6/§8) — what /api/report/:id returns. */
export function toQwenExport(scan, items) {
  return {
    format: 'qwen-knowledge-v1',
    generated_at: new Date().toISOString(),
    scan: {
      id: scan.id,
      topic: scan.topic,
      question: scan.topic,
      status: scan.status,
      created_at: scan.created_at,
      updated_at: scan.updated_at,
    },
    chunker: {
      target_chars: 900,
      overlap_chars: 140,
      min_chars: 200,
      target_tokens: 450,
      estimator: 'chars/2.2',
    },
    retrieval_hint: {
      method: 'lexical-scored (answerable)',
      weights: { topicMatch: 0.45, claimRelevance: 0.3, freshness: 0.15, confidence: 0.1 },
      top_k: 4,
    },
    items: items.map((it) => ({
      id: it.id,
      topic: it.topic,
      question: it.question,
      claim: it.claim,
      category: it.category,
      attribute: it.attribute,
      url: it.url,
      domain: it.domain,
      confidence: it.confidence,
      ttl_days: it.ttl_days,
      layer: it.layer,
      kind: it.kind,
      tokens: it.tokens,
      lang: it.lang,
      last_verified_at: it.last_verified_at,
      tags: safeParse(it.tags),
    })),
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return []; }
}

/**
 * Aggregated export for a batch (list) — one Qwen-ready document
 * covering every scan/topic inside the batch.
 */
export function toQwenBatchExport(batch, scans, items) {
  return {
    format: 'qwen-knowledge-v1',
    kind: 'batch',
    generated_at: new Date().toISOString(),
    batch: {
      id: batch.id,
      title: batch.title || null,
      topics_count: batch.topics_count,
      created_at: batch.created_at,
      updated_at: batch.updated_at,
    },
    scans: scans.map((s) => ({
      id: s.id,
      topic: s.topic,
      status: s.status,
      pages_done: s.pages_done,
      pages_total: s.pages_total,
      knowledge_count: s.knowledge_count,
      error: s.error,
    })),
    chunker: {
      target_chars: 900,
      overlap_chars: 140,
      min_chars: 200,
      target_tokens: 450,
      estimator: 'chars/2.2',
    },
    retrieval_hint: {
      method: 'lexical-scored (answerable)',
      weights: { topicMatch: 0.45, claimRelevance: 0.3, freshness: 0.15, confidence: 0.1 },
      top_k: 4,
      note: 'items are pre-chunked KnowledgeItems; group by topic field before top-k per question',
    },
    items: items.map((it) => ({
      id: it.id,
      scan_id: it.scan_id,
      topic: it.topic,
      question: it.question,
      claim: it.claim,
      category: it.category,
      attribute: it.attribute,
      url: it.url,
      domain: it.domain,
      confidence: it.confidence,
      ttl_days: it.ttl_days,
      layer: it.layer,
      kind: it.kind,
      tokens: it.tokens,
      lang: it.lang,
      last_verified_at: it.last_verified_at,
      tags: safeParse(it.tags),
    })),
  };
}


/** One Qwen-ready document for ALL knowledge in the DB (live — reads current rows). */
export function toQwenAllExport(items, meta = {}) {
  return {
    format: 'qwen-knowledge-v1',
    kind: 'all',
    generated_at: new Date().toISOString(),
    scope: {
      note: 'کل دانش استخراج‌شده — با هر افزوده منبع/دسته خودکار به‌روز می‌شود',
      items_total: items.length,
      topics: meta.topics || null,
      sources: meta.sources || null,
      categories: meta.categories || null,
    },
    chunker: {
      target_chars: 900,
      overlap_chars: 140,
      min_chars: 200,
      target_tokens: 450,
      estimator: 'chars/2.2',
    },
    retrieval_hint: {
      method: 'lexical-scored (answerable)',
      weights: { topicMatch: 0.45, claimRelevance: 0.3, freshness: 0.15, confidence: 0.1 },
      top_k: 4,
      note: 'items are pre-chunked KnowledgeItems; group by topic field before top-k per question',
    },
    items: items.map((it) => ({
      id: it.id,
      scan_id: it.scan_id,
      topic: it.topic,
      question: it.question,
      claim: it.claim,
      category: it.category,
      attribute: it.attribute,
      url: it.url,
      domain: it.domain,
      confidence: it.confidence,
      ttl_days: it.ttl_days,
      layer: it.layer,
      kind: it.kind,
      tokens: it.tokens,
      lang: it.lang,
      last_verified_at: it.last_verified_at,
      tags: safeParse(it.tags),
    })),
  };
}
