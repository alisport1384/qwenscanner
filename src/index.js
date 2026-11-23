/**
 * Cloudflare Worker entrypoint — Strictly Searcher-2 (هوش جستجوگر ۲).
 */

import { handleApi } from './api.js';
import { runTick } from './finder.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Searcher-2 Worker online', { status: 200 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runTick(env, { now: Date.now(), forceTrigger: false }).catch((err) => {
        console.error('scheduled tick error:', err);
      })
    );
  },
};
