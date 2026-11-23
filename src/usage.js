/**
 * Cloudflare Workers + D1 Free-Tier usage, limits & active guards monitor.
 */

export const FREE_TIER_LIMITS = {
  d1_storage_mb: 500,
  d1_rows_read_daily: 5_000_000,
  d1_rows_written_daily: 100_000,
  workers_requests_daily: 100_000,
  workers_subrequests_per_invocation: 50,
  workers_cpu_ms_per_invocation: 10,
  workers_cron_triggers: 5,
};

/**
 * Soft guard thresholds kept comfortably below Cloudflare Free plan hard caps
 * so the scanner automatically pauses before any storage or quota failure.
 */
export const GUARD_THRESHOLDS = {
  d1_storage_mb: 420, // 84% of 500 MB
  d1_rows_read_daily: 4_200_000, // 84% of 5M
  d1_rows_written_daily: 82_000, // 82% of 100K
  workers_requests_daily: 85_000, // 85% of 100K
  workers_subrequests_per_invocation: 28, // hardcoded cap inside runTick (vs 50 limit)
  workers_cpu_ms_per_invocation: 10,
};

const FREE_D1_CAP_BYTES = FREE_TIER_LIMITS.d1_storage_mb * 1024 * 1024;

function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

async function getMeta(env, key) {
  try {
    return await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first();
  } catch {
    return null;
  }
}

async function setMeta(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, Date.now())
    .run();
}

async function fetchD1Analytics(env, dateStr) {
  const token = env.CF_API_TOKEN;
  const accountTag = env.CF_ACCOUNT_ID;
  if (!token || !accountTag) return null;
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountTag}"}) {
        d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: "${dateStr}"}) {
          sum { rowsRead rowsWritten }
        }
      }
    }
  }`;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    const groups = data?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups || [];
    if (!groups.length) return null;
    return {
      rowsRead: groups[0]?.sum?.rowsRead || 0,
      rowsWritten: groups[0]?.sum?.rowsWritten || 0,
    };
  } catch {
    return null;
  }
}

async function fetchWorkerRequests(env, dateStr) {
  const token = env.CF_API_TOKEN;
  const accountTag = env.CF_ACCOUNT_ID;
  if (!token || !accountTag) return null;
  const query = `{
    viewer {
      accounts(filter: {accountTag: "${accountTag}"}) {
        workersInvocationsAdaptive(
          limit: 1,
          filter: {date_geq: "${dateStr}", date_leq: "${dateStr}"}
        ) {
          sum { requests }
        }
      }
    }
  }`;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    const groups = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
    if (!groups.length) return null;
    return groups[0]?.sum?.requests || 0;
  } catch {
    return null;
  }
}

async function fetchD1FileSize(env) {
  const token = env.CF_API_TOKEN;
  const accountTag = env.CF_ACCOUNT_ID;
  const dbId = env.CF_D1_ID;
  if (!token || !accountTag || !dbId) return null;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountTag}/d1/database/${dbId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    return data?.result?.file_size ?? null;
  } catch {
    return null;
  }
}

export async function estimateBytes(env) {
  try {
    const pc = await env.DB.prepare('PRAGMA page_count').first();
    const ps = await env.DB.prepare('PRAGMA page_size').first();
    const pageCount = Number(pc?.page_count || 0);
    const pageSize = Number(ps?.page_size || 0);
    if (pageCount > 0 && pageSize > 0) {
      return pageCount * pageSize;
    }
  } catch {
    /* fallback to row length estimation */
  }
  try {
    const row = await env.DB.prepare(
      `SELECT COALESCE((
         SELECT SUM(LENGTH(url) + LENGTH(title) + LENGTH(contact) + LENGTH(note) + 180)
         FROM sources
       ), 0) + COALESCE((
         SELECT SUM(LENGTH(query) + 80) FROM search_tasks
       ), 0) AS bytes`
    ).first();
    return Number(row?.bytes || 0);
  } catch {
    return 0;
  }
}

function guardStateFor(used, guardCap, hardCap) {
  if (used == null) return 'unknown';
  if (used >= guardCap) return 'blocked';
  if (used >= hardCap * 0.65) return 'warning';
  return 'ok';
}

export function evaluateGuards(usage = {}, env = null) {
  const subCap = Math.min(
    40,
    Math.max(6, Number(env?.MAX_SUBREQUESTS_PER_TICK) || GUARD_THRESHOLDS.workers_subrequests_per_invocation)
  );
  const d1Mb = typeof usage.d1_mb === 'number' ? usage.d1_mb : 0;
  const rowsRead = typeof usage.rows_read === 'number' ? usage.rows_read : null;
  const rowsWritten = typeof usage.rows_written === 'number' ? usage.rows_written : null;
  const requests = typeof usage.requests === 'number' ? usage.requests : null;

  const items = [
    {
      id: 'd1_storage',
      title: 'حجم دیتابیس D1',
      used: d1Mb,
      unit: 'MB',
      guard: GUARD_THRESHOLDS.d1_storage_mb,
      limit: FREE_TIER_LIMITS.d1_storage_mb,
      pct: +Math.min(100, (d1Mb / FREE_TIER_LIMITS.d1_storage_mb) * 100).toFixed(2),
      status: guardStateFor(d1Mb, GUARD_THRESHOLDS.d1_storage_mb, FREE_TIER_LIMITS.d1_storage_mb),
      note: 'توقف اسکن و پاک‌سازی در عبور از ۴۲۰ MB',
    },
    {
      id: 'd1_rows_read',
      title: 'خواندن روزانه D1 (rows_read)',
      used: rowsRead,
      unit: 'ردیف',
      guard: GUARD_THRESHOLDS.d1_rows_read_daily,
      limit: FREE_TIER_LIMITS.d1_rows_read_daily,
      pct:
        rowsRead == null
          ? null
          : +Math.min(100, (rowsRead / FREE_TIER_LIMITS.d1_rows_read_daily) * 100).toFixed(2),
      status: guardStateFor(
        rowsRead,
        GUARD_THRESHOLDS.d1_rows_read_daily,
        FREE_TIER_LIMITS.d1_rows_read_daily
      ),
      note: 'ریست ۰۰:۰۰ UTC • توقف خودکار در ۴٫۲M',
    },
    {
      id: 'd1_rows_written',
      title: 'نوشتن روزانه D1 (rows_written)',
      used: rowsWritten,
      unit: 'ردیف',
      guard: GUARD_THRESHOLDS.d1_rows_written_daily,
      limit: FREE_TIER_LIMITS.d1_rows_written_daily,
      pct:
        rowsWritten == null
          ? null
          : +Math.min(100, (rowsWritten / FREE_TIER_LIMITS.d1_rows_written_daily) * 100).toFixed(2),
      status: guardStateFor(
        rowsWritten,
        GUARD_THRESHOLDS.d1_rows_written_daily,
        FREE_TIER_LIMITS.d1_rows_written_daily
      ),
      note: 'ریست ۰۰:۰۰ UTC • توقف خودکار در ۸۲K',
    },
    {
      id: 'workers_requests',
      title: 'درخواست‌های Worker روزانه',
      used: requests,
      unit: 'درخواست',
      guard: GUARD_THRESHOLDS.workers_requests_daily,
      limit: FREE_TIER_LIMITS.workers_requests_daily,
      pct:
        requests == null
          ? null
          : +Math.min(100, (requests / FREE_TIER_LIMITS.workers_requests_daily) * 100).toFixed(2),
      status: guardStateFor(
        requests,
        GUARD_THRESHOLDS.workers_requests_daily,
        FREE_TIER_LIMITS.workers_requests_daily
      ),
      note: 'ریست ۰۰:۰۰ UTC • توقف کرون در ۸۵K',
    },
    {
      id: 'subrequests',
      title: 'درخواست خروجی در هر تیک',
      used: subCap,
      unit: 'درخواست/تیک',
      guard: subCap,
      limit: FREE_TIER_LIMITS.workers_subrequests_per_invocation,
      pct: +Math.min(100, (subCap / FREE_TIER_LIMITS.workers_subrequests_per_invocation) * 100).toFixed(1),
      status: 'ok',
      note: `سقف سخت کدشده ≤ ${subCap} از ۵۰ مجاز`,
    },
    {
      id: 'cpu_cron',
      title: 'زمان CPU و کرون‌های حساب',
      used: 1,
      unit: 'Cron',
      guard: FREE_TIER_LIMITS.workers_cron_triggers,
      limit: FREE_TIER_LIMITS.workers_cron_triggers,
      pct: 20,
      status: 'ok',
      note: `پارس سبک (< ۱۰ms CPU) • ۱ از ۵ Cron`,
    },
  ];

  const blockedItems = items.filter((i) => i.status === 'blocked');
  const warningItems = items.filter((i) => i.status === 'warning');
  const blocked = blockedItems.length > 0;
  const overall = blocked ? 'blocked' : warningItems.length > 0 ? 'warning' : 'ok';

  let reason = '';
  let blocked_by = '';
  if (blocked) {
    const first = blockedItems[0];
    blocked_by = first.id;
    reason = `توقف خودکار توسط نگهبان کلادفلر: «${first.title}» (${Number(first.used).toLocaleString('en-US')} از سقف ${Number(first.limit).toLocaleString('en-US')} ${first.unit})`;
  } else if (warningItems.length > 0) {
    reason = `هشدار نزدیکی به سقف: ${warningItems.map((w) => w.title).join('، ')}`;
  } else {
    reason = 'تمام محدودیت‌های پلن رایگان کلادفلر در محدوده امن هستند.';
  }

  return {
    overall,
    blocked,
    blocked_by,
    reason,
    thresholds: GUARD_THRESHOLDS,
    items,
  };
}

export async function refreshUsage(env, { now = Date.now(), force = false } = {}) {
  const date = todayKey(now);
  const cached = await getMeta(env, 'usage_daily');
  if (!force && cached?.value) {
    try {
      const v = JSON.parse(cached.value);
      if (v.date === date && now - (v.updated_at || 0) < 10 * 60_000) {
        const out = { ...v, limits: FREE_TIER_LIMITS, guard_thresholds: GUARD_THRESHOLDS };
        out.guards = evaluateGuards(out, env);
        return out;
      }
    } catch {
      /* rebuild */
    }
  }

  const [apiSize, d1Analytics, requests] = await Promise.all([
    fetchD1FileSize(env),
    fetchD1Analytics(env, date),
    fetchWorkerRequests(env, date),
  ]);
  const d1Bytes = apiSize ?? (await estimateBytes(env));

  const snap = {
    date,
    updated_at: now,
    d1_bytes: d1Bytes,
    d1_mb: +(d1Bytes / (1024 * 1024)).toFixed(3),
    cap_mb: FREE_TIER_LIMITS.d1_storage_mb,
    cap_percent: +((d1Bytes / FREE_D1_CAP_BYTES) * 100).toFixed(2),
    rows_read: d1Analytics?.rowsRead ?? null,
    rows_written: d1Analytics?.rowsWritten ?? null,
    requests,
    estimated_only: apiSize == null,
    cf_api: Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID),
    limits: FREE_TIER_LIMITS,
    guard_thresholds: GUARD_THRESHOLDS,
  };
  snap.guards = evaluateGuards(snap, env);

  try {
    await setMeta(env, 'usage_daily', JSON.stringify(snap));
  } catch {
    /* ignore */
  }
  return snap;
}

export async function getUsage(env, { now = Date.now() } = {}) {
  return refreshUsage(env, { now, force: false });
}

/**
 * Checks all Cloudflare Free plan guards before running any scan/write tick.
 * Uses cached usage for 15 minutes (or refreshes when stale) so guard checks
 * themselves do not waste D1 reads or subrequests.
 */
export async function checkFreeTierGuards(
  env,
  { now = Date.now(), maxAgeMs = 15 * 60_000 } = {}
) {
  const date = todayKey(now);
  let snap = null;
  try {
    const row = await getMeta(env, 'usage_daily');
    if (row?.value) snap = JSON.parse(row.value);
  } catch {
    /* ignore */
  }

  const isFresh =
    snap &&
    snap.date === date &&
    now - (snap.updated_at || 0) < maxAgeMs &&
    typeof snap.d1_mb === 'number';

  if (!isFresh) {
    snap = await refreshUsage(env, { now, force: true });
  } else {
    snap.limits = FREE_TIER_LIMITS;
    snap.guard_thresholds = GUARD_THRESHOLDS;
    snap.guards = evaluateGuards(snap, env);
  }

  return {
    blocked: Boolean(snap.guards?.blocked),
    blocked_by: snap.guards?.blocked_by || '',
    overall: snap.guards?.overall || 'ok',
    reason: snap.guards?.reason || '',
    guards: snap.guards,
    usage: snap,
  };
}

export async function getRowsReadFresh(env, { now = Date.now(), maxAgeMs = 25 * 60_000 } = {}) {
  const res = await checkFreeTierGuards(env, { now, maxAgeMs });
  return typeof res.usage?.rows_read === 'number' ? res.usage.rows_read : null;
}
