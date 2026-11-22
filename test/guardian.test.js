/** نگهبان اسکنر + استخراج تصویر — node test/guardian.test.js
 *  Verifies: guardian budget caps, pickImages filtering, claimsFromAnswers
 *  and quotesFromAnswers (image extraction → Quote rows).
 */
import assert from 'node:assert/strict';
import { createGuardian, dayKey } from '../src/guardian.js';
import { pickImages, claimsFromAnswers, quotesFromAnswers, EXTRACTION_FIELDS } from '../src/image_extract.js';

let failed = 0;
function ok(name, fn) { try { fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, e.message); } }
async function okAsync(name, fn) { try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, e.message); } }

function makeEnv() {
  const meta = new Map();
  return {
    DB: {
      prepare(sql) {
        const s = sql.replace(/\s+/g, ' ');
        return {
          bind(...a) { return { run: async () => { meta.set(a[0], a[1]); return { changes: 1 }; } }; },
          async first() {
            const v = meta.get(s.includes('guardian:') ? undefined : undefined);
            return null;
          },
        };
      },
    },
    _meta: meta,
  };
}

await okAsync('guardian caps fetch/AI budgets', async () => {
  const env = makeEnv();
  const g = await createGuardian(env, { now: Date.now() });
  assert.ok(g.fetchLeft() > 0);
  assert.ok(g.aiLeft() > 0);
  // exhaust fetch budget
  let count = 0;
  while (g.allowFetch(1) && count < 10000) { g.spendFetch(1); count++; }
  assert.equal(g.fetchLeft(), 0, 'fetch exhausted');
  assert.ok(!g.allowFetch(1), 'fetch denied after cap');
  assert.ok(g.aiLeft() > 0, 'AI budget untouched');
  // flush persists
  const flushed = await g.flush(env.DB);
  assert.equal(flushed, true);
});

ok('pickImages selects real images and skips logos/data-URIs', () => {
  const html = `
    <img src="logo.png">
    <img src="https://cdn.example.com/pic.jpg">
    <img src="data:image/png;base64,AAA">
    <img src="https://cdn.example.com/banner-ad.png">
    <img src="https://cdn.example.com/sheet.jpeg">
  `;
  const imgs = pickImages(html, 'https://example.com/page');
  assert.deepEqual(imgs, ['https://cdn.example.com/pic.jpg', 'https://cdn.example.com/sheet.jpeg']);
});

ok('claimsFromAnswers builds price claim with field data only', () => {
  const answers = {
    product: { value: 'میلگرد ۱۴', confidence: 0.9 },
    amount: { value: 1200000, confidence: 0.9 },
    price_basis: { value: 'هر متر', confidence: 0.9 },
    dimensions: { value: '14', confidence: 0.8 },
    piece_weight_kg: { value: 1.2, confidence: 0.8 },
  };
  const rows = claimsFromAnswers(answers, { url: 'https://e.com', domain: 'e.com', topic: 'میلگرد', scanId: 's1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attribute, 'price');
  assert.ok(/قیمت میلگرد ۱۴: 1200000 تومان/.test(rows[0].claim));
  assert.ok(/مبنای واحد: هر متر/.test(rows[0].claim));
});

ok('quotesFromAnswers produces Quote rows from image answers', () => {
  const answers = {
    product: { value: 'میلگرد ۱۴', confidence: 0.9 },
    amount: { value: 1200000, confidence: 0.9 },
    price_basis: { value: 'هر متر', confidence: 0.9 },
  };
  const qs = quotesFromAnswers(answers, { url: 'https://e.com', domain: 'e.com', topic: 'میلگرد', endpoint: 'qwen-scanner', seller: 'فروشگاه', now: Date.now() });
  assert.equal(qs.length, 1);
  assert.equal(qs[0].amount, 1200000);
  assert.equal(qs[0].currency, 'تومان');
  assert.equal(qs[0].unit, 'm');
});

ok('quotesFromAnswers drops low-confidence or no-price answers', () => {
  const low = { product: { value: 'میلگرد', confidence: 0.3 }, amount: { value: 100, confidence: 0.3 } };
  assert.equal(quotesFromAnswers(low, { url: 'https://e.com', domain: 'e.com', topic: 't', endpoint: 'qwen-scanner', seller: 's', now: Date.now() }).length, 0);
  const noPrice = { product: { value: 'میلگرد', confidence: 0.9 }, amount: { value: null, confidence: 0.9 } };
  assert.equal(quotesFromAnswers(noPrice, { url: 'https://e.com', domain: 'e.com', topic: 't', endpoint: 'qwen-scanner', seller: 's', now: Date.now() }).length, 0);
});

ok('EXTRACTION_FIELDS covers price fields', () => {
  for (const k of ['product', 'amount', 'price_basis', 'dimensions', 'grade', 'tax', 'city', 'phone', 'published_on', 'piece_weight_kg']) {
    assert.ok(EXTRACTION_FIELDS[k], 'missing field ' + k);
  }
});

console.log(failed ? `\n${failed} FAILED` : '\nAll guardian tests passed');
if (failed) process.exitCode = 1;
