/* مَسار — shared storage + drive logic, used by the page AND the service worker.
   The drive snapshot lives in IndexedDB so the notification buttons can work
   while the app is in the background (Google Maps in front). */
(function (root) {
  'use strict';
  const DB = 'masar', STORE = 'kv';

  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function get(key) {
    const db = await open();
    return new Promise((res, rej) => {
      const q = db.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
  async function set(key, val) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(val, key);
      t.oncomplete = () => res(); t.onerror = () => rej(t.error);
    });
  }

  // snap = {stops:[{id,lat,lon,label,sub,legM}], start, roundtrip, backM, status:{}, history:[], updated}
  function current(snap) {
    if (!snap) return null;
    for (let i = 0; i < snap.stops.length; i++) if (!snap.status[snap.stops[i].id]) return { stop: snap.stops[i], n: i + 1 };
    return null;
  }
  function remainingM(snap) {
    let m = 0;
    for (const s of snap.stops) if (!snap.status[s.id]) m += s.legM || 0;
    if (snap.roundtrip) m += snap.backM || 0;
    return m;
  }
  function mapsUrl(p) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat.toFixed(6) + ',' + p.lon.toFixed(6) + '&travelmode=driving&dir_action=navigate';
  }
  const km = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' كم';

  function notification(snap) {
    const c = current(snap);
    const done = Object.values(snap.status).filter((v) => v === 'done').length;
    if (c) {
      return {
        title: 'المحطة ' + c.n + ' من ' + snap.stops.length + ': ' + c.stop.label,
        options: {
          body: (c.stop.sub ? c.stop.sub + '\n' : '') + 'الباقي ' + km(remainingM(snap)) + ' · تم ' + done,
          tag: 'masar-drive', renotify: false, requireInteraction: true, silent: true,
          icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
          actions: [{ action: 'done', title: '✓ تم التوصيل' }, { action: 'nav', title: '🧭 الملاحة' }]
        }
      };
    }
    return {
      title: '🎉 خلصت الجولة! تم توصيل ' + done + ' محطة',
      options: {
        body: snap.roundtrip ? 'اضغط «الرجوع» للملاحة لنقطة البداية' : 'يعطيك العافية',
        tag: 'masar-drive', renotify: true, silent: false, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
        actions: snap.roundtrip ? [{ action: 'home', title: '↩ الرجوع للبداية' }] : []
      }
    };
  }

  // Apply a notification/button action to the stored snapshot.
  // Returns {snap, url} where url = Google Maps link to open (or null).
  async function applyAction(action) {
    const snap = await get('drive');
    if (!snap) return { snap: null, url: null };
    let url = null;
    if (action === 'done' || action === 'skip') {
      const c = current(snap);
      if (c) {
        snap.status[c.stop.id] = action; snap.history.push(c.stop.id); snap.updated = Date.now();
        await set('drive', snap);
        const nx = current(snap);
        if (nx) url = mapsUrl(nx.stop);
      }
    } else if (action === 'nav') {
      const c = current(snap); if (c) url = mapsUrl(c.stop);
    } else if (action === 'home') {
      if (snap.start) url = mapsUrl(snap.start);
    }
    return { snap, url };
  }

  root.MasarStore = { get, set, current, remainingM, mapsUrl, notification, applyAction, km };
})(typeof self !== 'undefined' ? self : this);
