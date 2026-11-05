// مَسار service worker: offline app shell + notification buttons while driving.
importScripts('store.js');
const CACHE = 'masar-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'solver.js', 'store.js', 'manifest.webmanifest',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return; // maps/search/routing -> network
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});

self.addEventListener('notificationclick', (e) => {
  const action = e.action || 'open';
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (action === 'open') {
      const w = all.find((c) => c.url.startsWith(self.registration.scope));
      if (w) return w.focus();
      return self.clients.openWindow('./?tab=drive');
    }
    const { snap, url } = await MasarStore.applyAction(action);
    if (snap) {
      const n = MasarStore.notification(snap);
      await self.registration.showNotification(n.title, n.options);
      all.forEach((c) => c.postMessage({ type: 'masar-sync' }));
    }
    if (url) await self.clients.openWindow(url);
  })());
});
