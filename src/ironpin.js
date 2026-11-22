// IronPin Quote.toJson compatible export. Each knowledge claim is parsed as
// independent evidence; no inferred price is carried across claims.
const CITIES=['بوئین زهرا','شهرکرد','نیشابور','اصفهان','شیراز','مشهد','تهران','تبریز','همدان','کاشان','اهواز','سیرجان','کرمان','شهرضا','ابرکوه','قزوین','تاکستان','بناب','میانه','رشت','ساری','یزد','ابهر','دزفول','شاهرود','سمنان','اردبیل','قم','اراک'];
/** آدرس‌یابی از شماره تلفن — پیش‌شماره‌های جغرافیایی همراه اول (اپراتورهای سراسری = بدون شهر). */
const PHONE_CITY={'0910':'تهران','0911':'ساری','0912':'تهران','0913':'اصفهان','0914':'تبریز','0915':'مشهد','0916':'اهواز','0917':'شیراز','0918':'همدان','0919':'تهران'};
export function cityFromPhone(text){
  const t=clean(String(text||''));
  const m=t.match(/(?:\+98|0098|0)?(9\d{9})(?!\d)/);
  if(!m)return null;
  const phone='0'+m[1];
  const city=PHONE_CITY[phone.slice(0,4)];
  return city?{city,prefix:phone.slice(0,4),phone}:null;
}
/**
 * تبدیل واحد کالا — صریح از متن در اولویت؛ وگرنه فرمول هندسی تقریبی (هیچ جدولی
 * حدس زده نمی‌شود: ارتفاع تیرآهن/هاش بدون وزن کاتالوگ null می‌ماند — همان قاعدهٔ
 * calculator.dart در اپ: «تبدیل متراژ بدون وزن واحد معتبر مجاز نیست»).
 */
export function computeConversions(text='',{unit='unknown',size='',thickness='',dims=''}={}){
  const t=clean(text);
  const out={pieceKg:null,lengthM:null,areaM2:null,kgm:null,basis:null};
  const n=s=>{const v=parseFloat(String(s).replace(',','.'));return Number.isFinite(v)?v:null};
  // 1) صریح از متن
  const lenM=t.match(/(\d+(?:[.,]\d+)?)\s*متری/)||t.match(/طول\s*[:：]?\s*(\d+(?:[.,]\d+)?)\s*متر/);
  const kgPiece=t.match(/(?:وزن\s*)?(?:هر\s*)?(?:شاخه|قطعه|عدد|برگ|رول)\s*(?:به\s*)?(?:حدود\s*)?(\d+(?:[.,]\d+)?)\s*کیلو/i)
    ||t.match(/(\d+(?:[.,]\d+)?)\s*کیلوگرم\s*(?:به ازای|هر)?\s*(?:شاخه|قطعه|عدد|برگ)/i);
  if(kgPiece){const v=n(kgPiece[1]);if(v&&v>0)out.pieceKg=v;}
  if(lenM){const v=n(lenM[1]);if(v&&v>0)out.lengthM=v;}
  if(out.pieceKg!=null||out.lengthM!=null)out.basis='صریح از متن';
  const kgmExplicit=t.match(/(\d+(?:[.,]\d+)?)\s*کیلوگرم\s*(?:به ازای|هر)\s*1?\s*متر/);
  let kgm=kgmExplicit?n(kgmExplicit[1]):null;
  // 2) فرمول هندسی خانواده (ورق → کیلو بر مترمربع)
  const isRound=/میلگرد|مفتول|گرد\s*توپر/.test(t);
  const isPipe=/لوله|مانیسمان|اسپیرال/.test(t);
  const isProfile=/قوطی|پروفیل/.test(t);
  const isAngle=/نبشی/.test(t);
  const isPlate=/ورق|پلیت|شیت/.test(t);
  const parts=(String(dims)||'').split(/[x×*]/).map(s=>n(s)).filter(v=>v!=null&&v>0);
  if(kgm==null&&isRound&&size){const d=n(size);if(d!=null&&d>0&&d<300)kgm=+(d*d/162.2).toFixed(3);}
  if(kgm==null&&isPipe&&parts.length>=2){const [D,tt]=parts;if(D>tt&&tt<40)kgm=+((D-tt)*tt*0.02466).toFixed(3);}
  if(kgm==null&&isProfile&&parts.length>=3){const [h,b,tt]=parts;kgm=+(((h+b)*2-4*tt)*tt*0.00785).toFixed(3);}
  if(kgm==null&&isAngle&&parts.length>=2){const b=parts[0];const tt=n(thickness)||parts[1]||null;if(tt)kgm=+((2*b-tt)*tt*0.00785).toFixed(3);}
  if(kgm!=null&&out.basis==null)out.basis='فرمول هندسی تقریبی';
  if(kgm!=null)out.kgm=kgm;
  if(isPlate&&thickness){const tt=n(thickness);if(tt!=null&&tt>0&&tt<100){
    const kgm2=+(tt*7.85).toFixed(2);
    const sheet=t.match(/(\d{3,4})\s*[x×*]\s*(\d{3,4})/);
    if(sheet){const a=(n(sheet[1])/1000)*(n(sheet[2])/1000);if(a>0)out.areaM2=+a.toFixed(3);
      if((unit==='sheet'||unit==='piece'||unit==='roll')&&out.pieceKg==null)out.pieceKg=+(a*kgm2).toFixed(1);
      if(out.basis==null)out.basis='فرمول هندسی تقریبی';}
  }}
  if(out.pieceKg==null&&kgm!=null&&out.lengthM!=null)out.pieceKg=+(kgm*out.lengthM).toFixed(1);
  return out;
}
const PRODUCT=/(میلگرد|تیر\s*آهن|تیرآهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|مانیسمان|اسپیرال|ورق|پلیت|شیت|چهارپهلو|شش[\s\u200c]*پر|مفتول|تسمه|سپری|رابیتس|توری|گابیون|مش\s*جوشی|شمش|بیلت|بلوم|اسلب|قراضه|(?:انکر\s*|رول\s*)?بولت|anchor\s*bolt|گندله|بریکت|فرو\s*آلیاژ|آهن\s*اسفنجی)/i;
const digits=s=>String(s||'').replace(/[۰-۹]/g,c=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c));
const clean=s=>digits(s).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[يك]/g,c=>c==='ي'?'ی':'ک').replace(/تومن/g,'تومان').replace(/\s+/g,' ').trim();
const numeric=s=>{let n=digits(s).replace(/[٬,]/g,'').replace(/٫/g,'.').replace(/\s/g,'');const x=Number(n);return Number.isFinite(x)&&x>0?x:null};
function dateOf(s){let t=clean(s);let m=t.match(/(20\d\d)[/.-](\d{1,2})[/.-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);if(m){let d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+(m[4]||0),+(m[5]||0)));return Number.isNaN(+d)?null:d.toISOString()}m=t.match(/(1[34]\d\d)[/.-](\d{1,2})[/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);if(m){let gy=+m[1]+621,gm=+m[2],gd=+m[3]; // Jalali rough Gregorian conversion, only calendar-valid output
let jy=+m[1]-979,jm=gm-1,jd=gd-1,jdn=365*jy+Math.floor(jy/33)*8+Math.floor((jy%33+3)/4);for(let i=0;i<jm;i++)jdn+=i<6?31:30;jdn+=jd+79;let gy2=1600+400*Math.floor(jdn/146097);jdn%=146097;let leap=true;if(jdn>=36525){jdn--;gy2+=100*Math.floor(jdn/36524);jdn%=36524;if(jdn>=365)jdn++ ;else leap=false;}gy2+=4*Math.floor(jdn/1461);jdn%=1461;if(jdn>=366){leap=false;jdn--;gy2+=Math.floor(jdn/365);jdn%=365;}let md=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31],mo=0;while(mo<11&&jdn>=md[mo])jdn-=md[mo++];let d=new Date(Date.UTC(gy2,mo,jdn+1,+(m[4]||0),+(m[5]||0))-210*60000);return d.toISOString()}return null}
const domainOf=(url,domain)=>{try{return new URL(url).hostname||domain||'نامشخص'}catch{return domain||'نامشخص'}};
/** Extract one trustworthy price from claim text — the export contract's
 *  price gate. T1: number [هزار|میلیون]? currency (ریال → تومان ÷10, basis
 *  recorded for honesty). T2: قیمت/نرخ/بهای … number + explicit currency.
 *  Gates: no price-like negatives (دلار/طلا/…) in the same segment, 1000 ≤
 *  amount ≤ 1e9 تومان, numbers never glued to a sign/separator. */
const PRICE_NEG=/(?:دلار|ارز\s|طلا|سکه|یورو|پوند|پلیمر|پیمتاش|شیشه|پلاستیک|دارو|قرص|کپسول|سهام|شاخص|برنج|فسفر|چدن|بیمه|وام|ملک|خودرو)/;
const PRICE_T1=/(?<![\d,.٬\-])(\d[\d,.٬]*\d|\d)\s*(هزار|میلیون)?\s*(تومان|تومن|ریال)/g;
const PRICE_T2=/(?:قیمت|نرخ|بهای)\s*[^0-9]{0,40}?(\d[\d,.٬]{3,}\d|\d{5,})\s*(هزار|میلیون)?\s*(تومان|تومن|ریال)/g;
function segmentAt(t,pos){
 const starts=[t.lastIndexOf('.',pos),t.lastIndexOf('\n',pos),t.lastIndexOf('؛',pos)];
 const start=Math.max(starts[0],starts[1],starts[2])+1;
 const ends=[t.indexOf('.',pos),t.indexOf('\n',pos),t.indexOf('؛',pos)].filter(i=>i>=0);
 const end=ends.length?Math.min.apply(null,ends):t.length;
 return t.slice(start,end);
}
export function extractPriceFromText(raw){
 const t=clean(String(raw||''));
 if(!t)return null;
 for(const re of [PRICE_T1,PRICE_T2]){
  for(const m of t.matchAll(re)){
   let a=numeric(m[1]);
   if(!a)continue;
   if(m[2]==='هزار')a*=1000;
   else if(m[2]==='میلیون')a*=1e6;
   let fromRial=false;
   if(m[3]==='ریال'){a/=10;fromRial=true;}
   if(!(a>=1000&&a<=1e9))continue;
   if(PRICE_NEG.test(segmentAt(t,m.index)))continue;
   return {amount:a,fromRial};
  }
 }
 return null;
}
/** Read-time contract guard: every served quote carries a real تومان amount.
 *  Invalid stored rows get one honest re-extraction from their own text;
 *  if that yields no price the row is dropped (never export priceless). */
export function repairQuote(q){
 if(!q||typeof q!=='object')return null;
 if(typeof q.amount==='number'&&q.amount>0&&q.currency==='تومان')return q;
 const d=(q.details&&typeof q.details==='object')?q.details:null;
 const ex=extractPriceFromText((d&&d['متن پیام'])||q.title||'');
 if(!ex)return null;
 q.amount=ex.amount;q.currency='تومان';
 q.status='استخراج متنی با مبلغ/ارز/واحد؛ موجودی نیازمند تأیید';
 if(d){
  d['مبلغ استخراج‌شده']=String(ex.amount);
  d['مبنای ارز']='تومان';
  d['وضعیت استخراج']='قیمت از ادعای اسکنر؛ موجودی نیازمند تأیید';
  if(ex.fromRial)d['مبنای تبدیل ارز']='ریال÷۱۰ از متن منبع';
 }
 return q;
}
function quote(row){const text=clean(row.claim||'');if(!text)return null;const lines=text.split(/[\n؛]+/).map(x=>x.trim()).filter(Boolean);let city=CITIES.find(c=>text.includes(c))||'نامشخص';const pc=cityFromPhone(text);let cityFrom=city==='نامشخص'?'':'از متن';if(city==='نامشخص'&&pc){city=pc.city;cityFrom='از پیش‌شماره '+pc.prefix;}let category=(PRODUCT.exec(text)||[])[0]||row.topic||row.category||'عمومی';let mat=/استیل|استنلس/i.test(text)?'استنلس استیل':/آلومینیوم/.test(text)?'آلومینیوم':/آلیاژ|MO40|CK45|A516/i.test(text)?'فولاد آلیاژی':'فولاد کربنی';let brand=(text.match(/ذوب.?آهن|مبارکه|فولاد خوزستان|کاوه|ارفع/)||[])[0]||'';const exPrice=extractPriceFromText(text);if(!exPrice)return null;let amount=exPrice.amount,unit='unknown',tax='نامشخص',currency='تومان';const basis=exPrice.basis;if(/کیلو(?:گرم)?|کیلویی/.test(text))unit='kg';else if(/مترمربع|متر مربع/.test(text))unit='m2';else if(/شاخه|عدد/.test(text))unit='piece';else if(/\bتن\b/.test(text))unit='ton';else if(/\bمتر\b/.test(text))unit='m';else if(/ورق|شیت|برگ/.test(text))unit='sheet';else if(/رول/.test(text))unit='roll';let title=text.slice(0,400);let size=(text.match(/(?:سایز|نمره|میلگرد|حرارتی|تیرآهن|نبشی|ناودانی)\s*(\d+(?:[.,]\d+)?)/)||[])[1]||'';let thickness=(text.match(/ضخامت\s*[:：]?\s*([\d.]+)/)||[])[1]||'';let dims=(text.match(/\d+(?:[.,]\d+)?\s*[x×*]\s*\d+(?:[.,]\d+)?(?:\s*[x×*]\s*\d+(?:[.,]\d+)?)?/i)||[])[0]||'';let grade=(text.match(/گرید\s*[:：]?\s*([\w-]+)/i)||[])[1]||'';const conv=computeConversions(text,{unit,size,thickness,dims});let date=dateOf(text)||new Date(Number(row.last_verified_at)||Date.now()).toISOString();if(/بدون ارزش افزوده/.test(text))tax='بدون ارزش افزوده';else if(/با ارزش افزوده/.test(text))tax='با ارزش افزوده';let details={'تحلیل متن':'محلی v2','متن پیام':text,'سرعنوان گروه':row.topic||'','مبنای شهر':cityFrom,'شماره تماس':pc?pc.phone:'','مبنای تبدیل واحد':conv.basis||'','وزن هر متر (تقریب)':conv.kgm!=null?conv.kgm+' کیلوگرم':'','مبلغ استخراج‌شده':amount?String(amount):'','مبنای ارز':currency,'مبنای واحد':unit,'زمان انتشار پیام':date,'وضعیت استخراج':amount?'قیمت از ادعای اسکنر؛ موجودی نیازمند تأیید':'متن فاقد مبلغ یکتای قابل استخراج','ویژگی‌های منبع':row.attribute||''};if(exPrice.fromRial)details['مبنای تبدیل ارز']='ریال÷۱۰ از متن منبع';let dateRaw=date;let src=String(row.url||'');try{let u=new URL(src);if(!/^https?:$/.test(u.protocol)||!u.hostname)src=''}catch{src=''}let id=`qw:${row.scan_id}:${row.id}`.slice(0,512);return {id,endpoint:'qwen-scanner',seller:domainOf(row.url,row.domain),sellerCity:city,title,category,material:mat,brand,loading:'نامشخص',loadingCity:'نامشخص',unit,tax,currency,terms:'نامشخص',sourceUrl:src,sourceDateRaw:dateRaw,status:amount?'استخراج متنی با مبلغ/ارز/واحد؛ موجودی نیازمند تأیید':'متن فاقد مبلغ یکتای قابل استخراج',amount,pieceKg:conv.pieceKg,lengthM:conv.lengthM,areaM2:conv.areaM2,fetchedAt:new Date(Number(row.last_verified_at)||Date.now()).toISOString(),size,thickness,dimensions:dims,grade,details}}
const BACKFILL_KEY='ironpin_backfill_v1'; // done flag → export `complete` stays true
const REBUILD_KEY='ironpin_backfill_v2'; // full re-materialization with the new extractor
const BATCH_SIZE=300;
const PRODUCT_ROW=/(میلگرد|تیر\s*آهن|هاش|ناودانی|نبشی|پروفیل|قوطی|لوله|ورق|پلیت|چهارپهلو|مفتول|تسمه|شمش|بیلت|بلوم|اسلب|قراضه|(?:انکر\s*|رول\s*)?بولت|anchor\s*bolt|رابیتس|توری|گابیون|مش(?:\s*جوشی)?|شش[\s\u200c]*پر|گندله|بریکت|فرو\s*آلیاژ|آهن\s*اسفنجی)/i;
const CURSOR_START={ts:0,rowid:0,done:false};
async function getCursor(db,key=BACKFILL_KEY){try{const m=await db.prepare('SELECT value FROM meta WHERE key=?1').bind(key).first();return m?.value?JSON.parse(m.value):CURSOR_START}catch{return CURSOR_START}}
/** Bounded backfill/upsert: 300 source rows per 5-minute tick (v2 rebuild). */
export async function processIronpinBatch(db){
 const c=await getCursor(db,REBUILD_KEY);
 const rows=await db.prepare(`SELECT rowid AS rid,id,scan_id,topic,claim,category,attribute,url,domain,last_verified_at FROM knowledge WHERE attribute='price' AND (last_verified_at > ?1 OR (last_verified_at = ?1 AND rowid > ?2)) ORDER BY last_verified_at,rowid LIMIT ${BATCH_SIZE}`).bind(c.ts,c.rowid).all();
 const list=rows.results||[];if(!list.length){if(!c.done)await db.prepare(`INSERT INTO meta(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(REBUILD_KEY,JSON.stringify({...c,done:true}),Date.now()).run();return {processed:0,done:true}}
 const stmts=[];for(const r of list){const q=quote(r);if(!q)continue;stmts.push(db.prepare(`INSERT INTO ironpin_quotes(scan_id,knowledge_id,source_last_verified_at,quote_json) VALUES(?1,?2,?3,?4) ON CONFLICT(scan_id,knowledge_id) DO UPDATE SET quote_json=excluded.quote_json, source_last_verified_at=MAX(ironpin_quotes.source_last_verified_at, excluded.source_last_verified_at)`).bind(r.scan_id,r.id,Date.now(),JSON.stringify(q)))}
 const last=list[list.length-1];const next={ts:last.last_verified_at,rowid:last.rid,done:false};stmts.push(db.prepare(`INSERT INTO meta(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(REBUILD_KEY,JSON.stringify(next),Date.now()));
 await db.batch(stmts);return {processed:list.length,quotes:stmts.length-1,done:false};
}
/** Serve pre-serialized Quote rows as a streamed single JSON response.
 *  `since` (ms) = incremental mode for the app's external scanner: only rows
 *  with source_last_verified_at > since (new OR updated), no candidates payload,
 *  and `cursor` = max timestamp served so the client can advance next time. */
export async function streamIronpinExport(db,{since=0}={}){
 const sinceN=Number(since)>0?Number(since):0;
 const incremental=sinceN>0;
 const [qres,state]=await Promise.all([
  incremental
   ? db.prepare('SELECT quote_json,source_last_verified_at FROM ironpin_quotes WHERE source_last_verified_at > ?1 ORDER BY source_last_verified_at, rowid').bind(sinceN).all()
   : db.prepare('SELECT quote_json,source_last_verified_at FROM ironpin_quotes ORDER BY rowid').all(),
  db.prepare('SELECT value FROM meta WHERE key=?1').bind(BACKFILL_KEY).first()
 ]);
 const raws=qres.results||[];let ready=false;try{ready=JSON.parse(state?.value||'{}').done===true}catch{}
 let cursor=sinceN;const qs=[];
 for(const r of raws){const t=Number(r.source_last_verified_at)||0;if(t>cursor)cursor=t;let q=null;try{q=JSON.parse(r.quote_json)}catch{continue}const fixed=repairQuote(q);if(fixed)qs.push(fixed)}
 let candidates=[];
 if(!incremental){
  try{
   const sres=await db.prepare(`SELECT url,domain,kind,part,name,readable,origin,state,created_at,last_checked_at FROM sources WHERE state IN ('new','seed') ORDER BY created_at DESC LIMIT 5000`).all();
   candidates=(sres.results||[]).map(x=>({url:x.url,domain:x.domain,kind:x.kind,part:x.part,name:x.name||'',readable:!!x.readable,origin:x.origin,state:x.state,created_at:x.created_at,last_checked_at:x.last_checked_at}));
  }catch{candidates=[]}
 }
 const generated=new Date(Math.max(Date.now(),...raws.map(x=>Number(x.source_last_verified_at)||0))).toISOString();const enc=new TextEncoder();let i=0,first=true,phase=0;
 const tail=`],\"candidates_count\":${candidates.length},\"candidates\":${JSON.stringify(candidates)},\"cursor\":${cursor}}`;
 const head=`{\"format\":\"ironpin-quotes-v1\",\"generated_at\":${JSON.stringify(generated)},\"count\":${qs.length},\"complete\":${ready},${incremental?`\"since\":${sinceN},`:''}\"quotes\":[`;
 const body=new ReadableStream({pull(controller){if(phase===0){controller.enqueue(enc.encode(head));phase=1;return}if(phase===1){const end=Math.min(i+50,qs.length);let chunk='';for(;i<end;i++){if(!first)chunk+=',';first=false;chunk+=JSON.stringify(qs[i])}if(chunk)controller.enqueue(enc.encode(chunk));if(i<qs.length)return;controller.enqueue(enc.encode(tail));phase=2;controller.close();return}controller.close()}});
 return new Response(body,{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':ready&&!incremental?'public, max-age=900':'no-store','X-Content-Type-Options':'nosniff'}});
}
export async function buildIronpinExport(db){
 const rows=await db.prepare('SELECT quote_json FROM ironpin_quotes ORDER BY rowid').all();const quotes=(rows.results||[]).map(r=>{try{return repairQuote(JSON.parse(r.quote_json))}catch{return null}}).filter(Boolean);return {format:'ironpin-quotes-v1',generated_at:new Date().toISOString(),count:quotes.length,quotes};
}
