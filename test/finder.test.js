import assert from 'node:assert/strict';
import { handleApi } from '../src/api.js';
import { addCustomProduct, runTick } from '../src/finder.js';

/** Minimal in-memory SQLite-like mock implementing Wrangler D1 prepare/bind/first/all/batch/run. */
function createMockD1() {
  const tables = {
    meta: new Map(), // key -> { key, value, updated_at }
    custom_products: [],
    sources: new Map(), // key -> row
    search_tasks: [],
  };
  let prodSeq = 1;
  let taskSeq = 1;

  function makeStmt(sql) {
    const s = sql.replace(/\s+/g, ' ').trim();
    const execWith = (args) => ({
      async first() {
        const res = await execWith(args).all();
        return res.results[0] || null;
      },
      async run() {
        await execWith(args).all();
        return { success: true };
      },
      async all() {
        if (s.startsWith('SELECT value FROM meta WHERE key =')) {
          const r = tables.meta.get(args[0]);
          return { results: r ? [{ value: r.value }] : [] };
        }
        if (s.startsWith('INSERT INTO meta')) {
          tables.meta.set(args[0], { key: args[0], value: args[1], updated_at: args[2] });
          return { results: [] };
        }
        if (s.startsWith('DELETE FROM meta WHERE key IN')) {
          for (const k of args) tables.meta.delete(k);
          return { results: [] };
        }
        if (s.startsWith('PRAGMA page_count')) {
          return { results: [{ page_count: 20 }] };
        }
        if (s.startsWith('PRAGMA page_size')) {
          return { results: [{ page_size: 4096 }] };
        }
        if (s.startsWith('DELETE FROM sources WHERE state =') || s.startsWith('DELETE FROM sources WHERE state IN')) {
          return { results: [] };
        }
        if (s.startsWith('DELETE FROM sources WHERE COALESCE')) {
          const cutoff = Number(args[0]);
          for (const [k, r] of tables.sources.entries()) {
            const ts = r.verified_at || r.discovered_at || r.updated_at || 0;
            if (ts < cutoff) tables.sources.delete(k);
          }
          return { results: [] };
        }
        if (s === 'DELETE FROM sources') {
          tables.sources.clear();
          return { results: [] };
        }
        if (s === 'DELETE FROM search_tasks') {
          tables.search_tasks = [];
          return { results: [] };
        }
        if (s === 'DELETE FROM custom_products') {
          tables.custom_products = [];
          return { results: [] };
        }
        if (s.startsWith('INSERT INTO custom_products')) {
          const existing = tables.custom_products.find((p) => p.normalized === args[1]);
          if (existing) {
            existing.name = args[0];
            existing.status = 'pending';
            existing.queries_done = 0;
            existing.queries_total = args[2];
          } else {
            tables.custom_products.push({
              id: prodSeq++,
              name: args[0],
              normalized: args[1],
              status: 'pending',
              queries_done: 0,
              queries_total: args[2],
              discovered_count: 0,
              last_scanned_at: 0,
              created_at: args[3],
            });
          }
          return { results: [] };
        }
        if (s.startsWith('SELECT * FROM custom_products WHERE normalized =')) {
          return { results: tables.custom_products.filter((p) => p.normalized === args[0]) };
        }
        if (s.startsWith('SELECT * FROM custom_products WHERE id =')) {
          return { results: tables.custom_products.filter((p) => p.id === Number(args[0])) };
        }
        if (s.startsWith('SELECT name FROM custom_products')) {
          return { results: tables.custom_products.map((p) => ({ name: p.name })) };
        }
        if (s.startsWith('SELECT * FROM custom_products ORDER BY')) {
          return { results: [...tables.custom_products].sort((a, b) => b.id - a.id) };
        }
        if (s.startsWith('UPDATE custom_products SET discovered_count =')) {
          for (const p of tables.custom_products) {
            p.discovered_count = [...tables.sources.values()].filter(
              (src) => src.state === 'ok' && src.matched_product.includes(p.name)
            ).length;
          }
          return { results: [] };
        }
        if (s.startsWith('UPDATE custom_products SET')) {
          for (const p of tables.custom_products) {
            const rel = tables.search_tasks.filter((t) => t.product_name === p.name);
            p.queries_total = rel.length;
            p.queries_done = rel.filter((t) => t.status === 'done').length;
            p.discovered_count = [...tables.sources.values()].filter(
              (src) => src.state === 'ok' && src.matched_product.includes(p.name)
            ).length;
            p.status = rel.some((t) => t.status === 'pending') ? 'scanning' : 'done';
            if (args[0] > 0) p.last_scanned_at = args[0];
          }
          return { results: [] };
        }
        if (s.startsWith('DELETE FROM custom_products WHERE id =')) {
          tables.custom_products = tables.custom_products.filter((p) => p.id !== Number(args[0]));
          return { results: [] };
        }
        if (s.startsWith('INSERT INTO search_tasks')) {
          const existing = tables.search_tasks.find((t) => t.kind === args[0] && t.query === args[2]);
          if (existing) {
            existing.status = 'pending';
            existing.tries = 0;
            existing.cycle_id = args[4];
            if (args[3]) existing.product_name = args[3];
          } else {
            tables.search_tasks.push({
              id: taskSeq++,
              kind: args[0],
              part: args[1],
              query: args[2],
              product_name: args[3],
              status: 'pending',
              tries: 0,
              cycle_id: args[4],
              created_at: args[5],
            });
          }
          return { results: [] };
        }
        if (s.startsWith("SELECT 1 AS ok FROM search_tasks WHERE status = 'pending'")) {
          const found = tables.search_tasks.some((t) => t.status === 'pending');
          return { results: found ? [{ ok: 1 }] : [] };
        }
        if (s.startsWith('SELECT COUNT(*) AS c FROM search_tasks')) {
          return { results: [{ c: tables.search_tasks.filter((t) => t.status === 'pending').length }] };
        }
        if (s.startsWith("SELECT * FROM search_tasks WHERE status = 'pending'")) {
          return {
            results: tables.search_tasks
              .filter((t) => t.status === 'pending')
              .slice(0, Number(args[0])),
          };
        }
        if (s.startsWith("UPDATE search_tasks SET status = 'done' WHERE id =")) {
          const t = tables.search_tasks.find((x) => x.id === args[0]);
          if (t) t.status = 'done';
          return { results: [] };
        }
        if (s.startsWith('UPDATE search_tasks SET tries =')) {
          const t = tables.search_tasks.find((x) => x.id === args[0]);
          if (t) {
            t.tries++;
            if (t.tries >= 3) t.status = 'done';
          }
          return { results: [] };
        }
        if (s.startsWith('DELETE FROM search_tasks WHERE product_name =')) {
          tables.search_tasks = tables.search_tasks.filter((t) => t.product_name !== args[0]);
          return { results: [] };
        }
        if (s.startsWith('SELECT part, COUNT(*) AS c FROM sources')) {
          const m = new Map();
          for (const r of tables.sources.values()) {
            if (r.state === 'new' || r.state === 'ok') m.set(r.part, (m.get(r.part) || 0) + 1);
          }
          return { results: [...m.entries()].map(([part, c]) => ({ part, c })) };
        }
        if (s.startsWith('SELECT host, COUNT(*) AS c FROM sources')) {
          const m = new Map();
          for (const r of tables.sources.values()) {
            if (r.kind === 'site' && (r.state === 'new' || r.state === 'ok')) {
              m.set(r.host, (m.get(r.host) || 0) + 1);
            }
          }
          return { results: [...m.entries()].map(([host, c]) => ({ host, c })) };
        }
        if (s === 'SELECT key FROM sources') {
          return { results: [...tables.sources.values()].map((r) => ({ key: r.key })) };
        }
        if (s === 'SELECT COUNT(*) AS c FROM sources') {
          return { results: [{ c: tables.sources.size }] };
        }
        if (s.startsWith('SELECT COUNT(*) AS c FROM sources WHERE COALESCE')) {
          const cutoff = Number(args[0]);
          let c = 0;
          for (const r of tables.sources.values()) {
            const ts = r.verified_at || r.discovered_at || r.updated_at || 0;
            if (ts < cutoff) c++;
          }
          return { results: [{ c }] };
        }
        if (s.startsWith('SELECT state, part, readable, COUNT(*) AS c')) {
          const m = new Map();
          for (const r of tables.sources.values()) {
            const k = `${r.state}|${r.part}|${r.readable ? 1 : 0}`;
            const cur = m.get(k) || { c: 0, custom_c: 0 };
            cur.c++;
            if (r.matched_product) cur.custom_c++;
            m.set(k, cur);
          }
          return {
            results: [...m.entries()].map(([k, v]) => {
              const [state, part, readable] = k.split('|');
              return { state, part: Number(part), readable: Number(readable), c: v.c, custom_c: v.custom_c };
            }),
          };
        }
        if (s.startsWith('SELECT state, part, COUNT(*) AS c FROM sources')) {
          const m = new Map();
          for (const r of tables.sources.values()) {
            const k = `${r.state}|${r.part}`;
            m.set(k, (m.get(k) || 0) + 1);
          }
          return {
            results: [...m.entries()].map(([k, c]) => {
              const [state, part] = k.split('|');
              return { state, part: Number(part), c };
            }),
          };
        }
        if (s.startsWith('INSERT INTO sources')) {
          if (!tables.sources.has(args[0])) {
            tables.sources.set(args[0], {
              key: args[0],
              url: args[1],
              kind: args[2],
              part: args[3],
              host: args[4],
              handle: args[5],
              name: args[6],
              title: '',
              site_name: '',
              contact: '',
              city: 'نامشخص',
              has_table: 0,
              readable: args[7],
              state: 'new',
              verify_tries: 0,
              depth: args[8],
              is_inner: args[9],
              hinted: args[10],
              origin: args[11],
              matched_product: args[12],
              discovered_from: args[13],
              provider: args[14],
              note: '',
              next_retry_at: 0,
              discovered_at: args[15],
              verified_at: 0,
              updated_at: args[15],
            });
          }
          return { results: [] };
        }
        if (s.startsWith("UPDATE sources SET state = 'new'")) {
          return { results: [] };
        }
        if (s.startsWith('UPDATE sources SET matched_product =')) {
          const r = tables.sources.get(args[0]);
          if (r && !r.matched_product.includes(args[1])) {
            r.matched_product = r.matched_product ? `${r.matched_product}، ${args[1]}` : args[1];
          }
          return { results: [] };
        }
        if (s.startsWith("SELECT 1 AS ok FROM sources WHERE state = 'new'")) {
          const found = [...tables.sources.values()].some(
            (r) => r.state === 'new' && r.next_retry_at <= args[0]
          );
          return { results: found ? [{ ok: 1 }] : [] };
        }
        if (s.startsWith("SELECT * FROM sources WHERE state = 'new'")) {
          return {
            results: [...tables.sources.values()]
              .filter((r) => r.state === 'new' && r.next_retry_at <= args[0])
              .slice(0, Number(args[1])),
          };
        }
        if (s.startsWith('UPDATE sources SET state =') && s.includes('verified_at =')) {
          const r = tables.sources.get(args[0]);
          if (r) {
            r.state = 'ok';
            if (!r.name && args[1]) r.name = args[1];
            r.title = args[2];
            r.site_name = args[3];
            r.contact = args[4];
            r.city = args[5];
            r.has_table = args[6];
            r.note = args[7];
            r.verified_at = args[8];
            r.updated_at = args[8];
          }
          return { results: [] };
        }
        if (s.startsWith("UPDATE sources SET state = 'rejected'")) {
          const r = tables.sources.get(args[0]);
          if (r) r.state = 'rejected';
          return { results: [] };
        }
        if (s.startsWith('SELECT key, url, kind, part, readable')) {
          return {
            results: [...tables.sources.values()].filter((r) => r.state === 'ok'),
          };
        }
        if (s.includes('FROM sources') && s.includes('SUM(LENGTH')) {
          return { results: [{ bytes: 1024 }] };
        }
        throw new Error('Unhandled mock SQL: ' + s);
      },
    });
    return {
      bind: (...v) => execWith(v),
      ...execWith([]),
    };
  }

  return {
    prepare: makeStmt,
    async batch(stmts) {
      const out = [];
      for (const st of stmts) out.push(await st.all());
      return out;
    },
  };
}

const env = {
  DB: createMockD1(),
  DEFAULT_REFRESH_HOURS: '24',
  SEARCH_QUERIES_PER_TICK: '3',
  VERIFIES_PER_TICK: '8',
  MAX_SUBREQUESTS_PER_TICK: '28',
};

const mockFetch = async (url) => {
  const u = String(url);
  if (u.includes('lite.duckduckgo.com') || u.includes('search')) {
    return new Response(
      `<html><body>
        <a class="result-link" href="https://steel-zagros.ir/prices">قیمت میلگرد زاگرس امروز فروش عمده</a>
        <a class="result-link" href="https://t.me/zagros_iron">کانال تلگرام میلگرد زاگرس</a>
      </body></html>`,
      { status: 200 }
    );
  }
  if (u.includes('steel-zagros.ir')) {
    return new Response(
      `<html><head><title>فولاد زاگرس</title><meta property="og:site_name" content="فولاد زاگرس" /></head>
       <body>
         <p>فروش میلگرد زاگرس قیمت روز تومان تحویل تهران ۰۲۱۵۵۴۴۳۳۲۲</p>
         <table><tr><th>سایز</th><th>قیمت</th></tr><tr><td>۱۶</td><td>۲۸۰۰۰</td></tr></table>
         <a href="https://eitaa.com/zagros_eitaa">کانال ایتا ما</a>
       </body></html>`,
      { status: 200 }
    );
  }
  if (u.includes('t.me/s/zagros_iron') || u.includes('eitaa.com/zagros_eitaa')) {
    return new Response(
      `<html><head><title>کانال فولاد زاگرس</title></head>
       <body><p>قیمت میلگرد زاگرس فروش روزانه تومان مشهد</p></body></html>`,
      { status: 200 }
    );
  }
  if (u.includes('mychannels.ir') || u.includes('canal')) {
    return new Response(`<html><body>نتیجه‌ای یافت نشد</body></html>`, { status: 200 });
  }
  return new Response('not found', { status: 404 });
};

// 1. Idle tick before due time should do nothing
const idleTick = await runTick(env, { now: 1000, fetchFn: mockFetch });
assert.equal(idleTick.idle, true);

// 2. Add custom product & run discovery ticks
const prod = await addCustomProduct(env, 'میلگرد زاگرس', 2000);
assert.equal(prod.name, 'میلگرد زاگرس');

const t1 = await runTick(env, { now: 3000, fetchFn: mockFetch });
assert.ok(t1.searches > 0);
assert.ok(t1.added >= 2);
assert.ok(t1.confirmed >= 1);

// Second tick picks up the discovered eitaa channel (depth 1) & remaining queries
const t2 = await runTick(env, { now: 4000, fetchFn: mockFetch });
assert.ok(t2.searches > 0 || t2.verified > 0);

// 3. /api/sources returns clean ironpin-sources-v1 JSON with NO quotes
const resSources = await handleApi(new Request('https://example.com/api/sources'), env);
assert.equal(resSources.status, 200);
const payload = await resSources.json();
assert.equal(payload.format, 'ironpin-sources-v1');
assert.equal(payload.quotes, undefined);
assert.ok(payload.sources.some((s) => s.url === 'https://steel-zagros.ir/prices' && s.has_table));
assert.ok(payload.sources.some((s) => s.url === 'https://t.me/zagros_iron' && s.kind === 'telegram'));
assert.ok(payload.sources.some((s) => s.url === 'https://eitaa.com/zagros_eitaa' && s.kind === 'eitaa'));

// 4. /api/status is lightweight (no sources array), exposes limits/guards & default 6-month retention
const resStatus = await handleApi(new Request('https://example.com/api/status'), env);
const statusJson = await resStatus.json();
assert.equal(statusJson.ok, true);
assert.equal(statusJson.sources, undefined);
assert.equal(statusJson.config.retention_months, 6);
assert.equal(statusJson.guards.overall, 'ok');
assert.ok(Array.isArray(statusJson.guards.items) && statusJson.guards.items.length >= 5);

// 5. /api/config updates refresh_hours & retention_months
const resCfg = await handleApi(
  new Request('https://example.com/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_hours: 12, auto_enabled: true, retention_months: 3 }),
  }),
  env
);
const cfgJson = await resCfg.json();
assert.equal(cfgJson.config.refresh_hours, 12);
assert.equal(cfgJson.config.retention_months, 3);

// 6. Guard blocks scan automatically when daily quota or storage threshold is reached
const todayStr = new Date().toISOString().slice(0, 10);
await env.DB.prepare(
  `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
)
  .bind(
    'usage_daily',
    JSON.stringify({
      date: todayStr,
      updated_at: Date.now(),
      d1_mb: 1.5,
      rows_read: 4_300_000,
      rows_written: 10_000,
      requests: 500,
    }),
    Date.now()
  )
  .run();

const guardedTick = await runTick(env, { now: Date.now(), forceTrigger: true, fetchFn: mockFetch });
assert.equal(guardedTick.guard_blocked, true);
assert.equal(guardedTick.blocked_by, 'd1_rows_read');

// Clear simulated high usage
await env.DB.prepare(
  `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
)
  .bind(
    'usage_daily',
    JSON.stringify({
      date: todayStr,
      updated_at: Date.now(),
      d1_mb: 1.5,
      rows_read: 1000,
      rows_written: 100,
      requests: 50,
    }),
    Date.now()
  )
  .run();

// 7. Manual purge (both older-than-N-months and all)
const resPurgeOlder = await handleApi(
  new Request('https://example.com/api/sources/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'older', months: 6 }),
  }),
  env
);
const purgeOlderJson = await resPurgeOlder.json();
assert.equal(purgeOlderJson.ok, true);
assert.equal(purgeOlderJson.retention_months, 6);
assert.ok(purgeOlderJson.deleted >= 1);

const resPurgeAll = await handleApi(
  new Request('https://example.com/api/sources/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'all' }),
  }),
  env
);
const purgeAllJson = await resPurgeAll.json();
assert.equal(purgeAllJson.ok, true);
const afterPurgeAll = await (await handleApi(new Request('https://example.com/api/sources'), env)).json();
assert.equal(afterPurgeAll.sources.length, 0);

// 8. /api/reset wipes cleanly
const resReset = await handleApi(new Request('https://example.com/api/reset', { method: 'POST' }), env);
const resetJson = await resReset.json();
assert.equal(resetJson.ok, true);
const afterReset = await (await handleApi(new Request('https://example.com/api/sources'), env)).json();
assert.equal(afterReset.sources.length, 0);

console.log('finder.test.js PASS');
