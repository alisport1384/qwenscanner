/** IronPin seed — first-tick bootstrap of sources + product price batch.
 *  Port knowledge from alisport1384/IronPin into the Qwen scanner.
 */

import { ENDPOINTS, REGISTRY, PRODUCT_PAGES, PRODUCTS } from './ironpin_data.js';
import { EXTRA_PRICE_TOPICS, CATALOG_SEED_KEY, CATALOG_VERSION } from './product_catalog.js';
import { classifyLink, ensureHarvestScan, previewUrl } from './finder.js';

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

function normalizeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Merge seed endpoint lists into unique http URLs with metadata. */
export function collectSeedUrls() {
  const byUrl = new Map();
  const put = (url, name, kind, origin) => {
    const u = normalizeHttpUrl(url);
    if (!u) return;
    if (!byUrl.has(u)) {
      byUrl.set(u, { url: u, name: name || '', kind: kind || 'site', origin });
    }
  };
  for (const e of ENDPOINTS) put(e.url, e.name, 'endpoint', 'ironpin_endpoints');
  for (const s of REGISTRY) put(s.url, s.name || s.owner || '', s.platform ? 'channel' : 'site', 'ironpin_registry');
  for (const p of PRODUCT_PAGES) put(p.url, p.title || '', 'product_page', 'ironpin_product_pages');
  return [...byUrl.values()];
}

/**
 * Idempotent seed:
 *  1) sources table ← IronPin endpoints/registry/product pages
 *  2) batch of product price topics (auto-refresh 24h)
 *  3) harvest scan pre-filled with seed URLs (direct fetch, no SERP)
 * Returns { seeded, sources, batch_id, harvest_scan_id } or null if already done.
 */

/** Insert EXTRA_PRICE_TOPICS into a dedicated batch once (catalog v2). */
async function topUpCatalogTopics(env, now) {
  const batchId = crypto.randomUUID();
  const insertScan = env.DB.prepare(
    `INSERT INTO scans (id, batch_id, topic, status, phase, auto_refresh, refresh_hours,
                        next_refresh_at, engines_used, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'queued', 'search', 1, 24, ?4, '[]', ?5, ?5)`
  );
  const stmts = [
    env.DB.prepare(
      `INSERT INTO batches (id, title, topics_count, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`
    ).bind(batchId, 'IronPin — سایر محصولات (کاتالوگ v2)', EXTRA_PRICE_TOPICS.length, now),
  ];
  for (const topic of EXTRA_PRICE_TOPICS) {
    stmts.push(insertScan.bind(crypto.randomUUID(), batchId, topic, now + 3600_000, now));
  }
  await env.DB.batch(stmts);
  await setMeta(env, CATALOG_SEED_KEY, JSON.stringify({
    version: CATALOG_VERSION, batch_id: batchId, topics: EXTRA_PRICE_TOPICS.length, at: now,
  }));
  return { batch_id: batchId, topics: EXTRA_PRICE_TOPICS.length };
}

export async function ensureIronPinSeed(env, { now = Date.now() } = {}) {
  const flag = await getMeta(env, 'ironpin_seeded');
  if (flag?.value) {
    try {
      const v = JSON.parse(flag.value);
      if (v.done) {
        // Catalog top-up (v2): extra price topics once
        const cat = await getMeta(env, CATALOG_SEED_KEY);
        if (!cat?.value) {
          const top = await topUpCatalogTopics(env, now);
          return { seeded: false, ...v, catalog_topup: top };
        }
        return { seeded: false, ...v };
      }
    } catch {
      /* re-seed */
    }
  }

  const seeds = collectSeedUrls();
  const insertSrc = env.DB.prepare(
    `INSERT INTO sources (url, domain, kind, part, name, key, readable, origin, state, created_at, last_checked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'seed', ?9, ?9)
     ON CONFLICT(key) DO NOTHING`
  );

  const srcStmts = [];
  let sourceCount = 0;
  for (const s of seeds) {
    const link = classifyLink(s.url);
    const key = link?.key || `raw:${s.url}`;
    const domain = (() => {
      try {
        return new URL(s.url).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })();
    const kind = link?.kind || s.kind;
    const part = link?.part ?? 0;
    const readable = link ? (link.readable ? 1 : 0) : 1;
    srcStmts.push(
      insertSrc.bind(
        s.url,
        domain,
        kind,
        part,
        s.name,
        key,
        readable,
        s.origin,
        now
      )
    );
    sourceCount++;
  }
  for (let i = 0; i < srcStmts.length; i += 50) {
    await env.DB.batch(srcStmts.slice(i, i + 50));
  }

  // Product price batch — topics from FinderPlan.products
  const batchId = crypto.randomUUID();
  const topics = PRODUCTS.map((p) => `قیمت ${p} امروز`);
  const insertScan = env.DB.prepare(
    `INSERT INTO scans (id, batch_id, topic, status, phase, auto_refresh, refresh_hours,
                        next_refresh_at, engines_used, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'queued', 'search', 1, 24, ?4, '[]', ?5, ?5)`
  );
  const batchStmts = [
    env.DB.prepare(
      `INSERT INTO batches (id, title, topics_count, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`
    ).bind(batchId, 'IronPin — قیمت فولاد', topics.length, now),
  ];
  for (const topic of topics) {
    batchStmts.push(insertScan.bind(crypto.randomUUID(), batchId, topic, now + 3600_000, now));
  }

  // Harvest scan with seed URLs as direct pages (skip SERP)
  const harvestId = await ensureHarvestScan(env, now);
  const insertPage = env.DB.prepare(
    `INSERT INTO pages (scan_id, url, domain, title, source, query, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'ironpin_seed', 'seed', 'pending', ?5)
     ON CONFLICT(scan_id, url) DO NOTHING`
  );
  for (const s of seeds) {
    const link = classifyLink(s.url);
    const fetchUrl = link ? previewUrl(link.kind, s.url) : s.url;
    let domain = '';
    try {
      domain = new URL(fetchUrl).hostname.replace(/^www\./, '');
    } catch {
      domain = '';
    }
    batchStmts.push(insertPage.bind(harvestId, fetchUrl, domain, s.name || '', now));
  }

  await env.DB.batch(batchStmts);

  const result = {
    done: true,
    seeded: true,
    sources: sourceCount,
    batch_id: batchId,
    harvest_scan_id: harvestId,
    topics: topics.length,
  };
  await setMeta(env, 'ironpin_seeded', JSON.stringify(result));
  return result;
}
