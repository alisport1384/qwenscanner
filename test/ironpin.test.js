import test from 'node:test';
import assert from 'node:assert/strict';
import { processIronpinBatch, buildIronpinExport, streamIronpinExport } from '../src/ironpin.js';
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
 const quote={id:'qw:s1:k1',title:'میلگرد'};const db={prepare(sql){return{bind(){return{async first(){return{value:JSON.stringify({done:true})}}}},async all(){return{results:sql.includes('ironpin_quotes')?[{quote_json:JSON.stringify(quote),source_last_verified_at:1}]:[]}}}}};const res=await streamIronpinExport(db);assert.equal(res.headers.get('cache-control'),'public, max-age=900');const out=JSON.parse(await res.text());assert.equal(out.format,'ironpin-quotes-v1');assert.equal(out.count,1);assert.equal(out.complete,true);assert.deepEqual(out.quotes,[quote]);assert.equal(out.candidates_count,0);
});

test('materialized output export loads stored Quote JSON',async()=>{
 const quote={id:'qw:s1:k1'};const db={prepare(sql){return{async all(){return{results:sql.includes('ironpin_quotes')?[{quote_json:JSON.stringify(quote)}]:[]}}}}};const out=await buildIronpinExport(db);assert.equal(out.format,'ironpin-quotes-v1');assert.equal(out.count,1);assert.deepEqual(out.quotes,[quote]);
});
