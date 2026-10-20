// 오프라인용 — 캐시에 있으면 바로 쓰고, 뒤에서 새 판을 받아 다음 실행 때 반영한다 (stale-while-revalidate).
// 파일 목록이 바뀌면 VERSION을 올린다.
const VERSION = 'hoedok-2026-10-20.1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './core.js',
  './words.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const fresh = fetch(req)
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
