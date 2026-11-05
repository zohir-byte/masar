// مَسار service worker: caches the app itself so it opens fast and offline.
const CACHE = 'masar-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'solver.js', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return; // maps, search, routing go to network
  // network first, fall back to cache (so updates arrive, but it still opens offline)
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
