/**
 * هوش جستجوگر ۲ — Link classification, canonicalization & messenger handling.
 * Faithful port of IronPin2 `lib/domain/source_finder.dart`.
 */

export const FinderPart = {
  sites: 0,
  social: 1,
  domestic: 2,
  all: [0, 1, 2],
  titles: [
    'وب‌سایت‌های فروش و پخش کالا',
    'کانال‌ها و صفحه‌های شبکه‌های اجتماعی',
    'کانال‌ها و صفحه‌های شبکه‌های داخلی',
  ],
};

export const FINDER_DIRECTORIES = [
  'mychannels.ir',
  'canaljoo.ir',
  'canalha.ir',
  'joinchannel.ir',
  'cafechannel.ir',
  'linkdoniwebsit.ir',
];

export function isDirectoryHost(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return FINDER_DIRECTORIES.some((d) => h === d || h.endsWith(`.${d}`));
}

const MESSENGERS = {
  't.me': ['telegram', FinderPart.social, true],
  'telegram.me': ['telegram', FinderPart.social, true],
  'instagram.com': ['instagram', FinderPart.social, false],
  'whatsapp.com': ['whatsapp', FinderPart.social, false],
  'eitaa.com': ['eitaa', FinderPart.domestic, true],
  'ble.ir': ['bale', FinderPart.domestic, true],
  'rubika.ir': ['rubika', FinderPart.domestic, true],
  'splus.ir': ['soroush', FinderPart.domestic, false],
  'igap.net': ['igap', FinderPart.domestic, false],
  'gap.im': ['gap', FinderPart.domestic, false],
};

const CANONICAL_HOST = {
  telegram: 't.me',
  instagram: 'www.instagram.com',
  eitaa: 'eitaa.com',
  bale: 'ble.ir',
  rubika: 'rubika.ir',
  soroush: 'splus.ir',
  igap: 'igap.net',
  gap: 'gap.im',
};

const RESERVED = new Set([
  'share', 'join', 'joinchat', 'joing', 'joinc', 's', 'search', 'proxy',
  'socks', 'addstickers', 'addemoji', 'addlist', 'iv', 'c', 'login', 'contact',
  'setlanguage', 'boost', 'giftcode', 'invoice', 'confirmphone', 'k', 'a', 'z',
  'web', 'download', 'apps', 'faq', 'privacy', 'blog', 'dl', 'about', 'app',
  'home', 'index', 'channel', 'channels', 'terms', 'support', 'help', 'tos',
  'static', 'assets', 'api', 'auth', 'p', 'reel', 'reels', 'explore',
  'accounts', 'stories', 'tv', 'direct', 'developer', 'legal', 'tags',
  'locations', 'challenge', 'landing', 'rules', 'features', 'security',
]);

const NOT_SITES = [
  'google.com', 'google.ir', 'bing.com', 'duckduckgo.com', 'yahoo.com',
  'yimg.com', 'yandex.com', 'yandex.ru', 'naver.com', 'naver.net',
  'pstatic.net', 'seznam.cz', 'qwant.com', 'dogpile.com', 'ecosia.org',
  'metager.org', 'mojeek.com', 'rismoon.com', 'microsoft.com', 'msn.com',
  'live.com', 'apple.com', 'facebook.com', 'fb.com', 'twitter.com', 'x.com',
  'youtube.com', 'youtu.be', 'linkedin.com', 'pinterest.com', 'aparat.com',
  'wikipedia.org', 'wikimedia.org', 'github.com', 'cafebazaar.ir', 'myket.ir',
  'enamad.ir', 'samandehi.ir', 'zarinpal.com', 'shaparak.ir', 'neshan.org',
  'balad.ir', 'waze.com', 'wa.me', 'telegram.org', 'w3.org', 'schema.org',
  'gravatar.com', 'wordpress.org', 'wordpress.com', 'cloudflare.com',
  'googleapis.com', 'gstatic.com', 'googletagmanager.com', 'bale.ai',
  'eitaa.ir', 'rubika.app', 'archive.org', 'zarebin.ir', 'gerdoo.me',
  'tgstat.com', 'telegram.dog',
  // Also never list channel directories as seller sites
  ...FINDER_DIRECTORIES,
];

const FILE_LIKE =
  /\.(?:jpe?g|png|gif|svg|webp|ico|pdf|zip|rar|apk|mp4|mp3|css|js|xml|json|xlsx?|docx?)$/i;
const HANDLE = /^[a-zA-Z][a-zA-Z0-9_]{2,63}$/;
const IG_HANDLE = /^[a-zA-Z0-9._]{2,30}$/;
const TRACKING = new Set([
  'fbclid', 'gclid', 'srsltid', 'yclid', 'msclkid', 'igshid', 'igsh',
  'ref', 'share', '_ga', '_gl',
]);

function canonicalPathKey(path) {
  try {
    return decodeURIComponent(path).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
}

/**
 * Converts messenger deep-links (`tg://resolve?domain=...`, `et://resolve?domain=...`)
 * into public web URLs.
 */
export function webAddressOf(href) {
  const s = String(href || '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.hostname !== 'resolve') return null;
  const domain = (u.searchParams.get('domain') || '').trim();
  if (!domain) return null;
  if (u.protocol === 'tg:') return `https://t.me/${domain}`;
  if (u.protocol === 'et:') return `https://eitaa.com/${domain}`;
  return null;
}

/**
 * Decides which list a public address belongs to, or null when it is not
 * a valid public place (invite, phone contact, bot, file, search engine...).
 */
export function classifyLink(raw) {
  const text = String(raw || '').trim();
  if (!text || text.length > 400) return null;

  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port) return null;
  if (!u.hostname) return null;

  let host = u.hostname.toLowerCase();
  if (host.startsWith('web.')) return null;
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.') || /^[\d.]+$/.test(host)) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  const seg = u.pathname.split('/').filter(Boolean);
  const messenger = MESSENGERS[host];
  if (messenger) {
    const [kind, part, readable] = messenger;
    if (kind === 'whatsapp') {
      if (seg.length < 2 || seg[0] !== 'channel') return null;
      const id = seg[1];
      if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return null;
      return {
        url: `https://whatsapp.com/channel/${id}`,
        kind,
        key: `whatsapp:${id}`,
        part,
        readable: false,
        host: '',
        handle: id,
      };
    }
    const path = seg[0] === 's' ? seg.slice(1) : seg.slice();
    if (!path.length) return null;
    let h = path[0];
    if (h.startsWith('@')) h = h.slice(1);
    const low = h.toLowerCase();
    if (RESERVED.has(low)) return null;
    if (kind === 'instagram') {
      if (!IG_HANDLE.test(h) || h.startsWith('.')) return null;
      return {
        url: `https://www.instagram.com/${low}/`,
        kind,
        key: `instagram:${low}`,
        part,
        readable: false,
        host: '',
        handle: low,
      };
    }
    if (path.length > 2 || (path.length === 2 && !/^\d+$/.test(path[1]))) {
      return null;
    }
    if (
      !HANDLE.test(h) ||
      low.endsWith('bot') ||
      low.includes('admin') ||
      low.includes('marketing')
    ) {
      return null;
    }
    return {
      url: `https://${CANONICAL_HOST[kind]}/${h}`,
      kind,
      key: `${kind}:${low}`,
      part,
      readable,
      host: '',
      handle: h,
    };
  }

  if (NOT_SITES.some((x) => host === x || host.endsWith(`.${x}`))) return null;
  if (FILE_LIKE.test(u.pathname)) return null;

  const rawQuery = {};
  for (const [k, v] of u.searchParams.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith('utm_') || TRACKING.has(lk)) continue;
    rawQuery[k] = v;
  }
  const sortedKeys = Object.keys(rawQuery).sort();
  const qs = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(rawQuery[k])}`)
    .join('&');

  let path = u.pathname ? u.pathname.replace(/\/+/g, '/') : '/';
  const lowerPath = path.toLowerCase();
  for (const idx of ['/index.html', '/index.htm', '/index.php']) {
    if (lowerPath.endsWith(idx)) {
      path = path.slice(0, path.length - idx.length);
      if (!path) path = '/';
      break;
    }
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const url = `${u.protocol}//${host}${path}${qs ? `?${qs}` : ''}`;
  if (url.length > 220) return null;
  const keyPath = canonicalPathKey(path);
  const queryPart = qs ? `?${qs.toLowerCase()}` : '';
  return {
    url,
    kind: 'site',
    key: `site:${host}${keyPath}${queryPart}`,
    part: FinderPart.sites,
    readable: true,
    host,
    handle: '',
  };
}

export function canonicalUrlKey(rawUrl) {
  const link = classifyLink(rawUrl);
  if (link) return link.key;
  try {
    const u = new URL(String(rawUrl || '').trim());
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    let path = u.pathname ? u.pathname.replace(/\/+/g, '/') : '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `raw:${host}${canonicalPathKey(path)}${u.search ? `?${u.search.toLowerCase()}` : ''}`;
  } catch {
    return String(rawUrl || '').trim().toLowerCase();
  }
}

/** Public preview reader URL: Telegram & Bale expose posts without login under /s/. */
export function previewUrl(kind, url) {
  if (kind !== 'telegram' && kind !== 'bale') return url;
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    return `https://${u.host}/s/${seg}`;
  } catch {
    return url;
  }
}
