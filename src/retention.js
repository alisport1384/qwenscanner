/** Price-data retention for D1 free tier.
 *  Near free-cap MB → purge price rows older than 3 days.
 *  Otherwise every 31 days → purge price rows older than 24 hours.
 */

const DAY_MS = 24 * 3600_000;
const DEFAULT_CYCLE_DAYS = 31;

/** Free D1 cap is 500MB; treat ≥90% as «before reaching free cap». */
const FREE_TIER_BYTES = 500 * 1024 * 1024;
const NEAR_CAP_RATIO = 0.9;

function intVar(env, name, fallback) {
  const v = parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
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

/** Configurable retention cycle in days (meta: retention_cycle_days, default 31). */
export async function getRetentionCycleDays(env) {
  const m = await getMeta(env, 'retention_cycle_days');
  const d = parseInt(String(m?.value ?? ''), 10);
  return Number.isFinite(d) && d >= 1 && d <= 3650 ? d : DEFAULT_CYCLE_DAYS;
}

export async function setRetentionCycleDays(env, days) {
  const d = parseInt(String(days ?? ''), 10);
  if (!Number.isFinite(d) || d < 1 || d > 3650) {
    throw new Error('retention_cycle_days must be 1..3650');
  }
  await setMeta(env, 'retention_cycle_days', String(d));
  return d;
}

/** Approximate stored bytes: knowledge text + page chars. */
export async function estimateDbBytes(env) {
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

/** Price rows ONLY — attribute/layer/tags marked price.
 *  NEVER matches claim text (technical docs mentioning «قیمت» stay). */
const PRICE_DELETE_STRICT = `
  DELETE FROM knowledge
  WHERE last_verified_at < ?1
    AND (
      attribute = 'price'
      OR layer = 'price'
      OR tags LIKE '%"price"%'
    )`;

/**
 * MANUAL price retention — only runs when explicitly invoked.
 * Deletes price-tagged knowledge older than `olderThanDays` (default from settings).
 * Never touches non-price (technical/explanatory) rows.
 * Returns { mode, cutoff, deleted, bytes, older_than_days }.
 */
export async function deleteOldPrices(env, { now = Date.now(), olderThanDays = null } = {}) {
  const days = olderThanDays ?? (await getRetentionCycleDays(env));
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw new Error('olderThanDays must be 1..3650');
  }
  const cutoff = now - days * DAY_MS;
  const bytes = await estimateDbBytes(env);
  let deleted = 0;
  try {
    const res = await env.DB.prepare(PRICE_DELETE_STRICT).bind(cutoff).run();
    deleted = res?.meta?.changes ?? res?.changes ?? 0;
  } catch (e) {
    console.error('manual price delete failed', e);
    throw e;
  }
  await setMeta(
    env,
    'price_retention',
    JSON.stringify({
      last_run: now,
      mode: 'manual',
      cutoff,
      deleted,
      bytes,
      older_than_days: days,
      scope: 'price_only',
    })
  );
  return { mode: 'manual', cutoff, deleted, bytes, older_than_days: days };
}

/** @deprecated auto path kept as no-op — deletion is manual-only now. */
export async function runPriceRetention() {
  return { mode: 'disabled_auto', cutoff: 0, deleted: 0, auto: false };
}

export async function getRetentionState(env) {
  const meta = await getMeta(env, 'price_retention');
  try {
    return JSON.parse(meta?.value || 'null');
  } catch {
    return null;
  }
}
