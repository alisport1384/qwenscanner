import assert from 'node:assert/strict';
import {
  FinderPart,
  classifyLink,
  isDirectoryHost,
  previewUrl,
  webAddressOf,
} from '../src/classify.js';

// Deep links
assert.equal(webAddressOf('tg://resolve?domain=ahanprice'), 'https://t.me/ahanprice');
assert.equal(webAddressOf('et://resolve?domain=ahan100'), 'https://eitaa.com/ahan100');
assert.equal(webAddressOf('https://t.me/ahanprice'), null);

// Telegram & Bale -> readable, previewUrl adds /s/
const tg = classifyLink('https://telegram.me/s/AhanPrice/123');
assert.deepEqual(tg, {
  url: 'https://t.me/AhanPrice',
  kind: 'telegram',
  key: 'telegram:ahanprice',
  part: FinderPart.social,
  readable: true,
  host: '',
  handle: 'AhanPrice',
});
assert.equal(previewUrl('telegram', tg.url), 'https://t.me/s/AhanPrice');

const bale = classifyLink('https://ble.ir/s/ahanonlineofficial');
assert.equal(bale.kind, 'bale');
assert.equal(bale.part, FinderPart.domestic);
assert.equal(bale.readable, true);
assert.equal(previewUrl('bale', bale.url), 'https://ble.ir/s/ahanonlineofficial');

// Eitaa & Rubika
const eitaa = classifyLink('https://eitaa.com/modiranahan');
assert.equal(eitaa.kind, 'eitaa');
assert.equal(eitaa.part, FinderPart.domestic);
assert.equal(eitaa.readable, true);

const rubika = classifyLink('https://rubika.ir/TahamtanIron/');
assert.equal(rubika.kind, 'rubika');
assert.equal(rubika.part, FinderPart.domestic);
assert.equal(rubika.readable, true);

// Instagram & WhatsApp -> listed as social, readable=false
const ig = classifyLink('https://instagram.com/Foolad.Market/');
assert.equal(ig.kind, 'instagram');
assert.equal(ig.part, FinderPart.social);
assert.equal(ig.readable, false);

const wa = classifyLink('https://whatsapp.com/channel/0029VaAbCdEf123456');
assert.equal(wa.kind, 'whatsapp');
assert.equal(wa.part, FinderPart.social);
assert.equal(wa.readable, false);

// Bots, reserved, web.*, files, search engines, directories rejected
assert.equal(classifyLink('https://t.me/my_price_bot'), null);
assert.equal(classifyLink('https://t.me/joinchat'), null);
assert.equal(classifyLink('https://web.eitaa.com/ahan'), null);
assert.equal(classifyLink('https://ahanmelal.com/list.pdf'), null);
assert.equal(classifyLink('https://google.com/search?q=iron'), null);
assert.equal(classifyLink('https://mychannels.ir/channel/1'), null);
assert.equal(isDirectoryHost('www.canaljoo.ir'), true);

// Website normalization strips tracking params & trailing index.html
const site = classifyLink('https://www.ahanmelal.com/rebar/index.html?utm_source=x&size=14');
assert.equal(site.kind, 'site');
assert.equal(site.part, FinderPart.sites);
assert.equal(site.url, 'https://ahanmelal.com/rebar?size=14');
assert.equal(site.key, 'site:ahanmelal.com/rebar?size=14');

console.log('classify.test.js PASS');
