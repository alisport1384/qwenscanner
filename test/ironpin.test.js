import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIronpinExport } from '../src/ironpin.js';

test('IronPin export uses Quote JSON contract and stable source row identity', async()=>{
 const row={id:'k1',scan_id:'s1',topic:'میلگرد',claim:'میلگرد سایز 16 قیمت 25000 تومان هر کیلو تهران 1405/02/03',category:'rag',attribute:'price',url:'https://example.com/p',domain:'example.com',last_verified_at:Date.UTC(2026,0,1)};
 const db={prepare(sql){assert.match(sql,/attribute='price'/);return{async all(){return{results:[row]}}}}};
 const out=await buildIronpinExport(db);assert.equal(out.format,'ironpin-quotes-v1');assert.equal(out.count,1);
 const q=out.quotes[0];assert.deepEqual(Object.keys(q),['id','endpoint','seller','sellerCity','title','category','material','brand','loading','loadingCity','unit','tax','currency','terms','sourceUrl','sourceDateRaw','status','amount','pieceKg','lengthM','areaM2','fetchedAt','size','thickness','dimensions','grade','details']);assert.equal(q.id,'qw:s1:k1');assert.equal(q.amount,25000);assert.equal(q.unit,'kg');assert.equal(q.sellerCity,'تهران');assert.equal(q.size,'16');assert.equal(q.fetchedAt,'2026-01-01T00:00:00.000Z');assert.equal(typeof q.details,'object');
});
