/**
 * تشخیص شهر — online mirror of IronPin's phone_city.dart + maps_link.dart.
 *
 * چهار شاهد نوشته‌شده (از قوی به ضعیف)، هیچ‌وقت حدس از روی عدد مبلغ:
 *   1. شهر صریح نوشته‌شده در متن (آدرس/انبار/بارگیری/دفتر/فروشگاه …)
 *   2. نام مکان یا مختصات در لینک نقشه (Google/Neshan/Balad long-link)
 *   3. پیش‌شمارهٔ تلفن ثابت (۰۲۱، ۰۳۱، ۰۵۱، …) — شماره همراه هرگز شهر نمی‌سازد
 *   4. (برای جدول‌های «دفتر فروشنده» صریح) همان شاهد متن
 *
 * اگر شاهدها نسازند، «نامشخص» می‌ماند؛ هیچ‌گاه از بزرگی عدد یا از شماره همراه
 * شهر ساخته نمی‌شود. تعارض شاهدها در details ثبت می‌شود.
 */

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function latin(s) {
  return String(s || '')
    .replace(/[۰-۹]/g, (c) => FA_DIGITS.indexOf(c))
    .replace(/[٠-٩]/g, (c) => AR_DIGITS.indexOf(c))
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک');
}

/** Landline area code → (city, province). Only documented codes. */
export const LANDLINE_AREAS = {
  '021': ['تهران', 'تهران'], '026': ['کرج', 'البرز'], '025': ['قم', 'قم'],
  '031': ['اصفهان', 'اصفهان'], '032': ['قزوین', 'قزوین'], '034': ['کرمان', 'کرمان'],
  '035': ['یزد', 'یزد'], '038': ['شهرکرد', 'چهارمحال و بختیاری'], '041': ['تبریز', 'آذربایجان شرقی'],
  '044': ['ارومیه', 'آذربایجان غربی'], '045': ['اردبیل', 'اردبیل'], '051': ['مشهد', 'خراسان رضوی'],
  '054': ['زاهدان', 'سیستان و بلوچستان'], '056': ['بیرجند', 'خراسان جنوبی'], '058': ['بجنورد', 'خراسان شمالی'],
  '061': ['اهواز', 'خوزستان'], '066': ['خرم‌آباد', 'لرستان'], '071': ['شیراز', 'فارس'],
  '074': ['یاسوج', 'کهگیلویه و بویراحمد'], '076': ['بندرعباس', 'هرمزگان'], '077': ['بوشهر', 'بوشهر'],
  '081': ['همدان', 'همدان'], '083': ['کرمانشاه', 'کرمانشاه'], '084': ['ایلام', 'ایلام'],
  '086': ['اراک', 'مرکزی'], '087': ['سنندج', 'کردستان'], '011': ['ساری', 'مازندران'],
  '013': ['رشت', 'گیلان'], '017': ['گرگان', 'گلستان'], '023': ['سمنان', 'سمنان'],
  '024': ['زنجان', 'زنجان'],
};

/** County of a landline from the first digits of the local number (fa.wikipedia). */
const LANDLINE_COUNTIES = {
  '051': {
    '32': 'مشهد', '33': 'مشهد', '342': 'طرقبه', '343': 'طرقبه', '345': 'سرخس',
    '346': 'فریمان', '347': 'کلات', '35': 'مشهد', '36': 'مشهد', '37': 'مشهد',
    '38': 'مشهد', '42': 'نیشابور', '432': 'نیشابور', '433': 'نیشابور',
    '434': 'نیشابور', '435': 'فیروزه', '436': 'فیروزه', '437': 'فیروزه',
    '438': 'نیشابور', '441': 'سبزوار', '442': 'سبزوار', '443': 'سبزوار',
    '444': 'سبزوار', '445': 'سبزوار', '446': 'سبزوار', '447': 'سبزوار',
    '448': 'سبزوار', '449': 'داورزن', '450': 'سلطان‌آباد', '451': 'سلطان‌آباد',
    '452': 'نقاب', '453': 'نقاب', '454': 'نقاب', '455': 'سبزوار',
    '456': 'جغتای', '457': 'جغتای', '459': 'داورزن', '461': 'چناران',
    '462': 'درگز', '463': 'چناران', '464': 'درگز', '466': 'درگز',
    '468': 'درگز', '472': 'قوچان', '473': 'قوچان', '474': 'قوچان',
    '475': 'قوچان', '477': 'قوچان', '522': 'تربت حیدریه', '523': 'تربت حیدریه',
    '524': 'تربت حیدریه', '525': 'تربت جام', '526': 'تربت جام', '527': 'تربت جام',
    '528': 'تربت جام', '529': 'تربت جام', '532': 'تربت حیدریه', '533': 'تربت حیدریه',
    '534': 'تربت حیدریه', '535': 'تربت حیدریه', '536': 'دولت‌آباد', '537': 'دولت‌آباد',
    '538': 'دولت‌آباد', '539': 'دولت‌آباد', '541': 'خواف', '542': 'خواف',
    '543': 'خواف', '544': 'خواف', '545': 'تایباد', '548': 'باخرز',
    '549': 'باخرز', '551': 'کاشمر', '552': 'کاشمر', '553': 'کاشمر',
    '554': 'بردسکن', '555': 'بردسکن', '556': 'بردسکن', '557': 'خواف',
    '558': 'کاشمر', '559': 'کاشمر', '562': 'رشتخوار', '563': 'رشتخوار',
    '564': 'رشتخوار', '565': 'بجستان', '566': 'بجستان', '567': 'فیض‌آباد',
    '568': 'فیض‌آباد', '569': 'فیض‌آباد', '572': 'گناباد', '573': 'گناباد',
    '574': 'گناباد', '575': 'گناباد', '577': 'خلیل‌آباد', '578': 'خلیل‌آباد',
  },
  '031': {
    '32': 'اصفهان', '332': 'اصفهان', '333': 'اصفهان', '335': 'خمینی‌شهر',
    '336': 'خمینی‌شهر', '337': 'خمینی‌شهر', '338': 'اصفهان', '34': 'اصفهان',
    '35': 'اصفهان', '36': 'اصفهان', '372': 'فلاورجان', '373': 'اصفهان',
    '374': 'فلاورجان', '375': 'فلاورجان', '376': 'فلاورجان', '377': 'اصفهان',
    '378': 'اصفهان', '379': 'اصفهان', '424': 'نجف‌آباد', '426': 'نجف‌آباد',
    '452': 'شاهین‌شهر', '453': 'شاهین‌شهر', '456': 'شاهین‌شهر',
    '457': 'شاهین‌شهر', '458': 'شاهین‌شهر', '462': 'نایین', '463': 'خور',
    '464': 'اصفهان', '465': 'اصفهان', '466': 'اصفهان', '522': 'زرین‌شهر',
    '532': 'شهرضا', '533': 'دهاقان', '534': 'شهرضا', '536': 'سمیرم',
    '537': 'دهاقان', '544': 'اردستان', '545': 'آران و بیدگل',
    '546': 'آران و بیدگل', '552': 'کاشان', '553': 'کاشان', '554': 'کاشان',
    '555': 'کاشان', '556': 'کاشان', '557': 'کاشان', '575': 'بویین میاندشت',
    '5759': 'فریدونشهر', '576': 'داران',
  },
};
const LANDLINE_SHARED = {
  '051': new Set(['546']),
  '031': new Set(['422', '423', '425', '427', '454', '523', '524', '525', '526', '535', '542', '543', '572', '573', '574', '577']),
};

const MOBILE_OPERATORS = {
  '0910': 'همراه اول', '0911': 'همراه اول', '0912': 'همراه اول', '0913': 'همراه اول',
  '0914': 'همراه اول', '0915': 'همراه اول', '0916': 'همراه اول', '0917': 'همراه اول',
  '0918': 'همراه اول', '0919': 'همراه اول', '0990': 'همراه اول', '0991': 'همراه اول',
  '0992': 'همراه اول', '0993': 'همراه اول', '0994': 'همراه اول',
  '0930': 'ایرانسل', '0933': 'ایرانسل', '0935': 'ایرانسل', '0936': 'ایرانسل',
  '0937': 'ایرانسل', '0938': 'ایرانسل', '0939': 'ایرانسل', '0901': 'ایرانسل',
  '0902': 'ایرانسل', '0903': 'ایرانسل', '0905': 'ایرانسل', '0941': 'رایتل',
  '0920': 'تالیا', '0921': 'تالیا', '0932': 'تالیا',
};

/** Cities the scanner can name from written text, without the network. */
export const KNOWN_CITIES = [
  'تهران', 'کرج', 'قم', 'اصفهان', 'مشهد', 'تبریز', 'شیراز', 'اهواز', 'رشت',
  'ساری', 'کرمان', 'یزد', 'همدان', 'کرمانشاه', 'ارومیه', 'اردبیل', 'زنجان',
  'قزوین', 'سمنان', 'گرگان', 'زاهدان', 'بیرجند', 'بجنورد', 'خرم‌آباد',
  'یاسوج', 'بندرعباس', 'بوشهر', 'ایلام', 'اراک', 'سنندج', 'شهرکرد', 'کاشان',
  'نجف‌آباد', 'خمینی‌شهر', 'شاهین‌شهر', 'فولادشهر', 'زرین‌شهر', 'دلیجان',
  'ساوه', 'ملایر', 'بروجرد', 'دورود', 'قائم‌شهر', 'بابل', 'آمل', 'گرمسار',
  'اسلامشهر', 'شهریار', 'ورامین', 'پاکدشت', 'پرند', 'رباط‌کریم',
  'آبادان', 'دزفول', 'ماهشهر', 'بندر ماهشهر', 'مسجد سلیمان', 'شوشتر', 'بهبهان',
  'شاهرود', 'سبزوار', 'نیشابور', 'تربت حیدریه', 'تربت جام', 'قوچان', 'کاشمر',
  'مراغه', 'مرند', 'میانه', 'خوی', 'سلماس', 'مهاباد', 'بوکان', 'سقز', 'پیرانشهر',
  'خلخال', 'پارس‌آباد', 'آستارا', 'بندر انزلی', 'لاهیجان', 'آستانه اشرفیه',
  'صومعه‌سرا', 'فومن', 'تالش', 'رودسر', 'چابهار', 'ایرانشهر', 'سراوان', 'زابل',
  'خاش', 'بم', 'رفسنجان', 'سیرجان', 'جیرفت', 'کهنوج', 'بافت', 'بردسیر', 'شهربابک',
  'میبد', 'اردکان', 'بافق', 'مهریز', 'تفت', 'ابرکوه', 'سپیدان', 'فسا', 'جهرم',
  'لار', 'مرودشت', 'کازرون', 'نی‌ریز', 'استهبان', 'داراب', 'اقلید', 'آباده',
  'گلپایگان', 'نایین', 'اردستان', 'سمیرم', 'چادگان', 'خوانسار', 'دهاقان',
  'برخوار', 'شهرضا', 'دولت‌آباد', 'کوهپایه', 'ورزنه', 'مبارکه', 'مجلسی',
];

/** Latin spellings of Iranian cities, as Google Maps writes them. */
export const CITY_LATIN_NAMES = {
  'tehran': 'تهران', 'karaj': 'کرج', 'qom': 'قم', 'isfahan': 'اصفهان',
  'esfahan': 'اصفهان', 'mashhad': 'مشهد', 'tabriz': 'تبریز', 'shiraz': 'شیراز',
  'ahvaz': 'اهواز', 'rasht': 'رشت', 'sari': 'ساری', 'kerman': 'کرمان',
  'yazd': 'یزد', 'hamedan': 'همدان', 'kermanshah': 'کرمانشاه', 'urmia': 'ارومیه',
  'ardabil': 'اردبیل', 'zanjan': 'زنجان', 'qazvin': 'قزوین', 'semnan': 'سمنان',
  'gorgan': 'گرگان', 'zahedan': 'زاهدان', 'birjand': 'بیرجند', 'bojnourd': 'بجنورد',
  'khorramabad': 'خرم‌آباد', 'yasuj': 'یاسوج', 'bandar abbas': 'بندرعباس',
  'bushehr': 'بوشهر', 'ilam': 'ایلام', 'arak': 'اراک', 'sanandaj': 'سنندج',
  'shahrekord': 'شهرکرد', 'kashan': 'کاشان', 'najafabad': 'نجف‌آباد',
  'sirjan': 'سیرجان', 'sabzevar': 'سبزوار', 'neyshabur': 'نیشابور',
  'shahroud': 'شاهرود', 'saveh': 'ساوه', 'malayer': 'ملایر', 'borujerd': 'بروجرد',
  'amol': 'آمل', 'babol': 'بابل', 'golpayegan': 'گلپایگان', 'mobarakeh': 'مبارکه',
  'fooladshahr': 'فولادشهر', 'abadan': 'آبادان', 'dezful': 'دزفول',
  'mahshahr': 'ماهشهر', 'bandar mahshahr': 'ماهشهر', 'chabahar': 'چابهار',
};

/** Major city centres (IR Iran bbox) — for nearest-city from coordinates. */
const CITY_COORDS = [
  ['تهران', 35.6892, 51.3890], ['کرج', 35.8327, 50.9916], ['قم', 34.6416, 50.8746],
  ['اصفهان', 32.6546, 51.6680], ['مشهد', 36.2605, 59.6168], ['تبریز', 38.0962, 46.2738],
  ['شیراز', 29.5918, 52.5837], ['اهواز', 31.3183, 48.6706], ['رشت', 37.2808, 49.5832],
  ['ساری', 36.5633, 53.0601], ['کرمان', 30.2839, 57.0834], ['یزد', 31.8974, 54.3569],
  ['همدان', 34.7989, 48.5146], ['کرمانشاه', 34.3142, 47.0650], ['ارومیه', 37.5527, 45.0761],
  ['اردبیل', 38.2498, 48.2933], ['زنجان', 36.6736, 48.4787], ['قزوین', 36.2688, 50.0020],
  ['سمنان', 35.5769, 53.3922], ['گرگان', 36.8427, 54.4439], ['زاهدان', 29.4963, 60.8629],
  ['بیرجند', 32.8663, 59.2211], ['بجنورد', 37.4747, 57.3290], ['خرم‌آباد', 33.4878, 48.3558],
  ['یاسوج', 30.6682, 51.5878], ['بندرعباس', 27.1832, 56.2666], ['بوشهر', 28.9234, 50.8203],
  ['ایلام', 33.6374, 46.4227], ['اراک', 34.0917, 49.6892], ['سنندج', 35.3219, 46.9862],
  ['شهرکرد', 32.3256, 50.8644], ['کاشان', 33.9859, 51.4105], ['نیشابور', 36.2130, 58.7960],
  ['شاهرود', 36.4190, 54.9761], ['سبزوار', 36.2130, 57.6770], ['سیرجان', 29.5590, 55.9160],
  ['مبارکه', 32.3667, 51.3667], ['نجف‌آباد', 32.6265, 51.3606], ['ساوه', 35.0231, 50.3561],
  ['ملایر', 34.2896, 48.8243], ['بروجرد', 33.8948, 48.7536], ['دزفول', 32.3814, 48.3989],
  ['آبادان', 30.3392, 48.3043], ['آمل', 36.4712, 52.3523], ['بابل', 36.5514, 52.6789],
  ['قوچان', 37.1190, 58.5150], ['کاشمر', 34.2080, 58.4660], ['تربت حیدریه', 35.2746, 59.2236],
  ['فولادشهر', 32.5703, 51.3731], ['خمینی‌شهر', 32.7264, 51.5317],
];

/** Normalises one phone-like token to digits with a leading zero. */
export function normalizeIranPhone(raw) {
  let d = latin(raw).replace(/[^0-9]/g, '');
  if (d.startsWith('0098')) d = '0' + d.substring(4);
  if (d.startsWith('98') && d.length >= 11) d = '0' + d.substring(2);
  if (d.startsWith('9') && d.length === 10) d = '0' + d;
  return d;
}

function countyOf(area, local) {
  const table = LANDLINE_COUNTIES[area];
  if (!table) return '';
  const shared = LANDLINE_SHARED[area] || new Set();
  for (const len of [3, 2]) {
    if (local.length < len) continue;
    const prefix = local.substring(0, len);
    if (shared.has(prefix)) return '';
    const hit = table[prefix];
    if (hit) return hit;
  }
  return '';
}

/** Classify one number. Never invents a city for a mobile. */
export function classifyPhone(raw) {
  const digits = normalizeIranPhone(raw);
  if (digits.startsWith('09') && digits.length >= 8) {
    return {
      raw, kind: 'موبایل', digits,
      operator: MOBILE_OPERATORS[digits.substring(0, 4)] || '',
      city: '', province: '',
      complete: digits.length === 11,
    };
  }
  if (digits.startsWith('0') && digits.length >= 8 && digits.length <= 11) {
    const area = digits.substring(0, 3);
    const place = LANDLINE_AREAS[area];
    const county = place ? countyOf(area, digits.substring(3)) : '';
    return {
      raw, kind: 'ثابت', digits, areaCode: area,
      city: county || (place ? place[0] : ''),
      province: place ? place[1] : '',
      complete: digits.length === 11,
      countyLevel: !!county,
    };
  }
  return { raw, kind: 'نامشخص', digits, city: '', province: '' };
}

const DIGITS = '[0-9۰-۹٠-٩]';
const PHONE_TOKEN = new RegExp(
  `(?<![${DIGITS}])(?:\\+?98|0)${DIGITS}{2}[\\s\\-‌]*${DIGITS}{3,8}(?:[\\s\\-]?${DIGITS}{2,4})?`, 'g');
const PHONE_REVERSED = /(?<![0-9])([1-9][0-9]{3}[\s]?[0-9]{4})\s*[-–—_/()\s]{1,3}\s*\(?(0[1-8][0-9])\)?(?![0-9])/g;
const PHONE_BRACKETED = /\(?(0[1-8][0-9])\)?\s*[-–—_/)\s]{1,3}\s*([1-9][0-9]{3}[\s\-]?[0-9]{4})(?![0-9])/g;

/** Every phone-like token of a text, de-duplicated, longest/complete first. */
export function phonesIn(text) {
  const seen = new Set();
  const out = [];
  const source = latin(text);
  const take = (candidate) => {
    const digits = normalizeIranPhone(candidate);
    if (digits.length < 8 || digits.length > 13) return;
    for (const k of seen) if (k.startsWith(digits)) return;
    for (const k of [...seen]) if (digits.startsWith(k)) seen.delete(k);
    for (let i = out.length - 1; i >= 0; i--) if (digits.startsWith(out[i].digits)) out.splice(i, 1);
    seen.add(digits);
    out.push(classifyPhone(digits));
  };
  PHONE_REVERSED.lastIndex = 0;
  let m;
  while ((m = PHONE_REVERSED.exec(source))) {
    if (LANDLINE_AREAS[m[2]]) take(`${m[2]}${m[1]}`);
  }
  PHONE_BRACKETED.lastIndex = 0;
  while ((m = PHONE_BRACKETED.exec(source))) {
    if (LANDLINE_AREAS[m[1]]) take(`${m[1]}${m[2]}`);
  }
  PHONE_TOKEN.lastIndex = 0;
  source.replace(PHONE_TOKEN, (tok) => { take(tok); return tok; });
  return out;
}

/** City named by a landline in this text, or ''. */
export function landlineCityIn(text) {
  const phones = phonesIn(text).filter((p) => p.city);
  if (!phones.length) return '';
  phones.sort((a, b) => {
    if (a.complete !== b.complete) return a.complete ? -1 : 1;
    return b.digits.length - a.digits.length;
  });
  return phones[0].city;
}

/* ---------------- Google Maps long-link reading ---------------- */

const MAPS_URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:google\.[a-z.]{2,7}\/maps[^\s<>"'\])]*|maps\.google\.[a-z.]{2,7}[^\s<>"'\])]*|maps\.app\.goo\.gl\/[^\s<>"'\])]*|goo\.gl\/maps\/[^\s<>"'\])]*|g\.co\/maps\/[^\s<>"'\])]*|nshn\.ir\/[^\s<>"'\])]*|neshan\.org\/maps[^\s<>"'\])]*|balad\.ir\/[^\s<>"'\])]*)/gi;
const IRAN_BBOX = { minLat: 25, maxLat: 39.8, minLng: 44, maxLng: 63.5 };

function inIran(lat, lng) {
  return lat >= IRAN_BBOX.minLat && lat <= IRAN_BBOX.maxLat && lng >= IRAN_BBOX.minLng && lng <= IRAN_BBOX.maxLng;
}

/** Nearest known city to a coordinate, or '' outside Iran. */
export function nearestCity(lat, lng) {
  if (!inIran(lat, lng)) return { city: '', km: null };
  let best = null;
  let bestD = Infinity;
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  for (const [name, clat, clng] of CITY_COORDS) {
    const dLat = rad(clat - lat);
    const dLng = rad(clng - lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(clat)) * Math.sin(dLng / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(a));
    if (km < bestD) { bestD = km; best = name; }
  }
  return { city: best || '', km: bestD === Infinity ? null : Math.round(bestD) };
}

/** What can be read from maps links in this text. Short links carry nothing. */
export function mapsLinksIn(text) {
  const out = [];
  const src = latin(text);
  MAPS_URL_RE.lastIndex = 0;
  let m;
  const seen = new Set();
  while ((m = MAPS_URL_RE.exec(src))) {
    let url = m[0];
    if (!/^https?:/i.test(url)) url = 'https://' + url;
    if (seen.has(url)) continue;
    seen.add(url);
    const info = { url, kind: 'نامشخص', lat: null, lng: null, placeName: '', city: '', inIran: false };
    const coord =
      /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(url) ||
      /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/.exec(url) ||
      /[?&](?:q|ll|query)=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(url) ||
      /center=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(url);
    if (coord) {
      const lat = +coord[1], lng = +coord[2];
      info.kind = 'مختصات';
      info.lat = lat; info.lng = lng;
      info.inIran = inIran(lat, lng);
      if (info.inIran) info.city = nearestCity(lat, lng).city;
    } else {
      const place = /\/place\/([^/@?]+)/.exec(url);
      if (place) {
        try {
          info.placeName = decodeURIComponent(place[1].replace(/\+/g, ' ')).trim();
        } catch {
          info.placeName = place[1].replace(/\+/g, ' ');
        }
        info.kind = 'نام مکان';
        const low = info.placeName.toLowerCase();
        for (const [latinName, faName] of Object.entries(CITY_LATIN_NAMES)) {
          if (low.includes(latinName)) { info.city = faName; break; }
        }
        if (!info.city) {
          for (const city of KNOWN_CITIES) {
            if (info.placeName.includes(city)) { info.city = city; break; }
          }
        }
      } else if (/maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/maps|nshn\.ir\/|neshan\.org\/maps\/share|balad\.ir\/p\//i.test(url)) {
        info.kind = 'لینک کوتاه';
      }
    }
    out.push(info);
  }
  return out;
}

/** City from a maps link in the text, if any long link names one. */
export function mapsCityIn(text) {
  for (const info of mapsLinksIn(text)) {
    if (info.city) return info.city;
  }
  return '';
}

/* ---------------- Explicit city in text ---------------- */

const CITY_TEXT_RE = (() => {
  const alt = KNOWN_CITIES.slice().sort((a, b) => b.length - a.length)
    .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:${alt})`, 'g');
})();

const PLACE_CONTEXT_RE = /(?:آدرس|انبار|بارگیری|تحویل|دفتر|فروشگاه|مغازه|نمایندگی|شعبه|کارخانه|مجموعه)[^\n]{0,40}$/;
const DELIVERY_CONTEXT_RE = /(?:انبار|بارگیری|تحویل|دفتر|فروشگاه|نمایندگی|کارخانه)/;

/**
 * City explicitly written for this offer, or ''. A city attached to a
 * place word wins over a bare mention; a bare mention alone is not enough
 * (a sentence like «مشهد مقدس است» is not an offer location).
 */
export function explicitCityIn(text) {
  const s = latin(text);
  let m;
  let best = '';
  CITY_TEXT_RE.lastIndex = 0;
  while ((m = CITY_TEXT_RE.exec(s))) {
    const before = s.substring(0, m.index);
    if (DELIVERY_CONTEXT_RE.test(before) && PLACE_CONTEXT_RE.test(before.slice(-40))) {
      return m[0];
    }
    if (!best) best = m[0];
  }
  return best;
}

/**
 * The city of an offer, from the four written witnesses (strong → weak).
 * Returns { city, basis, conflict } — 'نامشخص' when nothing written names one.
 */
export function resolveCity(text) {
  const t = latin(text || '');
  const declared = explicitCityIn(t);
  const maps = mapsCityIn(t);
  const landline = landlineCityIn(t);
  const witnesses = [
    ['متن آدرس/تحویل', declared],
    ['لینک نقشه', maps],
    ['پیش‌شماره تلفن ثابت', landline],
  ].filter(([, c]) => c);
  if (!witnesses.length) return { city: 'نامشخص', basis: '', conflict: '' };
  const [basis, city] = witnesses[0];
  const others = witnesses.slice(1).map(([b, c]) => `${b}: ${c}`).join('؛ ');
  const conflict = witnesses.some(([, c]) => c !== city) ? others : '';
  return { city, basis, conflict };
}
