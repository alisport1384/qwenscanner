/** Pipeline integration test — node test/pipeline.test.js
 *  Verifies: search phase queues pages, fetch phase finalizes scans,
 *  requeueDueScans requeues due auto-refresh scans. No network.
 */
import assert from 'node:assert/strict';
import { runTick, requeueDueScans, runSearchPhase, runFetchPhase } from '../src/pipeline.js';

function makeDb(opts = {}) {
  const scans = opts.scans || [];
  const pages = opts.pages || [];
  const quotes = opts.quotes || [];
  const meta = new Map();
  const table = { scans, pages, ironpin_quotes: quotes, meta };
  let seq = 1;
  let last = { sql: '', args: [] };

  const db = {
    _tables: table,
    prepare(sql) {
      const s = sql.replace(/\s+/g, ' ').trim();
      const stmt = {
        bind(...a) { last = { sql: s, args: a }; return stmt; },
        async first() {
          if (/FROM meta WHERE key/.test(s)) {
            const v = meta.get(last.args[0]);
            return v === undefined ? null : { value: v };
          }
          if (/SELECT COUNT\(\*\) AS c FROM pages WHERE scan_id = \?1/.test(s)) {
            return { c: table.pages.filter((p) => p.scan_id === last.args[0]).length };
          }
          if (/FROM ironpin_quotes WHERE scan_id = \?/.test(s)) {
            const c = table.ironpin_quotes.filter((q) => q.scan_id === last.args[0]).length;
            return { qc: c, total: 0, done: 0 };
          }
          if (/FROM pages WHERE scan_id = \?1 AND status = 'pending'/.test(s)) {
            return { c: table.pages.filter((p) => p.scan_id === last.args[0] && p.status === 'pending').length };
          }
          if (/FROM pages WHERE scan_id = \? AND status IN/.test(s)) {
            return { c: table.pages.filter((p) => p.scan_id === last.args[0] && ['pending', 'claimed'].includes(p.status)).length };
          }
          if (/SELECT \* FROM scans WHERE id = \?/.test(s)) {
            return table.scans.find((x) => x.id === last.args[0]) || null;
          }
          if (/SELECT \* FROM scans WHERE status = 'fetching'/.test(s)) {
            return table.scans.find((x) => x.status === 'fetching') || null;
          }
          if (/SELECT \* FROM scans WHERE status IN/.test(s)) {
            return table.scans.find((x) => ['queued', 'searching'].includes(x.status)) || null;
          }
          return null;
        },
        async all() {
          if (/UPDATE scans SET status = 'queued'/.test(s)) {
            const t = last.args[0];
            const ids = [];
            for (const row of table.scans) {
              if (row.auto_refresh === 1 && ['done', 'failed'].includes(row.status) && row.next_refresh_at && row.next_refresh_at <= t) {
                row.status = 'queued';
                row.phase = 'search';
                row.error = null;
                row.pages_done = 0;
                row.knowledge_count = 0;
                row.updated_at = t;
                row.next_refresh_at = t + (row.refresh_hours || 24) * 3600_000;
                ids.push(row.id);
              }
            }
            return { results: ids.map((id) => ({ id })) };
          }
          if (/UPDATE pages SET status = 'claimed'/.test(s)) {
            const picked = table.pages
              .filter((p) => p.scan_id === last.args[1] && p.status === 'pending')
              .slice(0, last.args[2]);
            for (const p of picked) { p.status = 'claimed'; p.attempts = (p.attempts || 0) + 1; p.claimed_at = last.args[0]; }
            return { results: picked };
          }
          if (/FROM ironpin_quotes WHERE scan_id = \? ORDER BY/.test(s)) {
            return { results: table.ironpin_quotes.filter((q) => q.scan_id === last.args[0]) };
          }
          if (/SELECT quote_json FROM ironpin_quotes/.test(s)) {
            return { results: table.ironpin_quotes.map((q) => ({ quote_json: q.quote_json, source_last_verified_at: q.source_last_verified_at })) };
          }
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO pages/.test(s)) {
            const [scanId, url] = last.args;
            if (!table.pages.some((p) => p.scan_id === scanId && p.url === url)) {
              table.pages.push({ id: seq++, scan_id: scanId, url, domain: 'example.com', status: 'pending' });
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT INTO ironpin_quotes/.test(s)) {
            table.ironpin_quotes.push({ scan_id: last.args[0], knowledge_id: last.args[1], source_last_verified_at: last.args[2], quote_json: last.args[3] });
            return { success: true, meta: { changes: 1 } };
          }
          if (/INSERT INTO meta/.test(s)) { meta.set(last.args[0], last.args[1]); return { success: true, meta: { changes: 1 } }; }
          // explicit UPDATE branches
          if (/UPDATE scans SET status = 'fetching'/.test(s)) {
            const row = table.scans.find((x) => x.id === last.args[1]);
            if (row) { row.status = 'fetching'; row.phase = 'fetch'; row.updated_at = last.args[0]; }
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE scans SET status = \?1, phase = 'fetch'/.test(s)) {
            const row = table.scans.find((x) => x.id === last.args[7]);
            if (row) {
              row.status = last.args[0];
              row.error = last.args[1];
              row.pages_done = last.args[2];
              row.pages_total = last.args[3];
              row.knowledge_count = last.args[4];
              row.next_refresh_at = last.args[5];
              row.updated_at = last.args[6];
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE scans SET status = 'queued'/.test(s)) {
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE scans SET status = \?1, phase = \?2/.test(s)) {
            const row = table.scans.find((x) => x.id === last.args[4]);
            if (row) {
              row.status = last.args[0];
              row.phase = last.args[1];
              row.engines_used = last.args[2];
              row.error = last.args[3];
              row.pages_total = table.pages.filter((p) => p.scan_id === last.args[4]).length;
              row.updated_at = last.args[5];
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (/UPDATE pages SET status = 'pending', claimed_at = NULL/.test(s)) {
            for (const p of table.pages) { if (p.status === 'claimed') p.status = 'pending'; }
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: {} };
        },
      };
      return stmt;
    },
    async batch(stmts) {
      for (const st of stmts) { await st.run(); }
    },
  };
  return db;
}

let failed = 0;
async function ok(name, fn) { try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, e.message); } }

await ok('search phase queues pages and moves scan to fetching', async () => {
  const scan = { id: 's1', topic: 'قیمت میلگرد', status: 'queued', phase: 'search', auto_refresh: 1, refresh_hours: 24, knowledge_count: 0, pages_total: 0, pages_done: 0, updated_at: Date.now() };
  const db = makeDb({ scans: [scan] });
  const stubSearch = async () => ({ hits: [{ url: 'https://example.com/a', engine: 'stub' }], enginesUsed: ['stub'] });
  await runSearchPhase(scan, { DB: db, MAX_PAGES_PER_SCAN: '12', SEARCH_QUERY_LIMIT: '3' }, { search: stubSearch });
  assert.equal(db._tables.pages.length, 1, 'page queued');
  assert.ok(['fetching', 'failed'].includes(scan.status), 'scan advanced: ' + scan.status);
});

await ok('finalize marks done when quotes exist', async () => {
  const scan = { id: 's1', topic: 'قیمت میلگرد', status: 'fetching', phase: 'fetch', auto_refresh: 0, refresh_hours: 24, knowledge_count: 0, pages_total: 0, pages_done: 0, updated_at: Date.now() };
  const db = makeDb({ scans: [scan], quotes: [{ scan_id: 's1', knowledge_id: 'q1', quote_json: '{}' }] });
  await runFetchPhase(scan, { DB: db, PAGES_PER_TICK: '5' });
  assert.equal(db._tables.scans[0].status, 'done');
});

await ok('finalize marks failed when no quotes', async () => {
  const scan = { id: 's2', topic: 'قیمت ورق', status: 'fetching', phase: 'fetch', auto_refresh: 0, refresh_hours: 24, knowledge_count: 0, pages_total: 0, pages_done: 0, updated_at: Date.now() };
  const db = makeDb({ scans: [scan] });
  await runFetchPhase(scan, { DB: db, PAGES_PER_TICK: '5' });
  assert.equal(db._tables.scans[0].status, 'failed');
});

await ok('requeueDueScans requeues due auto-refresh scans', async () => {
  const db = makeDb({ scans: [
    { id: 's3', topic: 't', status: 'done', phase: 'fetch', auto_refresh: 1, refresh_hours: 24, next_refresh_at: Date.now() - 1000, knowledge_count: 0, pages_total: 0, pages_done: 0, updated_at: Date.now() - 1000 },
  ] });
  await requeueDueScans({ DB: db });
  assert.equal(db._tables.scans[0].status, 'queued');
});

console.log(failed ? `\n${failed} FAILED` : '\nAll pipeline tests passed');
if (failed) process.exitCode = 1;
