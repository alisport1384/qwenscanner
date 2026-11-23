/**
 * PublicTables — header-driven HTML table price-list reader.
 * Port of IronPin lib/data/public_tables.dart (heading-owned mode) into the
 * online scanner. No DOM dependency: tables are located with a tag scanner.
 *
 * Rules mirrored from the app:
 *  - a table is a price list only when its header row/thead/all-th row carries
 *    a «قیمت» column + at least one describing column, and NO statistic
 *    column (میانه/میانگین/کمترین/بیشترین/بازه) — history and stats tables
 *    are not read;
 *  - the product of a generic seller table comes from: the row's own product
 *    cell, a hidden «نام کالا : …» cell, the table's <caption>, or the nearest
 *    preceding h1-h6/<header> that NAMES a product (a title announcing
 *    «میانه/نمودار/روند/تاریخچه/پیش‌بینی» disowns what follows);
 *  - a one-cell row with «آخرین بروز رسانی: …» dates the table; a short dated
 *    block before the table does the same; a date never comes from the clock;
 *  - currency comes ONLY from the price header/cell — never from the size of
 *    the number; Rial amounts stay Rial here (÷10 happens in ironpin.js);
 *  - a row whose price cell holds «استعلام/تماس/ناموجود» or several amounts
 *    is not a price and gets no amount;
 *  - one heading that owns several indistinguishable tables (no brand, no
 *    product in the rows) owns none of them;
 *  - word «ورق» inherits the sheet kind (سیاه/روغنی/…) from a nearby heading.
 */

import { normalizeText, priceUnit, dateIn, currencyNear } from './text_engine.js';

const PRICE_COL_RE = /^قیمت(?:\s|\(|$)/;
const ATTRIBUTE_COL_RE = /سایز|ضخامت|برند|کارخانه|تولید کننده|استاندارد|آنالیز|محل تحویل|بارگیری|واحد|حالت|وزن|نام|محصول|کالا|شرح|ابعاد|طول|عرض|گرید/;
const STATISTIC_COL_RE = /^(?:میانگین|میانه|کمترین|بیشترین|بازه)(?:\s|$)/;
const STATISTIC_TITLE_RE = /میانه|میانگین|نمودار|روند|مقایسه|تاریخچه|پیش‌بینی|پیش بینی/;
const NAME_LABEL_RE = /^\s*نام\s*(?:کالا|محصول)\s*[:：]\s*/;

const PRODUCT_RE =
  /انکر\s*بولت|انکربولت|رول\s*بولت|بولت|میلگرد(?:\s+بستر)?|میل(?:\s*استیل)?(?![ی])|تیر\s*آهن|تیراهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|مانیسمان|اسپیرال|\bERW\b|\bAPI\b|\bSCH\b|ورق|پلیت|صفحه\s+(?:فولادی|آهنی|فلزی)|شیت|چهارپهلو|شش\s*پر|مفتول|تسمه|سپری|رابیتس|توری|مش\s*جوشی|گابیون|حصاری|شمش|بیلت|بلوم|اسلب|قراضه|گندله|بریکت|فرو\s*آلیاژ|\bDRI\b|آهن\s*اسفنجی/;
const NON_METAL_RE =
  /قرص|کپسول|شیرخشک|قهوه|چای|دارو|ویتامین|مکمل|کاغذ|مقوا|MDF|ام‌دی‌ف|پلاستیک|پارچه|پشم|سنگ|سیمان|گچ|آجر|شیشه|پلیمر|لاستیک|لاک|رنگ|روغن\s+(?:خوراکی|سرخ\s*کردن)|عسل|برنج|گندم|ذرت|سویا|مرغ|گوشت|ماهی|شیر|پنیر|میوه|سبزی/;

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export function toLatinDigits(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, (c) => FA_DIGITS.indexOf(c))
    .replace(/[٠-٩]/g, (c) => AR_DIGITS.indexOf(c));
}
export function number(s) {
  const n = parseFloat(
    toLatinDigits(String(s || '')).replace(/[,٬ ]/g, '').replace(/٫/g, '.')
  );
  return Number.isFinite(n) ? n : null;
}

function latin(s) {
  return String(s || '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک');
}
const decodeEntities = (s) =>
  String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&zwnj;/gi, '‌')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

const stripTags = (s) =>
  decodeEntities(
    String(s || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

/** Family of the product vocabulary, or '' (port of ProductText.category). */
export function categoryOf(text) {
  const m = PRODUCT_RE.exec(latin(toLatinDigits(normalizeText(String(text || '')))));
  if (!m) return '';
  return m[0].replace(/\s+/g, ' ').trim();
}

const CATEGORY_FAMILIES = [
  ['میلگرد', /میلگرد/], ['میل استیل', /میل\s*استیل/], ['تیرآهن', /تیر\s*آهن|تیراهن/],
  ['هاش', /هاش/], ['ناودانی', /ناودانی/], ['نبشی', /نبشی/], ['پروفیل', /پروفیل/],
  ['قوطی', /قوطی/], ['لوله', /لوله|مانیسمان|اسپیرال|ERW|API|SCH/], ['ورق', /ورق/],
  ['پلیت', /پلیت|صفحه\s+(?:فولادی|آهنی|فلزی)/], ['شیت', /شیت/], ['چهارپهلو', /چهارپهلو/],
  ['شش پر', /شش\s*پر/], ['مفتول', /مفتول/], ['تسمه', /تسمه/], ['سپری', /سپری/],
  ['رابیتس', /رابیتس/], ['توری', /توری|حصاری|گابیون|مش\s*جوشی/], ['شمش', /شمش|بیلت|بلوم|اسلب/],
  ['قراضه', /قراضه/], ['بولت', /بولت/], ['آهن اسفنجی', /آهن\s*اسفنجی|DRI/],
  ['گندله', /گندله/], ['بریکت', /بریکت/], ['فروآلیاژ', /فرو\s*آلیاژ/],
];
/** Canonical family name for a matched product phrase. */
export function familyOf(text) {
  const s = latin(toLatinDigits(String(text || '')));
  for (const [fam, re] of CATEGORY_FAMILIES) if (re.test(s)) return fam;
  return '';
}

/** FNV-1a 32-bit (TextPriceEngine.key). */
export function keyHash(value) {
  let n = 2166136261;
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    n ^= s.charCodeAt(i);
    n = Math.imul(n, 16777619) >>> 0;
  }
  // include full unicode by hashing code units of utf8 — good enough for ids
  return (n >>> 0).toString(16);
}

/** Product phrase of a heading (port of PublicTables.ownerPhrase). */
export function ownerPhrase(heading) {
  const s = latin(toLatinDigits(normalizeText(String(heading || ''))));
  const parts = s
    .split(/[|·•:؛(\[+]| - | – /)
    .map((p) => p.trim())
    .filter((p) => familyOf(p));
  if (!parts.length) return '';
  let phrase = parts[0]
    .replace(/^(?:(?:جدول|لیست|آخرین)\s+)?قیمت\s+(?:(?:روز|امروز|خرید|فروش)\s+)?/, '')
    .replace(/\s+(?:امروز|به تفکیک|در بازار|بازار|همه|تمام|کلیه)(?:\s.*)?$/, '')
    .trim();
  const m = PRODUCT_RE.exec(phrase);
  const startsAtZero = m && m.index === 0;
  if (phrase.length > 48 || !startsAtZero) return '';
  return phrase;
}

function materialOf(title) {
  const t = `${latin(title)}`;
  if (/استیل|استنلس/i.test(t)) return 'استنلس استیل';
  if (/آلومینیوم/.test(t)) return 'آلومینیوم';
  if (/آلیاژ|MO40|CK45|A516/i.test(t)) return 'فولاد آلیاژی';
  return 'فولاد کربنی';
}

function parseUnit(v) {
  const s = latin(String(v || ''));
  if (s.includes('کیلو') || s === 'kg') return 'kg';
  if (s.includes('مترمربع') || s.includes('متر مربع')) return 'm2';
  if (s.includes('شاخه') || /^(?:هر\s+)?عدد$/.test(s.trim())) return 'piece';
  if (s === 'متر') return 'm';
  if (s === 'تن') return 'ton';
  if (s.includes('برگ') || /ورق|شیت/.test(s)) return 'sheet';
  if (s.includes('رول')) return 'roll';
  return 'unknown';
}

function taxOf(text) {
  const without = /بدون\s*(?:ارزش\s*افزوده|مالیات)|ارزش\s*افزوده\s*جدا|به\s*علاوه\s*(?:مالیات|ارزش\s*افزوده)/.test(text);
  const included = /(?:با|شامل|احتساب)\s*(?:ارزش\s*افزوده|مالیات)/.test(text);
  return without === included ? 'نامشخص' : without ? 'بدون ارزش افزوده' : 'با ارزش افزوده';
}

const DATE_INT_RE = /(1[34]\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/;

/** Locate all <table>…</table> blocks in document order (nesting-safe). */
export function locateTables(html) {
  const out = [];
  const re = /<table\b[^>]*>|<\/table>/gi;
  let m;
  const stack = [];
  while ((m = re.exec(html))) {
    const tag = m[0].toLowerCase();
    if (tag.startsWith('</')) {
      if (stack.length) {
        const start = stack.pop();
        if (stack.length === 0) out.push({ start, end: m.index + m[0].length });
      }
    } else {
      stack.push(m.index);
    }
  }
  return out;
}

/** Remove nested tables (replace with space) so rows are single-level. */
function unwrapNestedTables(block) {
  const parts = locateTables(block);
  if (!parts.length) return block;
  // keep only the outermost — inner content replaced with space, same length-ish
  let s = block;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    s = s.slice(0, p.start) + ' ' + s.slice(p.end);
  }
  return s;
}

/** Extract rows of a table block: [{cells:[{text,tag}], index}] */
function tableRows(block) {
  const inner = unwrapNestedTables(block);
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  let idx = 0;
  while ((m = trRe.exec(inner))) {
    const rowHtml = m[1];
    const cells = [];
    const cellRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let c;
    while ((c = cellRe.exec(rowHtml))) {
      cells.push({ text: stripTags(c[2]), tag: c[1].toLowerCase() });
    }
    if (cells.length) rows.push({ cells, index: idx });
    idx++;
  }
  return rows;
}

function tableCaption(block) {
  const m = /<caption\b[^>]*>([\s\S]*?)<\/caption>/i.exec(block);
  return m ? stripTags(m[1]) : '';
}

/** Every h1-h6/header block in the document, in order. */
export function headingBlocks(html) {
  const out = [];
  const re = /<(h[1-6]|header)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push({ tag: m[1].toLowerCase(), index: m.index, text: stripTags(m[2]) });
  }
  return out;
}

/** Short dated blocks before `upto` — «آخرین بروز رسانی: ۱۴۰۵/۰۹/۰۱» etc. */
export function precedingDateBlock(html, upto, datePattern) {
  const from = Math.max(0, upto - 6000);
  const window_ = html.slice(from, upto);
  const re = /<(p|li|div|span|td|h[1-6]|header|time|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  let found = null;
  while ((m = re.exec(window_))) {
    const text = stripTags(m[2]);
    if (!text || text.length > 120) continue;
    const hit = datePattern.exec(text);
    if (!hit) continue;
    if (
      text === hit[0] ||
      /^(?:شنبه|یکشنبه|دوشنبه|سه\s*شنبه|چهارشنبه|پنج\s*شنبه|جمعه)\s/.test(text) ||
      /تاریخ|بروزرسانی|بروز\s*رسانی|به\s*روز|لیست\s*قیمت/.test(text)
    ) {
      found = { text, raw: hit[0] };
    }
  }
  return found;
}

/** UI toggle / checkbox labels — «نمایش قیمت با ارزش افزوده» is a switch, not a price basis. */
const TAX_TOGGLE_RE = /نمایش\s*قیمت|تیک\s*بزنید|checkbox|toggle/i;

/**
 * Page-wide tax basis declaration, e.g. «قیمت … بدون ارزش افزوده می‌باشد».
 * Scans the whole document text; statements (they carry a verb) win, UI
 * toggles are ignored. Last statement wins. Returns 'نامشخص' when none.
 */
export function pageTaxDeclaration(cleanedHtml) {
  const text = String(cleanedHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const re = /[^.!?؟]{0,100}?(?:بدون\s*(?:ارزش\s*افزوده|مالیات)|(?:با|شامل|احتساب)\s*(?:ارزش\s*افزوده|مالیات))[^.!?؟]{0,60}?(?:می\s*باشد|میباشد|است|هستند|خواهد\s*بود|خواهند\s*بود)/g;
  let m;
  let found = 'نامشخص';
  while ((m = re.exec(text))) {
    const s = m[0];
    if (TAX_TOGGLE_RE.test(s)) continue;
    const tax = taxOf(s);
    if (tax !== 'نامشخص') found = tax;
  }
  return found;
}

/** Last short tax-declaring block before `upto`, or 'نامشخص'. */
export function precedingTaxBlock(html, upto, pageWide = 'نامشخص') {
  const from = Math.max(0, upto - 6000);
  const window_ = html.slice(from, upto);
  const re = /<(p|li|div|span|td|h[1-6]|header)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  let found = 'نامشخص';
  while ((m = re.exec(window_))) {
    const text = stripTags(m[2]);
    if (!text || text.length > 120) continue;
    if (TAX_TOGGLE_RE.test(text)) continue; // UI toggle, نه مبنای قیمت
    const tax = taxOf(text);
    if (tax !== 'نامشخص') found = tax;
  }
  return found !== 'نامشخص' ? found : pageWide;
}

const SHEET_KIND_RE = /سیاه|روغنی|گالوانیزه|آجدار|استیل|رنگی/;

/** Nearest heading before `upto` that names a sheet kind. */
export function sheetKindBefore(html, upto) {
  const headings = headingBlocks(html.slice(0, upto));
  let kind = '';
  for (const h of headings) {
    if (!h.text.includes('ورق')) continue;
    if (!/^(h[1-6]|header)$/.test(h.tag) && !h.text.startsWith('لیست قیمت')) continue;
    const m = SHEET_KIND_RE.exec(h.text);
    if (m) kind = m[0];
  }
  return kind;
}

/**
 * Owner (product phrase) of the tables after this point in the document:
 * the last h1-h6/header that names a product; a statistic title disowns.
 */
export function ownerBefore(html, upto) {
  const headings = headingBlocks(html.slice(0, upto));
  let owner = '';
  for (const h of headings) {
    if (h.text.length >= 160) continue;
    if (STATISTIC_TITLE_RE.test(h.text)) {
      owner = '';
      continue;
    }
    const phrase = ownerPhrase(h.text);
    if (phrase) owner = phrase;
  }
  return owner;
}

const DATE_PATTERN =
  /(?:1[34]\d{2})[/.\-]\d{1,2}[/.\-]\d{1,2}|\d{1,2}\s+(?:فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s+(?:ماه\s+)?1[34]\d{2}|20\d{2}-\d{2}-\d{2}/;

function isoDate(cell) {
  if (!cell) return null;
  const d = dateIn(cell);
  return d || null;
}

/** A row that only carries a «بروز رسانی» date dates the table, not a price. */
function singleCellDate(rows) {
  for (const row of rows) {
    if (row.cells.length !== 1) continue;
    const t = latin(row.cells[0].text);
    if (t.length >= 200) continue;
    if (!/بروز|به\s*روز|تاریخ/.test(t)) continue;
    const m = DATE_PATTERN.exec(t);
    if (!m) continue;
    const d = dateIn(t);
    if (d) return { date: d, raw: m[0] };
  }
  return null;
}

/**
 * Read every price table of an HTML document.
 * ctx: { endpoint, seller, sellerCity, sourceUrl, fetchedAt, category ('' = auto),
 *        defaultCurrency (source-declared), maxRows }
 * Returns Quote rows (same shape as text_engine analyzeText output).
 */
export function readTables(html, ctx = {}) {
  if (!html || typeof html !== 'string') return [];
  const endpoint = ctx.endpoint || 'qwen-scanner';
  const seller = ctx.seller || '';
  const sellerCity = ctx.sellerCity || 'نامشخص';
  const sourceUrl = ctx.sourceUrl || '';
  const fetchedAt = Number.isFinite(+ctx.fetchedAt) ? +ctx.fetchedAt : Date.now();
  const wantedCategory = ctx.category || 'عمومی';
  const defaultCurrency = ctx.defaultCurrency || 'نامشخص';
  const maxRows = ctx.maxRows || 2000;
  // 默认上限提高到 2000：ahanmelal 仅钢筋页就有 334 行，300 会白白截断。

  const cleaned = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|nav|footer|aside)[\s\S]*?<\/\1>/gi, ' ');

  const tableBlocks = locateTables(cleaned).map((b) => ({ ...b, kind: 'table' }));
  const gridBlocks = locateDivGrids(cleaned);
  const blocks = [...tableBlocks, ...gridBlocks].sort((a, b) => a.start - b.start);
  const out = [];
  const pageWideTax = pageTaxDeclaration(cleaned);
  const seen = new Map();
  let tableIndex = 0;
  // owner groups: identical heading-owned tables whose rows can't be told
  // apart are all dropped — their difference is not written where we read.
  const ownedGroups = new Map();

  for (const block of blocks) {
    const raw = cleaned.slice(block.start, block.end);
    const isGrid = block.kind === 'grid';
    const owner = ownerBefore(cleaned, block.start);
    const caption = ownerPhrase(tableCaption(raw));
    const headingDate = precedingDateBlock(cleaned, block.start, DATE_PATTERN);
    let precedingTax = precedingTaxBlock(cleaned, block.start, pageWideTax);
    let precedingDate = headingDate?.date || null;
    const rawDate = headingDate?.raw || '';
    // A caption that says more than the heading wins («تیرآهن 14» > «تیرآهن»).
    const tableOwner = caption && !(owner && owner.includes(caption)) ? caption : owner;
    const sheetKind = sheetKindBefore(cleaned, block.start);

    const rows = isGrid ? divGridRows(cleaned, block) : tableRows(raw);
    if (!rows.length) { tableIndex++; continue; }

    // Table-level date: one-cell «آخرین بروز رسانی» row.
    const tableDate = singleCellDate(rows);
    if (tableDate) precedingDate = tableDate.date;

    // Identify header row.
    let headers = null;
    let headerSet = false;
    for (const row of rows) {
      const text = row.cells.map((c) => latin(toLatinDigits(c.text)));
      const hasPrice = text.some((s) => PRICE_COL_RE.test(s));
      const hasAttr = text.some(
        (s) => !PRICE_COL_RE.test(s) && ATTRIBUTE_COL_RE.test(s)
      );
      const allTh = row.cells.every((c) => c.tag === 'th');
      const isHeadRow =
        row.index === 0 || (row.cells.length >= 2 && allTh) ||
        (row.cells.length >= 2 && hasPrice && hasAttr);
      if (hasPrice && hasAttr && !text.some((s) => STATISTIC_COL_RE.test(s))) {
        if (isHeadRow || headers == null) {
          headers = text;
          headerSet = true;
          continue;
        }
      }
      if (headerSet && headers) break;
    }
    if (!headers) { tableIndex++; continue; }

    const local = [];

    for (const row of rows) {
      const text = row.cells.map((c) => latin(toLatinDigits(c.text)));
      // Header rows already consumed; skip them in body.
      if (text.some((s) => PRICE_COL_RE.test(s)) && text.some((s) => ATTRIBUTE_COL_RE.test(s) && !PRICE_COL_RE.test(s))) {
        if (row.cells.every((c) => c.tag === 'th') || row.index === 0) continue;
      }
      if (text.some((s) => NON_METAL_RE.test(s))) continue;
      if (row.cells.length !== headers.length && row.cells.length < headers.length) continue;
      if (row.cells.length > headers.length + 2) continue;

      const field = (pattern) => {
        const i = headers.findIndex((h) => new RegExp(pattern).test(h));
        return i < 0 ? '' : text[i] || '';
      };

      // Name the row: its own product cell, a «نام کالا» cell, or the table owner.
      const wantedFamily = wantedCategory === 'عمومی' ? '' : (familyOf(wantedCategory) || wantedCategory);
      let title = text.find((s) => {
        const f = familyOf(s);
        return f && (!wantedFamily || f === wantedFamily);
      }) || '';
      let titleBasis = '';
      let rowInherited = false;
      if (title) {
        const named = title.replace(NAME_LABEL_RE, '');
        if (named !== title) { title = named; titleBasis = 'سلول نام کالا در همان ردیف'; }
      } else if (tableOwner) {
        const size = field('^(?:سایز|ابعاد)');
        const maker = field('برند|کارخانه|تولید کننده');
        title = [
          tableOwner,
          size && !tableOwner.includes(size) ? size : '',
          maker && !tableOwner.includes(maker) ? maker : '',
        ].filter(Boolean).join(' ');
        titleBasis = caption && tableOwner === caption ? 'عنوان جدول' : 'سرعنوان پیش از جدول';
        rowInherited = !maker;
      }
      if (!title) continue;
      if (sheetKind && familyOf(title) === 'ورق' && !title.includes(sheetKind)) {
        title = title.replace('ورق', `ورق ${sheetKind}`);
      }

      const rowCategory = familyOf(title) || categoryOf(title);
      if (!rowCategory) continue;

      const priceCell = field('^قیمت(?:\\s|\\(|$)');
      const priceHeader = headers.find((h) => PRICE_COL_RE.test(h)) || '';
      const priceText = `${priceHeader} ${priceCell}`;
      let cur = 'نامشخص';
      const t = /تومان/.test(priceText), r = /ریال/.test(priceText);
      if (t !== r) cur = t ? 'تومان' : 'ریال';
      const amountMatches = [...String(priceCell).matchAll(/(?<![\d.])(?:\d{1,3}(?:[,٬.]\d{3})+(?:٫\d+)?|\d{1,3}(?: \d{3})+|\d+(?:[٫.]\d+)?)(?![\d.,٬])/g)];
      const rawPrice = amountMatches.length === 1 ? amountMatches[0][0] : priceCell;
      const isQuoteWanted = /استعلام|تماس|ناموجود/.test(priceCell);
      const amount =
        isQuoteWanted || amountMatches.length !== 1 ? null : number(rawPrice);
      const valid = amount != null && Number.isFinite(amount) && amount > 0;

      const unitText = field('^واحد(?:\\s|$)');
      const cellUnit = parseUnit(unitText);
      const headerUnit = priceUnit(priceHeader);
      const unit = cellUnit !== 'unknown' ? cellUnit : headerUnit;

      const thicknessRaw = field('ضخامت');
      const thickness = number(thicknessRaw) != null ? String(number(thicknessRaw)) : ((/ضخامت\s*[:：]?\s*([\d.]+)/.exec(title) || [])[1] || '');
      const width = field('عرض');
      const length = field('طول');
      const lengthHeader = headers.find((h) => h.includes('طول')) || '';
      const dimsCell = field('ابعاد');
      const sizeField = field('^(?:سایز|نمره)(?:\\s|$)');
      const dimensionRe = /\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)?/i;
      const dims = dimsCell && dimensionRe.test(dimsCell)
        ? dimsCell.match(dimensionRe)[0]
        : dimensionRe.test(sizeField)
          ? sizeField.match(dimensionRe)[0]
          : width && length
            ? `${length} × ${width}`
            : '';
      const sizeMatch = /(?:سایز|نمره|میلگرد|حرارتی|تیرآهن|تیر آهن|نبشی|ناودانی)\s*(\d+(?:[٫.]\d+)?)/.exec(title);
      const sizeCellMatch = /(\d+(?:[.٫]\d+)?)/.exec(sizeField);
      const size = sizeMatch ? sizeMatch[1] : sizeCellMatch ? sizeCellMatch[1] : '';

      const rowDateCell = field('تاریخ|بروزرسانی|بروز\\s*رسانی|به\\s*روز');
      const announced = rowDateCell ? isoDate(rowDateCell) : tableDate?.date || precedingDate;
      const announcedRaw = rowDateCell || tableDate?.raw || rawDate;

      const brand = field('برند|کارخانه|تولید کننده');
      const grade = field('گرید|استاندارد|آنالیز');
      const loading = field('بارگیری|محل تحویل');
      const rowTax = taxOf(field('مالیات|ارزش افزوده'));
      const tax = rowTax !== 'نامشخص' ? rowTax : precedingTax;
      const scope = isGrid ? '' : tableCaption(raw);

      const identity = `${tableIndex}|${title}|${brand}|${dims}|${unit}|${cur}`;
      // 无价（تماس/استعلام）行直接跳过——产品只出「有价可比」的行。
      if (!valid || amount == null) continue;
      const count = seen.get(identity) || 0;
      seen.set(identity, count + 1);

      const issues = [];
      if (!valid) issues.push(isQuoteWanted ? 'استعلام/تماس؛ نه قیمت قابل‌مقایسه' : amountMatches.length > 1 ? 'مبلغ چندگانه؛ مبنا روشن نیست' : 'مبلغ نامعتبر');
      if (cur === 'نامشخص') issues.push('ارز جدول تصریح نشده');
      if (unit === 'unknown') issues.push('واحد قیمت تصریح نشده');
      if (!announced) issues.push('تاریخ نرخ نامشخص');

      const details = {
        'تحلیل متن': 'جدول عمومی (اسکنر آنلاین) v3',
        'شاهد ردیف': text.filter(Boolean).join(' | '),
        ...(amountMatches.length ? { 'مبلغ استخراج‌شده': rawPrice } : {}),
        'مبنای ارز': cur === 'نامشخص' ? 'نامشخص؛ از نام سایت حدس زده نشد' : 'سرستون/سلول قیمت',
        'مبنای واحد': unit === 'unknown' ? 'نامشخص' : cellUnit !== 'unknown' ? 'سلول واحد جدول' : 'واحد نوشته‌شده در سرستون قیمت',
        'مبنای تاریخ': announced ? (rowDateCell ? 'تاریخ ردیف جدول' : tableDate ? 'تاریخ نوشته‌شده درون جدول' : 'تاریخ صریح پیش از جدول') : 'نامشخص',
        ...(announced ? { 'دقت تاریخ نرخ': 'روز' } : {}),
        ...(titleBasis ? { 'مبنای نام کالا': titleBasis } : {}),
        ...(announcedRaw ? { 'تاریخ متن منبع': announcedRaw } : {}),
        'حدود منبع': 'جدول عمومی؛ انتشار مستقل پیام در دسترس نیست',
        'وضعیت استخراج': issues.length === 0 ? 'جدول عمومی؛ موجودی نیازمند تأیید' : issues.join('؛ '),
      };
      headers.forEach((h, i) => { if (h) details[h] = text[i] || ''; });

      local.push({ rowInherited, row: {
        id: `${endpoint}:${keyHash(identity)}:${count}`,
        endpoint,
        seller,
        sellerCity,
        title,
        category: rowCategory,
        unit,
        currency: cur,
        amount: valid && cur !== 'نامشخص' ? amount : null,
        fetchedAt: new Date(fetchedAt).toISOString(),
        sourceDateRaw: announced ? new Date(announced).toISOString() : '',
        size,
        thickness,
        dimensions: dims,
        grade,
        brand: brand || '',
        loading: loading || scope || 'نامشخص',
        loadingCity: 'نامشخص',
        sourceUrl,
        pieceKg: null,
        lengthM: /m\b|متر/.test(lengthHeader) ? number(length) : null,
        areaM2: null,
        tax,
        terms: 'نامشخص',
        material: materialOf(title),
        status: issues.length === 0 ? 'جدول عمومی؛ موجودی نیازمند تأیید' : issues.join('؛ '),
        details,
      } });
      if (out.length + local.length >= maxRows) break;
    }

    tableIndex++;
    const ownRows = local.filter((x) => !x.rowInherited).map((x) => x.row);
    const inheritedRows = local.filter((x) => x.rowInherited).map((x) => x.row);
    out.push(...ownRows);
    if (inheritedRows.length) {
      const key = tableOwner || '';
      if (!ownedGroups.has(key)) ownedGroups.set(key, []);
      ownedGroups.get(key).push(inheritedRows);
    }
    if (out.length >= maxRows) break;
  }

  // One owner, one indistinguishable table → its rows are that product.
  // Several → they cannot be told apart; none of them is read.
  for (const tables of ownedGroups.values()) {
    if (tables.length === 1) out.push(...tables[0]);
  }
  return out.slice(0, maxRows);
}

/* ---------- div-grid tables (any class containing standalone th/td) ---------- */

/** Token match for a class list containing a standalone word. */
function classHasToken(cls, token) {
  return new RegExp('(?:^|\\s|")' + token + '(?:$|\\s|")').test(' ' + String(cls || '').toLowerCase() + ' ');
}

/** Balanced scan: capture each outer block whose opening <div> class matches want(cls). */
function balancedDivBlocks(html, want) {
  const out = [];
  const tagRe = /<div\b[^>]*>|<\/div>/gi;
  const stack = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const t = m[0];
    if (/^<\/div/i.test(t)) {
      if (stack.length) {
        const top = stack[stack.length - 1];
        top.depth--;
        if (top.depth === 0) {
          stack.pop();
          out.push({ start: top.start, end: m.index + t.length });
        }
      }
      continue;
    }
    const clsM = /class\s*=\s*["']([^"']*)["']/i.exec(t);
    const cls = clsM ? clsM[1] : '';
    if (stack.length === 0 && want(cls)) {
      stack.push({ start: m.index, depth: 1 });
      continue;
    }
    if (stack.length) stack[stack.length - 1].depth++;
  }
  return out;
}

/** Direct cells (class has token th/td) of one div row block, in order. */
function divRowCells(rowHtml) {
  const out = [];
  const tagRe = /<div\b[^>]*>|<\/div>/gi;
  const stack = [];
  let m;
  while ((m = tagRe.exec(rowHtml))) {
    const t = m[0];
    if (/^<\/div/i.test(t)) {
      if (stack.length) {
        const top = stack[stack.length - 1];
        top.depth--;
        if (top.depth === 0) {
          stack.pop();
          out.push({ text: stripTags(rowHtml.slice(top.contentStart, m.index)), tag: top.tag });
        }
      }
      continue;
    }
    const clsM = /class\s*=\s*["']([^"']*)["']/i.exec(t);
    const cls = clsM ? clsM[1].toLowerCase() : '';
    const tag = classHasToken(cls, 'th') ? 'th' : classHasToken(cls, 'td') ? 'td' : '';
    if (stack.length === 0 && tag && !stack.length) {
      stack.push({ start: m.index, contentStart: m.index + t.length, depth: 1, tag });
      continue;
    }
    if (stack.length) stack[stack.length - 1].depth++;
  }
  return out;
}

/**
 * Locate div-grid "tables": clusters of consecutive .tr row blocks whose
 * cells carry class th/td (Bootstrap-style grids used by price sites).
 * Returns [{start, end, kind:'grid'}] with start = first row start.
 */
export function locateDivGrids(html) {
  const rowBlocks = balancedDivBlocks(html, (cls) => classHasToken(cls, 'tr'));
  if (!rowBlocks.length) return [];
  const groups = [];
  let current = [rowBlocks[0]];
  for (let i = 1; i < rowBlocks.length; i++) {
    const prev = current[current.length - 1];
    const gap = html.slice(prev.end, rowBlocks[i].start);
    if (/\S/.test(gap)) {
      groups.push(current);
      current = [];
    }
    current.push(rowBlocks[i]);
  }
  groups.push(current);
  const grids = [];
  for (const g of groups) {
    if (g.length < 2) continue; // a stray .tr is not a table
    const start = g[0].start;
    const end = g[g.length - 1].end;
    grids.push({ start, end, kind: 'grid', rowBlocks: g });
  }
  return grids;
}

function divGridRows(cleaned, grid) {
  const rows = [];
  let idx = 0;
  for (const rb of grid.rowBlocks) {
    const rowHtml = cleaned.slice(rb.start, rb.end);
    const cells = divRowCells(rowHtml);
    if (cells.length >= 2) rows.push({ cells, index: idx++ });
  }
  return rows;
}
