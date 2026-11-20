# راهنمای کامل ساخت و استقرار — اسکنر Qwen

سند گام‌به‌گام راه‌اندازی پنل اسکنر، دیتابیس D1، استقرار روی Cloudflare، لیست اسکن، و اتصال Qwen.

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
| `schema.sql` | DDL دیتابیس (scans, pages, knowledge, batches, sources, meta) |
| `src/` | منطق Worker (API، pipeline، چانکر، موتورها، retention، finder، seed) |
| `src/ironpin_data.js` | دانش IronPin: endpointها، registry، bankهای جستجوگر۲ |
| `src/retention.js` | پاک‌سازی قیمت: نزدیک سقف فری → ۳ روز؛ هر ۳۱ روز → ۲۴ ساعت |
| `src/finder.js` | هوش جستجوگر۲ — classifyLink + سه لیست + کشف منبع |
| `src/seed.js` | کاشت اولیه منابع/موضوعات قیمت IronPin در اولین tick |
| `public/index.html` | پنل فارسی |
| `test/` | تست‌های chunker، pipeline، finder/retention |

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

باید شامل `batches`, `scans`, `pages`, `knowledge`, `sources`, `meta` باشد.

---

## ۴. استقرار Worker

```bash
npx wrangler deploy
```

خروجی موفق:

```
✨ Deployed!
  https://qwen-scanner.<subdomain>.workers.dev
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

> **نکته workers.dev:** روی این اکانت، مسیر `*.workers.dev` خطای `1101` می‌دهد (خرابی edge سمت حساب — Hello World هم 1101؛ صفر invocation). مسیر production از **دامنه اختصاصی** `qwen.alisport0.qzz.io` (DNS proxied + Worker Route) سالم است و همین آدرس رسمی است.
>
> workers.dev این اکانت به `qwen-rag` تغییر کرد (`https://qwen-scanner.qwen-rag.workers.dev`) — اگر بعد از چند دقیقه سالم شد قابل استفاده است؛ وگرنه همین دامنه اختصاصی کافی است.

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
crons = ["*/5 * * * *", "0 */6 * * *"]
```

| زمان‌بندی | کار |
|-----------|-----|
| هر ۵ دقیقه | seed IronPin (یک‌بار) + retention قیمت + کشف منبع (جستجوگر۲، هر ۲۰ دقیقه) + پیش‌بردن صف جستجو/دریافت |
| هر ۶ ساعت | requeue اسکن‌های خودکار برای اسکن مجدد |

### نگهداری داده قیمت (D1 Free)

| شرط | قاعده |
|-----|-------|
| حجم تخمینی D1 ≥ ۹۰٪ سقف فری (۵۰۰MB) | حذف ردیف‌های `price` قدیمی‌تر از **۳ روز** |
| در غیر این صورت، هر **۳۱ روز** | حذف ردیف‌های `price` قدیمی‌تر از **۲۴ ساعت** |

ردیف قیمت = `attribute/layer = price` یا tags حاوی price یا claim شامل قیمت/تومان/ریال/price.

### هوش جستجوگر ۲ (IronPin)

- سه لیست: وب‌سایت‌ها / شبکه‌های اجتماعی / شبکه‌های داخلی
- bankهای query از `FinderPlan` (۵ پرسش در هر round، چرخشی)
- `classifyLink`: فقط http(s)، بدون port/userinfo، رد کردن موتور جستجو/فایل/ربات/مسیرهای رزرو
- منابع جدید خوانا → صفحه در اسکن «منابع قیمت آهن» → خروجی KnowledgeItem با همان متد Qwen
- کاشت اولین tick: ۵۸+۱۲۴+۸۰ منبع IronPin + لیست موضوعات `قیمت {محصول} امروز` با auto-refresh ۲۴ ساعت

مدیریت در داشبورد: Worker → **Settings** → **Triggers** → Cron Triggers.

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

**نمونه زنده پس از استقرار:**

| مورد | آدرس |
|------|------|
| لیست «لیست استقرار» (۲ موضوع) | `https://qwen.alisport0.qzz.io/report/batch/bb9e0626-ef04-4c81-a715-d494045b7a77` |
| JSON یکپارچه همان لیست | `https://qwen.alisport0.qzz.io/api/report/batch/bb9e0626-ef04-4c81-a715-d494045b7a77` |
| پنل | `https://qwen.alisport0.qzz.io/` |

4. JSON یکپارچه Qwen (همه دانش‌ها با فیلد `topic`):

```
/api/report/batch/<UUID>
```

فرمت خروجی:

```json
{
  "format": "qwen-knowledge-v1",
  "kind": "batch",
  "batch": { "id": "...", "title": "...", "topics_count": 5 },
  "scans": [ { "id": "...", "topic": "...", "status": "done", "knowledge_count": 12 } ],
  "chunker": { "target_chars": 900, "overlap_chars": 140, "min_chars": 200 },
  "retrieval_hint": { "weights": { "topicMatch": 0.45, "claimRelevance": 0.3, "freshness": 0.15, "confidence": 0.1 }, "top_k": 4 },
  "items": [ { "id": "...", "topic": "...", "claim": "...", "kind": "chunk", "confidence": 0.68, "ttl_days": 45 } ]
}
```

### ۶.۳ اجرای دستی tick (بدون صبر کردن cron)

```bash
curl -X POST "https://<worker>/api/dev/tick"
```

یا از داشبورد Cloudflare: Workers → your worker → **Settings** → **Triggers** → Cron → **Cron Triggers** → … یا استفاده از dashboard.

### ۶.۴ خودکارسازی (IronPin + جستجوگر۲ + نگهداری قیمت)

پس از deploy، cron هر ۵ دقیقه به‌صورت خودکار:

1. **کاشت IronPin** (فقط اولین tick): منابع + لیست `قیمت {میلگرد|تیرآهن|…} امروز` + صفحات seed
2. **نگهداری قیمت**: نزدیک سقف فری → ۳ روز؛ هر ۳۱ روز → ۲۴ ساعت
3. **جستجوگر۲**: هر ۲۰ دقیقه یک round کشف منبع (۳ لیست × ۵ پرسش)
4. **پیشبردن صف** و **requeue** هر ۶ ساعت

خروجی همه مسیرها: KnowledgeItem فرمت Qwen در D1 + لینک `/report/batch/:id`.

---

## ۷. API مرجع

| متد | مسیر | توضیح |
|-----|------|-------|
| POST | `/api/scans` | ساخت اسکن تکی `{topic}` |
| GET | `/api/scans` | فهرست اسکن‌ها |
| GET | `/api/scans/:id` | جزئیات + نمونه دانش |
| DELETE | `/api/scans/:id` | حذف اسکن |
| POST | `/api/scans/:id/refresh` | اسکن مجدد |
| GET | `/api/report/:id` | JSON Qwen تکی |
| POST | `/api/batches` | ساخت لیست `{title?, topics: "خط۱\\nخط۲"}` |
| GET | `/api/batches` | فهرست لیست‌ها + آمار |
| GET | `/api/batches/:id` | جزئیات لیست + اسکن‌ها |
| DELETE | `/api/batches/:id` | حذف لیست + همه فرزندان |
| GET | `/api/report/batch/:id` | **JSON یکپارچه کل لیست** |
| GET | `/api/stats` | آمار داشبورد (+ منابع، retention، جستجوگر۲) |
| GET | `/api/health` | سلامت D1 |
| POST | `/api/dev/tick` | اجرای دستی pipeline |
| GET | `/report/:id` | صفحه HTML گزارش تکی |
| GET | `/report/batch/:id` | **صفحه HTML یکپارچه لیست** |

اگر `AUTH_TOKEN` تنظیم شده باشد، همه به جز GET های `report` نیاز به `Authorization: Bearer <token>` دارند.

---

## ۸. تست‌ها

```bash
node test/chunker.test.js
node test/pipeline.test.js
node test/finder.test.js
```

- `chunker.test.js` — چانک‌بندی ۹۰۰/۱۴۰/۲۰۰ و Facts
- `pipeline.test.js` — صف، claim، finalize، requeue
- `finder.test.js` — classifyLink، FinderPlan، retention قیمت، seed

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

نکته: Cron endpoint محلی wrangler در حضور `[assets]` ممکن است ۵۰۰ بدهد (باگ شناخته‌شده wrangler 4.86).  
جایگزین: `POST /api/dev/tick` — همان مسیر production که cron صدا می‌زند.

داده محلی در `.wrangler/state/` می‌ماند.

---

## ۱۰. عیب‌یابی

| مشکل | راه‌حل |
|------|--------|
| `database_id` خطا | مقدار REPLACE را با ID واقعی از `wrangler d1 create` عوض کنید و دوباره execute |
| ۴۰۱ unauthorized | `AUTH_TOKEN` را در پنل وارد کنید یا Bearer بدهید |
| لیست ساخته نشد | حداکثر ۵۰ خط؛ هر خط ۲–۲۰۰ کاراکتر |
| دانش ۰ ماند | `POST /api/dev/tick` بزنید؛ یا ۵–۱۵ دقیقه صبر کنید (cron هر ۵ دقیقه) |
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
- [ ] یک اسکن تکی آزمایشی + یک لیست ۲خطی آزمایشی
- [ ] لینک `/report/batch/...` باز شد و JSON دانلود شد
- [ ] (اختیاری) `AUTH_TOKEN` تنظیم و deploy مجدد
- [ ] Cron Triggers در داشبورد فعال دیده شد

---

## ۱۲. معماری (خلاصه)

```
پنل (public/index.html)
    │  fetch JSON
    ▼
Worker API (src/api.js)  ◄──── Cron */5 و 0*/6 (src/pipeline.js)
    │
    ▼
D1: batches → scans → pages → knowledge
    │
    ▼
گزارش HTML /report/...  +  JSON qwen-knowledge-v1 /api/report/...
```

- **چانکر**: ۹۰۰ حرف / overlap ۱۴۰ / min ۲۰۰ (~۴۵۰ توکن)
- **موتورها**: bing → bing-rss → ddg → gerdoo → zarebin
- **ذخیره**: dual-write چانک + جمله نمایشی؛ confidence ۰.۶۸/۰.۶۲/۰.۵۵؛ TTL ۴۵ روز
- **لیست**: N اسکن → یک `batches` → یک لینک `/report/batch/:id` و یک JSON یکپارچه

---

*پایان سند — برای استقرار عملی: توکن Cloudflare را بدهید تا deploy از همین محیط انجام شود.*


---

## v1.3 — لینک کل دانش / منابع / مصرف / حذف دستی قیمت (2026-11-20)

| مسیر | متد | توضیح |
|------|-----|-------|
| `/report/all` | GET | صفحهٔ HTML کل دانش (زنده) |
| `/api/report/all` | GET | JSON کل دانش — بدون auth (قابل اشتراک) |
| `/report/sources` | GET | فهرست منابع HTML |
| `/api/sources` | GET | JSON منابع برای IronPin — بدون auth |
| `/api/usage` | GET | مصرف روزانه D1/CF + سقف ۵۰۰MB |
| `/api/usage/refresh` | POST | force refresh snapshot |
| `/api/prices/delete` | POST | **فقط دستی** حذف قیمت‌های قدیمی `{older_than_days}` |

Secrets: `CF_API_TOKEN` · `CF_ACCOUNT_ID` · `CF_D1_ID`

منبع: `state=dead` دیگر enqueue نمی‌شود؛ `live` بعد از استخراج دانش.
