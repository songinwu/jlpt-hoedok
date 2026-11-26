// 오프라인용 — 캐시에 있으면 바로 쓰고, 뒤에서 새 판을 받아 다음 실행 때 반영한다 (stale-while-revalidate).
// 파일 목록이 바뀌면 VERSION을 올린다.
const VERSION = 'hoedok-2026-11-26.2';
const AUDIO = 'hoedok-audio-v2'; // 발음 mp3 — 앱 버전이 바뀌어도 지우지 않는다 (한 번 들은 단어는 오프라인에서도)
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './core.js',
  './sync.js',
  './words.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' — GitHub Pages가 붙이는 HTTP 캐시(10분)를 건너뛰고 새 판을 받는다
  const fresh = SHELL.map((url) => new Request(url, { cache: 'reload' }));
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== AUDIO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (new URL(req.url).pathname.includes('/audio/')) {
    e.respondWith(audioResponse(req));
    return;
  }
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      e.waitUntil(fresh);
      return cached || fresh;
    }),
  );
});

// 발음 파일: 캐시에 있으면 캐시, 없으면 받아서 넣는다. Safari는 <audio>에 Range 요청을 보내므로 206으로 잘라 준다.
async function audioResponse(req) {
  const cache = await caches.open(AUDIO);
  const url = req.url.split('?')[0];
  let res = await cache.match(url);
  if (!res) {
    const got = await fetch(url);
    if (!got.ok) return got;
    await cache.put(url, got.clone());
    res = got;
  }
  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return res;
  const buf = await res.arrayBuffer();
  const start = m[1] ? Number(m[1]) : Math.max(0, buf.byteLength - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
