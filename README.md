# Qwen Scanner

اسکنر خودکار قیمت فولاد با خروجی Qwen — Cloudflare Workers + D1.

**پنل:** https://qwen.alisport0.qzz.io/

## لینک‌ها

| لینک | توضیح |
|------|-------|
| [/report/all](https://qwen.alisport0.qzz.io/report/all) | کل دانش (زنده) |
| [/api/report/all](https://qwen.alisport0.qzz.io/api/report/all) | JSON کل دانش |
| [/api/report/all?target=ironpin](https://qwen.alisport0.qzz.io/api/report/all?target=ironpin) | تفکیک: دانش IronPin |
| [/api/report/all?target=qwen](https://qwen.alisport0.qzz.io/api/report/all?target=qwen) | تفکیک: دانش کوئن |
| [/api/qwen](https://qwen.alisport0.qzz.io/api/qwen) | **لینک مخصوص مدل کوئن** |
| [/api/hushyar](https://qwen.alisport0.qzz.io/api/hushyar) | **لینک مخصوص هوشیار** |
| [/api/ironpin](https://qwen.alisport0.qzz.io/api/ironpin) | ردیف‌های Quote (IronPin)؛ `?since=<ms>` = حالت incremental با `cursor` |
| [/report/sources](https://qwen.alisport0.qzz.io/report/sources) | فهرست منابع (IronPin) |
| [/api/usage](https://qwen.alisport0.qzz.io/api/usage) | مصرف روزانه CF/D1 |

## اجرا

```bash
npm install
node test/chunker.test.js && node test/pipeline.test.js && node test/finder.test.js \
  && node test/ironpin.test.js && node test/guardian.test.js
npx wrangler deploy
```

نتیجهٔ ۲۱ نوامبر ۲۰۲۶: chunker ۱۷ + finder ۱۹ + guardian ۱۳ + ironpin ۷ + pipeline — همه سبز.

## مستندات

- [سند طراحی](docs/سند-طراحی.md)
- [تغییرات نسخه](docs/تغییرات-نسخه.md)
- [گزارش Qwen Pipeline](docs/QWEN-PIPELINE-REPORT.md)
- [BUILD](BUILD.md)

## قواعد کلیدی

- **نگهبان اسکنر**: سقف دیواری هر cron (۱۸ثانیه)، درخواست خروجی روزانه (۷۰۰)،
  خواندن D1 (۴٫۵M)، فراخوانی تصویر روزانه (۶۰) — حداقل مصرف پیش‌فرض
- **استخراج از تصویر**: مدل Clairic، فقط ردیفِ دارای قیمت/محصول+تماس، بدون جملهٔ اضافی
- **حذف قیمت فقط دستی** — دانش فنی هرگز پاک نمی‌شود
- منبع مرده (`state=dead`) دوباره اسکن نمی‌شود
- `/report/all` با هر افزوده جدید خودکار به‌روز است
