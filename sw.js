// Keeps the app shell available offline. Train data is never cached.
// tools/build.mjs fills in BUILD and the hashed SHELL names for each release.
const BUILD = 'dev';
const CACHE = `traim-${BUILD}`;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'js/app.js',
  'js/config.js',
  'js/errors.js',
  'js/google.js',
  'js/i18n.js',
  'js/icons.js',
  'js/pwa.js',
  'js/settings.js',
  'js/store.js',
  'js/trains.js',
  'js/util.js',
  'js/sources/sta.js',
  'js/sources/viaggiatreno.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// Network first, so a new version shows up right away; the cache is only the offline fallback.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/vt/')) return;
  if (url.pathname.endsWith('/version.json')) return;
  // Pages keep their URL across releases: revalidate them instead of trusting the HTTP cache.
  const fresh = request.mode === 'navigate' ? fetch(request, { cache: 'no-cache' }) : fetch(request);
  event.respondWith(
    fresh
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit ?? caches.match('index.html'))),
  );
});
