# راهنمای کامل ساخت و استقرار — اسکنر آنلاین آیرون پین

سند گام‌به‌گام راه‌اندازی پنل اسکنر، دیتابیس D1، استقرار روی Cloudflare،
لیست اسکن، و اتصال به اپلیکیشن آیرون پین.

---

## ۰. پیش‌نیازها

| مورد | نسخه / توضیح |
|------|----------------|
| حساب Cloudflare | رایگان کافی است (Workers Free + D1 Free) |
| Node.js | ۲۰ یا بالاتر (`node -v`) |
| npm | همراه Node |
| دسترسی ترمینال | برای اجرای wrangler |

---

## ۱. دریافت API Token از Cloudflare

1. وارد [dash.cloudflare.com](https://dash.cloudflare.com) شوید.
2. سمت راست بالا: **My Profile** → **API Tokens** → **Create Token**.
3. قالب **Edit Cloudflare Workers** را بزنید (یا Custom).
4. مجوزهای لازم (اگر Custom ساختید):
   - Account → **Cloudflare Workers Scripts**: Edit
   - Account → **D1**: Edit
   - Zone → **Workers Routes**: Edit (اگر دامنه دارید؛ برای workers.dev لازم نیست)
5. Account Scope: همان حساب خودتان.
6. **Continue to summary** → **Create Token** → توکن را کپی کنید (فقط یک بار نمایش داده می‌شود).

```bash
export CLOUDFLARE_API_TOKEN="YOUR_TOKEN_HERE"
export CLOUDFLARE_ACCOUNT_ID="YOUR_ACCOUNT_ID"
```

Account ID: صفحه اصلی داشبورد → سمت راست پنل خلاصه اکانت → **Account ID**.

---

## ۲. ساخت پروژه و وابستگی‌ها

```bash
cd qwen-scanner
npm install
```

فایل‌های کلیدی:

| فایل | نقش |
|------|-----|
| `wrangler.toml` | پیکربندی Worker، D1، Cron، متغیرها |
| `schema.sql` | DDL دیتابیس (batches, scans, pages, sources, meta, ironpin_quotes) |
| `src/` | منطق Worker (API، pipeline، موتورها، retention، finder، seed، guardian) |
| `src/text_engine.js` | جستجوگر ۱ — تجزیه متن و استخراج ردیف قیمت |
| `src/ironpin.js` | mapping Quote، دروازه حذف زباله، خروجی /api/ironpin |
| `src/ironpin_data.js` | دانش آیرون پین: endpointها، registry، بانکهای جستجوگر ۲ |
| `src/retention.js` | پاک‌سازی قیمت: نزدیک سقف فری → ۳ روز؛ هر ۳۱ روز → ۲۴ ساعت |
| `src/finder.js` | هوش جستجوگر ۲ — classifyLink + سه لیست + کشف منبع |
| `src/seed.js` | کاشت اولیه منابع/موضوعات قیمت آیرون پین در اولین tick |
| `src/image_extract.js` | استخراج تایپ‌شده از تصویر (Clairic) → ردیف Quote |
| `public/index.html` | پنل فارسی |
| `test/smoke.js` | تست استخراج و دروازه‌های حذف |

> مسیر RAG/چانکی مدل کوئن (`chunker.js`، جدول `knowledge`، `/api/qwen`،
> `/api/hushyar`، بخش دانش کوئن در گزارش‌ها) **حذف** شده است.

---

## ۳. ساخت دیتابیس D1

```bash
npx wrangler d1 create qwen_scanner
```

خروجی شامل `database_id` است. آن را در `wrangler.toml` جایگزین کنید:

```toml
[[d1_databases]]
binding = "DB"
database_name = "qwen_scanner"
database_id = "REPLACE_WITH_YOUR_DATABASE_ID"   # ← اینجا
```

اعمال جدول‌ها (ریموت = همان دیتابیس ابری):

```bash
npx wrangler d1 execute qwen_scanner --file=./schema.sql --remote
```

تایید:

```bash
npx wrangler d1 execute qwen_scanner --command="SELECT name FROM sqlite_master WHERE type='table'" --remote
```

باید شامل `batches`, `scans`, `pages`, `sources`, `meta`, `ironpin_quotes` باشد.

---

## ۴. استقرار Worker

```bash
npx wrangler deploy
```

### آدرس عملی این استقرار (آماده)

| نقش | آدرس |
|------|------|
| **پنل** | `https://qwen.alisport0.qzz.io/` |
| **گزارش لیست** | `https://qwen.alisport0.qzz.io/report/batch/<UUID>` |
| **JSON لیست** | `https://qwen.alisport0.qzz.io/api/report/batch/<UUID>` |
| D1 | `qwen_scanner` · id `da86e390-bf90-4e29-b7df-ea903729c967` |
| Worker | `qwen-scanner` |
| Route | `qwen.alisport0.qzz.io/*` → worker |

> **نکته workers.dev:** روی این اکانت، مسیر `*.workers.dev` خطای `1101` می‌دهد
> (خرابی edge سمت حساب). مسیر production از **دامنه اختصاصی**
> `qwen.alisport0.qzz.io` (DNS proxied + Worker Route) سالم است و همین آدرس
> رسمی است.

---

## ۵. تنظیمات اختیاری

### AUTH_TOKEN (محافظت پنل)

در `wrangler.toml`:

```toml
[vars]
AUTH_TOKEN = "یک رمز دلخواه"
```

سپس deploy مجدد. پنل هنگام اولین درخواست رمز می‌پرسد.

> لینک‌های گزارش (`/report/...`) بدون رمز باز می‌شوند (لینک‌های UUID غیرقابل حدس برای اشتراک).

### Cron Triggers (اتوماتیک در نبود شما)

در `wrangler.toml` از قبل تعریف شده:

```toml
[triggers]
crons = ["* * * * *", "*/5 * * * *", "0 */6 * * *"]
```

| زمان‌بندی | کار |
|-----------|-----|
| هر ۱ دقیقه | `* * * * *` — processIronpinBatch (Materialize) |
| هر ۵ دقیقه | `*/5 * * * *` — seed آیرون پین (یک‌بار) + نگهداری قیمت + کشف منبع (جستجوگر ۲) + پیش‌بردن صف جستجو/دریافت (fetch موازی) |
| هر ۶ ساعت | requeue اسکن‌های خودکار برای اسکن مجدد |

### نگهداری داده قیمت (D1 Free)

| شرط | قاعده |
|-----|-------|
| حجم تخمینی D1 ≥ ۹۰٪ سقف فری (۵۰۰MB) | حذف ردیف‌های قیمت قدیمی‌تر از **۳ روز** |
| در غیر این صورت، هر **۳۱ روز** | حذف ردیف‌های قیمت قدیمی‌تر از **۲۴ ساعت** |

حذف فقط **دستی** است — با دکمه پنل یا `POST /api/prices/delete?older_than_days=N`.

### هوش جستجوگر ۲ (IronPin)

- سه لیست: وب‌سایت‌ها / شبکه‌های اجتماعی / شبکه‌های داخلی
- بانکهای query از `FinderPlan` (۵ پرسش در هر round، چرخشی)
- `classifyLink`: فقط http(s)، بدون port/userinfo، رد کردن موتور جستجو/فایل/ربات/مسیرهای رزرو
- منابع جدید خوانا → صفحه در اسکن «منابع قیمت آهن» → استخراج ردیف قیمت
- کاشت اولین tick: منابع آیرون پین + لیست موضوعات `قیمت {محصول} امروز` با auto-refresh ۲۴ ساعت

### متغیرها (Free tier سازگار)

```toml
[vars]
MAX_PAGES_PER_SCAN = "12"
PAGES_PER_TICK = "5"
SEARCH_QUERY_LIMIT = "3"
```

---

## ۶. روش استفاده از پنل

### ۶.۱ اسکن تکی

1. **اسکن جدید (تکی)** → موضوع را بنویسید → **شروع اسکن**.
2. لینک گزارش باز می‌شود؛ پس از چند tick (۵ دقیقه‌ای یا دستی) پر می‌شود.

### ۶.۲ اسکن لیستی — هر خط یک موضوع ← یک لینک

1. کارت **اسکن لیستی**:
   - عنوان اختیاری
   - در کادر، **هر خط یک موضوع** (حداکثر ۵۰)
2. **شروع لیست** → همه موضوعات همزمان در صف می‌روند.
3. **یک لینک یکپارچه** برای کل لیست ساخته می‌شود:

```
/report/batch/<UUID>
```

4. JSON یکپارچه (همه اسکن‌ها با آمار):

```
/api/report/batch/<UUID>
```

### ۶.۳ اجرای دستی tick (بدون صبر کردن cron)

```bash
curl -X POST "https://<worker>/api/dev/tick"
```

### ۶.۴ خودکارسازی (IronPin + جستجوگر ۲ + نگهداری قیمت)

پس از deploy، cron هر ۵ دقیقه به‌صورت خودکار:

1. **کاشت آیرون پین** (فقط اولین tick)
2. **نگهداری قیمت**: نزدیک سقف فری → ۳ روز؛ هر ۳۱ روز → ۲۴ ساعت
3. **جستجوگر ۲**: هر ۲۰ دقیقه یک round کشف منبع
4. **پیشبردن صف** و **requeue** هر ۶ ساعت

خروجی همه مسیرها: ردیف‌های Quote فرمت `ironpin-quotes-v1` در D1 + لینک `/report/batch/:id`.

---

## ۷. API مرجع

| متد | مسیر | توضیح |
|-----|------|-------|
| POST | `/api/scans` | ساخت اسکن تکی `{topic}` |
| GET | `/api/scans` | فهرست اسکن‌ها |
| GET | `/api/scans/:id` | جزئیات + نمونه ردیفه‌ها |
| DELETE | `/api/scans/:id` | حذف اسکن |
| POST | `/api/scans/:id/refresh` | اسکن مجدد |
| POST | `/api/scans/:id/pause` | توقف اسکن خودکار |
| POST | `/api/scans/:id/resume` | ادامه اسکن خودکار |
| POST | `/api/batches` | ساخت لیست `{title?, topics: "خط۱\nخط۲"}` |
| GET | `/api/batches` | فهرست لیست‌ها + آمار |
| DELETE | `/api/batches/:id` | حذف لیست + همه فرزندان |
| GET | `/api/report/:id` | JSON اسکن تکی |
| GET | `/api/report/all` | JSON همه اسکن‌ها |
| GET | `/api/ironpin` | خروجی ردیف‌های Quote (IronPin)؛ اسنپ‌شات کامل = پنجرهٔ ۳۰ روز (dedup روزانه، سقف ۱۲۰۰۰)؛ `?since=<ms>` = incremental |
| GET | `/api/stats` | آمار داشبورد |
| GET | `/api/health` | سلامت D1 |
| GET | `/api/sources` | JSON منابع برای آیرون پین |
| GET | `/api/usage` | مصرف روزانه D1/CF |
| POST | `/api/usage/refresh` | force refresh snapshot |
| GET/POST | `/api/settings` | خواندن/تنظیم چرخه نگهداری قیمت |
| POST | `/api/prices/delete?older_than_days=N` | **فقط دستی** حذف قیمت‌های قدیمی |
| POST | `/api/dev/tick` | اجرای دستی pipeline |
| GET | `/report/:id` | صفحه HTML گزارش تکی |
| GET | `/report/batch/:id` | **صفحه HTML یکپارچه لیست** |
| GET | `/report/all` | صفحه HTML همه اسکن‌ها |
| GET | `/report/sources` | صفحه HTML وضعیت منابع |

اگر `AUTH_TOKEN` تنظیم شده باشد، همه به جز GET‌های `report` نیاز به
`Authorization: Bearer <token>` دارند.

---

## ۸. تست‌ها

```bash
npm test
```

- `npm test` — ۷ سوئیت: smoke · finder · ironpin · guardian · pipeline ·
  table_reader · city (فرمت خروجی، تبدیل ریال→تومان، دروازه‌های فید، شهر از شاهد مکتوب)

dry-run استقرار:

```bash
npx wrangler deploy --dry-run
```

---

## ۹. محلی توسعه

```bash
npm run dev          # http://localhost:8787
npm run db:apply:local
```

نکته: Cron endpoint محلی wrangler در حضور `[assets]` ممکن است ۵۰۰ بدهد
(باگ شناخته‌شده wrangler ۴.۸۶). جایگزین: `POST /api/dev/tick` — همان مسیر
production که cron صدا می‌خواند.

داده محلی در `.wrangler/state/` می‌ماند.

---

## ۱۰. عیب‌یابی

| مشکل | راه‌حل |
|------|--------|
| `database_id` خطا | مقدار REPLACE را با ID واقعی از `wrangler d1 create` عوض کنید و دوباره execute |
| ۴۰۱ unauthorized | `AUTH_TOKEN` را در پنل وارد کنید یا Bearer بدهید |
| لیست ساخته نشد | حداکثر ۵۰ خط؛ هر خط ۲–۲۰۰ کاراکتر |
| ردیف قیمت ۰ ماند | `POST /api/dev/tick` بزنید؛ یا ۵–۱۵ دقیقه صبر کنید (cron هر ۵ دقیقه) |
| صفحات timeout | طبیعی است؛ سایت‌های کند fail می‌شوند و بقیه ادامه دارد |
| deploy قدیمی | هر تغییر کد → دوباره `npx wrangler deploy` |

---

## ۱۱. چک‌لیست نهایی استقرار

- [ ] `CLOUDFLARE_API_TOKEN` و `CLOUDFLARE_ACCOUNT_ID` ست شد
- [ ] `npm install` انجام شد
- [ ] `wrangler d1 create qwen_scanner` → `database_id` در wrangler.toml
- [ ] `wrangler d1 execute ... --file=./schema.sql --remote`
- [ ] `npx wrangler deploy` موفق
- [ ] پنل باز شد، D1 متصل (نقطه سبز)
- [ ] یک اسکن تکی آزمایشی + یک لیست ۲ خطی آزمایشی
- [ ] لینک `/report/batch/...` باز شد و JSON دانلود شد
- [ ] (اختیاری) `AUTH_TOKEN` تنظیم و deploy مجدد
- [ ] Cron Triggers در داشبورد فعال دیده شد

---

## ۱۲. معماری (خلاصه)

```
پنل (public/index.html)
    │  fetch JSON
    ▼
Worker API (src/api.js)  ◄──── Cron * هر دقیقه / */5 / 0*/6 (src/pipeline.js)
    │
    ▼
D1: batches → scans → pages → ironpin_quotes
    │
    ▼
گزارش HTML /report/...  +  JSON ironpin-quotes-v1 /api/ironpin
```

- **جستجوگر ۱**: `text_engine.js` (تجزیه خط‌به‌خط مشابه موتور قیمت متن در
  اپلیکیشن) + `image_extract.js` (Clairic)
- **جستجوگر ۲**: `finder.js` + `ironpin_data.js` — کشف منابع و ارائه به جستجوگر ۱
- **موتورها**: bing → bing-rss → ddg → gerdoo → zarebin
- **لیست**: N اسکن → یک `batches` → یک لینک `/report/batch/:id` و یک JSON یکپارچه
- **نگهبان**: `guardian.js` — حد CPU/fetch/AI/حجم برای مصرف حداقلی


## کلید پروکسی خوانش (JINA_API_KEY) — لازم برای صفحات WAF ایران

از v1.9، واکشی مستقیم اول است؛ فقط اگر شکست بخورد یک‌بار از `https://r.jina.ai/<url>` استفاده می‌شود. از Cloudflare، IP اشتراکی anonymous معمولاً **429 «Per IP rate limit»** می‌دهد؛ کلید رایگان (ساخته‌شده در jina.ai، بدون کارت) ۵۰۰ RPM می‌دهد و مشکل را حل می‌کند:

```sh
npx wrangler secret put JINA_API_KEY   # مقدار: کلید از https://jina.ai (بخش API Key)
```

بدون کلید هم دپلوی کار می‌کند ولی صفحات WAF (iromart و امثالش) فقط گاهی (تصادفی) موفق می‌شوند.
علامت شفافیت: ردیف‌های ذخیره‌شده از این مسیر دارای `مسیر دریافت: پروکسی خوانش` هستند.
