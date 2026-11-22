/**
 * Panel report + public token report.
 *
 * IronPin-only: the Qwen knowledge section (حذف) and the target split in
 * /api/report/all are removed. Pages render Searcher-1 price quotes.
 */

const MAX_ROWS = 600;

function fmt(n) {
  if (n == null || Number.isNaN(n)) return null;
  return Number(n.toFixed(2));
}

function groupByCategory(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.category || 'نامشخص';
    if (!map.has(key)) map.set(key, { count: 0, min: Infinity, max: 0, prices: [], unit: r.unit, currency: r.currency });
    const g = map.get(key);
    g.count++;
    g.min = Math.min(g.min, r.amount);
    g.max = Math.max(g.max, r.amount);
    g.prices.push(r.amount);
    if (r.unit) g.unit = r.unit;
    if (r.currency) g.currency = r.currency;
  }
  for (const g of map.values()) g.avg = g.count ? g.prices.reduce((a, b) => a + b, 0) / g.count : 0;
  const sorted = [...map.entries()].map(([category, g]) => ({
    category,
    count: g.count,
    min: fmt(g.min === Infinity ? 0 : g.min),
    avg: fmt(g.avg),
    max: fmt(g.max),
    unit: g.unit,
    currency: g.currency,
  }));
  sorted.sort((a, b) => b.count - a.count);
  return sorted;
}

function groupByUnit(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.unit || 'نامشخص';
    if (!map.has(key)) map.set(key, { count: 0, min: Infinity, max: 0, prices: [], currency: r.currency });
    const g = map.get(key);
    g.count++;
    g.min = Math.min(g.min, r.amount);
    g.max = Math.max(g.max, r.amount);
    g.prices.push(r.amount);
    if (r.currency) g.currency = r.currency;
  }
  for (const g of map.values()) g.avg = g.count ? g.prices.reduce((a, b) => a + b, 0) / g.count : 0;
  const sorted = [...map.entries()].map(([unit, g]) => ({
    unit,
    count: g.count,
    min: fmt(g.min === Infinity ? 0 : g.min),
    avg: fmt(g.avg),
    max: fmt(g.max),
    currency: g.currency,
  }));
  sorted.sort((a, b) => b.count - a.count);
  return sorted;
}

function groupBySeller(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.seller || 'نامشخص';
    if (!map.has(key)) map.set(key, { count: 0, min: Infinity, max: 0, prices: [], urls: new Set() });
    const g = map.get(key);
    g.count++;
    g.min = Math.min(g.min, r.amount);
    g.max = Math.max(g.max, r.amount);
    g.prices.push(r.amount);
    if (r.source_url) g.urls.add(r.source_url);
  }
  for (const g of map.values()) g.avg = g.count ? g.prices.reduce((a, b) => a + b, 0) / g.count : 0;
  const sorted = [...map.entries()].map(([seller, g]) => ({
    seller,
    count: g.count,
    min: fmt(g.min === Infinity ? 0 : g.min),
    avg: fmt(g.avg),
    max: fmt(g.max),
    sources: g.urls.size,
  }));
  sorted.sort((a, b) => b.count - a.count);
  return sorted.slice(0, 80);
}

/**
 * Scoped report (token-gated): scan summary + quotes + pages + totals.
 * No Qwen knowledge section.
 */
export async function getPanelReport(env, scanId) {
  const scan = await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(scanId).first();
  if (!scan) return null;

  const [quotes, pages] = await Promise.all([
    env.DB.prepare(
      `SELECT id, seller, title, category, unit, currency, amount, source_url, published_at,
         piece_kg, length_m, area_m2, size, thickness, details, quality, material,
         brand, load_type, load_city, terms, source_date_raw
       FROM ironpin_quotes WHERE scan_id = ? ORDER BY id DESC LIMIT ${MAX_ROWS}`
    ).bind(scanId).all(),
    env.DB.prepare(
      `SELECT id, url, domain, title, status, error, http_status, chars, attempts, fetched_at
       FROM pages WHERE scan_id = ? ORDER BY id DESC LIMIT ${MAX_ROWS}`
    ).bind(scanId).all(),
  ]);

  const quoteRows = quotes?.results || [];
  const totals = {
    quotes: quoteRows.length,
    min: Infinity,
    max: 0,
    avg: 0,
    pages_done: 0,
    pages_failed: 0,
    pages_skipped: 0,
  };
  for (const q of quoteRows) {
    if (q.amount != null) {
      totals.min = Math.min(totals.min, q.amount);
      totals.max = Math.max(totals.max, q.amount);
      totals.avg += q.amount;
    }
  }
  totals.avg = totals.quotes ? totals.avg / totals.quotes : 0;
  for (const p of pages?.results || []) {
    if (p.status === 'done') totals.pages_done++;
    else if (p.status === 'failed') totals.pages_failed++;
    else if (p.status === 'skipped') totals.pages_skipped++;
  }
  totals.min = totals.min === Infinity ? 0 : fmt(totals.min);
  totals.max = fmt(totals.max);
  totals.avg = fmt(totals.avg);

  return {
    scan: {
      id: scan.id, topic: scan.topic, status: scan.status, phase: scan.phase,
      token: scan.token, auto_refresh: scan.auto_refresh,
      knowledge_count: scan.knowledge_count || 0,
      pages_total: scan.pages_total || 0, pages_done: scan.pages_done || 0,
      error: scan.error, next_refresh_at: scan.next_refresh_at,
      updated_at: scan.updated_at, created_at: scan.created_at,
    },
    totals,
    by_category: groupByCategory(quoteRows),
    by_unit: groupByUnit(quoteRows),
    by_seller: groupBySeller(quoteRows),
    quotes: quoteRows,
    pages: pages?.results || [],
  };
}

/* ----------------------------- HTML pages ------------------------------ */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('fa-IR');
  } catch {
    return String(ms);
  }
}

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 16px; font-family: Vazirmatn, Tahoma, "Segoe UI", sans-serif;
  background: #0d1117; color: #e6edf3; line-height: 1.7;
}
.wrap { max-width: 900px; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 4px; word-break: break-word; }
h2 { font-size: 1.05rem; margin: 28px 0 12px; color: #58a6ff; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
.sub { color: #8b949e; font-size: .9rem; margin-bottom: 16px; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.stat {
  background: #161b22; border: 1px solid #30363d; border-radius: 8px;
  padding: 8px 12px; font-size: .85rem;
}
.stat b { color: #58a6ff; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
.btn {
  display: inline-block; padding: 8px 14px; border-radius: 8px; text-decoration: none;
  font-size: .9rem; border: 1px solid #30363d; background: #21262d; color: #e6edf3;
  cursor: pointer; font-family: inherit;
}
.btn.primary { background: #238636; border-color: #2ea043; color: #fff; }
.btn:hover { filter: brightness(1.1); }
.item {
  background: #161b22; border: 1px solid #30363d; border-radius: 10px;
  padding: 14px 16px; margin-bottom: 12px;
}
.item.quote { border-right: 3px solid #3fb950; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; font-size: .78rem; align-items: center; }
.badge { padding: 2px 8px; border-radius: 999px; background: #30363d; }
.badge.quote { background: #3fb95022; color: #3fb950; }
.badge.status { background: #30363d; color: #e6edf3; }
.badge.status.done { background: #3fb95022; color: #3fb950; }
.badge.status.failed { background: #f8514922; color: #f85149; }
.badge.status.queued, .badge.status.searching, .badge.status.fetching {
  background: #d2992222; color: #d29922;
}
.topic-tag { background: #bc8cff22; color: #bc8cff; }
.claim { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; font-size: .95rem; }
.src { display: flex; gap: 12px; align-items: center; font-size: .82rem; margin-bottom: 6px; }
.src a { color: #58a6ff; text-decoration: none; word-break: break-all; }
.attr { color: #8b949e; }
.empty { color: #8b949e; text-align: center; padding: 40px 0; }
footer { margin-top: 28px; color: #484f58; font-size: .78rem; text-align: center; }
code { background: #21262d; padding: 1px 6px; border-radius: 4px; font-size: .85em; }
.scan-row {
  background: #161b22; border: 1px solid #30363d; border-radius: 8px;
  padding: 10px 14px; margin-bottom: 8px; display: flex; flex-wrap: wrap;
  gap: 10px; align-items: center; justify-content: space-between; font-size: .88rem;
}
.scan-row .t { font-weight: 600; word-break: break-word; flex: 1 1 200px; }
.scan-row .m { color: #8b949e; font-size: .78rem; display: flex; gap: 10px; flex-wrap: wrap; }
.table { width: 100%; border-collapse: collapse; font-size: .85rem; }
.table th, .table td { padding: 6px 8px; border-bottom: 1px solid #21262d; text-align: right; }
.table th { color: #8b949e; font-weight: 600; }
.table tr:hover td { background: #161b22; }
`;

const STATUS_FA = {
  queued: 'در صف',
  searching: 'جستجو',
  fetching: 'دریافت',
  done: 'کامل',
  failed: 'ناموفق',
};

function notFoundHtml(msg) {
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<title>خطا</title><style>body{font-family:Tahoma;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
</head><body><div style="text-align:center"><h2>${esc(msg)}</h2><a href="/" style="color:#58a6ff">بازگشت به پنل</a></div></body></html>`;
}

function quoteCard(q) {
  const topicTag = q.category ? `<span class="badge topic-tag">${esc(q.category)}</span>` : '';
  const specs = [
    q.material ? `ماده: ${esc(q.material)}` : '',
    q.brand ? `برند: ${esc(q.brand)}` : '',
    q.size ? `سایز: ${esc(q.size)}` : '',
    q.thickness ? `قلط: ${esc(q.thickness)}` : '',
    q.quality ? `کیفیت: ${esc(q.quality)}` : '',
    q.unit ? `واحد: ${esc(q.unit)}` : '',
    q.piece_kg != null ? `کیلو/عدد: ${q.piece_kg}` : '',
    q.length_m != null ? `طول(متر): ${q.length_m}` : '',
    q.area_m2 != null ? `باری(متر²): ${q.area_m2}` : '',
  ].filter(Boolean).join(' · ');
  return `
<article class="item quote">
  <div class="meta">
    <span class="badge quote">قیمت (تومان)</span>
    ${topicTag}
    <span class="attr">${q.currency ? esc(q.currency) : ''}</span>
  </div>
  <p class="claim">${esc(q.title || q.seller || '')}</p>
  <div class="src">
    <a href="${esc(q.source_url)}" target="_blank" rel="noopener noreferrer">${esc(q.seller || q.source_url)}</a>
    <span class="attr">${esc(specs)}</span>
  </div>
</article>`;
}

function pageShell(title, bodyHtml, extraScript = '') {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
</div>
${extraScript}
</body>
</html>`;
}

/** Single-scan report — /report/:id */
export async function renderReportPage(id, env) {
  const body = await getPanelReport(env, id);
  if (!body) return new Response(notFoundHtml('اسکنری با این شناسه یافت نشد'), { status: 404 });

  const { scan, totals, by_category, by_unit, quotes, pages } = body;
  const stats = `
<div class="stats">
  <div class="stat">قیمت‌ها: <b>${totals.quotes}</b></div>
  <div class="stat">حداقل: <b>${totals.min ?? '—'}</b></div>
  <div class="stat">حداکثر: <b>${totals.max ?? '—'}</b></div>
  <div class="stat">میانگین: <b>${totals.avg ?? '—'}</b></div>
</div>`;

  const quoteHtml = quotes.length
    ? quotes.map(quoteCard).join('')
    : '<div class="empty">هنوز قیمت استخراج نشده</div>';

  const catTable = by_category.length
    ? `<table class="table"><thead><tr><th>دسته</th><th>تعداد</th><th>حداقل</th><th>میانگین</th><th>حداکثر</th></tr></thead><tbody>${by_category.map((c) => `<tr><td>${esc(c.category)}</td><td>${c.count}</td><td>${c.min}</td><td>${c.avg}</td><td>${c.max}</td></tr>`).join('')}</tbody></table>`
    : '';

  const unitTable = by_unit.length
    ? `<table class="table"><thead><tr><th>واحد</th><th>تعداد</th><th>حداقل</th><th>میانگین</th><th>حداکثر</th></tr></thead><tbody>${by_unit.map((u) => `<tr><td>${esc(u.unit)}</td><td>${u.count}</td><td>${u.min}</td><td>${u.avg}</td><td>${u.max}</td></tr>`).join('')}</tbody></table>`
    : '';

  const pageList = pages.length
    ? `<h2>صفحات (${pages.length})</h2>${pages.slice(0, 30).map((p) => `
<div class="scan-row">
  <span class="t">${esc(p.title || p.url)}</span>
  <span class="m"><span class="badge status ${esc(p.status)}">${esc(STATUS_FA[p.status] || p.status)}</span>${p.chars ? `${p.chars} کاراکتر` : ''}</span>
</div>`).join('')}`
    : '';

  return new Response(pageShell(`گزارش: ${scan.topic}`, `
<h1>${esc(scan.topic)}</h1>
<div class="sub">اسکن #${scan.id} — وضعیت: ${esc(STATUS_FA[scan.status] || scan.status)} ·
  به‌روزرسانی: ${esc(fmtDate(scan.updated_at))}</div>
${stats}
<h2>قیمت‌ها</h2>
${quoteHtml}
${catTable ? `<h2>دسته‌بندی</h2>${catTable}` : ''}
${unitTable ? `<h2>واحده</h2>${unitTable}` : ''}
${pageList}
<footer>آینه اسکنر داخلی آیرون پین — اسکنر آنلاین</footer>
`), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=120',
    },
  });
}

/** Batch (materialized) report — /report/batch/:id */
export async function renderBatchReportPage(id, env) {
  const batch = await env.DB.prepare('SELECT * FROM batches WHERE id = ?').bind(Number(id)).first();
  if (!batch) return new Response(notFoundHtml('باتش با این شناسه یافت نشد'), { status: 404 });
  const scan = await env.DB.prepare('SELECT * FROM scans WHERE id = ?').bind(batch.scan_id).first();

  const quotes = await env.DB.prepare(
    `SELECT id, seller, title, category, unit, currency, amount, source_url, published_at,
       piece_kg, length_m, area_m2, size, thickness, details, quality, material,
       brand, load_type, load_city, terms, source_date_raw
     FROM ironpin_quotes WHERE scan_id = ? ORDER BY id DESC LIMIT ${MAX_ROWS}`
  ).bind(batch.scan_id).all();
  const quoteRows = quotes?.results || [];

  const stats = `
<div class="stats">
  <div class="stat">قیمت‌ها: <b>${quoteRows.length}</b></div>
  <div class="stat">اسکن: <b>${esc(scan?.topic || batch.topic)}</b></div>
</div>`;

  const quoteHtml = quoteRows.length
    ? quoteRows.map(quoteCard).join('')
    : '<div class="empty">هنوز قیمت استخراج نشده</div>';

  return new Response(pageShell(`باتش: ${batch.topic}`, `
<h1>باتش: ${esc(batch.topic)}</h1>
<div class="sub">باتش #${batch.id} — اسکن #${batch.scan_id}</div>
${stats}
<h2>قیمت‌ها</h2>
${quoteHtml}
<footer>آینه اسکنر داخلی آیرون پین — اسکنر آنلاین</footer>
`), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=120',
    },
  });
}

/** All-scans report — /report/all */
export async function renderAllReportPage(env) {
  const scans = await env.DB.prepare(
    `SELECT id, topic, status, knowledge_count, pages_total, pages_done, updated_at
     FROM scans ORDER BY id DESC LIMIT 100`
  ).all();
  const rows = scans?.results || [];

  const scanHtml = rows.length
    ? rows.map((s) => `
<div class="scan-row">
  <span class="t">${esc(s.topic)} <span class="badge status ${esc(s.status)}">${esc(STATUS_FA[s.status] || s.status)}</span></span>
  <span class="m">
    <span>قیمت: ${s.knowledge_count || 0}</span>
    <span>صفحات: ${s.pages_done || 0}/${s.pages_total || 0}</span>
    <span>${esc(fmtDate(s.updated_at))}</span>
    <a href="/report/${s.id}" class="btn">گزارش</a>
  </span>
</div>`).join('')
    : '<div class="empty">هیچ اسکنری وجود ندارد</div>';

  return new Response(pageShell('گزارش‌های اسکنر', `
<h1>گزارش‌های اسکنر</h1>
<div class="sub">آینه اسکنر داخلی آیرون پین — اسکنر آنلاین</div>
${scanHtml}
<footer>اسکنر آنلاین — گزارش‌های آیرون پین</footer>
`), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=120',
    },
  });
}

/** Sources status — /report/sources */
export async function renderSourcesPage(env) {
  const sources = await env.DB.prepare(
    `SELECT id, url, domain, state, kind, last_checked_at, quotes_total, batch_id, added_at
     FROM sources ORDER BY (state='dead') DESC, url`
  ).all();
  const rows = sources?.results || [];

  const stateFa = { live: 'فعال', dead: 'غیرفعال' };
  const listHtml = rows.length
    ? rows.map((s) => `
<div class="scan-row">
  <span class="t">${esc(s.url)}</span>
  <span class="m">
    <span class="badge ${s.state === 'live' ? 'status done' : 'status failed'}">${esc(stateFa[s.state] || s.state)}</span>
    <span>قیمت: ${s.quotes_total || 0}</span>
    <span>${esc(fmtDate(s.last_checked_at))}</span>
  </span>
</div>`).join('')
    : '<div class="empty">هیچ منبعی یافت نشده</div>';

  return new Response(pageShell('وضعیت منابع', `
<h1>وضعیت منابع</h1>
<div class="sub">آینه اسکنر داخلی آیرون پین — منابع کشف‌شده توسط اسکنر</div>
${listHtml}
<footer>اسکنر آنلاین — منابع</footer>
`), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
