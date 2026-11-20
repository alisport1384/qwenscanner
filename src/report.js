/** Server-rendered report pages — /report/:id and /report/batch/:id */

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
.item.chunk { border-right: 3px solid #58a6ff; }
.item.fact { border-right: 3px solid #d29922; }
.meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; font-size: .78rem; align-items: center; }
.badge { padding: 2px 8px; border-radius: 999px; background: #30363d; }
.badge.chunk { background: #0d419d33; color: #58a6ff; }
.badge.fact { background: #d2992222; color: #d29922; }
.badge.status { background: #30363d; color: #e6edf3; }
.badge.status.done { background: #3fb95022; color: #3fb950; }
.badge.status.failed { background: #f8514922; color: #f85149; }
.badge.status.queued, .badge.status.searching, .badge.status.fetching {
  background: #d2992222; color: #d29922;
}
.topic-tag { background: #bc8cff22; color: #bc8cff; }
.conf, .tok, .lang { color: #8b949e; }
.claim { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; font-size: .95rem; }
.src { display: flex; gap: 12px; align-items: center; font-size: .82rem; margin-bottom: 6px; }
.src a { color: #58a6ff; text-decoration: none; word-break: break-all; }
.attr { color: #8b949e; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  font-size: .7rem; background: #21262d; border: 1px solid #30363d;
  padding: 1px 6px; border-radius: 4px; color: #8b949e; font-family: monospace;
}
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

function itemCard(it) {
  let tags = [];
  try { tags = JSON.parse(it.tags || '[]'); } catch { tags = []; }
  const tagHtml = tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const topicTag = it.topic ? `<span class="badge topic-tag">${esc(it.topic)}</span>` : '';
  return `
<article class="item ${it.kind}">
  <div class="meta">
    <span class="badge ${it.kind}">${it.kind === 'chunk' ? 'چانک Qwen' : 'جمله (نمایش)'}</span>
    ${topicTag}
    <span class="conf">confidence ${it.confidence}</span>
    <span class="tok">${it.tokens} توکن</span>
    ${it.lang ? `<span class="lang">${esc(it.lang)}</span>` : ''}
  </div>
  <p class="claim">${esc(it.claim)}</p>
  <div class="src">
    <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.domain)}</a>
    <span class="attr">${esc(it.attribute || '')}</span>
  </div>
  <div class="tags">${tagHtml}</div>
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
  if (!/^[0-9a-fA-F-]{36}$/.test(id || '')) {
    return new Response(notFoundHtml('شناسه نامعتبر'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  let scan = null;
  try {
    scan = await env.DB.prepare('SELECT * FROM scans WHERE id = ?1').bind(id).first();
  } catch {
    /* fallthrough */
  }
  if (!scan) {
    return new Response(notFoundHtml('گزارش پیدا نشد'), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Batch child → redirect to aggregated list report
  if (scan.batch_id) {
    return new Response(null, {
      status: 302,
      headers: { Location: '/report/batch/' + scan.batch_id },
    });
  }

  let items = [];
  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM knowledge WHERE scan_id = ?1
       ORDER BY domain, CASE kind WHEN 'chunk' THEN 0 ELSE 1 END, chunk_index, id`
    )
      .bind(id)
      .all();
    items = rows.results || [];
  } catch {
    items = [];
  }

  const statusLabel = STATUS_FA[scan.status] || scan.status;
  const domains = [...new Set(items.map((i) => i.domain))];
  const chunks = items.filter((i) => i.kind === 'chunk').length;
  const facts = items.filter((i) => i.kind === 'fact').length;
  const engines = (() => {
    try { return JSON.parse(scan.engines_used || '[]').join('، '); } catch { return '—'; }
  })();

  const body = `
  <h1>${esc(scan.topic)}</h1>
  <div class="sub">
    وضعیت: ${esc(statusLabel)} ·
    ساخته‌شده: ${fmtDate(scan.created_at)} ·
    به‌روز: ${fmtDate(scan.updated_at)}
  </div>

  <div class="stats">
    <div class="stat">دانش‌ها: <b>${items.length}</b></div>
    <div class="stat">چانک: <b>${chunks}</b></div>
    <div class="stat">جملات: <b>${facts}</b></div>
    <div class="stat">دامنه‌ها: <b>${domains.length}</b></div>
    <div class="stat">صفحات: <b>${scan.pages_done}/${scan.pages_total}</b></div>
    <div class="stat">موتورها: <b>${esc(engines)}</b></div>
    <div class="stat">TTL: <b>${scan.ttl_days ?? 45} روز</b></div>
  </div>

  <div class="actions">
    <a class="btn primary" href="/api/report/${esc(scan.id)}" target="_blank">دانلود JSON آماده Qwen</a>
    <a class="btn" href="/">پنل اسکنر</a>
    <button class="btn" onclick="copyJson()">کپی JSON</button>
  </div>

  ${scan.error ? `<div class="item"><p class="claim">خطا: ${esc(scan.error)}</p></div>` : ''}

  ${items.length ? items.map(itemCard).join('\n') : '<div class="empty">هنوز دانشی ذخیره نشده است. صبر کنید cron اجرا شود یا از پنل دستی بزنید.</div>'}

  <footer>
    فرمت ذخیره: <code>qwen-knowledge-v1</code> ·
    چانک ۹۰۰ حرف / overlap ۱۴۰ / min ۲۰۰ ·
    بازیابی: answerable (وزن‌دهی ۰.۴۵/۰.۳۰/۰.۱۵/۰.۱۰)
  </footer>`;

  const script = `
<script>
async function copyJson() {
  try {
    const r = await fetch('/api/report/${esc(scan.id)}');
    const t = await r.text();
    await navigator.clipboard.writeText(t);
    alert('JSON کپی شد');
  } catch (e) { alert('کپی ناموفق: ' + e); }
}
</script>`;

  return new Response(pageShell('گزارش — ' + scan.topic, body, script), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Batch (list) report — /report/batch/:id — ONE link for whole list */
export async function renderBatchReportPage(id, env) {
  if (!/^[0-9a-fA-F-]{36}$/.test(id || '')) {
    return new Response(notFoundHtml('شناسه نامعتبر'), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  let batch = null;
  try {
    batch = await env.DB.prepare('SELECT * FROM batches WHERE id = ?1').bind(id).first();
  } catch {
    /* fallthrough */
  }
  if (!batch) {
    return new Response(notFoundHtml('لیست پیدا نشد'), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const scans =
    (
      await env.DB.prepare(
        `SELECT id, topic, status, pages_total, pages_done, knowledge_count, error, updated_at
         FROM scans WHERE batch_id = ?1 ORDER BY created_at ASC`
      )
        .bind(id)
        .all()
    ).results || [];

  const items =
    (
      await env.DB.prepare(
        `SELECT k.* FROM knowledge k
         JOIN scans s ON s.id = k.scan_id
         WHERE s.batch_id = ?1
         ORDER BY s.created_at, k.domain,
                  CASE k.kind WHEN 'chunk' THEN 0 ELSE 1 END, k.chunk_index, k.id`
      )
        .bind(id)
        .all()
    ).results || [];

  const done = scans.filter((s) => s.status === 'done').length;
  const active = scans.filter((s) => ['queued', 'searching', 'fetching'].includes(s.status)).length;
  const failed = scans.filter((s) => s.status === 'failed').length;
  const chunks = items.filter((i) => i.kind === 'chunk').length;
  const facts = items.filter((i) => i.kind === 'fact').length;
  const domains = [...new Set(items.map((i) => i.domain))];
  const topics = [...new Set(scans.map((s) => s.topic))];

  const scanRows = scans
    .map(
      (s) => `
<div class="scan-row">
  <div class="t">${esc(s.topic)}</div>
  <div class="m">
    <span class="badge status ${esc(s.status)}">${STATUS_FA[s.status] || esc(s.status)}</span>
    <span>📄 ${s.pages_done}/${s.pages_total}</span>
    <span>🧠 ${s.knowledge_count}</span>
    ${s.error ? `<span style="color:#f85149">${esc(s.error)}</span>` : ''}
  </div>
  <a class="btn" href="/api/report/${esc(s.id)}" target="_blank" style="padding:4px 10px;font-size:.78rem">JSON تکی</a>
</div>`
    )
    .join('');

  const body = `
  <h1>${esc(batch.title || 'لیست موضوعات')}</h1>
  <div class="sub">
    ${batch.topics_count} موضوع ·
    ساخته‌شده: ${fmtDate(batch.created_at)} ·
    به‌روز: ${fmtDate(batch.updated_at)}
  </div>

  <div class="stats">
    <div class="stat">کامل: <b>${done}/${scans.length}</b></div>
    <div class="stat">فعال: <b>${active}</b></div>
    <div class="stat">ناموفق: <b>${failed}</b></div>
    <div class="stat">دانش‌ها: <b>${items.length}</b></div>
    <div class="stat">چانک: <b>${chunks}</b></div>
    <div class="stat">جملات: <b>${facts}</b></div>
    <div class="stat">دامنه‌ها: <b>${domains.length}</b></div>
  </div>

  <div class="actions">
    <a class="btn primary" href="/api/report/batch/${esc(id)}" target="_blank">دانلود JSON یکپارچه Qwen</a>
    <a class="btn" href="/">پنل اسکنر</a>
    <button class="btn" onclick="copyJson()">کپی JSON کل لیست</button>
  </div>

  <h2>وضعیت موضوعات (${scans.length})</h2>
  ${scanRows || '<div class="empty">موضوعی ثبت نشده</div>'}

  <h2>دانش‌های ذخیره‌شده (${items.length})</h2>
  ${items.length ? items.map(itemCard).join('\n') : '<div class="empty">هنوز دانشی ذخیره نشده — چند دقیقه صبر کنید یا از پنل «اجرای دستی» بزنید.</div>'}

  <footer>
    یک لینک برای کل لیست · فرمت <code>qwen-knowledge-v1</code> ·
    هر آیتم فیلد <code>topic</code> دارد · چانک ۹۰۰/۱۴۰/۲۰۰ · TTL ۴۵ روز
  </footer>`;

  const script = `
<script>
async function copyJson() {
  try {
    const r = await fetch('/api/report/batch/${esc(id)}');
    const t = await r.text();
    await navigator.clipboard.writeText(t);
    alert('JSON کل لیست کپی شد');
  } catch (e) { alert('کپی ناموفق: ' + e); }
}
</script>`;

  return new Response(pageShell('لیست — ' + (batch.title || topics[0] || 'گزارش'), body, script), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}


/** ALL knowledge — /report/all — live aggregation (auto-updates with new sources/categories). */
export async function renderAllReportPage(env) {
  let items = [];
  let topics = 0;
  let domains = 0;
  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM knowledge
       ORDER BY last_verified_at DESC, domain, CASE kind WHEN 'chunk' THEN 0 ELSE 1 END, id
       LIMIT 5000`
    ).all();
    items = rows.results || [];
    const t = await env.DB.prepare('SELECT COUNT(DISTINCT topic) AS c FROM knowledge').first();
    topics = t?.c || 0;
    const d = await env.DB.prepare('SELECT COUNT(DISTINCT domain) AS c FROM knowledge').first();
    domains = d?.c || 0;
  } catch {
    items = [];
  }

  const chunks = items.filter((i) => i.kind === 'chunk').length;
  const facts = items.filter((i) => i.kind === 'fact').length;

  const body = `
  <h1>کل دانش اسکنر</h1>
  <div class="sub">زنده — با افزوده هر منبع یا دستهٔ جدید خودکار به‌روز می‌شود</div>
  <div class="stats">
    <div class="stat">ایتم‌ها: <b>${items.length}</b></div>
    <div class="stat">موضوعات: <b>${topics}</b></div>
    <div class="stat">دامنه‌ها: <b>${domains}</b></div>
    <div class="stat">چانک: <b>${chunks}</b></div>
    <div class="stat">جملات: <b>${facts}</b></div>
  </div>
  <div class="actions">
    <a class="btn primary" href="/api/report/all" target="_blank">دانلود JSON کل دانش</a>
    <a class="btn" href="/report/sources">فهرست منابع</a>
    <a class="btn" href="/">پنل</a>
    <button class="btn" onclick="copyJson()">کپی JSON</button>
  </div>
  ${items.length ? items.slice(0, 500).map(itemCard).join('\n') : '<div class="empty">هنوز دانشی نیست.</div>'}
  ${items.length > 500 ? `<div class="empty">${items.length - 500} ایتم دیگر در JSON کامل</div>` : ''}
  <footer>فرمت: <code>qwen-knowledge-v1</code> · لینک پایدار <code>/report/all</code></footer>`;

  const script = `
<script>
async function copyJson() {
  try {
    const r = await fetch('/api/report/all');
    const t = await r.text();
    await navigator.clipboard.writeText(t);
    alert('JSON کپی شد');
  } catch (e) { alert('کپی ناموفق: ' + e); }
}
</script>`;

  return new Response(pageShell('کل دانش — Qwen Scanner', body, script), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Sources list — /report/sources — for IronPin handoff. */
export async function renderSourcesPage(env) {
  let rows = [];
  try {
    const r = await env.DB.prepare(
      `SELECT url, domain, kind, part, name, readable, origin, state, created_at, last_checked_at
       FROM sources ORDER BY created_at DESC LIMIT 2000`
    ).all();
    rows = r.results || [];
  } catch {
    rows = [];
  }
  const byKind = {};
  for (const s of rows) byKind[s.kind] = (byKind[s.kind] || 0) + 1;

  const kindStats = Object.entries(byKind)
    .map(([k, n]) => `<div class="stat">${esc(k)}: <b>${n}</b></div>`)
    .join('');

  const list = rows
    .map(
      (s) => `
    <div class="scan-row">
      <div class="t">${esc(s.name || s.domain || s.url)}</div>
      <div class="m">
        <span class="badge">${esc(s.kind)}</span>
        <span class="badge">${s.readable ? 'خوانا' : 'فهرستی'}</span>
        <span class="badge">${esc(s.origin)}</span>
        <span class="badge">${esc(s.state || 'new')}</span>
        <a href="${esc(s.url)}" target="_blank" rel="noopener" style="color:#58a6ff;font-size:.75rem;word-break:break-all">${esc(s.url)}</a>
      </div>
    </div>`
    )
    .join('');

  const body = `
  <h1>فهرست منابع</h1>
  <div class="sub">${rows.length} منبع — برای تحویل به IronPin</div>
  <div class="stats">${kindStats}<div class="stat">کل: <b>${rows.length}</b></div></div>
  <div class="actions">
    <a class="btn primary" href="/api/sources" target="_blank">دانلود JSON منابع</a>
    <a class="btn" href="/report/all">کل دانش</a>
    <a class="btn" href="/">پنل</a>
  </div>
  ${list || '<div class="empty">منبعی ثبت نشده.</div>'}
  <footer>لینک پایدار <code>/report/sources</code> · API <code>/api/sources</code></footer>`;

  return new Response(pageShell('فهرست منابع — Qwen Scanner', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
