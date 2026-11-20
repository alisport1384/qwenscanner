/** In-memory D1 mock + pipeline integration test — node test/pipeline.test.js */

import assert from 'node:assert/strict';
import { runTick, requeueDueScans } from '../src/pipeline.js';
import { ensureSchema } from '../src/schema.js';

// ---------- minimal D1 mock ----------
function makeDb() {
  const tables = { scans: [], pages: [], knowledge: [] };
  let pageSeq = 1;

  function parse(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  const db = {
    _tables: tables,
    prepare(sql) {
      const s = parse(sql);
      const state = { params: [] };
      const stmt = {
        bind(...args) {
          state.params = args;
          return stmt;
        },
        async run() {
          exec(s, state.params);
          return { success: true, meta: {} };
        },
        async first() {
          return exec(s, state.params, 'first');
        },
        async all() {
          const r = exec(s, state.params, 'all');
          return { results: r, success: true };
        },
      };
      return stmt;
    },
    async batch(stmts) {
      // stmts are already-bound statements; call run/execute each
      const out = [];
      for (const st of stmts) {
        out.push(await st.run());
      }
      return out;
    },
  };

  function exec(sql, p, mode = 'run') {
    // CREATE TABLE / CREATE INDEX — ignore (schema pre-seeded)
    if (/^CREATE /i.test(sql)) return mode === 'first' ? {} : [];

    // SELECT COUNT(*) AS c FROM pages WHERE scan_id = ?1  (and variants)
    if (/SELECT COUNT\(\*\) AS c FROM pages WHERE scan_id = \?1 AND status = 'pending'/.test(sql)) {
      const c = tables.pages.filter((r) => r.scan_id === p[0] && r.status === 'pending').length;
      return mode === 'first' ? { c } : [{ c }];
    }
    if (/SELECT COUNT\(\*\) AS c FROM pages\s+WHERE scan_id = \?1 AND status IN \('pending','claimed'\)/.test(sql)) {
      const c = tables.pages.filter(
        (r) => r.scan_id === p[0] && (r.status === 'pending' || r.status === 'claimed')
      ).length;
      return mode === 'first' ? { c } : [{ c }];
    }
    if (/SELECT COUNT\(\*\) AS c FROM pages WHERE scan_id = \?1$/.test(sql)) {
      const c = tables.pages.filter((r) => r.scan_id === p[0]).length;
      return mode === 'first' ? { c } : [{ c }];
    }

    // SELECT * FROM scans WHERE status = 'fetching' ...
    if (/SELECT \* FROM scans WHERE status = 'fetching'/.test(sql)) {
      const rows = tables.scans
        .filter((r) => r.status === 'fetching')
        .sort((a, b) => a.updated_at - b.updated_at);
      return mode === 'first' ? rows[0] || null : rows.slice(0, 1);
    }
    if (/SELECT \* FROM scans WHERE status IN \('queued','searching'\)/.test(sql)) {
      const rows = tables.scans
        .filter((r) => r.status === 'queued' || r.status === 'searching')
        .sort((a, b) => (a.updated_at || a.created_at) - (b.updated_at || b.created_at));
      return mode === 'first' ? rows[0] || null : rows.slice(0, 1);
    }

    // UPDATE pages claim RETURNING
    if (/UPDATE pages SET status = 'claimed'/.test(sql) && /RETURNING/.test(sql)) {
      const [claimedAt, scanId, limit] = p;
      const cand = tables.pages
        .filter((r) => r.scan_id === scanId && r.status === 'pending')
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
      for (const r of cand) {
        r.status = 'claimed';
        r.claimed_at = claimedAt;
        r.attempts = (r.attempts || 0) + 1;
      }
      const results = cand.map((r) => ({
        id: r.id, url: r.url, domain: r.domain, title: r.title, attempts: r.attempts,
      }));
      return mode === 'first' ? results[0] || null : results;
    }

    // SELECT totals subqueries
    if (/SELECT\s+\(SELECT COUNT\(\*\) FROM knowledge WHERE scan_id = \?1\) AS kc/.test(sql)) {
      const kc = tables.knowledge.filter((r) => r.scan_id === p[0]).length;
      const total = tables.pages.filter((r) => r.scan_id === p[0]).length;
      const done = tables.pages.filter(
        (r) => r.scan_id === p[0] && ['done', 'skipped', 'failed'].includes(r.status)
      ).length;
      return mode === 'first' ? { kc, total, done } : [{ kc, total, done }];
    }
    if (/SELECT\s+\(SELECT COUNT\(\*\) FROM pages WHERE scan_id = \?1\) AS total/.test(sql)) {
      const total = tables.pages.filter((r) => r.scan_id === p[0]).length;
      const done = tables.pages.filter(
        (r) => r.scan_id === p[0] && ['done', 'skipped', 'failed'].includes(r.status)
      ).length;
      const kc = tables.knowledge.filter((r) => r.scan_id === p[0]).length;
      return mode === 'first' ? { total, done, kc } : [{ total, done, kc }];
    }

    // INSERT pages
    if (/INSERT INTO pages/.test(sql)) {
      const [scan_id, url, domain, title, source, query, created_at] = p;
      if (tables.pages.some((r) => r.scan_id === scan_id && r.url === url)) return;
      tables.pages.push({
        id: pageSeq++, scan_id, url, domain, title, source, query,
        status: 'pending', http_status: null, error: null, chars: 0,
        attempts: 0, claimed_at: null, fetched_at: null, created_at,
      });
      return;
    }

    // INSERT knowledge
    if (/INSERT INTO knowledge/.test(sql)) {
      const [
        id, scan_id, kind, topic, question, claim, category, attribute,
        url, domain, confidence, ttl_days, layer, tags,
        chunk_index, chunk_total, tokens, offset_chars, lang,
        created_at, last_verified_at,
      ] = p;
      const existing = tables.knowledge.find((r) => r.scan_id === scan_id && r.id === id);
      if (existing) {
        Object.assign(existing, { claim, confidence, tags, tokens, last_verified_at });
        return;
      }
      tables.knowledge.push({
        id, scan_id, kind, topic, question, claim, category, attribute,
        url, domain, confidence, ttl_days, layer, tags,
        chunk_index, chunk_total, tokens, offset_chars, lang,
        created_at, last_verified_at,
      });
      return;
    }

    // UPDATE pages done
    if (/UPDATE pages SET status = \?1, http_status/.test(sql)) {
      const [status, http_status, error, chars, fetched_at, title, id] = p;
      const r = tables.pages.find((x) => x.id === id);
      if (r) {
        r.status = status; r.http_status = http_status; r.error = error;
        r.chars = chars; r.fetched_at = fetched_at;
        if (title) r.title = title;
      }
      return;
    }

    // UPDATE scans various
    if (/UPDATE scans SET status = 'searching'/.test(sql)) {
      const r = tables.scans.find((x) => x.id === p[1]);
      if (r) { r.status = 'searching'; r.updated_at = p[0]; }
      return;
    }
    if (/UPDATE scans SET status = 'fetching', phase = 'fetch'/.test(sql)) {
      const r = tables.scans.find((x) => x.id === p[1]);
      if (r) { r.status = 'fetching'; r.phase = 'fetch'; r.updated_at = p[0]; }
      return;
    }
    if (/UPDATE scans SET status = \?1, phase = \?2, engines_used/.test(sql)) {
      const [status, phase, engines_used, error, id, updated_at] = p;
      const r = tables.scans.find((x) => x.id === id);
      if (r) {
        r.status = status; r.phase = phase; r.engines_used = engines_used;
        r.error = error; r.updated_at = updated_at;
        r.pages_total = tables.pages.filter((x) => x.scan_id === id).length;
      }
      return;
    }
    if (/UPDATE scans SET status = \?1, phase = 'fetch', error = \?2/.test(sql)) {
      const [status, error, pages_done, pages_total, knowledge_count, next_refresh_at, updated_at, id] = p;
      const r = tables.scans.find((x) => x.id === id);
      if (r) {
        Object.assign(r, {
          status, error, pages_done, pages_total, knowledge_count,
          next_refresh_at, updated_at, phase: 'fetch',
        });
      }
      return;
    }
    if (/UPDATE scans SET pages_total = \?1/.test(sql)) {
      const [pages_total, pages_done, knowledge_count, updated_at, id] = p;
      const r = tables.scans.find((x) => x.id === id);
      if (r) Object.assign(r, { pages_total, pages_done, knowledge_count, updated_at });
      return;
    }
    if (/UPDATE pages SET status = 'pending', claimed_at = NULL\s+WHERE status = 'claimed'/.test(sql)) {
      const cutoff = p[0];
      for (const r of tables.pages) {
        if (r.status === 'claimed' && r.claimed_at != null && r.claimed_at < cutoff) {
          r.status = 'pending'; r.claimed_at = null;
        }
      }
      return;
    }
    if (/UPDATE scans\s+SET status = 'queued', phase = 'search'/.test(sql) && /RETURNING id/.test(sql)) {
      const t = p[0];
      const ids = [];
      for (const r of tables.scans) {
        if (
          r.auto_refresh === 1 &&
          ['done', 'failed'].includes(r.status) &&
          r.next_refresh_at != null &&
          r.next_refresh_at <= t
        ) {
          r.status = 'queued'; r.phase = 'search'; r.error = null;
          r.updated_at = t;
          r.next_refresh_at = t + r.refresh_hours * 3600000;
          ids.push({ id: r.id });
        }
      }
      return mode === 'first' ? ids[0] || null : ids;
    }
    if (/UPDATE pages SET status = 'pending', claimed_at = NULL, attempts = 0\s+WHERE scan_id = \?1$/.test(sql)) {
      for (const r of tables.pages) {
        if (r.scan_id === p[0]) {
          r.status = 'pending'; r.claimed_at = null; r.attempts = 0;
        }
      }
      return;
    }

    throw new Error('mock: unhandled SQL: ' + sql.slice(0, 120));
  }

  return db;
}

// ---------- mock fetch for engines + pages ----------
const SERP_HTML = `
<html><body>
<div class="b_algo"><h2><a href="https://www.bing.com/ck/a?&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9hcnRpY2xl">Article One</a></h2>
<p class="b_lineclamp">Snippet about steel sheet price.</p></div>
<div class="b_algo"><h2><a href="https://second.example.org/page">Second Page</a></h2>
<p>Another snippet.</p></div>
<div class="b_algo"><h2><a href="https://third.example.net/info">Third</a></h2>
<p>Third snippet here.</p></div>
</body></html>`;

function makePageHtml(seed) {
  const para = `این یک پاراگراف نمونه برای تست اسکنر است. قیمت ورق گالوانیزه امروز 45000 تومان اعلام شد. ` .repeat(30);
  return `<html><head><title>PAGE ${seed}</title><script>bad()</script></head>
<body><nav>nav</nav><main><h1>Title ${seed}</h1><p>${para}</p></main></body></html>`;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('bing.com/search')) {
    return new Response(SERP_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  if (u.includes('duckduckgo') || u.includes('gerdoo') || u.includes('zarebin')) {
    return new Response('<html>empty</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  }
  if (u.includes('example.com') || u.includes('example.org') || u.includes('example.net')) {
    return new Response(makePageHtml(u), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response('not found', { status: 404 });
};

// ---------- seed scan directly (bypass API) ----------
const db = makeDb();
await ensureSchema({ DB: db });

const scanId = '11111111-2222-3333-4444-555555555555';
db._tables.scans.push({
  id: scanId,
  topic: 'قیمت ورق گالوانیزه',
  status: 'queued',
  phase: 'search',
  auto_refresh: 1,
  refresh_hours: 24,
  next_refresh_at: Date.now() + 3600_000,
  pages_total: 0,
  pages_done: 0,
  knowledge_count: 0,
  engines_used: '[]',
  error: null,
  created_at: Date.now(),
  updated_at: Date.now(),
});

const env = { DB: db, MAX_PAGES_PER_SCAN: '6', PAGES_PER_TICK: '3', SEARCH_QUERY_LIMIT: '2' };

let failed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('✓', name))
    .catch((e) => {
      failed++;
      console.error('✗', name, '\n  ', e.message);
      process.exitCode = 1;
    });
}

await ok('tick 1: search phase inserts pages', async () => {
  await runTick(env);
  const scan = db._tables.scans.find((s) => s.id === scanId);
  assert.equal(scan.status, 'fetching', `status=${scan.status}`);
  assert.ok(db._tables.pages.length >= 1, 'pages inserted');
});

await ok('tick 2-4: fetch phase stores knowledge', async () => {
  for (let i = 0; i < 4; i++) await runTick(env);
  const scan = db._tables.scans.find((s) => s.id === scanId);
  assert.ok(['fetching', 'done'].includes(scan.status), `status=${scan.status}`);
  assert.ok(db._tables.knowledge.length > 0, 'knowledge rows');
});

await ok('eventually done with knowledge_count > 0', async () => {
  for (let i = 0; i < 6; i++) await runTick(env);
  const scan = db._tables.scans.find((s) => s.id === scanId);
  assert.equal(scan.status, 'done', `status=${scan.status} err=${scan.error}`);
  assert.ok(scan.knowledge_count > 0);
  assert.ok(db._tables.pages.every((p) => p.status !== 'pending' && p.status !== 'claimed'));
});

await ok('knowledge items have Qwen format fields', async () => {
  const items = db._tables.knowledge;
  assert.ok(items.length >= 1);
  for (const it of items) {
    assert.ok(it.id && it.scan_id && it.claim);
    assert.equal(it.category, 'rag');
    assert.ok([0.68, 0.62, 0.55].includes(it.confidence));
    assert.equal(it.ttl_days, 45);
    const tags = JSON.parse(it.tags);
    assert.ok(Array.isArray(tags) && tags.includes('rag'));
    if (it.kind === 'chunk') {
      assert.ok(it.chunk_index != null && it.chunk_total != null);
      assert.ok(it.claim.length >= 200 || it.claim.length >= 100);
    }
  }
  const domains = new Set(items.map((i) => i.domain));
  assert.ok(domains.size >= 1);
});

await ok('requeueDueScans re-queues expired auto scans', async () => {
  const scan = db._tables.scans.find((s) => s.id === scanId);
  scan.next_refresh_at = Date.now() - 1000;
  await requeueDueScans(env);
  assert.equal(scan.status, 'queued');
  assert.ok(db._tables.pages.every((p) => p.status === 'pending'));
  assert.ok(scan.next_refresh_at > Date.now());
});

await ok('re-scan upserts (no duplicate knowledge ids)', async () => {
  const before = db._tables.knowledge.length;
  for (let i = 0; i < 6; i++) await runTick(env);
  const after = db._tables.knowledge.length;
  // same pages → same ids → upsert, count stable or grown only if new pages
  assert.ok(after >= before);
  const ids = db._tables.knowledge.map((k) => k.scan_id + '|' + k.id);
  assert.equal(new Set(ids).size, ids.length, 'unique (scan_id,id)');
});

await ok('concurrent in-flight pages block finalize', async () => {
  // mark one page claimed with recent timestamp; empty claim path must not finalize
  const p = db._tables.pages[0];
  p.status = 'claimed';
  p.claimed_at = Date.now();
  const scan = db._tables.scans.find((s) => s.id === scanId);
  scan.status = 'fetching';
  await runTick(env);
  assert.notEqual(scan.status, 'done'); // still fetching due to in-flight
  p.status = 'done';
  p.claimed_at = null;
  for (let i = 0; i < 6; i++) await runTick(env);
  assert.equal(scan.status, 'done');
});

console.log(failed ? `\n${failed} FAILED` : '\nAll pipeline tests passed');
