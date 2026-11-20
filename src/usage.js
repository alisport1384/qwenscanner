/** Cloudflare / D1 usage snapshot — daily token consumption + MB cap display. */

const DAY_MS = 24 * 3600_000;
const FREE_D1_CAP_BYTES = 500 * 1024 * 1024; // free tier storage cap

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

function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

/**
 * GraphQL: D1 rows read/written for a date range (requires CF_API_TOKEN secret).
 * Returns { rowsRead, rowsWritten } or null on any failure.
 */
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

/** GraphQL: worker invocations (requests) for today. */
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

/** D1 file size in bytes via REST (needs CF_API_TOKEN). */
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

/**
 * Build today's usage snapshot and persist to meta (idempotent per day unless force).
 * Returns { date, d1_bytes, d1_mb, cap_mb, cap_percent, rows_read, rows_written, requests, sources, knowledge, estimated_only }.
 */
export async function refreshUsage(env, { now = Date.now(), force = false } = {}) {
  const date = todayKey(now);
  const cached = await getMeta(env, 'usage_daily');
  if (!force && cached?.value) {
    try {
      const v = JSON.parse(cached.value);
      if (v.date === date && v.d1_bytes != null) return v;
    } catch {
      /* rebuild */
    }
  }

  const d1Bytes = (await fetchD1FileSize(env)) ?? (await estimateBytes(env));
  const estimatedOnly = (await fetchD1FileSize(env)) == null;
  const d1Analytics = await fetchD1Analytics(env, date);
  const requests = await fetchWorkerRequests(env, date);

  const sources = await count(env, 'sources');
  const knowledge = await count(env, 'knowledge');
  const pages = await count(env, 'pages');

  const snap = {
    date,
    updated_at: now,
    d1_bytes: d1Bytes,
    d1_mb: +(d1Bytes / (1024 * 1024)).toFixed(2),
    cap_mb: FREE_D1_CAP_BYTES / (1024 * 1024),
    cap_percent: +((d1Bytes / FREE_D1_CAP_BYTES) * 100).toFixed(2),
    rows_read: d1Analytics?.rowsRead ?? null,
    rows_written: d1Analytics?.rowsWritten ?? null,
    requests,
    sources,
    knowledge,
    pages,
    estimated_only: estimatedOnly,
    cf_api: Boolean(env.CF_API_TOKEN),
  };
  await setMeta(env, 'usage_daily', JSON.stringify(snap));
  return snap;
}

async function count(env, table) {
  try {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first();
    return r?.c || 0;
  } catch {
    return 0;
  }
}

async function estimateBytes(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT COALESCE((
         SELECT SUM(LENGTH(claim) + LENGTH(question) + LENGTH(tags) + LENGTH(topic) + LENGTH(url))
         FROM knowledge
       ), 0) + COALESCE((
         SELECT SUM(LENGTH(url) + LENGTH(COALESCE(title,'')) + LENGTH(COALESCE(source,'')) + chars)
         FROM pages
       ), 0) AS bytes`
    ).first();
    return Number(row?.bytes || 0);
  } catch {
    return 0;
  }
}

export async function getUsage(env, { now = Date.now() } = {}) {
  return refreshUsage(env, { now, force: false });
}

/**
 * Cheap today-rows-read for the cron read-budget guard:
 * 1 meta row read; refreshes via GraphQL (free, not D1) when older than maxAgeMs.
 * Never runs table COUNTs — safe to call every tick. Returns null when unknown.
 */
export async function getRowsReadFresh(env, { now = Date.now(), maxAgeMs = 30 * 60_000 } = {}) {
  const date = todayKey(now);
  let v = null;
  try {
    const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1')
      .bind('usage_daily')
      .first();
    if (row?.value) v = JSON.parse(row.value);
  } catch {
    /* over quota / missing */
  }
  if (
    v &&
    v.date === date &&
    typeof v.rows_read === 'number' &&
    now - (v.updated_at || 0) < maxAgeMs
  ) {
    return v.rows_read;
  }
  const a = await fetchD1Analytics(env, date); // GraphQL — free
  if (a && typeof a.rowsRead === 'number') {
    if (v && v.date === date) {
      v.rows_read = a.rowsRead;
      v.rows_written = a.rowsWritten;
      v.updated_at = now;
      try {
        await setMeta(env, 'usage_daily', JSON.stringify(v));
      } catch {
        /* ignore */
      }
    }
    return a.rowsRead;
  }
  return v && v.date === date && typeof v.rows_read === 'number' ? v.rows_read : null;
}
