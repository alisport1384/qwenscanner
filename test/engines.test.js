import assert from 'node:assert/strict';
import {
  DIRECTORY_PROVIDERS,
  SEARCH_PROVIDERS,
  answersQuestion,
  isChallengeOrBlocked,
  readSearchResults,
  saysNoResults,
  unwrapResultLink,
} from '../src/engines.js';

assert.equal(SEARCH_PROVIDERS.length, 9);
assert.equal(DIRECTORY_PROVIDERS.length, 6);

// Unwrap DDG, Yahoo, Bing redirect links
assert.equal(
  unwrapResultLink('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fahanmelal.com%2Frebar'),
  'https://ahanmelal.com/rebar'
);
assert.equal(
  unwrapResultLink('https://r.search.yahoo.com/_ylt=abc/RU=https%3a%2f%2fasreahan.com%2f/RK=2/RS=xyz'),
  'https://asreahan.com/'
);
const bingB64 = 'a1' + btoa('https://fardadfoolad.ir/').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
assert.equal(
  unwrapResultLink(`https://www.bing.com/ck/a?!&&p=1&u=${bingB64}&ntb=1`),
  'https://fardadfoolad.ir/'
);

// Parse Bing RSS XML
const rss = `<?xml version="1.0"?><rss><channel>
  <item>
    <title>قیمت میلگرد امروز - آهن ملل</title>
    <link>https://ahanmelal.com/rebar</link>
    <description>فروش میلگرد آجدار اصفهان با قیمت روز</description>
  </item>
</channel></rss>`;
const rssHits = readSearchResults(rss, 'bing');
assert.equal(rssHits.length, 1);
assert.equal(rssHits[0].url, 'https://ahanmelal.com/rebar');
assert.ok(answersQuestion('قیمت میلگرد امروز', rssHits));

// Parse Zarebin JSON
const zJson = JSON.stringify({
  results: [
    { web_link: 'https://t.me/s/ahanprice', title: 'کانال قیمت آهن', description: 'فروش میلگرد' },
  ],
});
const zHits = readSearchResults(zJson, 'zarebin');
assert.equal(zHits.length, 1);
assert.equal(zHits[0].url, 'https://t.me/s/ahanprice');

// Challenge & no-results checks
assert.equal(saysNoResults('متاسفانه هیچ نتیجه‌ای یافت نشد'), true);
assert.equal(isChallengeOrBlocked(429, 'Too many requests'), true);
assert.equal(isChallengeOrBlocked(200, '<html><body>Please verify you are a human</body></html>'), true);
assert.equal(isChallengeOrBlocked(200, '<html><body>قیمت میلگرد</body></html>'), false);

console.log('engines.test.js PASS');
