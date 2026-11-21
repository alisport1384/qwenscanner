/** QwenRag-compatible chunker — port of domain/QwenRag.kt (QWEN-PIPELINE-REPORT §5) */

export const TARGET_CHARS = 900;   // ≈ 450 Persian tokens (2.2 chars/token)
export const OVERLAP_CHARS = 140;  // ≈ 63 tokens — pronoun reference preserved
export const MIN_CHARS = 200;      // shorter = noise, discarded
export const TARGET_TOKENS = 450;

/** Persian mixed with Latin/digits ≈ 2.0–2.5 chars/token (Qwen tokenizer) */
export function estimateTokens(text) {
  return Math.round(text.length / 2.2);
}

/** Sentence-based split — never mid-sentence. Terminators: . ? ! ؟ … \n */
export function splitSentences(text) {
  const out = [];
  if (!text) return out;
  const isTerm = (ch) =>
    ch === '.' || ch === '?' || ch === '!' || ch === '؟' || ch === '…' || ch === '\n';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (isTerm(text[i])) {
      let end = i + 1;
      while (end < text.length && '")»”\'’.!؟…'.includes(text[end]) && !isTerm(text[end])) end++;
      const raw = text.slice(start, end);
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (trimmed) out.push({ text: trimmed, offset: start + lead });
      start = end;
      i = end - 1;
    }
  }
  const rest = text.slice(start);
  const lead = rest.length - rest.trimStart().length;
  const trimmed = rest.trim();
  if (trimmed) out.push({ text: trimmed, offset: start + lead });
  return out;
}

/** Hard-split oversized sentence at word boundaries (pages without punctuation). */
function hardSplit(sentence, offset) {
  const parts = [];
  const words = sentence.split(/\s+/).filter(Boolean);
  let buf = '';
  let partStart = offset;
  let cursor = 0;
  for (const w of words) {
    const idx = sentence.indexOf(w, cursor);
    const wOff = offset + (idx >= 0 ? idx : 0);
    cursor = (idx >= 0 ? idx : cursor) + w.length;
    if (buf && buf.length + 1 + w.length > TARGET_CHARS) {
      parts.push({ text: buf.trim(), offset: partStart });
      partStart = wOff;
      buf = w;
    } else {
      buf = buf ? `${buf} ${w}` : w;
      if (buf.length <= w.length + 1) partStart = wOff;
    }
  }
  if (buf.trim()) parts.push({ text: buf.trim(), offset: partStart });
  return parts;
}

/**
 * Sentence-oriented chunker: target 900, overlap 140, min 200.
 * Returns [{ text, offset, tokens, index }].
 */
export function chunk(text) {
  if (!text) return [];
  let sentences = splitSentences(text);
  sentences = sentences.flatMap((s) =>
    s.text.length > TARGET_CHARS ? hardSplit(s.text, s.offset) : [s]
  );

  const chunks = [];
  let basket = '';
  let basketStart = 0;
  let started = false;

  const push = (content, start) => {
    const t = content.trim();
    if (t.length >= MIN_CHARS) {
      chunks.push({ text: t, offset: start, tokens: estimateTokens(t), index: chunks.length });
    }
  };

  for (const s of sentences) {
    if (basket.length + s.text.length > TARGET_CHARS && basket.length >= MIN_CHARS) {
      push(basket, basketStart);
      const overlap = basket.slice(-OVERLAP_CHARS);
      basketStart = Math.max(0, basketStart + basket.length - overlap.length);
      basket = overlap + s.text;
      started = true;
      continue;
    }
    if (!started) {
      basketStart = s.offset;
      started = true;
    }
    basket += s.text;
  }
  push(basket, basketStart);
  return chunks;
}

/** Fallback for short pages (100–399 chars): single KnowledgeItem. Null if <100. */
export function singleChunk(text) {
  if (!text || text.length < 100) return null;
  const t = text.trim();
  if (!t) return null;
  return { text: t, offset: 0, tokens: estimateTokens(t), index: 0 };
}

/**
 * قربالگیری جملات اضافی — menu/chrome/footer boilerplate must never be
 * registered as knowledge (spec: «هیچ جمله‌ای خارج از اهداف در موارد ثبت‌شده»).
 * Conservative: only short, menu-shaped sentences with known chrome phrases.
 */
const NOISE_PHRASES = [
  'صفحه اصلی', 'ورود به سایت', 'ثبت نام', 'ورود کاربران', 'درباره ما', 'تماس با ما',
  'لینک‌های مفید', 'شبکه‌های اجتماعی', 'کپیرایت', 'تمامی حقوق محفوظ', 'all rights reserved',
  'copyright', 'پیگیری سفارش', 'سبد خرید', 'فروشگاه اینترنتی', 'جستجو در سایت',
  'پیشنهاد ویژه', 'تخفیف ویژه', 'عضویت در خبرنامه', 'آخرین اخبار سایت', 'نقشه سایت',
  'چرا ما را انتخاب کنید', 'ارسال رایگان', 'پرداخت اینترنتی', 'پشتیبانی ۲۴ ساعته',
];

export function isNoiseSentence(s) {
  const t = (s || '').trim();
  if (!t) return true;
  if (t.length > 48) return false;
  const low = t.toLowerCase();
  return NOISE_PHRASES.some((p) => low.includes(p));
}

/** Dual-write fact harvest: sentences 30–320 chars (report §7.1 FactHarvester). */
export function harvestFacts(text, limit = 8) {
  const facts = [];
  for (const s of splitSentences(text || '')) {
    const len = s.text.length;
    if (len >= 30 && len <= 320 && !isNoiseSentence(s.text)) {
      facts.push({ text: s.text, offset: s.offset, tokens: estimateTokens(s.text) });
      if (facts.length >= limit) break;
    }
  }
  return facts;
}
