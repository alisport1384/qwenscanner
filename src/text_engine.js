/**
 * Searcher-1 — faithful port of IronPin's TextPriceEngine.analyze
 * (lib/domain/text_engine.dart). This is the online mirror of IronPin's
 * internal scanner: it reads one fetched page's visible text and returns
 * Quote-compatible rows.
 *
 * Rules mirrored exactly from the app:
 *  - Source text is evidence, never instructions.
 *  - A row is registered ONLY when it carries a real, positive price in a
 *    declared currency; product + specs + price + material, no prose.
 *  - Currency is detected next to the amount (currencyNear), then the group,
 *    then the source default; Rial is converted to Toman (÷10).
 *  - Unit basis is read only when the row itself states one (priceUnit);
 *    no basis is invented from the price magnitude.
 *  - No density/default-length/nominal-size inference: conversions come from
 *    explicit pieceKg/lengthM/areaM2 or geometric formulas (see ironpin.js).
 *  - Non-metal, buy-bid, service-labour and channel-chatter lines are dropped.
 *  - Junk links are stripped from sourceUrl; only http(s) with a host survive.
 */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function toLatinDigits(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, (c) => FA_DIGITS.indexOf(c))
    .replace(/[٠-٩]/g, (c) => AR_DIGITS.indexOf(c));
}

/** Normalise: latin digits, strip bidi marks, unify separators (IronPin normalize). */
export function normalizeText(text) {
  return toLatinDigits(String(text || ''))
    .replace(/[‌‍‏-⁤-⁩]/g, '')
    .split('\n')
    .map((s) =>
      s
        .replace(/_/g, ' ')
        .replace(/،/g, ',')
        .replace(/تومن/g, 'تومان')
    )
    .join('\n');
}

function latin(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, (c) => FA_DIGITS.indexOf(c))
    .replace(/[٠-٩]/g, (c) => AR_DIGITS.indexOf(c))
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک');
}

function number(s) {
  const n = parseFloat(
    toLatinDigits(String(s || ''))
      .replace(/[,٬ ]/g, '')
      .replace(/٫/g, '.')
  );
  return Number.isFinite(n) ? n : null;
}

/** Non-metal rejection (ProductText._nonMetal) — قرص آهن، MDF، کاغذ… */
const NON_METAL_RE =
  /قرص|کپسول|شیرخشک|قهوه|چای|دارو|ویتامین|مکمل|کاغذ|مقوا|MDF|ام‌دی‌ف|پلاستیک|پارچه|پشم|سنگ|سیمان|گچ|آجر|شیشه|پلیمر|لاستیک|لاک|رنگ|روغن\s+(?:خوراکی|سرخ\s*کردن)|عسل|برنج|گندم|ذرت|سویا|مرغ|گوشت|ماهی|شیر|پنیر|میوه|سبزی/;

/** Product vocabulary (ProductText.product + family keywords). */
const PRODUCT_RE =
  /انکر\s*بولت|انکربولت|رول\s*بولت|بولت|میلگرد(?:\s+بستر)?|میل(?:\s*استیل)?(?![ی])|تیر\s*آهن|تیراهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|مانیسمان|اسپیرال|\bERW\b|\bAPI\b|\bSCH\b|ورق|پلیت|صفحه\s+(?:فولادی|آهنی|فلزی)|شیت|چهارپهلو|شش\s*پر|مفتول|تسمه|سپری|رابیتس|توری|مش\s*جوشی|گابیون|حصاری|شمش|بیلت|بلوم|اسلب|قراضه|گندله|بریکت|فرو\s*آلیاژ|\bDRI\b|آهن\s*اسفنجی/;

const datePattern =
  /(?:1[34]\d{2})[/.\-]\d{1,2}[/.\-]\d{1,2}|\d{1,2}\s+(?:فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s+(?:ماه\s+)?1[34]\d{2}|20\d{2}-\d{2}-\d{2}/;

const PRICE_NUMBER =
  /(?<![\d.])(?:\d+(?:[.٫]\d+)?(?=\s*(?:هزار|میلیون)\s*(?:تومان|ریال))|(?:\d{1,4}(?:[,٬.]\d{3})+|\d{1,4}(?: \d{3})+)|\d{4,9}|\d{1,4}(?=\s*(?:تومان|ریال)))(?:٫\d+)?(?![\d.,٬])/g;

const MONETARY_PROTECTED =
  /(?:ضخامت|سایز|قطر|نمره|عرض|ارتفاع|طول|وزن|میلگرد(?: بستر)?|حرارتی|تیر\s*آهن|تیراهن|نبشی|ناودانی|ورق\s*(?:(?:آهن|سیاه|روغنی|گالوانیزه|رنگی|آجدار|استیل|گرم|سرد|برشی|فابریک)\s*)*)\s*[:：]?\s*(\d+(?:[.٫]\d+)?)/g;
const DIM_PROTECTED =
  /\d+(?:[.٫]\d+)?\s*[x×*]\s*\d+(?:[.٫]\d+)?(?:\s*[x×*]\s*\d+(?:[.٫]\d+)?)?/gi;

function monetaryMask(line) {
  let masked = line;
  const protected_ = [];
  let m;
  MONETARY_PROTECTED.lastIndex = 0;
  while ((m = MONETARY_PROTECTED.exec(line)) !== null) {
    const after = line.substring(m.index + m[0].length);
    if (/^\s*(?:(?:هزار|میلیون)\s*)?(?:تومان|ریال)/.test(after)) continue;
    protected_.push([m.index + m[0].length - m[1].length, m.index + m[0].length]);
  }
  DIM_PROTECTED.lastIndex = 0;
  while ((m = DIM_PROTECTED.exec(line)) !== null) {
    protected_.push([m.index, m.index + m[0].length]);
  }
  for (const r of protected_) {
    masked = masked.replaceRange
      ? masked.replaceRange(r[0], r[1], ' '.repeat(r[1] - r[0]))
      : masked.split('').map((c, i) => (i >= r[0] && i < r[1] ? ' ' : c)).join('');
  }
  return masked;
}

/** Currency of one row, decided next to its own amount (IronPin currencyNear). */
export function currencyNear(text, at) {
  const s = latin(text);
  if (at >= 0 && at < s.length) {
    const code = /^\s*([RT])(?![A-Za-z0-9])/.exec(s.substring(at))?.[1];
    if (code === 'R') return 'ریال';
    if (code === 'T') return 'تومان';
  }
  const toman = [...s.matchAll(/تومان/g)].map((m) => m.index);
  const rial = [...s.matchAll(/ریال/g)].map((m) => m.index);
  if (toman.length === 0 && rial.length === 0) return 'نامشخص';
  if (toman.length === 0) return 'ریال';
  if (rial.length === 0) return 'تومان';
  const nearest = (xs) => xs.map((x) => Math.abs(x - at)).reduce((a, b) => (a < b ? a : b));
  return nearest(toman) <= nearest(rial) ? 'تومان' : 'ریال';
}

/** The single basis a row states, or 'unknown' (IronPin priceUnit). */
export function priceUnit(text) {
  const s = latin(text);
  if (s.trimLeft().startsWith('#') || NON_METAL_RE.test(s)) return 'unknown';
  if (/کیلویی|تومانی?\s*[/\\]\s*کیلو|ریال\s*[/\\]\s*کیلو/.test(s)) return 'kg';
  const m =
    /(?:هر\s+|[/\\]\s*|مبنای\s+|بر\s*مبنای\s+|بر\s*اساس\s+|واحد\s*[:：]?\s*|به\s*ازای\s+|قیمت\s+)(کیلوگرم|کیلو|مترمربع|متر\s*مربع|شاخه|عدد|برگ|رول|تن|متر)(?![\p{L}])/u.exec(s) ||
    /(?<!(?:وزن|جرم|مساحت|طول|عرض|ابعاد)\s)(?:هر|یک|تک)\s+(?:برگ\s+|شیت\s+)?(?:ورق|برگ|شیت)(?![\p{L}])/u.exec(s) ||
    /(?:تومان|ریال)\s*(?:[/|،,]\s*)?(?:کیلوگرم|کیلو|شاخه|عدد|برگ|ورق|شیت|رول|تن|متر\s*مربع|مترمربع|متر)(?![\p{L}])/u.exec(s);
  if (m != null) return parseUnit(m[1]);
  PRICE_NUMBER.lastIndex = 0;
  const amount = PRICE_NUMBER.exec(s);
  PRICE_NUMBER.lastIndex = 0;
  const from = amount == null ? 0 : s.lastIndexOf('\n', amount.index) + 1;
  const to =
    amount == null
      ? s.length
      : s.indexOf('\n', amount.index + amount[0].length) < 0
          ? s.length
          : s.indexOf('\n', amount.index + amount[0].length);
  const scope = s.substring(from, to);
  const found = new Set();
  for (const unit of scope.matchAll(/(?<![آ-یA-Za-z])(کیلوگرم|کیلو|مترمربع|متر مربع|شاخه|برگ|رول|تن|متر|عدد|قطعه)(?![آ-یA-Za-z])/gu)) {
    const before = scope.substring(0, unit.index);
    if (/#[^\s]*$/.test(before) || before.endsWith('_') || scope.substring(unit.index + unit[0].length).startsWith('_')) continue;
    if (/(?:وزن|جرم|معادل|تناژ|طول|عرض|ارتفاع|ضخامت|ابعاد|سایز|قطر|نمره|تعداد)[^\n]{0,12}$/.test(before)) continue;
    found.add(parseUnit(unit[1]));
  }
  if (found.size !== 1) return 'unknown';
  const only = [...found][0];
  if ((only === 'm' || only === 'ton') && !/تومان|ریال/.test(scope)) return 'unknown';
  return only;
}

function parseUnit(v) {
  const s = latin(v);
  if (s.includes('کیلو') || s === 'kg') return 'kg';
  if (s.includes('مترمربع') || s.includes('متر مربع')) return 'm2';
  if (s.includes('شاخه') || /^(?:هر\s+)?عدد$/.test(s)) return 'piece';
  if (s === 'متر') return 'm';
  if (s === 'تن') return 'ton';
  if (s.includes('برگ') || /^(?:هر\s+|یک\s+|تک\s+)?(?:ورق|شیت|sheet)$/i.test(s)) return 'sheet';
  if (s.includes('رول')) return 'roll';
  return 'unknown';
}

function terms(text) {
  return [...text.matchAll(/[^\n]*(?:نقد|اعتبار|چک|تسویه|اقساط|تحویل|بارگیری|حداقل\s*سفارش|پیش\s*پرداخت|حمل|کرایه|بندیل|بندل|خرده\s*فروشی|عمده\s*فروشی)[^\n]*/g)]
    .map((m) => m[0].trim())
    .filter((s) => s.length < 260)
    .slice(0, 8)
    .join('؛ ');
}

function taxOf(text) {
  const without = /بدون\s*(?:ارزش\s*افزوده|مالیات)|ارزش\s*افزوده\s*جدا|به\s*علاوه\s*(?:مالیات|ارزش\s*افزوده)/.test(text);
  const included = /(?:با|شامل|احتساب)\s*(?:ارزش\s*افزوده|مالیات)/.test(text);
  return without === included ? 'نامشخص' : without ? 'بدون ارزش افزوده' : 'با ارزش افزوده';
}

/** Jalali → Gregorian (rough, calendar-valid output only), mirroring IronPin. */
function jalaliToGregorian(jy, jm, jd, hh, mm) {
  jm = jm - 1;
  jd = jd - 1;
  let jdn = 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4);
  for (let i = 0; i < jm; i++) jdn += i < 6 ? 31 : 30;
  jdn += jd + 79;
  let gy = 1600 + 400 * Math.floor(jdn / 146097);
  jdn %= 146097;
  let leap = true;
  if (jdn >= 36525) {
    jdn--;
    gy += 100 * Math.floor(jdn / 36524);
    jdn %= 36524;
    if (jdn >= 365) jdn++;
    else leap = false;
  }
  gy += 4 * Math.floor(jdn / 1461);
  jdn %= 1461;
  if (jdn >= 366) {
    leap = false;
    jdn--;
    gy += Math.floor(jdn / 365);
    jdn %= 365;
  }
  const md = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let mo = 0;
  while (mo < 11 && jdn >= md[mo]) jdn -= md[mo++];
  const d = new Date(Date.UTC(gy, mo, jdn + 1, hh || 0, mm || 0) - 210 * 60000);
  return Number.isNaN(+d) ? null : d.toISOString();
}

export function dateIn(text) {
  const s = latin(text);
  // Gregorian ISO date (20xx-mm-dd)
  const iso = /(20\d{2})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return Number.isNaN(+d) ? null : d.toISOString();
  }
  // Jalali numeric: 13xx/14xx/yyyy/mm/dd (+ optional time)
  const num = /(1[34]\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (num) {
    return jalaliToGregorian(+num[1], +num[2], +num[3], +(num[4] || 0), +(num[5] || 0));
  }
  // Jalali named: <day> <month> <year>
  const named = /(\d{1,2})\s+(?:فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s+(?:ماه\s+)?(1[34]\d{2})/.exec(s);
  if (named) {
    return jalaliToGregorian(+named[3], +named[1], 0, 0, 0);
  }
  return null;
}

function cleanUrl(src) {
  let s = String(src || '');
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return '';
    return u.toString();
  } catch {
    return '';
  }
}

function hashId(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * Analyze one page's visible text into Quote rows — the online mirror of
 * IronPin's TextPriceEngine.analyze. Returns an array of Quote-compatible
 * plain objects (same shape IronPin2's Quote.fromJson expects).
 */
export function analyzeText({
  text,
  endpoint,
  seller,
  sourceUrl,
  fetchedAt,
  sellerCity = 'نامشخص',
  publishedAt = null,
  defaultCurrency = 'نامشخص',
}) {
  const hasPhoto = false;
  if (String(text || '').length > 120000) return [];
  const normalized = normalizeText(text);
  const lines = normalized.split('\n').filter((s) => s.trim() !== '');
  if (lines.length > 0 && /خریداریم/.test(lines[0]) && !/فروش|عرضه/.test(normalized)) return [];

  const out = [];
  let heading = '';
  let contextCategory = '';
  let contextCurrency = 'نامشخص';
  let contextUnit = 'unknown';
  let globalUnit = 'unknown';
  let globalCurrency = 'نامشخص';
  let pending = null;
  let priceDate = null;
  let invalidDate = false;
  let datePrecision = 'نامشخص';
  let dateBasis = 'تاریخ صریح داخل متن';
  const allTerms = terms(normalized);
  const allTax = taxOf(normalized);
  let lastPriceIndex = -1;
  let lastBasisIndex = -1;
  const occurrences = new Map();

  for (let index = 0; index < lines.length && out.length < 300; index++) {
    let line = lines[index].trim();
    const inDate = datePattern.test(line);
    if (inDate) {
      priceDate = dateIn(line) ? new Date(dateIn(line)).toISOString() : null;
      dateBasis = 'تاریخ صریح داخل متن';
      datePrecision = /\d{1,2}:\d{2}/.test(line) ? 'زمان' : 'روز';
      invalidDate = priceDate == null;
      pending = null;
      if (lastPriceIndex >= 0 && lastBasisIndex <= lastPriceIndex) {
        contextUnit = globalUnit = 'unknown';
        contextCurrency = globalCurrency = 'نامشخص';
      }
      if (PRODUCT_RE.test(line) && line.length < 150) {
        heading = datePattern.exec(line)?.[0] === line ? heading : line;
      }
      line = line.replace(datePattern, ' ').trim();
    }
    const relative = /(?:قیمت|نرخ|تاریخ)\s*(?:روز\s*)?(امروز|دیروز)(?:\s|[:：]|$)/.exec(line);
    if (!inDate && relative != null && publishedAt != null) {
      const pub = new Date(publishedAt);
      const day = new Date(pub.getTime() - (relative[1] === 'دیروز' ? 86400000 : 0));
      priceDate = day.toISOString();
      datePrecision = 'روز';
      dateBasis = 'تاریخ نسبی از زمان انتشار پیام';
      invalidDate = false;
    }
    if (line === '') continue;
    if (NON_METAL_RE.test(line)) {
      pending = null;
      heading = '';
      contextCategory = '';
      continue;
    }
    if (/^https?:\/\/|^@|(?:تلفن|تماس|همراه|شماره|☎|📞|📱|داخلی|عضو|مشترک|مشاهده|کد\s*پستی)/.test(line) && !PRODUCT_RE.test(line) && !/سایز|ضخامت/.test(line)) {
      pending = null;
      continue;
    }
    if (/کاهش|افزایش|تغییر|تخفیف|اجرت|کرایه|هزینه حمل|دوبله کردن/.test(line) && !/سایز|ضخامت|قیمت|⬅/.test(line)) continue;
    if (/تأسیس|تاسیس|بهره برداری|کارمند|تولیدکننده|ظرفیت تولید/.test(line) && !/تومان|ریال|قیمت|نرخ|💰/.test(line)) continue;
    if (/خریداریم|خریدار\s+(?:تیر|میلگرد|ورق|آهن)|دستمزد|اجرت\s+(?:دوبل|برش|خم|جوش)|دوبله\s*کردن/.test(line)) {
      pending = null;
      continue;
    }
    const cat = PRODUCT_RE.exec(line)?.[0] || '';
    if (cat === '' && /حداقل\s*سفارش|^وزن|^طول|^تعداد|^بارگیری/.test(line)) continue;
    const lineCurrency = /تومان/.test(line) && !/ریال/.test(line) ? 'تومان' : /ریال/.test(line) && !/تومان/.test(line) ? 'ریال' : 'نامشخص';
    const lineUnit = priceUnit(line);
    const numbers = [];
    PRICE_NUMBER.lastIndex = 0;
    for (const m of monetaryMask(line).matchAll(PRICE_NUMBER)) {
      const raw = m[0].replace(/[,٬. ]/g, '');
      if (/^0\d{9,10}$/.test(raw)) continue;
      const before = line.substring(0, m.index);
      const after = line.substring(m.index + m[0].length);
      if (/[x×*]\s*$/i.test(before) || /^\s*[x×*]/i.test(after)) continue;
      if (/^\s*(?:کیلوگرم|کیلو|میلی\s*متر|سانتی\s*متر|mm|cm|متر|تن|تایی|عدد|میل|هکتار|نفر|دستگاه|درصد)(\s|$|[،,؛:])/.test(after)) continue;
      if (/(?:وزن|طول|عرض|ارتفاع|ابعاد|ضخامت|سایز|قطر|نمره|بار|کیلوگرم|تعداد|شاخه|سال)\s*[:：]?\s*$/.test(before)) continue;
      if (/(?:کاهش|افزایش|تغییر|تخفیف|🔻|🔺|⬇|⬆)\s*$/.test(before)) continue;
      numbers.push(m);
    }
    const onlyContext = numbers.length === 0;
    if (onlyContext) {
      if (cat === '' && contextCategory !== '' && /ضخامت|سایز|ابعاد|قطر|نمره/.test(line)) pending = line;
      if (cat !== '') {
        heading = line;
        contextCategory = cat;
        pending = line;
        contextUnit = globalUnit;
        contextCurrency = globalCurrency;
      }
      if (lineCurrency !== 'نامشخص' && /قیمت|مبنا|واحد|نرخ|تومان|ریال/.test(line)) {
        contextCurrency = lineCurrency;
        lastBasisIndex = index;
        if (cat === '') globalCurrency = lineCurrency;
      }
      if (lineUnit !== 'unknown') {
        contextUnit = lineUnit;
        lastBasisIndex = index;
        if (cat === '') globalUnit = lineUnit;
      }
      continue;
    }
    const descriptor = cat !== '' || /سایز|ضخامت|ابعاد|نمره|حرارتی|آجدار|ساده|\d+(?:[.٫]\d+)?\s*میل|A[1-4]|ST(?:37|52)/i.test(line);
    const owner = pending != null ? pending : heading !== '' ? heading : null;
    const candidate = descriptor ? line : owner == null ? '' : `${owner} ${line}`;
    if (candidate === '' || (cat === '' && contextCategory === '' && !PRODUCT_RE.test(candidate))) {
      pending = null;
      continue;
    }
    const labelled = numbers.filter((m) => /^\s*(?:تومان|ریال)/.test(line.substring(m.index + m[0].length)));
    const range = numbers.length === 2 && /^(?:تا|الی|–|-|—)$/.test(line.substring(numbers[0].index + numbers[0][0].length, numbers[1].index).trim());
    const candidates = range ? numbers : labelled.length > 0 ? labelled : numbers;
    if ((!range && candidates.length !== 1) || candidates.length === 0) {
      pending = null;
      continue;
    }
    const chosen = candidates[0];
    const scale = /^\s*(هزار|میلیون)\s*(?:تومان|ریال)/.exec(line.substring(chosen.index + chosen[0].length));
    const value = scale == null ? number(chosen[0]) : number(chosen[0]) * (scale[1] === 'میلیون' ? 1000000 : 1000);
    if (value == null || !Number.isFinite(value) || value <= 0) {
      pending = null;
      continue;
    }
    let cur = currencyNear(line, chosen.index);
    if (cur === 'نامشخص') cur = lineCurrency;
    if (cur === 'نامشخص') cur = contextCurrency;
    let currencySource = cur === 'نامشخص' ? '' : 'متن همان ردیف یا گروه';
    if (cur === 'نامشخص' && defaultCurrency !== 'نامشخص') {
      cur = defaultCurrency;
      currencySource = 'ارز اعلامی خود منبع؛ نه حدس از بزرگی مبلغ';
    }
    const unit = lineUnit === 'unknown' ? contextUnit : lineUnit;
    const productCategory = cat !== '' ? cat : PRODUCT_RE.test(candidate) ? PRODUCT_RE.exec(candidate)[0] : contextCategory;
    let model = (descriptor ? line.substring(0, chosen.index) : `${owner} ${line.substring(0, chosen.index)}`)
      .replace(/[:：=⬅️✅🔹▫️💰]+/gu, ' ')
      .trim();
    if (model === '') model = heading;
    const sizeMatch = /(?:سایز|نمره|میلگرد|حرارتی|تیرآهن|تیر آهن|نبشی|ناودانی)\s*(\d+(?:[٫.]\d+)?(?:\s*[,/و]\s*\d+(?:[٫.]\d+)?)*)/.exec(model);
    const dims = /\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?)?/i.exec(model)?.[0];
    const grade = /گرید\s*[:：]?\s*([\w-]+)/i.exec(model)?.[1] || '';
    const spec = `${productCategory}|${heading}|${model}|${unit}|${cur}|${priceDate || ''}`;
    const count = (occurrences.get(spec) || 0) + 1;
    occurrences.set(spec, count);
    const identity = `${endpoint}:${sourceUrl}:${hashId(spec)}:${count}`;
    const priceTime = priceDate;
    const dateIssue = invalidDate ? 'تاریخ صریح نامعتبر' : '';
    const loading = /(?:انبار|تحویل|بارگیری)\s*[:：]?\s*([^\n]{2,65})/.exec(`${heading}\n${normalized}`)?.[0] || 'نامشخص';
    const issues = [];
    if (cur === 'نامشخص') issues.push('ارز اعلام نشده/متعارض');
    if (unit === 'unknown') issues.push('مبنای واحد قیمت اعلام نشده');
    if (range) issues.push('بازه قیمت؛ نه مبلغ یکتای قابل مقایسه');
    if (dateBasis.includes('نسبی')) issues.push(dateBasis);
    if (priceTime == null && publishedAt == null) issues.push('تاریخ معتبر در دسترس نیست');
    if (dateIssue !== '') issues.push(dateIssue);
    const status = issues.length === 0 ? 'استخراج متنی با مبلغ/ارز/واحد صریح؛ موجودی نیازمند تأیید' : issues.join('؛ ');
    out.push({
      id: identity,
      endpoint,
      seller,
      sellerCity,
      title: model.includes(productCategory) ? model : `${productCategory} ${model}`,
      category: productCategory,
      unit,
      currency: cur,
      amount: cur === 'نامشخص' || range ? null : value,
      lengthM: number(/(?:طول(?: شاخه)?|حالت)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*متر/.exec(candidate)?.[1] || ''),
      pieceKg: number(/وزن\s*(?:هر|یک)?\s*(?:شاخه|برگ|رول)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*کیلو/.exec(candidate)?.[1] || ''),
      tax: taxOf(candidate) === 'نامشخص' ? allTax : taxOf(candidate),
      terms: allTerms === '' ? 'نامشخص' : allTerms,
      brand: '',
      material: /استیل|استنلس/i.test(`${heading} ${model}`) ? 'استنلس استیل' : /آلومینیوم/.test(`${heading} ${model}`) ? 'آلومینیوم' : /آلیاژ|MO40|CK45|A516/i.test(`${heading} ${model}`) ? 'فولاد آلیاژی' : 'فولاد کربنی',
      areaM2: number(/مساحت\s*(?:(?:هر|یک)\s*(?:برگ|ورق|شاخه)\s*)?[:：]?\s*(\d+(?:\.\d+)?)\s*متر\s*مربع/.exec(candidate)?.[1] || ''),
      loading,
      loadingCity: 'نامشخص',
      sourceUrl: cleanUrl(sourceUrl),
      fetchedAt: new Date(fetchedAt).toISOString(),
      sourceDateRaw: priceTime || '',
      size: sizeMatch?.[1] || '',
      thickness: /ضخامت\s*[:：]?\s*([\d.]+)/.exec(model)?.[1] || '',
      dimensions: dims || '',
      grade,
      status,
      details: {
        'تحلیل متن': 'محلی v2 (اسکنر آنلاین)',
        'شاهد ردیف': candidate,
        'مبلغ استخراج‌شده': range ? `${numbers[0][0]} تا ${numbers[1][0]}` : chosen[0],
        ...(invalidDate ? { 'تاریخ نامعتبر': 'بله' } : {}),
        'مبنای ارز': cur === 'نامشخص' ? 'نامشخص' : currencySource === '' ? 'متن همان ردیف یا گروه' : currencySource,
        'مبنای واحد': unit === 'piece' && productCategory === 'بولت' ? 'عدد / ست' : unitLabel(unit),
        'زمان انتشار پیام': publishedAt ? new Date(publishedAt).toISOString() : '',
        'دقت تاریخ نرخ': datePrecision,
        'مبنای تاریخ': priceTime != null ? dateBasis : publishedAt != null ? 'زمان انتشار؛ تاریخ خود نرخ تصریح نشده' : 'نامشخص',
        'وضعیت استخراج': status,
      },
    });
    lastPriceIndex = index;
    pending = null;
  }
  return out;
}

function unitLabel(u) {
  return ({ kg: 'کیلوگرم', piece: 'شاخه', m: 'متر', m2: 'مترمربع', ton: 'تن', sheet: 'برگ', roll: 'رول', unknown: 'نامشخص' })[u] || u;
}
