/**
 * هوش جستجوگر ۲ — Fast public page parser & Searcher-2 candidate verifier.
 * Zero heavy DOM tree building (stays well under Cloudflare Workers' 10ms CPU limit).
 */

import { contactLines, knownCity, sellsGoods, tradeEvidence } from './banks.js';
import { webAddressOf } from './classify.js';
import { decodeEntities } from './engines.js';

const WRITTEN_CHANNELS_RE =
  /(?:https?:\/\/)?((?:t\.me|telegram\.me|eitaa\.com|ble\.ir|rubika\.ir|splus\.ir)\/[A-Za-z0-9_@/]{3,80})/g;

const BLOCK_TAG_RE =
  /<\/?(?:p|div|br|li|tr|h[1-6]|section|article|footer|header|address|table|ul|ol|td|th)\b[^>]{0,200}>/gi;

/** Removes <script>, <style>, <noscript>, <svg>, <template>, <head> in O(N) time. */
function stripSilentBlocks(html) {
  const lower = html.toLowerCase();
  const tags = ['script', 'style', 'noscript', 'svg', 'template', 'head'];
  let cur = html;
  let curLow = lower;
  for (const tag of tags) {
    const open = `<${tag}`;
    const close = `</${tag}>`;
    if (!curLow.includes(open)) continue;
    let out = '';
    let pos = 0;
    while (pos < cur.length) {
      const start = curLow.indexOf(open, pos);
      if (start === -1) {
        out += cur.slice(pos);
        break;
      }
      // Make sure it's actually `<tag` followed by whitespace or `>`
      const after = curLow[start + open.length];
      if (after && !/[\s>/]/.test(after)) {
        out += cur.slice(pos, start + open.length);
        pos = start + open.length;
        continue;
      }
      out += cur.slice(pos, start);
      const end = curLow.indexOf(close, start + open.length);
      if (end === -1) {
        pos = cur.length;
      } else {
        pos = end + close.length;
      }
    }
    cur = out;
    curLow = cur.toLowerCase();
  }
  return cur;
}

function oneLine(s, max = 120) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max);
}

function stripAllTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]{0,400}>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(headChunk, attrName, attrValue) {
  const re = new RegExp(
    `<meta\\b[^>]{0,250}${attrName}=["']${attrValue}["'][^>]{0,250}content=["']([^"']{1,400})["'][^>]{0,120}>|` +
      `<meta\\b[^>]{0,250}content=["']([^"']{1,400})["'][^>]{0,250}${attrName}=["']${attrValue}["'][^>]{0,120}>`,
    'i'
  );
  const m = headChunk.match(re);
  return m ? decodeEntities((m[1] || m[2] || '').trim()) : '';
}

/**
 * Parses a fetched public page (HTML) into Searcher-2 features:
 * { title, site, table, text, links }
 */
export function parsePublicPage(pageUrl, rawHtml) {
  const html = String(rawHtml || '').slice(0, 180_000);
  const headChunk = html.slice(0, 35_000);

  const ogTitle = extractMeta(headChunk, 'property', 'og:title');
  const titleTagMatch = headChunk.match(/<title\b[^>]{0,100}>([\s\S]{0,300}?)<\/title>/i);
  const title = oneLine(ogTitle || (titleTagMatch ? stripAllTags(titleTagMatch[1]) : ''), 120);
  const site = oneLine(extractMeta(headChunk, 'property', 'og:site_name'), 40);
  const desc = [
    extractMeta(headChunk, 'property', 'og:description'),
    extractMeta(headChunk, 'name', 'description'),
  ]
    .filter(Boolean)
    .join('\n');

  // Check if any <table> contains "قیمت"
  let hasPriceTable = false;
  const tableRe = /<table\b[^>]{0,200}>([\s\S]{0,25000}?)<\/table>/gi;
  let tm;
  let tChecked = 0;
  while ((tm = tableRe.exec(html)) !== null && tChecked < 25) {
    tChecked++;
    if (tm[1].includes('قیمت')) {
      hasPriceTable = true;
      break;
    }
  }

  let base;
  try {
    base = new URL(pageUrl);
  } catch {
    base = null;
  }

  // Extract links from <a href="...">text</a>
  const links = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]{0,300}href=["']([^"']{1,400})["'][^>]{0,200}>([\s\S]{0,400}?)<\/a>/gi;
  let am;
  while ((am = anchorRe.exec(html)) !== null && links.length < 400) {
    const href = decodeEntities(am[1].trim());
    if (
      !href ||
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:') ||
      href.startsWith('tel:')
    ) {
      continue;
    }
    let resolved = webAddressOf(href);
    if (!resolved && base) {
      try {
        resolved = new URL(href, base).toString();
      } catch {
        continue;
      }
    }
    if (!resolved) continue;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      links.push({ url: resolved, text: oneLine(stripAllTags(am[2]), 120) });
    }
  }

  // Extract visible text
  const visibleHtml = stripSilentBlocks(html);
  const visibleWithBreaks = visibleHtml.replace(BLOCK_TAG_RE, '\n');
  const plain = decodeEntities(visibleWithBreaks.replace(/<[^>]{0,400}>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n[ \n]*/g, '\n')
    .trim()
    .slice(0, 60_000);

  // Plain-text channel URLs written without <a>
  WRITTEN_CHANNELS_RE.lastIndex = 0;
  let wm;
  let writtenCount = 0;
  while ((wm = WRITTEN_CHANNELS_RE.exec(plain)) !== null && writtenCount < 60) {
    writtenCount++;
    const resolved = `https://${wm[1]}`;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      links.push({ url: resolved, text: '' });
    }
  }

  const fullText = [desc, plain].filter(Boolean).join('\n');
  return {
    title,
    site,
    table: hasPriceTable,
    text: fullText,
    textLength: plain.length,
    links,
  };
}

/**
 * Evaluates a public page with IronPin2 Searcher-2 verification rules.
 */
export function judgePublicPage(pageUrl, rawHtml, customKeyword = '') {
  const page = parsePublicPage(pageUrl, rawHtml);
  const evidence = tradeEvidence(`${page.title}\n${page.text}`, customKeyword);
  const sells = sellsGoods(`${page.title}\n${page.text}`, customKeyword);
  const contact = contactLines(page.text);
  const city = knownCity(`${page.title}\n${page.site}\n${contact}`);
  return {
    title: page.title,
    site: page.site,
    table: page.table,
    sells,
    evidence,
    contact,
    city,
    textLength: page.textLength,
    links: page.links,
  };
}
