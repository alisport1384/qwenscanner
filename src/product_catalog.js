/** Product catalog v2 — fields + notes for steel families (IronPin product_schema + user specs).
 *  Families used for classification, price context and seed topics.
 */

/** IronPin productFields (evidence-based labels) + extra technical notes. */
export const PRODUCT_FIELDS = {
  'ورق': {
    kind: 'نوع ورق', thickness: 'ضخامت', width: 'عرض', length: 'طول',
    grade: 'گرید', material: 'جنس', form: 'حالت عرضه', dimensions: 'ابعاد', dimUnit: 'واحد ابعاد',
  },
  'میلگرد بستر': {
    width: 'عرض بستر', size: 'قطر مفتول', length: 'طول',
    material: 'جنس', coating: 'پوشش', dimUnit: 'واحد ابعاد',
  },
  'میلگرد': {
    size: 'قطر اسمی', grade: 'گرید / آنالیز', kind: 'نوع میلگرد',
    length: 'طول', material: 'جنس', dimUnit: 'واحد ابعاد',
  },
  'تیرآهن': {
    grade: 'استاندارد مقطع', size: 'سایز / ارتفاع اسمی',
    length: 'طول', material: 'جنس', dimUnit: 'واحد ابعاد',
  },
  'تیرچه': {
    kind: 'نوع تیرچه (فلزی / بتنی)',
    size: 'ارتفاع / سایز', length: 'طول',
    material: 'جنس', grade: 'گرید فولاد',
    mesh: 'شبکه / مفتول', dimUnit: 'واحد ابعاد',
  },
  'نبشی': {
    dimensions: 'دو بال', thickness: 'ضخامت', length: 'طول',
    form: 'فابریک / پرسی', material: 'جنس', grade: 'گرید', dimUnit: 'واحد ابعاد',
  },
  'ناودانی': {
    size: 'ارتفاع اسمی', thickness: 'ضخامت', length: 'طول',
    grade: 'استاندارد مقطع', material: 'جنس', dimUnit: 'واحد ابعاد',
  },
  'سپری': {
    size: 'سایز', thickness: 'ضخامت', length: 'طول',
    grade: 'گرید', material: 'جنس', dimUnit: 'واحد ابعاد',
  },
  'پروفیل': {
    dimensions: 'ابعاد مقطع', thickness: 'ضخامت', kind: 'نوع مقطع',
    length: 'طول', material: 'جنس', grade: 'گرید', dimUnit: 'واحد ابعاد',
  },
  'لوله': {
    size: 'قطر اسمی طبق منبع', thickness: 'ضخامت', kind: 'نوع لوله',
    length: 'طول', schedule: 'رده (Sch)', material: 'جنس', grade: 'گرید',
    dimUnit: 'واحد قطر / ابعاد',
  },
  'بولت': {
    kind: 'نوع بولت / انکر (خام L/J/U، مکانیکی رول‌بولت، شیمیایی HIT)',
    size: 'قطر اسمی', length: 'طول طبق منبع', threadLength: 'طول رزوه',
    pitch: 'گام رزوه', grade: 'گرید / رده مقاومتی (F1554 جدا از 10.9)',
    material: 'جنس', coating: 'پوشش',
    accessories: 'شمول مهره، واشر، چسب / ست', model: 'مدل / تأییدیه سیستم',
    embedment: 'عمق کاشت مؤثر', torque: 'گشتاور',
    lengthDeployed: 'طول بازشده روی محور',
    massNote: 'وزن ست ≠ وزن بدنه',
    dimUnit: 'واحد ابعاد',
  },
  'تسمه': {
    form: 'فابریک / برشی / ترانس', width: 'عرض', thickness: 'ضخامت',
    length: 'طول', material: 'جنس', grade: 'گرید (CK45 و…)',
    tolerance: 'تلرانس‌ها', cutPrice: 'قیمت برش سفارشی', dimUnit: 'واحد ابعاد',
  },
  'چهارپهلو': {
    size: 'ضلع', length: 'طول', material: 'جنس', grade: 'گرید',
    form: 'نوردی سیاه vs ترانس سنگ‌خورده',
    hexKey: 'شش‌پر آچاری', areaFormula: 'فرمول √3/2', dimUnit: 'واحد ابعاد',
  },
  'مفتول': {
    size: 'نمره = قطر', kind: 'نوع مفتول', material: 'جنس', grade: 'گرید',
    coil: 'کلاف 30kg', use: 'سیاه بتن vs گالوانیزه فضا باز', dimUnit: 'واحد ابعاد',
  },
  'مش جوشی': {
    size: 'قطر سیم', mesh: 'چشمه (nx/ny ≠ تعداد سیم)',
    dimensions: 'ابعاد برگ', material: 'جنس',
    overlap: 'اورلب 1 چشمه', massFormula: 'فرمول kg/برگ', dimUnit: 'واحد ابعاد',
  },
  'توری': {
    mesh: 'چشمه', size: 'قطر سیم', dimensions: 'ابعاد',
    kind: 'حصاری / مرغی / فرنگی / گابیون / سرند',
    coating: 'پوشش (Z180 — عمر ~20 سال)', material: 'جنس', dimUnit: 'واحد ابعاد',
  },
  'رابیتس': {
    columns: 'تعداد ستون (9/11/13)', mass: 'وزن برگ کارخانه‌ای',
    massNote: 'ستون به‌تنهایی وزن نمی‌دهد', dimensions: 'ابعاد',
    material: 'جنس', dimUnit: 'واحد ابعاد',
  },
  'شمش': {
    grade: 'آنالیز (3SP vs 5SP)', dimensions: 'مقطع (بیلت/بلوم/اسلب)',
    length: 'طول', material: 'جنس',
    exchange: 'حواله بورس کالا', dimUnit: 'واحد ابعاد',
  },
  'قراضه': {
    kind: 'نوع / درجه سورت (۸ درجه)', material: 'جنس', form: 'خرید / فروش',
    purity: 'خلوص', deduction: 'کسر ناخالصی', contaminant: 'مس دشمن کوره',
  },
  'other': {
    kind: 'سایر (DRI / گندله / بریکت / فروآلیاژ)',
    material: 'جنس', grade: 'گرید / آنالیز', form: 'حالت عرضه',
    unit: 'تن / کیلوگرم طبق اطلاعیه',
  },
};

/** Catalog notes (user specs) keyed by family id — for docs, tags, UI. */
export const CATALOG_NOTES = {
  'لوله': '۸ گرید: مانیسمان/ERW/اسپیرال/API/داربستی/گالوانیزه (+گازی/مبلی/جدار چاه)؛ رده Sch؛ نمره اینچی ≠ قطر واقعی؛ ۵ نوع معامله؛ هزینه حمل 12m',
  'بولت': 'L/J/U خام؛ مکانیکی رول‌بولت؛ شیمیایی HIT کپسولی؛ F1554 جدا از 10.9؛ طول بازشده روی محور؛ گشتاور؛ عمق کاشت؛ وزن ست ≠ بدنه',
  'تسمه': 'فابریک/برشی/ترانس با تلرانس‌ها؛ CK45؛ قیمت برش سفارشی',
  'چهارپهلو': 'نوردی سیاه vs ترانس سنگ‌خورده؛ شش‌پر آچاری؛ فرمول √3/2',
  'مفتول': 'نمره = قطر؛ کلاف 30kg؛ سیاه بتن vs گالوانیزه فضا باز',
  'مش جوشی': 'چشمه ≠ تعداد سیم (nx/ny)؛ اورلب 1 چشمه؛ فرمول kg/برگ',
  'توری': 'حصاری/مرغی/فرنگی/گابیون/سرند؛ Z180 عمر ~20 سال',
  'رابیتس': 'ستون 9/11/13 + وزن برگ کارخانه‌ای (ستون به‌تنهایی وزن نمی‌دهد)',
  'تیرچه': 'فلزی فولادی vs بتنی با شبکه فولادی؛ ارتفاع و طول؛ مفتول شبکه؛ واحد شاخه / متر طبق منبع',
  'شمش': 'بیلت/بلوم/اسلب؛ 3SP vs 5SP؛ حواله بورس کالا',
  'قراضه': '۸ درجه سورت؛ خلوص؛ کسر ناخالصی؛ مس دشمن کوره',
  other: 'DRI / گندله / بریکت / فروآلیاژها — ردیف «سایر»',
};

/** Family matchers — order matters (more specific first). */
const FAMILY_MATCHERS = [
  ['بولت', /انکر\s*بولت|انکربولت|رول\s*بولت|رول‌بولت|\bbolt\b|F1554|\bHIT\b|شیمیایی\s*کپسولی|پیچ\s*مکاری/i],
  ['میلگرد بستر', /میلگرد\s*بستر|بستر\s*میلگرد/i],
  ['میلگرد', /میلگرد|rebar/i],
  ['تیرچه', /تیر\s*چه|tirche/i],
  ['تیرآهن', /تیر\s*آهن|تیراهن|\bIPE\b|\bINP\b|\bHEA\b|\bHEB\b|هاش/i],
  ['نبشی', /نبشی|angle\s*steel/i],
  ['ناودانی', /ناودانی|\bUPN\b|\bUPE\b/i],
  ['سپری', /سپری/i],
  ['پروفیل', /پروفیل|قوطی|مربعی\s*بسته|مستطیلی\s*بسته/i],
  ['چهارپهلو', /چهار\s*پهلو|شش\s*پر/i],
  ['لوله', /لوله|\bpipe\b|\btube\b|مانیسمان|اسپیرال|\bERW\b|\bAPI\b|\bSCH\b|داربستی/i],
  ['تسمه', /تسمه|\bstrip\b|\bband\b/i],
  ['مفتول', /مفتول|سیم\s*بتن|سیم\s*آرماتور|کلاف\s*سیم/i],
  ['مش جوشی', /مش\s*جوشی|مش\s*فولادی|\bwelded\s*mesh\b/i],
  ['توری', /توری|گابیون|حصاری|مرغی|سرند|\bZ180\b/i],
  ['رابیتس', /رابیتس/i],
  ['شمش', /شمش|\bbillet\b|\bbloom\b|\bslab\b|3SP|5SP|حواله\s*بورس/i],
  ['قراضه', /قراضه|آهن\s*قراضه|سورت|\bscrap\b/i],
  ['other', /\bDRI\b|گندله|بریکت|فرو\s*آلیاژ|اسفنجی\s*آهن|pellet|briquette|ferro/i],
  ['ورق', /ورق|\bsheet\b|\bplate\b|شیت|گالوانیزه|عرشه/i],
];

/** Classify free text → family id or ''. */
export function classifyProduct(text) {
  const t = String(text || '');
  if (!t) return '';
  for (const [id, re] of FAMILY_MATCHERS) {
    if (re.test(t)) return id;
  }
  return '';
}

/** Extended price topics for seed top-up (v2). */
export const EXTRA_PRICE_TOPICS = [
  'قیمت تسمه فولادی امروز',
  'قیمت چهارپهلو امروز',
  'قیمت مفتول امروز',
  'قیمت مش جوشی امروز',
  'قیمت توری حصاری امروز',
  'قیمت رابیتس امروز',
  'قیمت شمش فولاد امروز',
  'قیمت قراضه آهن امروز',
  'قیمت انکر بولت امروز',
  'قیمت بولت فولادی امروز',
  'قیمت لوله مانیسمان امروز',
  'قیمت آهن اسفنجی و DRI امروز',
  'قیمت بریکت و گندله امروز',
  'قیمت فروآلیاژ امروز',
];

/** Seed meta key for catalog top-up. */
export const CATALOG_SEED_KEY = 'product_catalog_seeded';
export const CATALOG_VERSION = 2;
