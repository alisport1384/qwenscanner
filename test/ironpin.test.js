import test from 'node:test';
import assert from 'node:assert/strict';
import { processIronpinBatch, buildIronpinExport, streamIronpinExport, cityFromPhone, computeConversions, extractPriceFromText, repairQuote } from '../src/ironpin.js';
const row={rid:4,id:'k1',scan_id:'s1',topic:'میلگرد',claim:'میلگرد سایز 16 قیمت 25000 تومان هر کیلو تهران 1405/02/03',category:'rag',attribute:'price',url:'https://example.com/p',domain:'example.com',last_verified_at:Date.UTC(2026,0,1)};
const keys=['id','endpoint','seller','sellerCity','title','category','material','brand','loading','loadingCity','unit','tax','currency','terms','sourceUrl','sourceDateRaw','status','amount','pieceKg','lengthM','areaM2','fetchedAt','size','thickness','dimensions','grade','details'];

test('incremental batch stores canonical Quote row and advances bounded cursor',async()=>{
 let stored=null,cursor=null,selected=0;
 const db={
  prepare(sql){return {bind(...args){return {sql,args,async first(){return null},async all(){return sql.includes('FROM knowledge')?{results:[row]}:{results:[]}}}}}},
  async batch(stmts){selected=stmts.length;for(const s of stmts){if(s.sql.includes('ironpin_quotes'))stored=JSON.parse(s.args[3]);if(s.sql.includes('meta('))cursor=JSON.parse(s.args[1])}}
 };
 const res=await processIronpinBatch(db);assert.equal(res.processed,1);assert.equal(selected,2);assert.deepEqual(cursor,{ts:row.last_verified_at,rowid:4,done:false});assert.deepEqual(Object.keys(stored),keys);assert.equal(stored.id,'qw:s1:k1');assert.equal(stored.amount,25000);assert.equal(stored.unit,'kg');assert.equal(stored.sellerCity,'تهران');assert.equal(stored.size,'16');
});

test('materialized export stream is valid single-GET JSON',async()=>{
 const quote={id:'qw:s1:k1',title:'میلگرد',amount:25000,currency:'تومان'};const db={prepare(sql){return{bind(){return{async first(){return{value:JSON.stringify({done:true})}}}},async all(){return{results:sql.includes('ironpin_quotes')?[{quote_json:JSON.stringify(quote),source_last_verified_at:1}]:[]}}}}};const res=await streamIronpinExport(db);assert.equal(res.headers.get('cache-control'),'public, max-age=900');const out=JSON.parse(await res.text());assert.equal(out.format,'ironpin-quotes-v1');assert.equal(out.count,1);assert.equal(out.complete,true);assert.deepEqual(out.quotes,[quote]);assert.equal(out.candidates_count,0);
});

test('materialized output export loads stored Quote JSON',async()=>{
 const quote={id:'qw:s1:k1',amount:25000,currency:'تومان'};const db={prepare(sql){return{async all(){return{results:sql.includes('ironpin_quotes')?[{quote_json:JSON.stringify(quote)}]:[]}}}}};const out=await buildIronpinExport(db);assert.equal(out.format,'ironpin-quotes-v1');assert.equal(out.count,1);assert.deepEqual(out.quotes,[quote]);
});

test('cityFromPhone resolves geographic prefixes, null otherwise',()=>{
 assert.equal(cityFromPhone('تماس 09121234567').city,'تهران');
 assert.equal(cityFromPhone('+989171234567').city,'شیراز');
 assert.equal(cityFromPhone('شماره 09191234567').prefix,'0919');
 assert.equal(cityFromPhone('بدون شماره در متن'),null);
 // operator (non-geographic) numbers give nothing — never a guessed city
 assert.equal(cityFromPhone('09351234567'),null);
});

test('unit conversions: explicit wins, formulas by family, no invented tables',()=>{
 const e=computeConversions('میلگرد شاخه 12 متری وزن 92 کیلوگرم هر شاخه',{unit:'piece'});
 assert.equal(e.pieceKg,92);
 assert.equal(e.lengthM,12);
 assert.equal(e.basis,'صریح از متن');
 const r=computeConversions('میلگرد سایز 14',{unit:'kg',size:'14'});
 assert.equal(r.kgm,+(14*14/162.2).toFixed(3));
 assert.equal(r.basis,'فرمول هندسی تقریبی');
 const p=computeConversions('ورق 1000x2000 ضخامت 3',{unit:'sheet',thickness:'3'});
 assert.equal(p.areaM2,2);
 assert.equal(p.pieceKg,47.1);
 // catalog-height profiles (IPE/HA) must stay null — app rule: no conversion
 // without a valid unit weight.
 const h=computeConversions('تیرآهن IPE200 و هاش 300',{unit:'m'});
 assert.equal(h.pieceKg,null);
 assert.equal(h.areaM2,null);
});

test('incremental export honors since, returns cursor, skips candidates',async()=>{
 const binds=[];
 const rows=[{quote_json:'{"id":"a","amount":1500,"currency":"تومان"}',source_last_verified_at:2000},{quote_json:'{"id":"b","amount":2500,"currency":"تومان"}',source_last_verified_at:3000}];
 const db={prepare(sql){return{bind(...args){
   binds.push({sql,args});
   return{async first(){return{value:JSON.stringify({done:true})}},async all(){return{results:rows}}};
 }}}};
 const res=await streamIronpinExport(db,{since:1500});
 const qbind=binds.find(b=>b.sql.includes('ironpin_quotes'));
 assert.ok(qbind,'quotes query executed');
 assert.ok(qbind.sql.includes('source_last_verified_at >'),'filtered by since');
 assert.equal(qbind.args[0],1500);
 const out=JSON.parse(await res.text());
 assert.equal(out.format,'ironpin-quotes-v1');
 assert.equal(out.count,2);
 assert.equal(out.since,1500);
 assert.equal(out.cursor,3000,'cursor = max served timestamp');
 assert.equal(out.candidates_count,0,'incremental payload carries no candidates');
 assert.equal(out.complete,true);
 assert.equal(res.headers.get('cache-control'),'no-store','incremental is never cached');
});

test('incremental export with no new rows keeps cursor at since',async()=>{
 const db={prepare(sql){return{bind(...args){
   return{async first(){return{value:JSON.stringify({done:true})}},async all(){return{results:[]}}};
 }}}};
 const res=await streamIronpinExport(db,{since:777});
 const out=JSON.parse(await res.text());
 assert.equal(out.count,0);
 assert.equal(out.cursor,777);
});

test('extractPriceFromText: explicit currency, rial conversion, gates',()=>{
 const e1=extractPriceFromText('نرخ هر شاخه 155,000,000 ریال است');
 assert.equal(e1.amount,15500000);
 assert.equal(e1.fromRial,true);
 const e2=extractPriceFromText('بین 101,820 تا 120,455 تومان');
 assert.equal(e2.amount,120455);
 assert.equal(e2.fromRial,false);
 const e3=extractPriceFromText('قیمت میلگرد 125 هزار تومان');
 assert.equal(e3.amount,125000);
 // price-like negatives in the same segment never become a quote amount
 assert.equal(extractPriceFromText('قیمت دلار 269,970 تومان امروز'),null);
 // a number glued to a minus sign is not a price
 assert.equal(extractPriceFromText('نوسان -580,000 ریال در هفته گذشته'),null);
 // no explicit price → no quote (بدون قیمت ندار)
 assert.equal(extractPriceFromText('میلگرد سایز 16 موجود در انبار'),null);
});

test('repairQuote enforces تومان-only contract at read time',()=>{
 const ok={id:'a',amount:5000,currency:'تومان'};
 assert.equal(repairQuote(ok),ok);
 const fixed=repairQuote({id:'b',title:'ورق آهن',amount:null,currency:'نامشخص',details:{'متن پیام':'قیمت ورق 149,500 تومان هر کیلوگرم'}});
 assert.equal(fixed.amount,149500);
 assert.equal(fixed.currency,'تومان');
 // priceless rows are dropped, never exported
 assert.equal(repairQuote({id:'c',title:'خبر روز',amount:null}),null);
});
