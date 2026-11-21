/**
 * نگهبان اسکنر — CPU / HTTP / D1-read / storage budgets.
 *
 * Four hard limits, minimal usage by default:
 *   1. CPU wall-clock   : every scheduled run stops at TICK_BUDGET_MS.
 *   2. Daily requests   : at most DAILY_FETCH_LIMIT outbound page fetches/day.
 *   3. D1 reads         : existing guard in index.js (rows_read > 4.5M → skip work).
 *   4. DB size          : existing retention.js (near free-tier cap → shorter TTL).
 * AI image extraction gets its own daily cap (IMAGE_EXTRACT_LIMIT).
 *
 * Counters live in meta under `guardian:YYYY-MM-DD` and are flushed once per
 * run (a crash under-counts — the caps stay soft by design; no extra D1 reads).
 */

const DAY_MS = 86_400_000;

export function dayKey(t = Date.now()) {
  return new Date(t).toISOString().slice(0, 10);
}

function intVar(env, name, fallback) {
  const v = parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Create a guardian bound to `env`; call load-less (constructor reads meta once). */
export async function createGuardian(env, { now = Date.now() } = {}) {
  const tickMs = intVar(env, 'TICK_BUDGET_MS', 18_000);
  const fetchLimit = intVar(env, 'DAILY_FETCH_LIMIT', 700);
  const aiLimit = intVar(env, 'IMAGE_EXTRACT_LIMIT', 60);
  const key = `guardian:${dayKey(now)}`;

  let fetched = 0;
  let aiUsed = 0;
  try {
    const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first();
    if (row?.value) {
      const v = JSON.parse(row.value);
      fetched = Number.isFinite(v?.fetched) ? v.fetched : 0;
      aiUsed = Number.isFinite(v?.ai) ? v.ai : 0;
    }
  } catch {
    /* fresh day */
  }

  const deadline = now + tickMs;
  let dirty = false;

  return {
    key,
    /** Wall-clock deadline of THIS run. */
    expired: (at = Date.now()) => at >= deadline,
    deadline: () => deadline,

    fetchLeft: () => Math.max(0, fetchLimit - fetched),
    allowFetch: (n = 1) => fetched + n <= fetchLimit,
    spendFetch: (n = 1) => {
      fetched += n;
      dirty = true;
    },

    aiLeft: () => Math.max(0, aiLimit - aiUsed),
    allowAi: (n = 1) => aiUsed + n <= aiLimit,
    spendAi: (n = 1) => {
      aiUsed += n;
      dirty = true;
    },

    stats: () => ({
      key,
      fetched,
      ai_used: aiUsed,
      fetch_limit: fetchLimit,
      ai_limit: aiLimit,
      deadline,
      tick_ms: tickMs,
      remaining_today: Math.max(0, fetchLimit - fetched),
      day_ms: DAY_MS,
    }),

    /** Persist today's counters — one write, once per run. */
    async flush(db = env.DB) {
      if (!dirty) return false;
      dirty = false;
      try {
        await db
          .prepare(
            `INSERT INTO meta (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                             updated_at = excluded.updated_at`
          )
          .bind(key, JSON.stringify({ fetched, ai: aiUsed, date: dayKey() }), Date.now())
          .run();
        return true;
      } catch (e) {
        console.error('guardian flush failed', e);
        return false;
      }
    },
  };
}
