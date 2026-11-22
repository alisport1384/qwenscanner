/** نگهبان اسکنر + استخراج تصویر — node test/guardian.test.js */
import assert from 'node:assert/strict';
import { createGuardian, dayKey } from '../src/guardian.js';
import { pickImages, claimsFromAnswers, EXTRACTION_FIELDS } from '../src/image_extract.js';
import { inferAttribute, filterByTarget, toHushyarExport } from '../src/knowledge.js';

let passed = 0;
const tests = [];
function ok(name, fn) {
  tests.push([name, fn]);
}

function fakeEnv(vars = {}) {
  const store = {};
  return {
    store,
    TICK_BUDGET_MS: vars.tick ?? '1000',
    DAILY_FETCH_LIMIT: vars.fetch ?? '5',
    IMAGE_EXTRACT_LIMIT: vars.ai ?? '2',
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('FROM meta') && store[args[0]] != null) return { value: store[args[0]] };
                return null;
              },
              async run() {
                if (sql.includes('INSERT INTO meta')) store[args[0]] = args[1];
                return {};
              },
            };
          },
        };
      },
    },
  };
}

ok('guardian enforces daily fetch budget', async () => {
  const env = fakeEnv({ fetch: '5' });
  const g = await createGuardian(env, { now: 1_000_000 });
  assert.equal(g.allowFetch(5), true);
  g.spendFetch(5);
  assert.equal(g.allowFetch(1), false);
  assert.equal(g.fetchLeft(), 0);
});

ok('guardian enforces AI budget', async () => {
  const env = fakeEnv({ ai: '2' });
  const g = await createGuardian(env, { now: 1_000_000 });
  assert.equal(g.allowAi(2), true);
  g.spendAi(2);
  assert.equal(g.allowAi(1), false);
});

ok('guardian wall-clock deadline is injectable and absolute', async () => {
  const env = fakeEnv({ tick: '1000' });
  const g = await createGuardian(env, { now: 5_000 });
  assert.equal(g.expired(5_999), false);
  assert.equal(g.expired(6_000), true);
  assert.equal(g.expired(7_000), true);
});

ok('guardian flush persists and reloads same-day counters', async () => {
  const env = fakeEnv({ fetch: '5' });
  const now = 1_700_000_000_000;
  const g = await createGuardian(env, { now });
  g.spendFetch(3);
  await g.flush();
  const g2 = await createGuardian(env, { now });
  assert.equal(g2.fetchLeft(), 2);
  // different day → fresh counters
  const g3 = await createGuardian(env, { now: now + 86_400_000 });
  assert.equal(g3.fetchLeft(), 5);
});

ok('dayKey is UTC yyyy-mm-dd', () => {
  assert.match(dayKey(Date.UTC(2026, 10, 21, 12)), /^2026-11-21$/);
});

// --- image extraction (pure parts) ---

ok('pickImages skips data/logos/icons/gif and dedups, bounded', () => {
  const html = `
    <img src="/img/photo1.jpg">
    <img src="https://cdn.example.com/p/photo1.jpg?x=1">
    <img src="/static/logo.png">
    <img src="/favicon.ico">
    <img src="data:image/png;base64,AAAA">
    <img src="/assets/chart.gif">
    <img src="https://cdn.example.com/p/price.webp">`;
  const out = pickImages(html, 'https://example.com/page', 3);
  assert.deepEqual(out, [
    'https://example.com/img/photo1.jpg',
    'https://cdn.example.com/p/photo1.jpg?x=1',
    'https://cdn.example.com/p/price.webp',
  ]);
  // default bound: at most 2 images per page (guardian minimal usage)
  assert.equal(pickImages(html, 'https://example.com/page').length, 2);
});

ok('confident price answer becomes one compact price claim', () => {
  const rows = claimsFromAnswers(
    {
      product: { value: 'میلگرد 14', confidence: 0.95 },
      amount: { value: 12500, confidence: 0.99 },
      price_basis: { value: 'هر کیلو', confidence: 0.9 },
      city: { value: 'تهران', confidence: 0.85 },
      phone: { value: '09121234567', confidence: 0.9 },
      published_on: { value: '2026-11-21', confidence: 0.9 },
      grade: { value: null, confidence: 1 },
    },
    { url: 'https://x.com/a', domain: 'x.com', topic: 'قیمت میلگرد', scanId: 's1' }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attribute, 'price');
  assert.ok(rows[0].claim.includes('قیمت میلگرد 14: 12500 تومان'));
  assert.ok(rows[0].claim.includes('مبنای واحد: هر کیلو'));
  assert.ok(rows[0].claim.includes('تماس: 09121234567'));
  // no prose — claim is field data joined by '، ' only
  assert.ok(!/کنید|لطفا|بیشتر بخوانید/.test(rows[0].claim));
});

ok('low-confidence amount never produces a price row', () => {
  const rows = claimsFromAnswers(
    {
      amount: { value: 999, confidence: 0.2 },
      product: { value: 'ورق فولادی', confidence: 0.9 },
      city: { value: 'اصفهان', confidence: 0.8 },
    },
    { url: 'https://x.com/a', domain: 'x.com', topic: 't', scanId: 's' }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attribute, 'specs'); // product+city contact row, no price
});

ok('answers without price and without product+contact are dropped', () => {
  assert.equal(claimsFromAnswers({}, { url: 'u', domain: 'd', topic: 't', scanId: 's' }).length, 0);
  assert.equal(
    claimsFromAnswers(
      { product: { value: 'میلگرد', confidence: 0.9 } },
      { url: 'u', domain: 'd', topic: 't', scanId: 's' }
    ).length,
    0
  );
  assert.equal(claimsFromAnswers(null, { url: 'u', domain: 'd', topic: 't', scanId: 's' }).length, 0);
});

ok('extraction field map covers spec items (price/date/unit/address/phone/tax/features)', () => {
  const keys = Object.keys(EXTRACTION_FIELDS);
  for (const k of ['product', 'amount', 'price_basis', 'dimensions', 'grade', 'tax', 'city', 'phone', 'published_on', 'piece_weight_kg']) {
    assert.ok(keys.includes(k), 'missing field ' + k);
  }
  for (const spec of Object.values(EXTRACTION_FIELDS)) {
    assert.ok(['text', 'number', 'date', 'list', 'estimate'].includes(spec.type));
  }
});

// --- target separation + hushyar feed ---

ok('definition/calculation attributes are recognized for Qwen', () => {
  assert.equal(inferAttribute('تعریف میلگرد: میله فولادی توپر با مقطع دایره‌ای است'), 'definition');
  assert.equal(inferAttribute('محاسبه وزن: 14×14÷162=1.2 کیلوگرم بر متر'), 'calculation');
  assert.equal(inferAttribute('نرخ تبدیل واحد شاخه به کیلوگرم در جدول آمده است'), 'calculation');
  assert.equal(inferAttribute('قیمت میلگرد 14: 12000 تومان'), 'price');
});

ok('filterByTarget splits IronPin rows from the full Qwen corpus', () => {
  const items = [
    { attribute: 'price' },
    { attribute: 'specs' },
    { attribute: 'definition' },
    { attribute: 'calculation' },
    { attribute: 'reviews' },
    { attribute: 'updates' },
    { attribute: 'basics' },
  ];
  const ip = filterByTarget(items, 'ironpin');
  assert.deepEqual(ip.map((x) => x.attribute), ['price', 'specs', 'definition', 'calculation']);
  assert.equal(filterByTarget(items, 'qwen').length, items.length);
  assert.equal(filterByTarget(items, '').length, items.length);
});

ok('hushyar export has recognizable format, link map and section counts', () => {
  const items = [
    { id: '1', attribute: 'definition', claim: 'الف', tags: '[]' },
    { id: '2', attribute: 'price', claim: 'ب', tags: '[]' },
    { id: '3', attribute: 'price', claim: 'ج', tags: '[]' },
  ];
  const doc = toHushyarExport(items, { topics: 1, sources: 1 });
  assert.equal(doc.format, 'hushyar-knowledge-v1');
  assert.equal(doc.links.qwen_model, 'https://qwen.alisport0.qzz.io/api/qwen');
  assert.equal(doc.links.ironpin_quotes, 'https://qwen.alisport0.qzz.io/api/ironpin');
  assert.ok(doc.links.self.startsWith('https://'), 'absolute self link');
  assert.equal(doc.counts.prices, 2);
  assert.equal(doc.counts.definitions, 1);
  assert.equal(doc.items.length, 3);
});

for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log('✓', name);
  } catch (e) {
    console.error('✗', name, '\n  ', e.message);
    process.exitCode = 1;
  }
}

console.log(`\n${passed}/${tests.length} tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
