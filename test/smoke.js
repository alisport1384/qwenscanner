/**
 * Smoke test for the IronPin mirror extraction pipeline.
 * Run: node test/smoke.js
 */
import { analyzeText } from '../src/text_engine.js';
import { extractQuotesFromPage, repairQuote, computeConversions } from '../src/ironpin.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}

// --- Test 1: simple price with size + unit + Toman ---
const t1 = `قیمت میل استیل 12 میلی متری ۳۵۰ هزار تومان برای هر تن
امروز ۱۴۰۴/۰۳/۱۰
در هر متر`;
let quotes = analyzeText({ text: t1,
  endpoint: 'qwen-scanner', seller: 'فروشگاه البرز', sourceUrl: 'https://example.com/1',
  fetchedAt: Date.now(), sellerCity: 'تهران', defaultCurrency: 'نامشخص',
 });
check('simple quote count 1', quotes.length === 1, JSON.stringify(quotes.map(q => q.amount)));
if (quotes[0]) {
  check('amount 350000', quotes[0].amount === 350000, String(quotes[0].amount));
  check('title mentions میل استیل', /میل استیل/.test(quotes[0].title || ''));
  check('currency تومان', quotes[0].currency === 'تومان');
  check('unit value present', ['ton','m','kg','piece','sheet','roll','m2'].includes(quotes[0].unit));
}

// --- Test 2: Rial → Toman conversion (in extractQuotesFromPage) ---
const t2 = `قیمت ورق آهن 3 میلی 450000 ریال در متر
قیمت روز`;
const q2 = extractQuotesFromPage(t2, { endpoint: 'qwen-scanner', seller: 'شرکت فولاد', sourceUrl: 'https://example.com/2', fetchedAt: Date.now(), sellerCity: 'شیراز', defaultCurrency: 'نامشخص' });
check('rial→toman 45000', q2.length === 1 && q2[0].amount === 45000 && q2[0].currency === 'تومان', JSON.stringify(q2.map(q => [q.amount, q.currency])));

// --- Test 3: multi-line with separator and title ---
const t3 = `# جدول قیمت آهن آلات
میل ۸: ۶۰۰,۰۰۰ تومان / متر
میل ۱۰: ۹۵۰,۰۰۰ تومان / متر
`;
quotes = analyzeText({ text: t3,
  endpoint: 'qwen-scanner', seller: 'خط تولید', sourceUrl: 'https://example.com/3',
  fetchedAt: Date.now(), sellerCity: 'مشهد', defaultCurrency: 'نامشخص',
 });
check('multi quote rows', quotes.length >= 2, String(quotes.length));
const amounts = quotes.map(q => q.amount).sort((a, b) => a - b);
check('multi amounts 600000/950000', amounts[0] === 600000 && amounts[amounts.length - 1] === 950000, JSON.stringify(amounts));

// --- Test 4: reject pure prose without price ---
const t4 = `آهن آلات با کیفیت عالی در بازار موجود است. محصولات متنوع و با استانداردهای روز.`;
quotes = analyzeText({ text: t4,
  endpoint: 'qwen-scanner', seller: 'وبسایت خبری', sourceUrl: 'https://example.com/4',
  fetchedAt: Date.now(), sellerCity: 'نامشخص', defaultCurrency: 'نامشخص',
 });
check('reject prose no-price', quotes.length === 0, String(quotes.length));

// --- Test 5: extractQuotesFromPage with junk markers ---
const t5 = `قیمت میلگرد 14: 1,200,000 تومان — لینک کوتاه کد خبر 12345`;
const q5 = extractQuotesFromPage(t5, { endpoint: 'qwen-scanner', seller: 'سل', sourceUrl: 'https://x/5', fetchedAt: Date.now(), sellerCity: 'نامشخص', defaultCurrency: 'نامشخص' });
check('junk marker strips row', q5.length === 0, JSON.stringify(q5.map(q => q.amount)));

// --- Test 6: repairQuote accepts a valid steel quote ---
const q6 = repairQuote({
  id: 'r6', endpoint: 'qwen-scanner', seller: 'س', title: 'میلگرد ۱۲', category: 'میل استیل',
  material: 'استیل', unit: 'm', currency: 'تومان', amount: 300000,
  sourceUrl: 'https://x/6', publishedAt: null, fetchedAt: Date.now(),
  unitPrice: 300000, pieceKg: 0.888, lengthM: 1, areaM2: null,
 });
check('repair quote ok', q6 && q6.amount === 300000, JSON.stringify(q6));

// --- Test 7: computeConversions rebar per-meter ---
const conv = computeConversions('میلگرد ۱۲، وزن هر متر 0.888 کیلوگرم', { unit: 'm', size: '12', thickness: '', dims: '' });
check('conversion kg/m from text', conv?.kgm === 0.888 && conv?.pieceKg == null, JSON.stringify(conv));

const convP = computeConversions('هر شاخه ۱۲ کیلوگرم', { unit: 'piece', size: '', thickness: '', dims: '' });
check('conversion pieceKg from text', convP?.pieceKg === 12, JSON.stringify(convP));

const conv2 = computeConversions('میلگرد ۱۲', { unit: 'm', size: '12', thickness: '', dims: '' });
check('rebar formula kg/m', conv2?.kgm != null && Math.abs(conv2.kgm - 0.888) < 0.01, JSON.stringify(conv2));

// --- Test 8: guard — amount out of range dropped ---
const q8 = repairQuote({
  id: 'r8', endpoint: 'qwen-scanner', seller: 'س', title: 'میلگرد ۱۶', category: 'میل استیل',
  material: 'استیل', unit: 'm', currency: 'تومان', amount: 50,
  sourceUrl: 'https://x/8', publishedAt: null, fetchedAt: Date.now(),
  unitPrice: 50, pieceKg: null, lengthM: null, areaM2: null,
 });
check('drop absurd amount', q8 === null, String(q8));

// --- Test 9: reject non-steel claim ---
const q9 = repairQuote({
  id: 'r9', endpoint: 'qwen-scanner', seller: 'س', title: 'قیمت ماشین', category: 'ماشین',
  material: '—', unit: 'عدد', currency: 'تومان', amount: 5000000,
  sourceUrl: 'https://x/9', publishedAt: null, fetchedAt: Date.now(),
  unitPrice: 5000000, pieceKg: null, lengthM: null, areaM2: null,
 });
check('drop non-steel claim', q9 === null, String(q9));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
