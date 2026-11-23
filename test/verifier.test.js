import assert from 'node:assert/strict';
import { judgePublicPage, parsePublicPage } from '../src/verifier.js';

const sampleHtml = `
<!doctype html>
<html>
<head>
  <title>لیست قیمت میلگرد | فولاد گستر مشهد</title>
  <meta property="og:site_name" content="فولاد گستر مشهد" />
  <meta name="description" content="فروش و پخش میلگرد و تیرآهن قیمت روز" />
  <style>.hidden { color: red; }</style>
  <script>var secret = "ignore me میلگرد";</script>
</head>
<body>
  <h1>قیمت روز میلگرد و تیرآهن و ورق سیاه</h1>
  <p>فروش عمده و تحویل فوری بنگاه مشهد طرحچی ۵ با قیمت مناسب و تومان</p>
  <p>تلفن فروش: 09151112233</p>
  <p>کانال ایتا بدون لینک: eitaa.com/fooladgostar</p>
  <table>
    <tr><th>محصول</th><th>قیمت (تومان)</th></tr>
    <tr><td>میلگرد ۱۶</td><td>۲۸۵۰۰</td></tr>
  </table>
  <a href="/price/sheet">قیمت ورق سیاه</a>
  <a href="tg://resolve?domain=fooladgostar_tg">تلگرام ما</a>
  <a href="https://rubika.ir/fooladgostar_rb">روبیکا</a>
</body>
</html>
`;

const parsed = parsePublicPage('https://fooladgostar.ir/rebar', sampleHtml);
assert.equal(parsed.site, 'فولاد گستر مشهد');
assert.equal(parsed.table, true);
assert.ok(!parsed.text.includes('ignore me'));
assert.ok(parsed.links.some((l) => l.url === 'https://fooladgostar.ir/price/sheet'));
assert.ok(parsed.links.some((l) => l.url === 'https://t.me/fooladgostar_tg'));
assert.ok(parsed.links.some((l) => l.url === 'https://rubika.ir/fooladgostar_rb'));
assert.ok(parsed.links.some((l) => l.url === 'https://eitaa.com/fooladgostar'));

const judged = judgePublicPage('https://fooladgostar.ir/rebar', sampleHtml);
assert.equal(judged.sells, true);
assert.equal(judged.city, 'مشهد');
assert.ok(judged.contact.includes('09151112233'));

const nonSteelHtml = `<html><head><title>داروخانه آنلاین</title></head><body>
  <p>فروش قرص آهن ففول و کپسول ویتامین قیمت بسته ۵۰ هزار تومان</p>
</body></html>`;
const badJudged = judgePublicPage('https://pharma.ir/fefol', nonSteelHtml);
assert.equal(badJudged.sells, false);

console.log('verifier.test.js PASS');
