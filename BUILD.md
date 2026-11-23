# راهنمای ساخت، راه‌اندازی و استقرار — سرور هوش جستجوگر ۲ (`qwenscanner v2.0`)

این راهنما نحوهٔ راه‌اندازی، بازنشانی دیتابیس D1، تست و استقرار سرور آنلاین **هوش جستجوگر ۲ (Searcher-2)** برای اپلیکیشن **IronPin** را شرح می‌دهد.

> از نسخهٔ **۲.۰.۰** به بعد، این سرویس **منحصراً هوش جستجوگر ۲** (کشف و راستی‌آزمایی منابع فروش مقاطع فولادی) را اجرا می‌کند و هیچ‌گونه استخراج قیمت (`ironpin_quotes` / Searcher-1 / OCR / AI) روی سرور انجام نمی‌دهد.

---

## ۰. پیش‌نیازها

| مورد | توضیح |
|------|-------|
| حساب Cloudflare | پلن رایگان (`Workers Free` + `D1 Free`) کافی است |
| Node.js | نسخهٔ ۲۰ یا بالاتر (`node -v`) |
| npm | همراه Node.js |
| Wrangler | نسخهٔ ۴ (`npx wrangler --version`) |

---

## ۱. تنظیم متغیرهای احراز هویت Cloudflare

```bash
export CLOUDFLARE_API_TOKEN="YOUR_CLOUDFLARE_API_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="YOUR_CLOUDFLARE_ACCOUNT_ID"
```

برای نمایش آمار مصرف Cloudflare در پنل وب (`src/usage.js`)، سه Secret زیر روی Worker لازم است:

```bash
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_D1_ID
```

---

## ۲. ساختار پروژه و فایل‌ها

| فایل | نقش |
|------|-----|
| `wrangler.toml` | پیکربندی Worker، اتصال D1 (`DB`)، دارایی‌های ایستا (`public/`)، کرون `*/5 * * * *` و متغیرهای محدودکننده |
| `wipe.sql` | حذف کامل جداول قدیمی و جدید برای شروع تمیز |
| `schema.sql` | ایجاد ۴ جدول بهینه و ایندکس‌گذاری‌شده (`meta`, `custom_products`, `sources`, `search_tasks`) |
| `src/index.js` | نقطهٔ ورود Worker (`fetch` برای API/پنل و `scheduled` برای اجرای کرون) |
| `src/api.js` | روتر REST API (`/api/sources`, `/api/status`, `/api/scan/trigger`, `/api/config`, `/api/products`, `/api/usage/refresh`, `/api/reset`) |
| `src/classify.js` | طبقه‌بندی لینک‌ها (`classifyLink`، `webAddressOf` برای `tg://`/`et://`، تفکیک ۳ لیست، پیش‌نمایش `/s/`) |
| `src/banks.js` | واژگان محصولات فولادی، تشخیص اقلام غیرفلزی (`isNonMetal`)، `tradeEvidence` / `sellsGoods`، بانک پرس‌وجوهای `FinderPlan`، پرس‌وجوهای محصولات سفارشی، شهر و خطوط تماس |
| `src/engines.js` | اتصال به **۹ موتور جستجو** (`ddg-lite`, `yahoo`, `bing`, `ddg`, `naver`, `bing-html`, `yahoo-ca`, `gerdoo`, `zarebin`) و **۶ دایرکتوری کانال ایرانی** |
| `src/verifier.js` | تحلیلگر سبک HTML بدون ساخت درخت DOM سنگین (زیر سقف ۱۰ میلی‌ثانیه CPU) و راستی‌آزمایی صفحهٔ عمومی |
| `src/finder.js` | موتور چرخشی هوش جستجوگر ۲، مدیریت `cooldown` موتورها و دامنه‌ها، پیمایش عمق ۲، چرخه ۲۴ ساعته قابل تنظیم و صف محصولات سفارشی |
| `src/usage.js` | پایش مصرف و سقف‌های پلن رایگان Cloudflare Workers و D1 |
| `public/index.html` | پنل اصلی سبک (وضعیت چرخه، نگهبان لیمیت‌های کلادفلر، پاک‌سازی ۶ماهه/دستی و مدیریت محصولات) |
| `public/sources.html` | صفحه اختصاصی و صفحه‌بندی‌شدهٔ فهرست منابع (`/sources`) برای سبک ماندن بارگذاری پنل اصلی |
| `test/*.test.js` | ۵ سوئیت آزمون مستقل (`classify`, `banks`, `engines`, `verifier`, `finder`) |

---

## ۳. راه‌اندازی و پاک‌سازی دیتابیس D1

اگر دیتابیس قبلی وجود دارد و می‌خواهید کامل پاک و از نو ساخته شود:

```bash
npm run db:wipe
npm run db:apply
```

یا برای توسعهٔ محلی:

```bash
npm run db:apply:local
```

بررسی جداول ساخته‌شده:

```bash
npx wrangler d1 execute qwen_scanner --command="SELECT name FROM sqlite_master WHERE type='table'" --remote
```

جداول مورد انتظار: `meta`, `custom_products`, `sources`, `search_tasks`.

---

## ۴. اجرای آزمون‌ها و استقرار

```bash
npm install
npm test
npm run deploy
```

آدرس تولید فعال: `https://qwen.alisport0.qzz.io/`

---

## ۵. تنظیمات پلن رایگان Cloudflare (در `wrangler.toml`)

```toml
[triggers]
crons = ["*/5 * * * *"]

[vars]
DEFAULT_REFRESH_HOURS = "24"
SEARCH_QUERIES_PER_TICK = "3"
VERIFIES_PER_TICK = "8"
MAX_SUBREQUESTS_PER_TICK = "28"
FETCH_TIMEOUT_MS = "9000"
```

* سقف‌های Cloudflare Free: **۱۰ میلی‌ثانیه CPU** و **۵۰ درخواست خروجی (`subrequests`)** در هر اجرا، **۵ میلیون ردیف خواندن** و **۱۰۰ هزار نوشتن** روزانه در D1، **۵۰۰ مگابایت** فضای D1، و **۱۰۰ هزار درخواست** روزانهٔ Worker.
* در زمان بیکاری چرخه، هر تیک کرون `*/5 * * * *` تنها ۲–۴ ردیف ایندکس‌شده می‌خواند و در کمتر از ۱ میلی‌ثانیه متوقف می‌شود.

---

## ۶. مرجع API

| متد | مسیر | توضیح |
|-----|------|-------|
| `GET` | `/api/health` | بررسی سلامت و حالت اجرا (`searcher2-only`) |
| `GET` | `/api/sources` | خروجی رسمی `ironpin-sources-v1` برای اپلیکیشن IronPin (پشتیبانی از `?readable=1`, `?part=0\|1\|2`, `?product=...`) |
| `GET` | `/api/status` | وضعیت کامل چرخه، شمارش ۳ لیست، وضعیت ۹ موتور و ۶ دایرکتوری، محصولات سفارشی و مصرف Cloudflare |
| `POST` | `/api/scan/trigger` | اجرای فوری یک برش اسکن (یا شروع چرخه جدید در صورت بیکار بودن) |
| `POST` | `/api/config` | تغییر بازه اسکن خودکار (`refresh_hours`: ۱ تا ۱۶۸) و بازه نگهداری منابع (`retention_months`: ۱ تا ۳۶، پیش‌فرض ۶) |
| `POST` | `/api/sources/purge` | پاک‌سازی دستی منابع (`{ mode: "older", months }` یا `{ mode: "all" }` برای حذف همهٔ منابع) |
| `GET` | `/api/products` | فهرست محصولات سفارشی افزوده‌شده |
| `POST` | `/api/products` | افزودن محصول سفارشی `{ name }` و صف‌کردن فوری پرس‌وجوهای کشف منبع |
| `DELETE` | `/api/products?id=<id>` | حذف محصول سفارشی و پرس‌وجوهای در انتظار آن |
| `POST` | `/api/usage/refresh` | بروزرسانی مستقیم آمار مصرف از API کلودفلر |
| `POST` | `/api/reset` | پاک‌سازی داده‌های کشف‌شده و بازنشانی شمارنده‌ها |
