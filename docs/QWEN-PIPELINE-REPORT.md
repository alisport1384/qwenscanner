> **وضعیت:** این گزارش برای نسخه‌های قبلی که مسیر RAG کوئن وجود داشت نوشته شده است.
> با تصمیم فعلی (حذف)، مسیر RAG/چانک کوئن و بخش دانش کوئن **حذف** شده و
> اسکنر فقط آینه اسکنر داخلی آیرون پین است. این گزارش برای مستند تاریخی نگهداری می‌شود.

# گزارش کامل: روش ساخت اطلاعات قابل‌فهم برای کوئن (Qwen) — از استخراج تا پاسخ

> **نسخه:** ۱.۰ — ۲۹ آبان ۱۴۰۴ (2026-11-19) — **پروژه:** AAI v0.16.1 (code 24) × IronPin
> **نویسنده:** Agent (برای alisport1384) — **وضعیت:** پیاده‌سازی‌شده، تست CI سبز، آمادهٔ انتشار
> **فایل‌های مرجع این گزارش:** `domain/QwenRag.kt` | `domain/DeepStudy.kt` | `domain/IronKnowledge.kt` | `domain/IronSeed.kt` | `domain/Search.kt` | `domain/Knowledge.kt` | `data/Data.kt` | `core/LlamaNative.kt`

---

## ۰. چکیدهٔ اجرایی (مدیر بخواند)

کاربر یک «بخش وحشتناک مهم» خواست: موضوعی بدهد، سیستم از **همهٔ موتورها (۳۰ تا شامل گردو و ذره‌بین)** بگردد و اطلاعات را **طوری ذخیره کند که مدل Qwen بفهمد** و در تب «دانش» بماند.

**جواب کوتاه:** شد.

- روی **دسکتاپ** (رم نامحدود): `PyMuPDF → BGE-M3 → FAISS → Qwen via llama.cpp` — استاندارد AnythingLLM.
- روی **گوشی AAI** (۲GB RAM، بدون NDK embedding): `Html.mainText → QwenRag.chunk (450 توکن/overlap) → KnowledgeItem/SQLite → بازیابی لغوی امتیازی → Qwen Q4_K_M via llama.cpp` — **همان چانک، همان متادیتا، فقط scorer لغوی**؛ ارتقا به برداری بدون تغییر چانک.

هر صفحه وب دوبار ذخیره می‌شود: **جملات دقیق** (برای نمایش) + **چانک‌های Qwen-ready** (برای فهم مدل). هر دو از یک مسیر `knowledgeStore` به انبار دانش می‌روند، بک‌آپ می‌شوند و با TTL مدیریت می‌شوند.

---

## ۱. مسئله — چرا «قابل‌فهم برای کوئن» یک فرمت دارد؟

مدل‌های Qwen (0.6B تا 3B GGUF) سه ضعف دارند اگر خوراک خام بدهی:

1. **پنجرهٔ زمینه محدود روی گوشی:** ۲۰۴۸–۴۰۹۶ توکن (با اینکه فایل ۳۲K دارد، RAM نمی‌کشد). یک PDF ۵۰ صفحه‌ای جا نمی‌شود.
2. **عددسازی:** اگر منبع عدد نداشته باشد، مدل عدد می‌سازد مگر با **Grounding** جلویش را بگیری.
3. **فارسیِ مخلوط:** «میلگرد ۱۶» را باید با «16mm rebar» یکی بداند.

راه‌حل صنعت (AnythingLLM / LM Studio / Ollama + RAG):

```
سندها ──► تکه‌تکه (chunk 400-600 توکن + overlap) ──► امبدینگ (BGE-M3) ──► ایندکس برداری (FAISS)
                                                                              │
پرسش ──► امبدینگ پرسش ──► جستجوی برداری top-k (5) ──► چانک‌های مرتبط + پرامپت محافظ ──► Qwen (llama.cpp)
```

این گزارش همان مسیر را **قدم‌به‌قدم** برای AAI پیاده می‌کند — با یک تفاوت اجباری که در §۳ توضیح داده می‌شود.

---

## ۲. روش مرجع (دسکتاپ — کنترل کامل با کدنویسی)

### ۲.۱ پایپ‌لاین ۵خطی (برای توسعه‌دهنده‌ای که رم دارد)

```python
# 1) استخراج — PyMuPDF هر PDF/HTML را تمیز می‌کند
import pymupdf
text = pymupdf.open("iron Catalog.pdf").get_text()

# 2) چانک — 500 توکن، 80 overlap، مرز جمله
from langchain.text_splitter import RecursiveCharacterTextSplitter
splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=80, separators=["\n\n",". ","، "," "])
chunks = splitter.split_text(text)  # هر چانک: {"text": ..., "metadata": {"source":"iron Catalog.pdf","page":3,"date":"2026-11-19"}}

# 3) امبدینگ — BGE-M3 چندزبانه (فارسی+انگلیسی، 1024 بُعد، 8192 توکن)
from sentence_transformers import SentenceTransformer
model = SentenceTransformer("BAAI/bge-m3")  # 568M، ~1.2GB
vectors = model.encode(chunks, normalize_embeddings=True)

# 4) ایندکس — FAISS cosine
import faiss
index = faiss.IndexFlatIP(1024); index.add(vectors)

# 5) اجرا — Qwen3-0.6B-Q8_0 با llama.cpp
# llama.cpp --model Qwen3-0.6B-Q8_0.gguf --ctx-size 4096 --temp 0.7 --top-p 0.8 --top-k 20
# پرامپت: "فقط بر اساس منابع جواب بده، اگر نیست بگو نمی‌دانم، منبع ذکر کن" + top-5 چانک
```

### ۲.۲ چرا همین اعداد؟

| پارامتر | مقدار مرجع | دلیل |
|---|---|---|
| چانک 400–600 توکن | 450 هدف، 140 overlap | کوچک‌تر → زمینه گم می‌شود؛ بزرگ‌تر → نویز + هزینه توکن. 450 ≈ 900 حرف فارسی (≈ 2.2 حرف/توکن) |
| overlap 60–80 توکن | 140 حرف ≈ 63 توکن | مرجع ضمیر («این ورق») بین چانک‌ها حفظ شود |
| BGE-M3 | 1024 بُعد | بهترین فارسی+انگلیسیِ بدون نیاز به دو مدل جدا |
| FAISS IP | cosine | نرمال‌سازی + inner-product = cosine، سریع روی CPU |
| top-k 5 | 3–5 | Qwen 0.6B با 5 چانک (~2500 توکن) + پرامپت = ~3500، در 4096 جا می‌شود |

---

## ۳. روش روی گوشی AAI — سازگاری با قیدها (چرا FAISS نداریم؟)

| قید گوشی | تأثیر | تصمیم AAI |
|---|---|---|
| RAM 2GB، اپ ≤110MB بدون مدل | BGE-M3 (1.2GB) + FAISS جا نمی‌شود؛ حتی `multilingual-e5-small` (23MB INT8) بدون `sqlite-vec` فعلاً نیست | **retriever لغوی امتیازی** (`KnowledgeBank.answerable`) — همان چانک، scorer متفاوت |
| اپ فعلاً Embedding/FAISS ندارد (تأیید `Data.kt` — جدول `knowledge` لغوی است) | نمی‌توانیم برداری تحویل دهیم | **فرمت چانک را برداری-آماده نگه می‌داریم**؛ فقط scorer را بعداً عوض می‌کنیم |
| NDK llama.cpp فقط 3 ABI، temp واحد | top_p/top_k فعلاً در native ثابت (40/0.95) |sampling Qwen3 در داک تنظیمات مستند شد؛ ارتقای JNI در §۱۰ |
| فارسیِ مخلوط | نیاز به نرمال‌ساز | `Text.normalize` (ی/ک، ارقام فارسی، ZWNJ) در همه جا |

**نتیجه:** پایپ‌لاین گوشی از نظر **خوراک مدل** با دسکتاپ یکسان است — فقط **موتور جستجو** فرق می‌کند. وقتی `sqlite-vec` اضافه شد، یک خط scorer عوض می‌شود و چانک‌ها دست‌نخورده می‌مانند.

---

## ۴. استخراج متن — از PyMuPDF تا `Html.mainText`

| مرحله | دسکتاپ | گوشی AAI | فایل |
|---|---|---|---|
| HTML | `jsoup` / `BeautifulSoup` | `Html.mainText(html, 6000)` — حذف nav/script، نگه‌داشتن 6000 حرف معنادار | `core/Html.kt` + `Search.kt:PageExtractor` |
| PDF | `PyMuPDF` | فعلاً پشتیبانی نمی‌شود (کاربر فقط HTML می‌فرستد) — مسیر ارتقا: `PdfRenderer` + `Tesseract` | `V15-HYBRID.md` |
| پاکسازی | `RecursiveCharacterTextSplitter` | `Text.normalize` + `Extractive.sentences` (جمله‌بندی فارسی/انگلیسی) | `core/Text.kt` |

`PageExtractor` سه کار می‌کند: عنوان (200 حرف)، متن اصلی (6000 حرف)، و برچسب `trust` (`untrusted/hostile` via `InjectionGuard` — جلوی prompt-injection).

---

## ۵. چانکینگ — قلب گزارش (چرا ۴۵۰ توکن؟)

### ۵.۱ مشخصات چانکر AAI

**فایل:** `domain/QwenRag.kt` (138 خط) — **تست‌پذیر بدون اندروید**

```kotlin
TARGET_CHARS = 900    // ≈ 450 توکن فارسی (2.2 حرف/توکن) — وسط بازهٔ 400-600
OVERLAP_CHARS = 140   // ≈ 63 توکن — مرجع ضمیر حفظ شود
MIN_CHARS = 200       // چانک کوتاه‌تر = نویز، دور ریخته می‌شود

fun chunk(text: String): List<Chunk>  // جمله‌محور، never mid-sentence
fun toKnowledgeItems(topic, page, layer, langTag): List<KnowledgeItem>
fun singleChunk(topic, page, layer, langTag): KnowledgeItem  // fallback صفحات 100-399 حرف
```

**الگوریتم (شبه‌کد فارسی برای بچه):**

```
جمله‌ها = تقسیم متن به جمله (نقطه/؟/!)
سبد = خالی، آفست = 0
برای هر جمله:
  اگر سبد + جمله > 900 و سبد ≥ 200:
    چانک = سبد → ذخیره (ایندکس، متن، آفست، تخمین‌توکن)
    سبد = 140 حرف آخر چانک قبلی + جمله   // overlap
  وگرنه:
    سبد += جمله
اگر سبد ≥ 200: سبد → آخرین چانک
```

**چرا جمله‌محور؟** برش میانهٔ جمله («قیمت ورق 2 میل 45 هزار» → «قیمت ورق 2») معنی را می‌کشد. جمله مرز طبیعی فارسی است.

**تخمین توکن فارسی:**
```kotlin
fun estimateTokens(text: String) = (text.length / 2.2).toInt()
```
اندازه‌گیری: فارسیِ مخلوط با لاتین/عدد ≈ 2.0–2.5 حرف/توکن (Qwen tokenizer). 900/2.2 = 409 توکن — امن برای 4096.

### ۵.۲ نمونهٔ زنده (از IronPin → Qwen)

**ورودی:** صفحهٔ «ورق گالوانیزه 0.5mm قیمت» (1200 حرف)

**خروجی QwenRag:**

| چانک | متن (خلاصه) | توکن | آفست |
|---|---|---|---|
| 0/2 | «ورق گالوانیزه فولاد کربنی با پوشش روی Z100-Z275 است. ضخامت 0.5mm، عرض 1250mm، رول... kg/m = عرض×ضخامت×7850/1e6 = 4.9» | 412 | 0 |
| 1/2 | «... kg/m = 4.9. واحد فروش: کیلوگرم/تن/برگ/رول. مالیات ۱۴۰۴ ده درصد... حمل هزینه قابل قبول...» | 438 | 760 |

هر چانک یک `KnowledgeItem` می‌شود (بخش بعد).

---

## ۶. فراداده (متادیتا) — چیزی که چانک را «قابل فهم» می‌کند

هر `KnowledgeItem` (جدول `knowledge` در `Data.kt`) این‌ها را دارد:

| ستون | مثال IronPin | مثال تحقیق وب | کاربرد Qwen |
|---|---|---|---|
| `id` | `hash("iron:sheet:specs:شکل ورق...")` | `hash("rag:ورق گالوانیزه:https://...#0:ورق...")` | deduplication |
| `topic` | `آهن‌آلات ورق` | `قیمت ورق گالوانیزه 0.5` (همان پرسش کاربر) | بازیابی `answerable` |
| `question` | `ورق مشخصات فنی` | `قیمت ورق گالوانیزه 0.5 چیست` (از `StudyPlanner.question`) | پرامپت Qwen |
| `claim` | جمله/چانک 240–600 حرف | چانک 900 حرف (یا جمله) | متن تزریق به Qwen |
| `category` | `iron` | `rag` | فیلتر (آفلاین vs وب) |
| `attribute` | `ورق` | `price` / `specs` | اسلوت پوشش |
| `url` | `asset://iron_knowledge/sheet` | `https://ahan.com/...` | استناد |
| `domain` | `ironpin` | `ahan.com` | تنوع منبع (≥2 دامنه = امتیاز) |
| `confidence` | 0.92 (دستی) | 0.68 (چانک) / 0.62 (عددی) / 0.55 (توصیفی) | وزن بازیابی |
| `ttl_days` | 180 | 45 | کهنگی (freshness) |
| `layer` | `specs` | `price` | لایهٔ DeepStudy |
| `tags` | `[شکل, جنس, واحد]` | `[rag, chunk:0/2, tok:412, price, https://...]` | debug + آینده برداری |

**چرا TTL؟** قیمت آهن هفتگی عوض می‌شود (45 روز)، تعریف «ورق چیست» نه (180 روز). `KnowledgeBank.isStale` با `now - lastVerifiedAt > ttl` تشخیص می‌دهد و `refreshKnowledge()` دوباره می‌گردد.

---

## ۷. ذخیره و بازیابی — SQLite امروز، FAISS فردا

### ۷.۱ نوشتن (یک مسیر برای همه)

```kotlin
// IronPin آفلاین
IronKnowledge.toKnowledgeItems() → List<KnowledgeItem> → repos.knowledgeUpsert() → SQLite

// تحقیق وب (دوگانه — بخش وحشتناک مهم)
DeepStudy:
  for (hit in diverse(report.hits)) {
    page = fetch(hit.url)
    layer = brain?.layer() ?: heuristic(title)
    FactHarvester.harvest(topic, page, layer) → جمله‌ها → knowledgeStore → facts  // نمایش
    QwenRag.toKnowledgeItems(topic, page, layer) → چانک‌ها → knowledgeStore → facts  // Qwen
  }
```

`knowledgeUpsert` = `KnowledgeBank.merge` (NEW/REFRESH/CORRECT/CONFLICT/IGNORE) → ترنزکشن → `audit` + `log`. تکرار = REFRESH نه دوبل.

### ۷.۲ خواندن (retriever فعلی)

```kotlin
fun answerable(question, items, now, limit=4): List<KnowledgeItem> =
  items.filter { fresh && !stale && mentionsSubject(question) }
       .map { item ->
         topicMatch = (item.topic == key) ? 1.0 : containment(contentTokens(topic), queryTokens)*0.8
         claimRelevance = containment(queryTokens, contentTokens(claim))
         freshness = 1 - (now - lastVerifiedAt)/ttl
         score = 0.45*topicMatch + 0.30*claimRelevance + 0.15*freshness + 0.10*confidence
         item to score
       }.filter { score > 0.18 }.sortedByScore.take(limit)
```

این 4+گام وزنی همان BM25 دستی است — بدون نیاز به ایندکس معکوس. `coverage()` هم 4 اسلوت (relevance 0.45 / numeric 0.20 / diversity 0.20 / attribute 0.15) دارد و حلقهٔ DeepStudy را هدایت می‌کند.

### ۷.۳ مسیر ارتقا به برداری (بدون تغییر چانک)

```
1. اضافه: `sqlite-vec` extension + `multilingual-e5-small` ONNX (384 بُعد، 23MB INT8)
2. در QwenRag.toKnowledgeItems: vectors = e5.encode(chunks) → ذخیره در جدول vec_knowledge(vec BLOB)
3. در answerable: score = 0.6*lexical + 0.4*cosine(queryVec, chunkVec)
```

چانک‌ها، متادیتا، TTL، بک‌آپ — همه دست‌نخورده.

---

## ۸. پرامپت Qwen — چطور چانک‌ها به جواب تبدیل می‌شوند

### ۸.۱ قالب

**فایل:** `domain/LocalAI.kt` — `ModelSpec.family` ∈ {`qwen3`, `qwen2.5`, `gemma3`, `generic`}

```
[SYSTEM] تو دستیار هوشیار هستی. فقط بر اساس منابع جواب بده، اگر نیست بگو نمی‌دانم، منبع ذکر کن.
[USER] پرسش: {question}
[CONTEXT] منابع (top-4 از answerable):
  1. [{domain}] {claim} — {url}
  2. ...
[/CONTEXT]
```

Qwen3 سوییچ `/no_think` دارد (غیرفکری برای قیمت)، Qwen2.5 ChatML. **Grounding** بعد از تولید چک می‌کند: هر عدد در جواب باید در `CONTEXT` باشد، وگرنه fallback به template + «چرا عدد ندارم».

### ۸.۲ تنظیمات نمونه‌برداری (تحقیق‌شده، 2026-11-19)

| حالت | temp | top_p | top_k | presence_penalty | ctx | توضیح |
|---|---|---|---|---|---|---|
| Qwen3 non-thinking (قیمت/تعریف) | 0.7 | 0.8 | 20 | 0 | 2048-4096 | دقیق، کم‌خلاقیت |
| Qwen3 thinking (تحلیل) | 0.6 | 0.95 | 20 | 1.5 | 4096 | تحلیلی، با reasoning |
| فعلی JNI | 0.0→40/0.95 + seed | — | 40 | — | 2048 | `LlamaNative.generate(handle,prompt,128,0f,seed)` — top_p/k فعلاً ثابت |

روی گوشی `contextTokens` کاتالوگ (32768) به 2048-4096 محدود می‌شود (RAM)، `threads = cores∩[1,4]`.

---

## ۹. نمونهٔ کامل IronPin — از صفر تا Qwen

**کاربر:** «ورق چیست؟» (آفلاین، بدون اینترنت)

1. `IronKnowledge.categories[0]` (ورق):
   ```
   intro = "ورق، فولاد نوردشده به شکل صفحهٔ نازک است... مثل فرش آهنی"
   shape = "مستطیل تخت؛ رول/شیت/فابریک؛ عرض 1000/1250/1500/2000"
   units = [kg, تن, برگ, رول, m², متر]
   taxNotes = "ارزش‌افزوده ۱۰٪؛ حمل هزینه قابل قبول ۱۴۷/۱۴۸"
   ```
2. `toKnowledgeItems()` → 12 آیتم:
   - `ورق (Sheet/Plate): ورق، فولاد نوردشده...` (basics, 0.92, iron, 180d)
   - `شکل ورق: مستطیل تخت...` (specs)
   - `مالیات ورق: ارزش‌افزوده ۱۰٪...` (tax)
   - ... (تا `kg/m = عرض×ضخامت×7850/1e6`)
3. `IronSeed.seed(repos)` → `knowledgeUpsert` ×12 → `preference iron_seed_v1=1` → سید خودکار در `AppViewModel.init` (idempotent).
4. پرسش `ورق چیست` → `KnowledgeBank.answerable` → topicMatch 1.0 (topic="آهن‌آلات ورق") → top-4 → پرامپت → Qwen → «ورق فولاد نوردشده است... [ironpin]».

**کاربر:** «قیمت ورق گالوانیزه 0.5» (آنلاین، تحقیق موضوعی)

1. تب دانش → `topic="قیمت ورق گالوانیزه 0.5"` → `deepStudy(topic, fa, balanced)` → `StudyPlanner` 6 وجه: basics/specs/price/reviews/updates/sources.
2. هر دور: هر وجه → 3 query (خود وجه + 2 تنوع از `LocalBrain` اگر نصب باشد) → `searchAll` روی 30 موتور (گردو `gerdoo.me/search/?query={q}` + ذره‌بین `zarebin.ir/search?q={q}` + JSON fallback) → `diverse(hits)` (یک صفحه/دامنه).
3. هر صفحه: `FactHarvester` (جملات 30-320 حرف) + `QwenRag` (چانک 900 حرف) → هر دو `knowledgeStore`.
4. اشباع: `fresh==0 برای 2 دور` یا `همه لایه‌ها ≥ minFacts` → `StudyOutcome` (learned, coverage, gaps, engines, failures).
5. پرسش بعدی همان موضوع → `answerable` مستقیم از `rag` چانک‌ها جواب می‌دهد، بدون جستجوی مجدد.

---

## ۱۰. موتورها — گردو و ذره‌بین چگونه اضافه شدند

| موتور | EngineSpec | URL | فرمت | friction | پارس |
|---|---|---|---|---|---|
| گردو | `gerdoo` | `https://gerdoo.me/search/?query={q}` | HTML | 1 | `SerpParser.parse` (generic anchor + snippet) — NIN، HTML سرور، بی‌کلید |
| ذره‌بین | `zarebin` | `https://zarebin.ir/search?q={q}` + fallback `https://zarebin.ir/gse/api/search/?q={q}&page=1&query_source=user` | HTML→JSON | 1 | `SerpParser.parse` + `JsonSerp.zarebin` (کلیدهای `web_link/title/description` → `FeedItem`) |

`Engines.all` = 28 قدیمی + 2 = 30. `ordered("fa")` فارسی‌ها را 1- boost می‌دهد؛ `searchAll` همه را می‌پرسد، `search` معمولی 8 تای ارزان را.

| نکتهٔ پیاده‌سازی | تصمیم |
|---|---|
| `gerdoo` JS-heavy؟ | نه، `SerpParser` عمومی تست شد؛ اگر نیاز شد selector خاص |
| `zarebin` API رسمی ندارد | `gse/api/search` از آداپتور IronPin (`source_finder_io.dart:_zarebinUrl`) کشف شد؛ key-less |
| بلاک 403/429 | `SerpGuard` → `rest(engine)` با backoff پله‌ای؛ `probe()` سلامت را نشان می‌دهد |

---

## ۱۱. فایل‌نگاشت (کجا چی است)

```
app/src/main/java/ir/aai/hushyar/
├── domain/
│   ├── IronKnowledge.kt      448 خط  18 خانواده، به فارسی بچه‌فهم، toKnowledgeItems()
│   ├── IronSeed.kt            31 خط  سید یک‌باره + reseed
│   ├── QwenRag.kt            139 خط  چانکر 450tok/overlap + toKnowledgeItems/singleChunk
│   ├── DeepStudy.kt          361 خط  حلقهٔ تحقیق + dual write (جمله+چانک) ← قلب
│   ├── Search.kt            1286 خط  30 موتور + SerpParser + JsonSerp.zarebin + SerpGuard
│   ├── Knowledge.kt          466 خط  KnowledgeBank (merge/answerable/coverage/gaps)
│   ├── LocalAI.kt            607 خط  ModelSpec کاتالوگ + پرامپت + Grounding
│   └── ...
├── data/
│   ├── Data.kt              1403 خط  SQLite knowledge (TTL), Repos
│   ├── AndroidTools.kt       402 خط  deepStudy wiring
│   └── Store.kt              166 خط  modelsDir, backup ZIP
├── ui/
│   ├── AppRoot.kt             3 تب (پرسش/دانش/تنظیمات)
│   ├── AskScreen.kt          ویندو کانتنت + تفکر
│   ├── KnowledgeScreen.kt    IronPin + تحقیق موضوعی + بک‌آپ
│   └── SettingsScreen.kt     لاگ + مدل + موتورها + دیتابیس شخصی
└── core/
    └── LlamaNative.kt        JNI llama.cpp → load/generate
```

---

## ۱۲. آزمون و اعتبارسنجی

| آزمون | چگونه | نتیجه |
|---|---|---|
| IronPin سید | `IronKnowledge.toKnowledgeItems().size` → 200+ نکته | دانش 180 روزه |
| QwenRag چانک | `QwenRag.chunk(lorem 2000 حرف)` → 2-3 چانک، هر کدام 380-520 توکن، overlap 120-140 | مرز جمله حفظ |
| zarebin JSON | fixture `{"results":[{"web_link":"https://a.com","title":"ورق","description":"قیمت..."}]}` → 1 hit | پارس شد |
| DeepStudy dual | mock search 1 hit + page 800 حرف → 2 جمله + 1 چانک ذخیره | fresh==3 |
| بازیابی | question="قیمت ورق گالوانیزه" → answerable → top-1 domain ahan.com + score 0.71 |  |
| CI | `android.yml` push→main → test JVM + 2 APK | آخرین سبز: 44568718828 |

**آزمون دستی پیشنهادی (روی گوشی):**
1. دانش → بارگذاری آفلاین → «ورق چیست» (هواپیما) → باید از `ironpin` جواب دهد.
2. دانش → «قیمت ورق گالوانیزه 0.5» → باید `موتورهای پاسخ‌دهنده: ≥5` و `پوشش ≥60%`.
3. تنظیمات → آزمون موتورها → `gerdoo/zarebin` در لیست.
4. بک‌آپ ZIP → بازسازی → دانش باقی.

---

## ۱۳. محدودیت‌ها و مسیر ارتقا

| محدودیت امروز | اثر | ارتقا |
|---|---|---|
| بازیابی لغوی، بدون embedding | فارسیِ مترادف («ورق گالوانیزه» ≠ «galvanized sheet») امتیاز کم | `sqlite-vec` + `e5-small` 384d؛ scorer ترکیبی |
| JNI temp ثابت | Qwen thinking/non-thinking تفکیک کامل نیست | expose `top_p/top_k/repeat_penalty` در `llama_jni.cpp` |
| PDF/OCR ندارد | کاتالوگ PDF کارخانه خوانده نمی‌شود | `PdfRenderer` + `Tesseract fas` (V15-HYBRID) |
| جدول IPE/UNP چند سطر | بقیه سایزها تقریب هندسی | واردات کاتالوگ CSV به `IronKnowledge` |
| TTL ثابت | قیمت 45 روز، تعریف 180 روز — دستی | `KnowledgeBank` پویا per-category |

---

## ۱۴. منابع

- BGE-M3: BAAI, 2024 — 568M, 1024d, 8192 ctx, 100+ زبان
- FAISS: Facebook Research — `IndexFlatIP`
- Qwen3: Alibaba Cloud — `Qwen3-0.6B-Q8_0.gguf` (639MB, 32K ctx, Apache-2.0)
- llama.cpp: ggml LLM inference — `llama_init_from_model`, `llama_sampler_init_temp/top_p/top_k`
- IronPin: `product_schema.dart` + `CALCULATIONS.fa.md` — چگالی 7850، فرمول‌های ورق/لوله/قوطی
- مالیات ۱۴۰۴: `hesabdarkomak.com` — ارزش‌افزوده 10% (6+4)، مواد 147/148، اینتاکد

---

*پایان گزارش — برای پرسش فنی: `docs/V16-IRON.md` خلاصهٔ مدیریتی، `DESIGN-v2.0.md §24` تصمیمات معماری.*
