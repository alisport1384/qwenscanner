/** Finder classify + retention unit tests — node test/finder.test.js */
import assert from 'node:assert/strict';
import {
  classifyLink,
  canonicalUrlKey,
  previewUrl,
  finderQueries,
  FinderPart,
} from '../src/finder.js';
import { runPriceRetention, deleteOldPrices, estimateDbBytes } from '../src/retention.js';
import { collectSeedUrls } from '../src/seed.js';
import { FINDER_BANKS, FINDER_PER_ROUND, PRODUCTS, ENDPOINTS } from '../src/ironpin_data.js';
import { inferAttribute } from '../src/knowledge.js';
import { classifyProduct, PRODUCT_FIELDS, CATALOG_NOTES, EXTRA_PRICE_TOPICS } from '../src/product_catalog.js';
import { TAXONOMY, PRODUCT_RE } from '../src/ironpin_data.js';

let failed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('✓', name);
  } catch (e) {
    failed++;
    console.error('✗', name, '\n  ', e.message);
    process.exitCode = 1;
  }
}

// --- classifyLink ---
ok('rejects non-http / userinfo / port / IP', () => {
  assert.equal(classifyLink('ftp://example.com/x'), null);
  assert.equal(classifyLink('https://user:pass@example.com/'), null);
  assert.equal(classifyLink('https://example.com:8080/'), null);
  assert.equal(classifyLink('https://192.168.1.1/x'), null);
  assert.equal(classifyLink('https://web.telegram.org/k/'), null);
});

ok('rejects search engines and file links', () => {
  assert.equal(classifyLink('https://www.bing.com/search?q=x'), null);
  assert.equal(classifyLink('https://google.com/x'), null);
  assert.equal(classifyLink('https://example.com/a.pdf'), null);
  assert.equal(classifyLink('https://gerdoo.me/search/?query=x'), null);
});

ok('telegram channel → social part, readable, canonical key', () => {
  const l = classifyLink('https://t.me/ahanmelal');
  assert.ok(l);
  assert.equal(l.kind, 'telegram');
  assert.equal(l.part, FinderPart.social);
  assert.equal(l.readable, true);
  assert.equal(l.key, 'telegram:ahanmelal');
  assert.equal(l.url, 'https://t.me/ahanmelal');
});

ok('telegram reserved path and bot handles rejected', () => {
  assert.equal(classifyLink('https://t.me/joinchat/Abc'), null);
  assert.equal(classifyLink('https://t.me/share?url=x'), null);
  assert.equal(classifyLink('https://t.me/somebot'), null);
  assert.equal(classifyLink('https://t.me/my_admin_page'), null);
});

ok('bale/eitaa/rubika → domestic part', () => {
  const b = classifyLink('https://ble.ir/ahanonlineofficial');
  assert.ok(b);
  assert.equal(b.part, FinderPart.domestic);
  assert.equal(b.readable, true);
  const e = classifyLink('https://eitaa.com/steel_market');
  assert.ok(e);
  assert.equal(e.part, FinderPart.domestic);
  const r = classifyLink('https://rubika.ir/ahan_news');
  assert.ok(r);
  assert.equal(r.part, FinderPart.domestic);
});

ok('instagram listed but not readable', () => {
  const l = classifyLink('https://instagram.com/ahan.melal/');
  assert.ok(l);
  assert.equal(l.kind, 'instagram');
  assert.equal(l.readable, false);
  assert.equal(l.part, FinderPart.social);
});

ok('site classify: strip www, sort query, drop tracking, normalize index.html', () => {
  const a = classifyLink('https://www.ahanmelal.com/rebar/?utm_source=x&b=2&a=1');
  const b = classifyLink('https://ahanmelal.com/rebar?a=1&b=2');
  assert.ok(a && b);
  assert.equal(a.part, FinderPart.sites);
  assert.equal(a.readable, true);
  assert.equal(a.key, b.key);
  const idx = classifyLink('https://ahanmelal.com/shop/index.html');
  assert.ok(idx);
  assert.ok(!idx.url.includes('index.html'));
});

ok('canonicalUrlKey stable for raw and classified', () => {
  assert.equal(
    canonicalUrlKey('https://www.ahanmelal.com/rebar/'),
    canonicalUrlKey('https://ahanmelal.com/rebar')
  );
});

ok('previewUrl: telegram/bale → /s/', () => {
  assert.equal(previewUrl('telegram', 'https://t.me/ahanmelal'), 'https://t.me/s/ahanmelal');
  assert.equal(previewUrl('bale', 'https://ble.ir/ahanonlineofficial'), 'https://ble.ir/s/ahanonlineofficial');
  assert.equal(previewUrl('site', 'https://x.com/a'), 'https://x.com/a');
});

// --- FinderPlan ---
ok('finderQueries: 5 per round, wraps bank', () => {
  assert.equal(FINDER_PER_ROUND, 5);
  for (const part of FinderPart.all) {
    const q0 = finderQueries(part, 0);
    assert.equal(q0.length, 5);
    const bank = FINDER_BANKS[part];
    assert.ok(bank.length >= 5);
    const qNext = finderQueries(part, 1);
    assert.notDeepEqual(q0, qNext);
    // wrap
    const rounds = Math.ceil(bank.length / 5);
    const qWrap = finderQueries(part, rounds);
    assert.equal(qWrap.length, 5);
  }
});

ok('three banks present with IronPin titles', () => {
  assert.equal(FINDER_BANKS.length, 3);
  assert.equal(FinderPart.titles.length, 3);
  assert.ok(FinderPart.titles[0].includes('وب‌سایت'));
});

// --- seed collection ---
ok('collectSeedUrls: endpoints + registry + product pages, http only', () => {
  const seeds = collectSeedUrls();
  assert.ok(seeds.length >= ENDPOINTS.length);
  for (const s of seeds.slice(0, 20)) {
    assert.match(s.url, /^https?:\/\//);
  }
  const urls = new Set(seeds.map((s) => s.url));
  assert.equal(urls.size, seeds.length, 'unique urls');
});

ok('IronPin products for price topics', () => {
  assert.ok(PRODUCTS.includes('میلگرد'));
  assert.ok(PRODUCTS.length >= 6);
});

// --- knowledge price attribute ---
ok('inferAttribute tags steel price text as price', () => {
  assert.equal(inferAttribute('قیمت میلگرد امروز ۲۸۵۰۰ تومان'), 'price');
  assert.equal(inferAttribute('میلگرد 14 ذوب آهن 28500 تومان هر کیلو'), 'price');
  assert.equal(inferAttribute('مشخصات فنی ورق سیاه'), 'specs');
});

// --- retention ---
function makeRetentionDb({ bytes = 1000, priceRows = [] } = {}) {
  const meta = new Map();
  const tables = { knowledge: priceRows.slice(), meta };
  return {
    _tables: tables,
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      const state = { params: [] };
      const stmt = {
        bind(...a) {
          state.params = a;
          return stmt;
        },
        async first() {
          if (/SELECT value FROM meta WHERE key/.test(s)) {
            const v = meta.get(state.params[0]);
            return v === undefined ? null : { value: v };
          }
          if (/SELECT COALESCE/.test(s) && /AS bytes/.test(s)) {
            return { bytes };
          }
          return null;
        },
        async run() {
          if (/INSERT INTO meta/.test(s)) {
            meta.set(state.params[0], state.params[1]);
            return { success: true, meta: { changes: 1 } };
          }
          if (/DELETE FROM knowledge/.test(s)) {
            const cutoff = state.params[0];
            let changes = 0;
            tables.knowledge = tables.knowledge.filter((k) => {
              // STRICT: only structured price markers — never claim text
              const isPrice =
                k.attribute === 'price' ||
                k.layer === 'price' ||
                (k.tags || '').includes('price');
              const old = k.last_verified_at < cutoff;
              if (isPrice && old) {
                changes++;
                return false;
              }
              return true;
            });
            return { success: true, meta: { changes } };
          }
          return { success: true, meta: {} };
        },
        async all() {
          return { results: [] };
        },
      };
      return stmt;
    },
    async batch(stmts) {
      const out = [];
      for (const st of stmts) out.push(await st.run());
      return out;
    },
  };
}

const DAY = 24 * 3600_000;

await (async () => {
  const now = Date.now();
  const rows = [
    { id: '1', scan_id: 's', attribute: 'price', layer: 'price', tags: '["price"]', claim: 'قیمت میلگرد 28000', last_verified_at: now - 40 * DAY },
    { id: '2', scan_id: 's', attribute: 'price', layer: 'price', tags: '["price"]', claim: 'قیمت ورق 45000', last_verified_at: now - 2 * DAY },
    { id: '3', scan_id: 's', attribute: 'specs', layer: 'specs', tags: '[]', claim: 'عوامل مؤثر بر قیمت ورق سیاه', last_verified_at: now - 40 * DAY },
    { id: '4', scan_id: 's', attribute: 'basics', layer: 'basics', tags: '[]', claim: 'متن عادی', last_verified_at: now - 40 * DAY },
    { id: '5', scan_id: 's', attribute: null, layer: null, tags: '["price","market"]', claim: 'نرخ روز', last_verified_at: now - 40 * DAY },
  ];

  // auto path disabled — never runs without explicit command
  const rAuto = await runPriceRetention({ DB: makeRetentionDb({ priceRows: rows }) }, { now });
  assert.equal(rAuto.mode, 'disabled_auto');
  assert.equal(rAuto.deleted, 0);

  // manual delete: only structured price rows; technical knowledge untouched
  const db = makeRetentionDb({ priceRows: rows });
  const rMan = await deleteOldPrices({ DB: db }, { now, olderThanDays: 30 });
  assert.equal(rMan.mode, 'manual');
  assert.equal(rMan.older_than_days, 30);
  assert.equal(rMan.deleted, 2, 'rows 1 and 5 deleted');
  const ids = db._tables.knowledge.map((k) => k.id);
  assert.ok(!ids.includes('1'), 'old price deleted');
  assert.ok(ids.includes('2'), 'recent price kept');
  assert.ok(ids.includes('3'), 'technical claim mentioning قیمت KEPT');
  assert.ok(ids.includes('4'), 'non-price basics kept');
  assert.ok(!ids.includes('5'), 'tagged old price deleted');

  // large horizon → nothing deleted
  const db2 = makeRetentionDb({ priceRows: rows });
  const r3 = await deleteOldPrices({ DB: db2 }, { now, olderThanDays: 3650 });
  assert.equal(r3.deleted, 0, 'nothing older than 3650d');

  // estimate
  const b = await estimateDbBytes({ DB: makeRetentionDb({ bytes: 42 }) });
  assert.equal(b, 42);

  console.log(failed ? `\n${failed} FAILED` : '\nAll finder/retention tests passed');
  if (failed) process.exitCode = 1;
})();

// --- product catalog v2 ---
ok('TAXONOMY has required groups incl. سایر/other', () => {
  const groups = TAXONOMY.map((g) => g.group);
  for (const g of ['لوله', 'بولت و انکر', 'تسمه', 'چهارپهلو', 'مفتولی', 'مواد اولیه', 'قراضه و دست دوم', 'سایر']) {
    assert.ok(groups.includes(g), 'missing group ' + g);
  }
  const other = TAXONOMY.find((g) => g.id === 'other');
  assert.ok(other, 'other id missing');
  assert.ok(other.types.includes('DRI') && other.types.includes('گندله') && other.types.includes('بریکت'));
});

ok('PRODUCT_RE matches all catalog families', () => {
  const samples = [
    'لوله مانیسمان', 'لوله ERW', 'رده SCH 40', 'انکر بولت HIT',
    'بولت F1554', 'تسمه CK45', 'چهارپهلو شش پر', 'مفتول کلاف',
    'مش جوشی', 'توری حصاری Z180', 'گابیون', 'رابیتس 13 ستون',
    'شمش 3SP', 'بیلت', 'قراضه سورت', 'قیمت DRI', 'گندله', 'بریکت', 'فروآلیاژ',
  ];
  for (const s of samples) assert.ok(PRODUCT_RE.test(s), 'PRODUCT_RE miss: ' + s);
});

ok('classifyProduct maps families', () => {
  assert.equal(classifyProduct('قیمت لوله مانیسمان امروز'), 'لوله');
  assert.equal(classifyProduct('انکر بولت شیمیایی'), 'بولت');
  assert.equal(classifyProduct('تسمه فابریک CK45'), 'تسمه');
  assert.equal(classifyProduct('چهارپهلو ترانس'), 'چهارپهلو');
  assert.equal(classifyProduct('مفتول گالوانیزه'), 'مفتول');
  assert.equal(classifyProduct('مش جوشی 10x10'), 'مش جوشی');
  assert.equal(classifyProduct('توری حصاری'), 'توری');
  assert.equal(classifyProduct('رابیتس 11 ستون'), 'رابیتس');
  assert.equal(classifyProduct('شمش بیلت 3SP'), 'شمش');
  assert.equal(classifyProduct('قراضه درجه 1'), 'قراضه');
  assert.equal(classifyProduct('گندله آهن و DRI'), 'other');
  assert.equal(classifyProduct('قرص آهن'), ''); // non-metal not a family here
});

ok('PRODUCT_FIELDS cover key families + notes', () => {
  for (const f of ['لوله', 'بولت', 'تسمه', 'چهارپهلو', 'مفتول', 'مش جوشی', 'توری', 'رابیتس', 'شمش', 'قراضه', 'other']) {
    assert.ok(PRODUCT_FIELDS[f], 'fields missing ' + f);
  }
  assert.ok(CATALOG_NOTES['لوله'].includes('Sch'));
  assert.ok(CATALOG_NOTES['لوله'].includes('12m'));
  assert.ok(CATALOG_NOTES['بولت'].includes('F1554'));
  assert.ok(CATALOG_NOTES['other'].includes('DRI'));
  assert.ok(EXTRA_PRICE_TOPICS.length >= 10);
});

ok('inferAttribute tags new product prices', () => {
  assert.equal(inferAttribute('قیمت تسمه فولادی 45000 تومان'), 'price');
  assert.equal(inferAttribute('قیمت انکر بولت HIT 12 میلیمتر'), 'price');
  assert.equal(inferAttribute('قیمت گندله آهن 12000 تومان'), 'price');
});
