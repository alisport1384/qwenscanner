/** City resolution — written witnesses only — node test/city.test.js */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCity, resolvePageCity, explicitCityIn } from '../src/city.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(here, 'fixtures', 'ahanmelal_rebar.html'), 'utf8');

let failed = 0;
function ok(name, fn) { try { fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, e.message); } }

ok('explicitCityIn picks a place-word city, never a bare brand name', () => {
  assert.equal(explicitCityIn('انبار تحویل مشهد — میلگرد ۱۴'), 'مشهد');
  assert.equal(explicitCityIn('قیمت میلگرد میانه ۱۴'), '');
  assert.equal(explicitCityIn('دفتر فروش اصفهان'), 'اصفهان');
});

ok('resolveCity keeps row-level order (delivery text wins, else نامشخص)', () => {
  assert.equal(resolveCity('قیمت میلگرد نیشابور ۱۴ | A3').city, 'نامشخص');
  assert.equal(resolveCity('تحویل: انبار مشهد').city, 'مشهد');
});

ok('resolvePageCity prefers the landline area code over prose', () => {
  // ahanmelal fixture: landline 031 (اصفهان) beats the bare «ابرکوه/میانه» prose
  const p = resolvePageCity(fixtureHtml);
  assert.equal(p.city, 'اصفهان');
  assert.ok(/تلفن/.test(p.basis));
  assert.ok(p.conflict.includes('ابرکوه'));
});

ok('resolvePageCity uses address text when no landline exists', () => {
  const p = resolvePageCity('دفتر فروش و ارسال: انبار تهران\nمیلگرد 16 — ۹۸,۰۰۰ تومان');
  assert.equal(p.city, 'تهران');
});

ok('resolvePageCity stays نامشخص with no witness (never guesses)', () => {
  assert.equal(resolvePageCity('میلگرد ۱۶ — ۹۸,۰۰۰ تومان\nفولاد مبارکه').city, 'نامشخص');
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log('All city tests passed');
