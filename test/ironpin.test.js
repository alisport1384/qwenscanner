/** IronPin Quote export tests — node test/ironpin.test.js
 *  Verifies: extractQuotesFromPage shape, Rial→Toman, repairQuote gates,
 *  buildIronpinExport full/incremental with cursor, cityFromPhone.
 */
import assert from 'node:assert/strict';
import {
  extractQuotesFromPage, repairQuote, computeConversions, cityFromPhone,
  buildIronpinExport, storeQuotes,
} from '../src/ironpin.js';

const KEYS = ['id', 'endpoint', 'seller', 'sellerCity', 'title', 'category', 'material', 'brand', 'loading', 'loadingCity', 'unit', 'tax', 'currency', 'terms', 'sourceUrl', 'sourceDateRaw', 'status', 'amount', 'pieceKg', 'lengthM', 'areaM2', 'fetchedAt', 'size', 'thickness', 'dimensions', 'grade', 'details'];

let failed = 0;
function ok(name, fn) { try { fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, e.message); } }

ok('extractQuotesFromPage returns Quote-compatible keys', () => {
  const qs = extractQuotesFromPage('قیمت میلگرد ۱۴: ۱,۲۰۰,۰۰۰ تومان هر متر', { endpoint: 'qwen-scanner', seller: 'فروشگاه', sourceUrl: 'https://example.com/p', fetchedAt: Date.now(), sellerCity: 'تهران', defaultCurrency: 'نامشخص' });
  assert.equal(qs.length, 1);
  assert.deepEqual(Object.keys(qs[0]).sort(), [...KEYS].sort());
  assert.equal(qs[0].amount, 1200000);
  assert.equal(qs[0].currency, 'تومان');
  assert.equal(qs[0].unit, 'm');
});

ok('Rial → Toman conversion', () => {
  const qs = extractQuotesFromPage('قیمت ورق آهن 3 میلی 450000 ریال در متر', { endpoint: 'qwen-scanner', seller: 'شرکت', sourceUrl: 'https://example.com/p2', fetchedAt: Date.now(), sellerCity: 'شیراز', defaultCurrency: 'نامشخص' });
  assert.equal(qs.length, 1);
  assert.equal(qs[0].amount, 45000);
  assert.equal(qs[0].currency, 'تومان');
});

ok('repairQuote drops junk and non-steel claims', () => {
  const junk = { id: 'j', endpoint: 'qwen-scanner', seller: 'x', title: 'قیمت میلگرد ۱۴: ۱,۲۰۰,۰۰۰ تومان لینک کوتاه کد خبر ۱', category: 'میلگرد', material: 'فولاد', unit: 'm', currency: 'تومان', amount: 1200000, sourceUrl: 'https://e.com', publishedAt: null, fetchedAt: Date.now(), unitPrice: 1200000, pieceKg: null, lengthM: null, areaM2: null, details: {} };
  assert.equal(repairQuote(junk), null, 'junk dropped');
  const nonSteel = { id: 'n', endpoint: 'qwen-scanner', seller: 'x', title: 'قیمت ماشین ۵ میلیون تومان', category: 'ماشین', material: '—', unit: 'piece', currency: 'تومان', amount: 5000000, sourceUrl: 'https://e.com', publishedAt: null, fetchedAt: Date.now(), unitPrice: 5000000, pieceKg: null, lengthM: null, areaM2: null, details: {} };
  assert.equal(repairQuote(nonSteel), null, 'non-steel dropped');
});

ok('repairQuote drops absurd amounts', () => {
  const bad = { id: 'b', endpoint: 'qwen-scanner', seller: 'x', title: 'قیمت میلگرد ۱۶: ۵۰ تومان', category: 'میلگرد', material: 'فولاد', unit: 'm', currency: 'تومان', amount: 50, sourceUrl: 'https://e.com', publishedAt: null, fetchedAt: Date.now(), unitPrice: 50, pieceKg: null, lengthM: null, areaM2: null, details: {} };
  assert.equal(repairQuote(bad), null);
});

ok('computeConversions: rebar formula + explicit piece weight', () => {
  const c1 = computeConversions('میلگرد ۱۲', { unit: 'm', size: '12', thickness: '', dims: '' });
  assert.ok(Math.abs(c1.kgm - 0.888) < 0.01, 'rebar kg/m');
  const c2 = computeConversions('هر شاخه ۱۲ کیلوگرم', { unit: 'piece', size: '', thickness: '', dims: '' });
  assert.equal(c2.pieceKg, 12);
});

ok('cityFromPhone maps prefixes', () => {
  assert.deepEqual(cityFromPhone('تماس با 09121234567 برای سفارش'), { city: 'تهران', prefix: '0912', phone: '09121234567' });
  assert.equal(cityFromPhone('جهتی نیست'), null);
});

ok('buildIronpinExport full snapshot shape', async () => {
  const quote = { id: 'q1', endpoint: 'qwen-scanner', seller: 'x', title: 'قیمت میلگرد ۱۴: ۱,۲۰۰,۰۰۰ تومان', category: 'میلگرد', material: 'فولاد', unit: 'm', currency: 'تومان', amount: 1200000, sourceUrl: 'https://e.com', fetchedAt: new Date().toISOString(), details: {} };
  const db = {
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ');
      return {
        bind() { return this; },
        async all() {
          if (/FROM ironpin_quotes ORDER BY rowid/.test(s)) {
            return { results: [{ quote_json: JSON.stringify(quote), source_last_verified_at: 1234567890 }] };
          }
          return { results: [] };
        },
      };
    },
  };
  const out = await buildIronpinExport(db);
  assert.equal(out.format, 'ironpin-quotes-v1');
  assert.equal(out.count, 1);
  assert.equal(out.cursor, 1234567890);
  assert.equal(out.complete, true);
  assert.equal(out.quotes[0].amount, 1200000);
});

ok('storeQuotes writes rows and returns count', async () => {
  const rows = [];
  const db = {
    prepare() {
      return {
        bind(...a) { rows.push(a); return { run: async () => { return { changes: 1 }; } }; },
      };
    },
    async batch() {},
  };
  const q = { id: 'q1', title: 'میلگرد', amount: 100, currency: 'تومان', unit: 'm' };
  const n = await storeQuotes(db, 's1', [q, q], Date.now());
  assert.equal(n, 2);
  assert.equal(rows.length, 2);
});

console.log(failed ? `\n${failed} FAILED` : '\nAll ironpin tests passed');
if (failed) process.exitCode = 1;
