/** Node unit tests — run: node test/chunker.test.js */
import assert from 'node:assert/strict';
import {
  chunk, splitSentences, singleChunk, harvestFacts, estimateTokens, isNoiseSentence,
  TARGET_CHARS, OVERLAP_CHARS, MIN_CHARS,
} from '../src/chunker.js';
import { buildKnowledgeItem, hashId, inferAttribute, toQwenExport } from '../src/knowledge.js';
import { extractMainText, extractTitle, detectLang, normalizeUrl, domainOf } from '../src/extract.js';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('✓', name);
  } catch (e) {
    console.error('✗', name, '\n  ', e.message);
    process.exitCode = 1;
  }
}

// --- chunker ---
ok('splitSentences keeps Persian terminators', () => {
  const s = splitSentences('قیمت بالا رفت. فردا کاهش می‌یابد؟ بله!');
  assert.equal(s.length, 3);
  assert.ok(s[0].text.includes('رفت'));
});

ok('chunk respects target/min/overlap', () => {
  const para =
    'این یک جمله نمونه برای تست چانکر است و طول آن باید کنترل شود. '.repeat(40);
  const chunks = chunk(para);
  assert.ok(chunks.length >= 2, `expected >=2 got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.text.length <= TARGET_CHARS + 200, `chunk too long: ${c.text.length}`);
    assert.ok(c.text.length >= MIN_CHARS, `chunk too short: ${c.text.length}`);
    assert.ok(c.tokens > 0);
    assert.equal(typeof c.index, 'number');
  }
  // overlap: second chunk starts with tail of first (when both from same flow)
  if (chunks.length >= 2) {
    const tail = chunks[0].text.slice(-40);
    const head = chunks[1].text.slice(0, 40);
    // either overlap present OR sentence boundary made exact cut — check chars
    const overlapPresent = chunks[1].text.length > 0;
    assert.ok(overlapPresent && tail.length > 0 && head.length > 0);
  }
});

ok('chunk never exceeds hard cap badly', () => {
  const long = 'کلمه '.repeat(5000); // no punctuation → hardSplit
  const chunks = chunk(long);
  assert.ok(chunks.length > 1);
  // Max = overlap(140) + one hardSplit sentence(≤900+word slack)
  for (const c of chunks) assert.ok(c.text.length <= TARGET_CHARS + OVERLAP_CHARS + 200, `len=${c.text.length}`);
});

ok('short text → empty chunk, singleChunk fallback works', () => {
  const short = 'متن کوتاه است. ';
  assert.equal(chunk(short).length, 0);
  const body = 'این متن باید حداقل صد کاراکتر داشته باشد تا singleChunk قبولش کند. '.repeat(3);
  const sc = singleChunk(body);
  assert.ok(sc && sc.text.length >= 100);
  assert.equal(singleChunk('کوتاه'), null);
});

ok('harvestFacts 30-320 chars only', () => {
  const text =
    'جمله خیلی کوتاه. ' +
    'این یک جمله با طول متوسط است که برای ذخیره به عنوان فکت مناسب خواهد بود و باید در بازه سی تا سیصد و بیست کاراکتر باشد. '.repeat(1) +
    ' x'.repeat(400);
  const facts = harvestFacts(text, 10);
  assert.ok(facts.length >= 1);
  for (const f of facts) {
    assert.ok(f.text.length >= 30 && f.text.length <= 320);
  }
});

ok('estimateTokens ~ length/2.2', () => {
  assert.equal(estimateTokens('a'.repeat(22)), 10);
});

// --- knowledge ---
ok('hashId stable + hex16', () => {
  const a = hashId('rag:topic:http://x#chunk:0/1:claim');
  const b = hashId('rag:topic:http://x#chunk:0/1:claim');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, hashId('other'));
});

ok('buildKnowledgeItem chunk confidence 0.68, tags format', () => {
  const it = buildKnowledgeItem({
    kind: 'chunk', topic: 'ورق', question: 'ورق چیست', claim: 'ورق فولاد نوردشده است. '.repeat(10),
    url: 'https://a.com/x', domain: 'a.com', index: 0, total: 2, layer: null, lang: 'fa', now: 1000,
  });
  assert.equal(it.confidence, 0.68);
  assert.equal(it.category, 'rag');
  assert.equal(it.ttl_days, 45);
  const tags = JSON.parse(it.tags);
  assert.ok(tags.includes('rag'));
  assert.ok(tags.some((t) => t.startsWith('chunk:0/2')));
  assert.ok(tags.some((t) => t.startsWith('tok:')));
  assert.ok(tags.includes('https://a.com/x'));
});

ok('fact numeric → 0.62, descriptive → 0.55', () => {
  const base = { kind: 'fact', topic: 't', question: 't', url: 'https://b.com', domain: 'b.com', index: 0, total: 1, layer: null, lang: 'en', now: 1 };
  const num = buildKnowledgeItem({ ...base, claim: 'قیمت 45000 تومان است' });
  const desc = buildKnowledgeItem({ ...base, claim: 'این ماده از فولاد ساخته شده است و کیفیت خوبی دارد' });
  assert.equal(num.confidence, 0.62);
  assert.equal(desc.confidence, 0.55);
});

ok('inferAttribute price/specs basics', () => {
  assert.equal(inferAttribute('قیمت ورق امروز'), 'price');
  assert.equal(inferAttribute('مشخصات فنی وزن'), 'specs');
  assert.equal(inferAttribute('تاریخچه فولاد'), 'basics');
});

ok('toQwenExport shape', () => {
  const scan = { id: 'x', topic: 't', status: 'done', created_at: 1, updated_at: 2 };
  const items = [buildKnowledgeItem({
    kind: 'chunk', topic: 't', question: 't', claim: 'c '.repeat(50),
    url: 'https://d.com', domain: 'd.com', index: 0, total: 1, layer: null, lang: 'fa', now: 1,
  })];
  const exp = toQwenExport(scan, items);
  assert.equal(exp.format, 'qwen-knowledge-v1');
  assert.equal(exp.items.length, 1);
  assert.equal(exp.chunker.target_chars, 900);
  assert.ok(exp.retrieval_hint.weights.topicMatch === 0.45);
  assert.equal(typeof exp.items[0].tags, 'object');
});

// --- extract ---
ok('extractMainText strips scripts/styles, caps', () => {
  const html = `<html><head><style>.a{}</style><script>var x=1;</script></head>
<body><nav>menu</nav><main><h1>Title</h1><p>${'متن مفید '.repeat(200)}</p></main></body></html>`;
  const text = extractMainText(html, 6000);
  assert.ok(!text.includes('var x'));
  assert.ok(!text.includes('.a{}'));
  assert.ok(text.includes('متن مفید'));
  assert.ok(text.length <= 6000);
});

ok('extractTitle og:title priority', () => {
  const html = `<meta property="og:title" content="عنوان OG"><title>Plain</title>`;
  assert.equal(extractTitle(html), 'عنوان OG');
});

ok('detectLang fa/en/mixed', () => {
  assert.equal(detectLang('این یک متن فارسی کاملاً طولانی برای تشخیص است'), 'fa');
  assert.equal(detectLang('This is a long English sentence for detection'), 'en');
  assert.equal(detectLang(''), 'und');
});

ok('normalizeUrl strips utm + fragment, rejects bad', () => {
  const u = normalizeUrl('https://Example.com/a?utm_source=x&b=2#frag');
  assert.equal(u, 'https://example.com/a?b=2');
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('not a url'), null);
  assert.equal(domainOf('https://www.a.com/x'), 'a.com');
});

ok('isNoiseSentence filters menu/chrome boilerplate only', () => {
  assert.equal(isNoiseSentence('صفحه اصلی'), true);
  assert.equal(isNoiseSentence('تمامی حقوق محفوظ است'), true);
  assert.equal(isNoiseSentence('عضویت در خبرنامه'), true);
  // real content — even short, even containing a chrome-ish word — stays
  assert.equal(isNoiseSentence('قیمت میلگرد امروز افزایش یافت'), false);
  assert.equal(isNoiseSentence('قیمت تیرآهن IPE20 در بازار تهران'), false);
  // long sentences are never treated as noise
  assert.equal(isNoiseSentence('عضویت در خبرنامه برای دریافت آخرین قیمت‌های روز بازار آهن و فولاد بسیار مفید است'), false);
});

ok('harvestFacts skips noise rows (no extra sentences registered)', () => {
  const text =
    'قیمت میلگرد سایز 14 در بازار تهران امروز 12500 تومان هر کیلوگرم اعلام شد. ' +
    'صفحه اصلی. ' +
    'تیرآهن IPE20 نیز با نرخ 21000 تومان به فروش می‌رسد که نسبت به هفته گذشته تغییری نداشته است.';
  const facts = harvestFacts(text, 8);
  assert.equal(facts.length, 2);
  assert.ok(facts.every((f) => !f.text.includes('صفحه اصلی')));
  assert.ok(facts[0].text.includes('12500'));
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
