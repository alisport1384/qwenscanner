/** Table reader + table-quote bridge — node test/table_reader.test.js
 *  Uses the real ahanmelal.com rebar fixture (saved HTML) to lock the
 *  div-grid price-table behaviour: priced rows only, VAT honesty, Rial→Toman.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTables } from '../src/table_reader.js';
import { extractTableQuotes } from '../src/ironpin.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'fixtures', 'ahanmelal_rebar.html'), 'utf8');
const ctx = {
  endpoint: 'qwen-scanner', seller: 'ahanmelal.com', sellerCity: 'نامشخص',
  sourceUrl: 'https://ahanmelal.com/rebar/ribbed-rebar-price', fetchedAt: Date.now(),
  category: 'میلگرد', defaultCurrency: 'نامشخص',
};

let failed = 0;
function ok(name, fn) { try { fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, e.message); } }

ok('readTables yields only priced rows from the div-grid', () => {
  const rows = readTables(html, { ...ctx, maxRows: 10000 });
  assert.ok(rows.length >= 330, 'expected >=330 priced rows, got ' + rows.length);
  for (const r of rows) {
    assert.equal(typeof r.amount, 'number');
    assert.ok(r.amount > 0);
    assert.equal(r.unit, 'kg');
    assert.ok(!String(r.details?.['شاهد ردیف'] || '').includes('تماس'));
  }
});

ok('readTables marks rows بدون ارزش افزوده per the page declaration', () => {
  const rows = readTables(html, { ...ctx, maxRows: 5 });
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.tax, 'بدون ارزش افزوده');
});

ok('readTables parses the Jalali row date', () => {
  const rows = readTables(html, { ...ctx, maxRows: 1 });
  assert.match(rows[0].sourceDateRaw, /^2026-11-21T/);
});

ok('extractTableQuotes repairs, prices and dedups rows', () => {
  const qs = extractTableQuotes(html, ctx);
  assert.ok(qs.length >= 300, 'expected >=300 quotes, got ' + qs.length);
  for (const q of qs) {
    assert.equal(q.currency, 'تومان');
    assert.ok(q.amount >= 1000 && q.amount <= 2e6, 'amount in fence: ' + q.amount);
    assert.notEqual(q.sellerCity, '');
  }
  // Every row carries a short product-anchored title — no sentences.
  for (const q of qs) assert.ok(q.title.length <= 160 && !q.title.includes('تماس با ما'), q.title);
});

console.log(failed ? `\n${failed} FAILED` : '\nAll table_reader tests passed');
if (failed) process.exitCode = 1;
