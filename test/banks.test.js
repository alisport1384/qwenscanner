import assert from 'node:assert/strict';
import {
  FINDER_BANKS,
  contactLines,
  customProductQueries,
  finderQueries,
  isNonMetal,
  knownCity,
  normalizeText,
  sellsGoods,
  tradeEvidence,
} from '../src/banks.js';

assert.equal(normalizeText('میلگرد\u200c۱۶_آجدار كاشان ي'), 'میلگرد 16 آجدار کاشان ی');

// Non-metal pharmaceutical/MDF rejection
assert.equal(isNonMetal('قرص آهن فروس سولفات ۵۰ میلی گرم'), true);
assert.equal(isNonMetal('قیمت ورق ام دی اف ملامینه'), true);
assert.equal(isNonMetal('قیمت میلگرد ۱۶ اصفهان هر کیلو ۲۸۵۰۰ تومان'), false);

// Short text trade evidence
assert.equal(sellsGoods('فروش میلگرد ۱۶ قیمت روز تهران'), true);
assert.equal(sellsGoods('قرص آهن ففول قیمت داروخانه'), false);
assert.equal(sellsGoods('این یک مقاله درباره تاریخچه ساختمان است'), false);

// Long text requires >= 3 goods and >= 2 trade
const longGood =
  'فروش و پخش میلگرد و تیرآهن و ورق سیاه با قیمت روز کارخانه و تحویل فوری بنگاه. '.repeat(12);
assert.equal(longGood.length > 600, true);
assert.equal(sellsGoods(longGood), true);

const longWeak = ('قیمت میلگرد فقط یکبار گفته شد ' + 'متن عمومی بی‌ربط '.repeat(60));
assert.equal(tradeEvidence(longWeak).okFor(longWeak.length), false);

// Custom keyword support
assert.equal(sellsGoods('فروش پانل ساندویچی سقفی با قیمت روز کارخانه', 'پانل ساندویچی'), true);

// FinderPlan banks
assert.equal(FINDER_BANKS.length, 3);
assert.equal(finderQueries(0, 0).length, 5);
assert.equal(finderQueries(1, 0).length, 5);
assert.equal(finderQueries(2, 0).length, 5);

const cpq = customProductQueries('میلگرد زاگرس');
assert.equal(cpq.length, 6);
assert.ok(cpq.some((q) => q.kind === 'directory'));

// City & contact extraction
assert.equal(knownCity('دفتر فروش مشهد بلوار طرحچی'), 'مشهد');
assert.equal(knownCity('تهران بازار آهن شادآباد'), 'تهران');
const contact = contactLines('سلام\nتلفن فروش: 09151234567\nآدرس: مشهد طرحچی ۷\nمتن عادی');
assert.ok(contact.includes('09151234567'));
assert.ok(contact.includes('طرحچی'));

console.log('banks.test.js PASS');
