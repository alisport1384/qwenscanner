/**
 * هوش جستجوگر ۲ — Product vocabulary, trade evidence, query banks & city/contact helpers.
 * Faithful port of IronPin2 `lib/domain/product_text.dart`, `source_finder.dart`, `sources.dart`.
 */

import { FinderPart } from './classify.js';

/** Normalize Persian/Arabic characters, digits, ZWNJ and whitespace. */
export function normalizeText(value) {
  let s = String(value || '');
  if (!s) return '';
  s = s
    .replace(/[\u06F0-\u06F9]/g, (c) => String.fromCharCode(0x30 + (c.charCodeAt(0) - 0x06F0)))
    .replace(/[\u0660-\u0669]/g, (c) => String.fromCharCode(0x30 + (c.charCodeAt(0) - 0x0660)))
    .replace(/\u064A/g, '\u06CC') // ي -> ی
    .replace(/\u0643/g, '\u06A9') // ك -> ک
    .replace(/\u066B/g, '.')
    .replace(/[\u200C_\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+/g, ' ')
    .trim();
  return s;
}

const NON_METAL_FAST =
  /قرص|[کك]پسول|شربت|آمپول|و[یي]ال|دارو|م[کك]مل|و[یي]تام[یي]ن|فول[یي][کك]|فروس|ف[یي]فول|ففول|فروگلوب[یي]ن|فرود[یي]ن|فروفورت|س[یي]دورال|هموگلوب[یي]ن|خون[یي]|فقر|بل[یي]ستر|قطره|گرم|د[یي]\s*اف|نئوپان|ها[یي]گلاس|ملام[یي]نه|گچ|[کك]ناف|[کك]اغذ|مقوا|پاسور|پل[کك]س[یي]|[کك]ربنات|[یي]ونول[یي]ت|پل[یي][کك]ا|fefol|ferrous|folic|tablet|capsule|blister|vitamin|supplement|pharmac|anemia|mdf|hdf|pvc|a4|a5|mg|mcg/i;

const NON_METAL_RE =
  /(?:^|[^آ-ی])(?:قرص|کپسول|شربت|آمپول|ویال|دارو(?:خانه|یی)?|مکمل|ویتامین|فولیک|فروس|فیفول|ففول|فروگلوبین|فرودین|فروفورت|سیدورال|هموگلوبین|کم\s*خونی|فقر\s*آهن|بلیستر|قطره\s*آهن|میلی\s*گرم|میکروگرم|ام\s*دی\s*اف|نئوپان|هایگلاس|ملامینه|گچ\s*برگ|کناف|کاغذ|مقوا|پاسور|پلکسی|پلی\s*کربنات|یونولیت|پلیکا)(?:$|[^آ-ی])|\b(?:fefol|ferrous|folic|tablets?|capsules?|blister|vitamins?|supplements?|pharmac(?:y|eutical)|anemia|mdf|hdf|upvc|pvc|a4|a5)\b|\b\d+(?:\.\d+)?\s*(?:mg|mcg)\b/i;

export function isNonMetal(text) {
  if (!NON_METAL_FAST.test(text)) return false;
  return NON_METAL_RE.test(normalizeText(text));
}

export const PRODUCT_RE =
  /انکر\s*بولت|انکربولت|رول\s*بولت|بولت|\banchor\s+bolt\b|مواد\s*اولیه\s*فولاد|آهن\s*اسفنجی|گندله|بریکت|فرو\s*آلیاژ|\bDRI\b|\bHBI\b|pellet|briquette|ferroalloy|میلگرد(?:\s+بستر)?|تیر\s*چه|تیر\s*آهن|تیراهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|ورق|پلیت|صفحه\s+(?:فولادی|آهنی|فلزی)|شیت|\b(?:plate|sheet)\b|چهارپهلو|مفتول|تسمه|سپری|رابیتس|توری|مش\s+جوشی|شمش|قراضه/gi;

const WHOLESALE_RE = /آهن\s?آلات|آهن\s?فروش|مقاطع\s+فولادی|بنگاه\s+آهن/g;
const TRADE_RE =
  /قیمت|فروش|خرید|پخش|توزیع|عمده|استعلام|سفارش|تومان|ریال|موجودی|تحویل|بنگاه|نمایندگی|بارگیری/g;

export function productCategory(text) {
  const norm = normalizeText(text);
  if (isNonMetal(norm)) return '';
  const m = norm.match(new RegExp(PRODUCT_RE.source, 'i'));
  const s = m ? m[0] : '';
  if (!s) return '';
  if (/مواد|اسفنجی|گندله|بریکت|فرو|DRI|HBI|pellet|briquette|ferro/i.test(s)) {
    return 'مواد اولیه فولاد';
  }
  if (/تیر\s*چه/.test(s)) return 'تیرچه';
  if (s.includes('تیر') || s === 'هاش') return 'تیرآهن';
  if (/پلیت|صفحه|شیت|plate|sheet/i.test(s)) return 'ورق';
  if (/بولت|anchor/i.test(s)) return 'بولت';
  if (s === 'قوطی') return 'پروفیل';
  return s;
}

/**
 * Counts product mentions (`goods`) and commercial trade words (`trade`).
 * If `customKeyword` is provided (from user-added custom products), also recognizes
 * non-catalog steel/construction product terms when paired with trade signals.
 */
export function tradeEvidence(text, customKeyword = '') {
  const s = normalizeText(text);
  let goods = 0;
  let firstProduct = '';

  const pRe = new RegExp(PRODUCT_RE.source, 'gi');
  let m;
  while ((m = pRe.exec(s)) !== null && goods < 20) {
    const from = Math.max(0, m.index - 48);
    const to = Math.min(s.length, m.index + m[0].length + 48);
    if (!isNonMetal(s.slice(from, to))) {
      goods++;
      if (!firstProduct) firstProduct = productCategory(m[0]) || m[0];
    }
  }

  const wRe = new RegExp(WHOLESALE_RE.source, 'g');
  while ((m = wRe.exec(s)) !== null && goods < 20) {
    const from = Math.max(0, m.index - 48);
    const to = Math.min(s.length, m.index + m[0].length + 48);
    if (!isNonMetal(s.slice(from, to))) {
      goods++;
      if (!firstProduct) firstProduct = 'آهن‌آلات';
    }
  }

  if (customKeyword) {
    const kw = normalizeText(customKeyword);
    if (kw.length >= 2 && s.includes(kw) && !isNonMetal(s)) {
      goods = Math.max(goods, 2);
      if (!firstProduct) firstProduct = customKeyword;
    }
  }

  let trade = 0;
  const tRe = new RegExp(TRADE_RE.source, 'g');
  while (tRe.exec(s) !== null && trade < 20) {
    trade++;
  }

  return {
    goods,
    trade,
    product: firstProduct,
    okFor(length) {
      return length < 600 ? goods >= 1 && trade >= 1 : goods >= 3 && trade >= 2;
    },
  };
}

export function sellsGoods(text, customKeyword = '') {
  const ev = tradeEvidence(text, customKeyword);
  return ev.okFor(String(text || '').length);
}

// ------------------------------------------------------------------ Query banks

export const FINDER_PER_ROUND = 5;

export const PRODUCTS = [
  'میلگرد', 'تیرآهن', 'ورق', 'پروفیل', 'لوله', 'نبشی', 'ناودانی',
  'سپری', 'تسمه', 'چهارپهلو', 'مفتول', 'مش جوشی', 'توری', 'رابیتس',
  'شمش', 'قراضه', 'بولت', 'انکر بولت', 'آهن اسفنجی', 'گندله',
];

export const CITIES = [
  'مشهد', 'تهران', 'اصفهان', 'تبریز', 'شیراز', 'اهواز', 'کرج', 'قم',
  'کرمانشاه', 'ارومیه', 'رشت', 'زاهدان', 'کرمان', 'همدان', 'یزد', 'اردبیل',
  'بندرعباس', 'اراک', 'زنجان', 'قزوین', 'سنندج', 'خرم‌آباد', 'گرگان', 'ساری',
  'بوشهر', 'بیرجند', 'ایلام', 'شهرکرد', 'سمنان', 'یاسوج', 'بجنورد',
];

function weave(general, local) {
  const out = [];
  const seen = new Set();
  let g = 0;
  let l = 0;
  while (g < general.length || l < local.length) {
    for (let i = 0; i < 3 && g < general.length; i++) {
      const q = general[g++];
      if (!seen.has(q)) {
        seen.add(q);
        out.push(q);
      }
    }
    for (let i = 0; i < 2 && l < local.length; i++) {
      const q = local[l++];
      if (!seen.has(q)) {
        seen.add(q);
        out.push(q);
      }
    }
  }
  return out;
}

export const FINDER_BANKS = [
  // Part 0: Websites
  weave(
    [
      ...PRODUCTS.map((p) => `قیمت ${p} امروز`),
      'فروش آهن آلات', 'پخش آهن آلات', 'لیست قیمت آهن آلات',
      'قیمت ورق سیاه امروز', 'قیمت ورق گالوانیزه امروز', 'قیمت قوطی امروز',
      'قیمت شمش فولاد امروز', 'قیمت میلگرد کلاف امروز', 'قیمت هاش امروز',
      'بنکداری آهن آلات', 'بازرگانی آهن و فولاد', 'جدول قیمت روز مقاطع فولادی',
      ...PRODUCTS.map((p) => `خرید ${p}`),
      ...PRODUCTS.map((p) => `فروش ${p}`),
      ...PRODUCTS.map((p) => `پخش ${p}`),
    ],
    [
      ...CITIES.flatMap((c) => [`قیمت آهن ${c}`, `آهن فروشی ${c}`]),
      'فولاد فروشی کاشان', 'آهن فروشی نیشابور', 'آهن فروشی دزفول',
      'آهن فروشی بابل', 'آهن فروشی آمل', 'آهن فروشی سبزوار',
    ]
  ),
  // Part 1: Social networks (Telegram, Instagram, WhatsApp)
  weave(
    [
      'کانال تلگرام قیمت آهن', 'کانال تلگرام قیمت میلگرد',
      'site:t.me قیمت آهن', 'site:t.me قیمت میلگرد', 'site:t.me آهن آلات',
      'پیج اینستاگرام آهن آلات', 'site:instagram.com آهن آلات',
      ...PRODUCTS.slice(1, 7).map((p) => `کانال تلگرام قیمت ${p}`),
      'کانال تلگرام آهن آلات',
      'site:t.me قیمت ورق سیاه', 'site:t.me قیمت تیرآهن', 'site:t.me قیمت قوطی',
      'site:t.me بازرگانی آهن', 'site:t.me پخش میلگرد', 'کانال تلگرام ورق گالوانیزه',
      'کانال تلگرام بازار آهن شادآباد', 'کانال تلگرام بازار آهن مکان',
    ],
    [
      ...CITIES.map((c) => `کانال تلگرام آهن ${c}`),
      'کانال تلگرام آهن کاشان', 'کانال تلگرام آهن نیشابور',
    ]
  ),
  // Part 2: Domestic networks (Eitaa, Bale, Rubika, Soroush, iGap, Gap)
  weave(
    [
      ...['ایتا', 'بله', 'روبیکا'].map((m) => `کانال ${m} قیمت آهن`),
      ...['ایتا', 'بله', 'روبیکا'].map((m) => `کانال ${m} قیمت میلگرد`),
      ...['ایتا', 'بله', 'روبیکا'].map((m) => `کانال ${m} آهن آلات`),
      'site:eitaa.com قیمت میلگرد', 'site:eitaa.com آهن آلات',
      'site:ble.ir قیمت آهن', 'site:ble.ir آهن آلات',
      'site:rubika.ir آهن آلات', 'site:rubika.ir قیمت میلگرد',
      'site:eitaa.com قیمت ورق', 'site:ble.ir قیمت میلگرد',
      ...PRODUCTS.slice(1, 7).map((p) => `کانال ایتا قیمت ${p}`),
      ...['ورق', 'تیرآهن', 'پروفیل', 'لوله'].map((p) => `کانال روبیکا قیمت ${p}`),
      ...['ورق', 'تیرآهن', 'پروفیل'].map((p) => `کانال بله قیمت ${p}`),
    ],
    [
      ...CITIES.map((c) => `کانال ایتا آهن ${c}`),
      'کانال روبیکا آهن مشهد', 'کانال روبیکا آهن تهران', 'کانال روبیکا آهن اصفهان',
      'کانال بله آهن مشهد', 'کانال بله آهن تهران', 'کانال بله آهن اصفهان',
    ]
  ),
];

export function finderQueries(part, round, perRound = FINDER_PER_ROUND) {
  const bank = FINDER_BANKS[part] || [];
  if (!bank.length) return [];
  const start = (round * perRound) % bank.length;
  const out = [];
  for (let i = 0; i < perRound; i++) {
    out.push(bank[(start + i) % bank.length]);
  }
  return out;
}

export function usesSiteOperator(query) {
  return String(query || '').trim().toLowerCase().startsWith('site:');
}

export function queryTokens(query) {
  return normalizeText(query)
    .split(' ')
    .filter((w) => w.length >= 3 && !w.toLowerCase().startsWith('site:'));
}

/** Build Searcher-2 queries across all 3 lists + directories for a custom product. */
export function customProductQueries(productName) {
  const name = normalizeText(productName);
  if (!name) return [];
  return [
    { kind: 'search', part: FinderPart.sites, query: `قیمت ${name} امروز`, product_name: name },
    { kind: 'search', part: FinderPart.sites, query: `فروش ${name} لیست قیمت`, product_name: name },
    { kind: 'search', part: FinderPart.social, query: `site:t.me ${name}`, product_name: name },
    { kind: 'search', part: FinderPart.social, query: `کانال تلگرام قیمت ${name}`, product_name: name },
    { kind: 'search', part: FinderPart.domestic, query: `کانال ایتا بله روبیکا ${name}`, product_name: name },
    { kind: 'directory', part: FinderPart.social, query: name, product_name: name },
  ];
}

/** Seed homepages of known Iranian steel sellers (to crawl inner price/channel links). */
export const SEED_HOMEPAGES = [
  'https://ahanmelal.com/',
  'https://asreahan.com/',
  'https://markazeahan.com/',
  'https://ahanonline.com/',
  'https://ahanprice.com/',
  'https://fardadfoolad.ir/',
  'https://mashhadfoolad.com/',
  'https://www.khabazzadeh.com/',
  'https://samentejarat.com/',
  'https://www.shahrahan.com/',
  'https://rahsakht.ir/',
  'https://khoshkamiron.ir/',
  'https://ahanmaham.com/',
  'https://radmanahan.ir/',
  'https://novinpars.com/',
  'https://ahanresan.com/',
  'https://tikahan.com/',
  'https://www.shekofte.com/',
  'https://ahan.co/',
];

const KNOWN_CITIES = [
  'بوئین زهرا', 'شهرکرد', 'نیشابور', 'اصفهان', 'مشهد', 'تهران', 'تبریز',
  'همدان', 'کاشان', 'اهواز', 'سیرجان', 'کرمان', 'شهرضا', 'ابرکوه', 'قزوین',
  'تاکستان', 'بناب', 'میانه', 'رشت', 'ساری', 'یزد', 'ابهر', 'دزفول',
  'شاهرود', 'سمنان', 'اردبیل', 'قم', 'اراک', 'شیراز', 'کرج', 'کرمانشاه',
  'ارومیه', 'زاهدان', 'بندرعباس', 'زنجان', 'سنندج', 'خرم آباد', 'گرگان',
  'بوشهر', 'بیرجند', 'ایلام', 'یاسوج', 'بجنورد',
];

export function knownCity(text) {
  const s = normalizeText(text);
  if (!s) return 'نامشخص';
  for (const c of KNOWN_CITIES) {
    if (s.includes(c)) return c;
  }
  return 'نامشخص';
}

const PHONE_RE = /(?:\+98|0098|0)?(?:9\d{9}|[1-8]\d{9}|[1-8]\d{7})/g;
const ADDRESS_RE = /(?:آدرس|نشانی|دفتر|انبار|کارخانه|بزرگراه|بلوار|خیابان|جاده|طرحچی|شهرک\s*صنعتی)/;

export function contactLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.length > 400) continue;
    if (
      PHONE_RE.test(line) ||
      ADDRESS_RE.test(line) ||
      /maps\.google|goo\.gl\/maps|neshan\.org|balad\.ir/i.test(line)
    ) {
      PHONE_RE.lastIndex = 0;
      out.push(line.length > 220 ? line.slice(0, 220) : line);
    }
    PHONE_RE.lastIndex = 0;
    if (out.length >= 8) break;
  }
  return out.join('\n');
}
