/**
 * Cloudflare Workers + D1 Free-Tier usage & limits monitor.
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

async function estimateBytes(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT COALESCE((
         SELECT SUM(LENGTH(url) + LENGTH(title) + LENGTH(contact) + LENGTH(note) + 120)
         FROM sources
       ), 0) + COALESCE((
         SELECT SUM(LENGTH(query) + 60) FROM search_tasks
       ), 0) AS bytes`
    ).first();
    return Number(row?.bytes || 0);
  } catch {
    return 0;
  }
}

export async function refreshUsage(env, { now = Date.now(), force = false } = {}) {
  const date = todayKey(now);
  const cached = await getMeta(env, 'usage_daily');
  if (!force && cached?.value) {
    try {
      const v = JSON.parse(cached.value);
      if (v.date === date && now - (v.updated_at || 0) < 10 * 60_000) {
        return { ...v, limits: FREE_TIER_LIMITS };
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
  };
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

export async function getRowsReadFresh(env, { now = Date.now(), maxAgeMs = 25 * 60_000 } = {}) {
  const date = todayKey(now);
  let v = null;
  try {
    const row = await getMeta(env, 'usage_daily');
    if (row?.value) v = JSON.parse(row.value);
  } catch {
    /* ignore */
  }
  if (
    v &&
    v.date === date &&
    typeof v.rows_read === 'number' &&
    now - (v.updated_at || 0) < maxAgeMs
  ) {
    return v.rows_read;
  }
  const a = await fetchD1Analytics(env, date);
  if (a && typeof a.rowsRead === 'number') {
    const next = {
      ...(v || {}),
      date,
      rows_read: a.rowsRead,
      rows_written: a.rowsWritten,
      updated_at: now,
    };
    try {
      await setMeta(env, 'usage_daily', JSON.stringify(next));
    } catch {
      /* ignore */
    }
    return a.rowsRead;
  }
  return v && v.date === date && typeof v.rows_read === 'number' ? v.rows_read : null;
}
