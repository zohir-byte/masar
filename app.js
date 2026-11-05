/* مَسار — personal route planner (max 35 stops) */
(function () {
  'use strict';
  const MAX_STOPS = 35;
  const BOOK_MAX = 400;
  const OSRM = 'https://router.project-osrm.org';
  const PHOTON = 'https://photon.komoot.io';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const KEY = 'masar.v1';
  const S = window.MasarStore;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const placeKey = (p) => p.lat.toFixed(4) + ',' + p.lon.toFixed(4);

  // ---------- state ----------
  let state = {
    startMode: 'gps', start: null, stops: [], roundtrip: true,
    plan: null,            // {order:[ids], start, dur, dist, approx, roundtrip, geom, legs:[m per stop], backM}
    drive: { status: {}, history: [], updated: 0 },
    book: [],              // saved addresses [{key,lat,lon,label,sub,uses,last}]
    lastRound: []          // stops of the last started round
  };
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.stops)) state = Object.assign(state, s); } catch (e) {}
  if (!Array.isArray(state.book)) state.book = [];
  if (!Array.isArray(state.lastRound)) state.lastRound = [];
  // older saves had no book: seed it from the current stops
  state.stops.forEach((s) => addToBook(s, true));

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    pushSnap();
  }

  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }

  // ---------- address book ----------
  function addToBook(s, quiet) {
    const key = placeKey(s);
    const ex = state.book.find((b) => b.key === key);
    if (ex) { if (!quiet) { ex.uses = (ex.uses || 0) + 1; ex.last = Date.now(); } ex.label = s.label; ex.sub = s.sub || ex.sub; return; }
    state.book.unshift({ key, lat: s.lat, lon: s.lon, label: s.label, sub: s.sub || '', uses: 1, last: Date.now() });
    if (state.book.length > BOOK_MAX) state.book.length = BOOK_MAX;
  }

  // ---------- drive snapshot (shared with service worker) ----------
  function buildSnap() {
    if (!state.plan) return null;
    const legs = state.plan.legs || [];
    return {
      stops: orderedStops().map((s, i) => ({ id: s.id, lat: s.lat, lon: s.lon, label: s.label, sub: s.sub, legM: legs[i] || 0 })),
      start: state.plan.start, roundtrip: state.plan.roundtrip, backM: state.plan.backM || 0,
      status: state.drive.status, history: state.drive.history, updated: state.drive.updated || 0
    };
  }
  function pushSnap() { try { S.set('drive', buildSnap()).catch(() => {}); } catch (e) {} }
  async function pullSnap() {
    if (!state.plan) return;
    let snap; try { snap = await S.get('drive'); } catch (e) { return; }
    if (!snap || !snap.stops || (snap.updated || 0) <= (state.drive.updated || 0)) return;
    const ids = state.plan.order.join(',');
    if (snap.stops.map((s) => s.id).join(',') !== ids) return;
    state.drive = { status: snap.status || {}, history: snap.history || [], updated: snap.updated };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    render(); drawMap(false);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pullSnap(); });
  window.addEventListener('focus', pullSnap);

  let swReg = null;
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'masar-sync') pullSnap(); });
  }
  const notifSupported = () => 'Notification' in window && 'serviceWorker' in navigator && window.isSecureContext;
  async function getReg() { return swReg || (await navigator.serviceWorker.ready); }
  async function showNotif() {
    if (!notifSupported() || Notification.permission !== 'granted' || !state.plan) return;
    try { const reg = await getReg(); const n = S.notification(buildSnap()); await reg.showNotification(n.title, n.options); } catch (e) {}
  }
  async function clearNotif() {
    if (!notifSupported()) return;
    try { const reg = await getReg(); (await reg.getNotifications({ tag: 'masar-drive' })).forEach((n) => n.close()); } catch (e) {}
  }
  async function askNotif() {
    if (!notifSupported()) { toast('الإشعارات مش مدعومة هون. ثبّت التطبيق من Chrome على الشاشة الرئيسية', 4500); return; }
    let p = Notification.permission;
    if (p === 'default') p = await Notification.requestPermission();
    if (p === 'granted') { await showNotif(); toast('✓ الإشعار شغّال. اسحب شريط الإشعارات وانت بـ Google Maps'); }
    else toast('الإشعارات مرفوضة. فعّلها من إعدادات الهاتف ← التطبيقات ← مَسار', 5000);
    render();
  }
  $('notifBtn').onclick = askNotif;

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([51.16, 10.45], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  map.attributionControl.setPrefix(false);
  const layer = L.layerGroup().addTo(map);
  let routeLine = null;

  $('mapToggle').onclick = () => {
    const w = $('mapWrap'); w.classList.toggle('big');
    $('mapToggle').textContent = w.classList.contains('big') ? '⤡' : '⤢';
    setTimeout(() => map.invalidateSize(), 280);
  };

  function pinIcon(text, cls) {
    const big = cls === 'cur';
    return L.divIcon({ className: '', html: '<div class="pin ' + (cls || '') + '"><span>' + esc(text) + '</span></div>', iconSize: big ? [34, 34] : [28, 28], iconAnchor: big ? [17, 34] : [14, 28] });
  }

  function drawMap(fit) {
    layer.clearLayers();
    const pts = [];
    const start = (state.plan && state.plan.start) || state.start;
    if (start) { L.marker([start.lat, start.lon], { icon: pinIcon('★', 'start') }).addTo(layer); pts.push([start.lat, start.lon]); }
    const cur = currentStop();
    orderedStops().forEach((s, i) => {
      const st = state.drive.status[s.id];
      const cls = st === 'done' ? 'done' : st === 'skip' ? 'skip' : (cur && cur.id === s.id ? 'cur' : '');
      L.marker([s.lat, s.lon], { icon: pinIcon(i + 1, cls), zIndexOffset: cls === 'cur' ? 1000 : 0 }).bindPopup(esc(s.label)).addTo(layer);
      pts.push([s.lat, s.lon]);
    });
    if (routeLine) layer.addLayer(routeLine);
    if (fit && pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  }

  map.on('contextmenu', async (e) => {
    if (state.stops.length >= MAX_STOPS) return toast('الحد الأقصى ' + MAX_STOPS + ' محطة');
    const { lat, lng } = e.latlng;
    let label = lat.toFixed(5) + ', ' + lng.toFixed(5), sub = 'نقطة من الخريطة';
    try {
      const r = await fetchJSON(PHOTON + '/reverse?lat=' + lat + '&lon=' + lng + '&lang=de', 6000);
      if (r.features && r.features[0]) { const f = fmtPhoton(r.features[0]); label = f.label; sub = f.sub; }
    } catch (err) {}
    addStop({ lat, lon: lng, label, sub });
  });

  // ---------- geocoding ----------
  async function fetchJSON(url, timeout) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout || 12000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  function fmtPhoton(f) {
    const p = f.properties || {};
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const label = street || p.name || p.city || '—';
    const sub = [p.name && street ? p.name : null, [p.postcode, p.city || p.town || p.village].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label, sub };
  }
  function biasPoint() {
    const s = state.start || state.stops[state.stops.length - 1];
    if (s) return s;
    const c = map.getCenter(); return map.getZoom() > 8 ? { lat: c.lat, lon: c.lng } : null;
  }
  async function geocode(q, limit) {
    const b = biasPoint();
    try {
      let url = PHOTON + '/api/?q=' + encodeURIComponent(q) + '&limit=' + (limit || 5) + '&lang=de';
      if (b) url += '&lat=' + b.lat + '&lon=' + b.lon;
      const r = await fetchJSON(url, 8000);
      const out = (r.features || []).map(fmtPhoton);
      if (out.length) return out;
    } catch (e) {}
    const r = await fetchJSON(NOMINATIM + '/search?format=jsonv2&addressdetails=1&accept-language=de&limit=' + (limit || 5) + '&q=' + encodeURIComponent(q), 10000);
    return r.map((x) => {
      const a = x.address || {};
      const street = [a.road, a.house_number].filter(Boolean).join(' ');
      return { lat: +x.lat, lon: +x.lon, label: street || x.name || x.display_name.split(',')[0], sub: [a.postcode, a.city || a.town || a.village].filter(Boolean).join(' ') };
    });
  }

  function attachSearch(input, box, onPick, useBook) {
    let timer = null, seq = 0;
    function addRow(r, saved) {
      const b = document.createElement('button');
      b.innerHTML = (saved ? '📒 ' : '') + esc(r.label) + '<small>' + esc(r.sub) + '</small>';
      b.onclick = () => { box.innerHTML = ''; input.value = ''; onPick(r); };
      box.appendChild(b);
    }
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      box.innerHTML = '';
      if (q.length < 2) return;
      // saved addresses first, instantly
      const ql = q.toLowerCase();
      const saved = useBook ? state.book.filter((b) => (b.label + ' ' + b.sub).toLowerCase().includes(ql)).slice(0, 3) : [];
      saved.forEach((r) => addRow(r, true));
      if (q.length < 3) return;
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const res = await geocode(q, 5);
          if (my !== seq) return;
          box.innerHTML = ''; saved.forEach((r) => addRow(r, true));
          const keys = new Set(saved.map((s) => s.key));
          res.filter((r) => !keys.has(placeKey(r))).forEach((r) => addRow(r, false));
          if (!box.children.length) box.innerHTML = '<button disabled>لا توجد نتائج</button>';
        } catch (e) { if (my === seq && !saved.length) box.innerHTML = '<button disabled>تعذّر البحث، تأكد من الإنترنت</button>'; }
      }, 350);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = box.querySelector('button:not([disabled])'); if (f) f.click(); } });
  }

  // ---------- stops ----------
  function invalidatePlan() {
    const had = !!state.plan;
    state.plan = null; routeLine = null; state.drive = { status: {}, history: [], updated: 0 };
    if (had) clearNotif();
  }
  function addStop(s, opts) {
    opts = opts || {};
    if (state.stops.length >= MAX_STOPS) { if (!opts.quiet) toast('الحد الأقصى ' + MAX_STOPS + ' محطة'); return false; }
    const key = placeKey(s);
    if (state.stops.some((x) => placeKey(x) === key)) { if (!opts.quiet) toast('هالعنوان موجود بالقائمة'); return false; }
    state.stops.push({ id: uid(), lat: s.lat, lon: s.lon, label: s.label, sub: s.sub || '' });
    addToBook(s);
    if (!opts.batch) { invalidatePlan(); save(); render(); drawMap(true); }
    return true;
  }
  function finishBatch() { invalidatePlan(); save(); render(); drawMap(true); }
  function removeStop(id) {
    state.stops = state.stops.filter((s) => s.id !== id);
    invalidatePlan(); save(); render(); drawMap(false);
  }
  function orderedStops() {
    if (!state.plan) return state.stops.slice();
    const m = new Map(state.stops.map((s) => [s.id, s]));
    return state.plan.order.map((id) => m.get(id)).filter(Boolean);
  }

  attachSearch($('stopInput'), $('stopSug'), (r) => addStop(r), true);
  attachSearch($('startInput'), $('startSug'), (r) => { state.start = r; addToBook(r); invalidatePlan(); save(); render(); drawMap(true); }, true);

  $('bulkBtn').onclick = () => $('bulkBox').classList.toggle('hidden');
  $('bulkGo').onclick = async () => {
    const lines = $('bulkText').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const btn = $('bulkGo'); btn.disabled = true;
    const failed = [];
    for (let i = 0; i < lines.length; i++) {
      if (state.stops.length >= MAX_STOPS) { toast('وصلت للحد الأقصى ' + MAX_STOPS); break; }
      btn.textContent = 'جاري الإضافة ' + (i + 1) + '/' + lines.length + '…';
      try { const r = await geocode(lines[i], 1); if (r[0]) addStop(r[0], { quiet: true }); else failed.push(lines[i]); }
      catch (e) { failed.push(lines[i]); }
      await new Promise((res) => setTimeout(res, 300));
    }
    btn.disabled = false; btn.textContent = 'أضف العناوين';
    $('bulkText').value = failed.join('\n');
    if (failed.length) toast('ما لقيت ' + failed.length + ' عنوان، تركتهم بالمربع لتعدّلهم', 4000);
    else $('bulkBox').classList.add('hidden');
  };
  $('clearAll').onclick = () => {
    if (!state.stops.length) return;
    if (confirm('مسح كل المحطات؟ (بتضل محفوظة بالعناوين المحفوظة)')) { state.stops = []; invalidatePlan(); save(); render(); drawMap(false); }
  };

  $('repeatBtn').onclick = () => {
    if (!state.lastRound.length) return;
    if (state.stops.length && !confirm('استبدال المحطات الحالية بمحطات آخر جولة؟')) return;
    state.stops = [];
    state.lastRound.slice(0, MAX_STOPS).forEach((s) => addStop(s, { batch: true, quiet: true }));
    finishBatch(); toast('✓ رجّعت ' + state.stops.length + ' محطة من آخر جولة');
  };

  // address book sheet
  let picked = new Set();
  function renderBook() {
    const q = $('bookFilter').value.trim().toLowerCase();
    const inStops = new Set(state.stops.map(placeKey));
    const items = state.book.filter((b) => !q || (b.label + ' ' + b.sub).toLowerCase().includes(q));
    const ul = $('bookList'); ul.innerHTML = '';
    if (!state.book.length) ul.innerHTML = '<li class="empty">لسا ما في عناوين محفوظة. كل عنوان بتضيفه بينحفظ هون تلقائياً.</li>';
    else if (!items.length) ul.innerHTML = '<li class="empty">ما في نتائج</li>';
    items.forEach((b) => {
      const li = document.createElement('li');
      const already = inStops.has(b.key);
      li.innerHTML = '<label><input type="checkbox"' + (already ? ' checked disabled' : picked.has(b.key) ? ' checked' : '') + '><span class="txt"><b>' + esc(b.label) + '</b><small>' + esc(b.sub) + (already ? ' · <span class="in">بالقائمة</span>' : '') + '</small></span></label><button class="del" aria-label="حذف من المحفوظة">✕</button>';
      li.querySelector('input').onchange = (e) => { e.target.checked ? picked.add(b.key) : picked.delete(b.key); bookCount(); };
      li.querySelector('.del').onclick = () => {
        if (!confirm('حذف «' + b.label + '» من العناوين المحفوظة؟')) return;
        state.book = state.book.filter((x) => x.key !== b.key); picked.delete(b.key); save(); renderBook(); bookCount();
      };
      ul.appendChild(li);
    });
    bookCount();
  }
  function bookCount() {
    const room = MAX_STOPS - state.stops.length;
    $('bookAdd').textContent = picked.size ? 'أضف المحدّد (' + picked.size + ')' : 'أضف المحدّد';
    $('bookAdd').disabled = !picked.size;
    $('bookInfo').textContent = 'محفوظ ' + state.book.length + ' · باقي مكان لـ ' + room;
  }
  $('bookBtn').onclick = () => { picked = new Set(); $('bookFilter').value = ''; renderBook(); $('bookSheet').classList.remove('hidden'); };
  $('bookClose').onclick = () => $('bookSheet').classList.add('hidden');
  $('bookSheet').onclick = (e) => { if (e.target.id === 'bookSheet') $('bookSheet').classList.add('hidden'); };
  $('bookFilter').oninput = renderBook;
  $('bookAll').onclick = () => {
    const q = $('bookFilter').value.trim().toLowerCase();
    const inStops = new Set(state.stops.map(placeKey));
    state.book.filter((b) => !inStops.has(b.key) && (!q || (b.label + ' ' + b.sub).toLowerCase().includes(q))).forEach((b) => picked.add(b.key));
    renderBook();
  };
  $('bookAdd').onclick = () => {
    let added = 0, full = false;
    state.book.filter((b) => picked.has(b.key)).forEach((b) => {
      if (state.stops.length >= MAX_STOPS) { full = true; return; }
      if (addStop(b, { batch: true, quiet: true })) added++;
    });
    finishBatch();
    $('bookSheet').classList.add('hidden');
    toast(full ? 'أضفت ' + added + '، وصلت للحد الأقصى ' + MAX_STOPS : '✓ أضفت ' + added + ' محطة');
  };

  // start / end options
  function setStartMode(m) { state.startMode = m; if (m === 'gps') state.start = null; invalidatePlan(); save(); render(); }
  $('startGps').onclick = () => setStartMode('gps');
  $('startAddr').onclick = () => setStartMode('addr');
  $('endBack').onclick = () => { state.roundtrip = true; invalidatePlan(); save(); render(); };
  $('endFree').onclick = () => { state.roundtrip = false; invalidatePlan(); save(); render(); };

  function getGps() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('no geo'));
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'موقعي الحالي' }),
        rej, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
  }

  // ---------- optimize ----------
  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const coordStr = (pts) => pts.map((p) => p.lon.toFixed(6) + ',' + p.lat.toFixed(6)).join(';');

  async function optimize() {
    if (state.stops.length < 1) return toast('أضف محطة واحدة على الأقل');
    const btn = $('optimize'); btn.disabled = true; btn.textContent = 'جاري الحساب…';
    try {
      let start = state.start;
      if (state.startMode === 'gps') {
        try { start = await getGps(); }
        catch (e) { toast('ما قدرت آخذ موقعك. فعّل الـ GPS أو اختر «عنوان» للبداية', 4500); return; }
      } else if (!start) { toast('اكتب عنوان البداية أولاً'); return; }

      const pts = [start].concat(state.stops);
      let D = null, Dist = null, approx = false;
      try {
        const t = await fetchJSON(OSRM + '/table/v1/driving/' + coordStr(pts) + '?annotations=duration,distance', 20000);
        if (t.code !== 'Ok') throw new Error(t.code);
        const BIG = 1e7;
        D = t.durations.map((r) => r.map((v) => (v == null ? BIG : v)));
        Dist = t.distances ? t.distances.map((r) => r.map((v) => (v == null ? BIG : v))) : null;
      } catch (e) {
        approx = true;
        Dist = pts.map((a) => pts.map((b) => haversine(a, b) * 1.3));
        D = Dist.map((r) => r.map((m) => m / (35 / 3.6)));
      }
      if (!Dist) Dist = pts.map((a) => pts.map((b) => haversine(a, b) * 1.3));
      const order = MasarSolver.solve(D, state.roundtrip);
      const ids = order.map((i) => state.stops[i - 1].id);
      let dur = MasarSolver.routeCost(D, order, state.roundtrip);
      // per-leg distances (matrix first, replaced by real road legs below)
      const idxSeq = [0].concat(order);
      let legs = order.map((_, k) => Dist[idxSeq[k]][idxSeq[k + 1]]);
      let backM = state.roundtrip ? Dist[order[order.length - 1]][0] : 0;

      routeLine = null; let geom = null;
      const seq = [start].concat(order.map((i) => pts[i]));
      if (state.roundtrip) seq.push(start);
      if (!approx) {
        try {
          const r = await fetchJSON(OSRM + '/route/v1/driving/' + coordStr(seq) + '?overview=full&geometries=geojson', 20000);
          if (r.code === 'Ok' && r.routes[0]) {
            const g = r.routes[0].geometry.coordinates.map((c) => [c[1], c[0]]);
            geom = g.length > 2500 ? g.filter((_, k) => k % Math.ceil(g.length / 2500) === 0 || k === g.length - 1) : g;
            routeLine = L.polyline(geom, { color: '#ffb020', weight: 5, opacity: 0.85 });
            dur = r.routes[0].duration;
            const L2 = r.routes[0].legs || [];
            if (L2.length === seq.length - 1) {
              legs = order.map((_, k) => L2[k].distance);
              backM = state.roundtrip ? L2[L2.length - 1].distance : 0;
            }
          }
        } catch (e) {}
      }
      if (!routeLine) routeLine = L.polyline(seq.map((p) => [p.lat, p.lon]), { color: '#ffb020', weight: 3, dashArray: '6 8' });
      const dist = legs.reduce((a, b) => a + b, 0) + backM;

      state.plan = {
        order: ids, start: { lat: start.lat, lon: start.lon, label: start.label }, dur, dist, approx, roundtrip: state.roundtrip,
        legs: legs.map(Math.round), backM: Math.round(backM),
        geom: geom && geom.map((c) => [+c[0].toFixed(5), +c[1].toFixed(5)])
      };
      state.drive = { status: {}, history: [], updated: Date.now() };
      save(); render(); drawMap(true);
    } finally {
      btn.disabled = false; render();
    }
  }
  $('optimize').onclick = optimize;

  function fmtDur(s) {
    const m = Math.round(s / 60); if (m < 60) return m + ' د';
    return Math.floor(m / 60) + ' س ' + (m % 60) + ' د';
  }
  const fmtKm = S.km;

  // ---------- drive ----------
  function currentStop() {
    if (!state.plan) return null;
    return orderedStops().find((s) => !state.drive.status[s.id]) || null;
  }
  function openMaps(p) {
    const a = document.createElement('a'); a.href = S.mapsUrl(p); a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function mark(status) {
    const cur = currentStop(); if (!cur) return;
    state.drive.status[cur.id] = status; state.drive.history.push(cur.id); state.drive.updated = Date.now();
    save(); render(); drawMap(false); showNotif();
    const next = currentStop();
    if (next) { map.panTo([next.lat, next.lon]); openMaps(next); }
    else toast('🎉 خلصت الجولة!', 3500);
  }
  $('doneBtn').onclick = () => mark('done');
  $('skipBtn').onclick = () => mark('skip');
  $('undoBtn').onclick = () => {
    const id = state.drive.history.pop(); if (!id) return;
    delete state.drive.status[id]; state.drive.updated = Date.now();
    save(); render(); drawMap(false); showNotif();
  };
  $('navBtn').onclick = () => {
    const cur = currentStop();
    showNotif();
    if (cur) openMaps(cur);
    else if (state.plan && state.plan.roundtrip) openMaps(state.plan.start);
  };
  $('newRound').onclick = () => {
    if (!confirm('بدء جولة جديدة؟ المحطات الحالية بتنمسح (وبتضل بالعناوين المحفوظة وبزر «آخر جولة»).')) return;
    state.stops = []; invalidatePlan(); save(); render(); drawMap(false); showTab('plan');
  };

  // tabs
  function showTab(t) {
    $('tabPlan').classList.toggle('on', t === 'plan'); $('tabDrive').classList.toggle('on', t === 'drive');
    $('planView').classList.toggle('hidden', t !== 'plan'); $('driveView').classList.toggle('hidden', t !== 'drive');
    state.tab = t; try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    setTimeout(() => map.invalidateSize(), 50);
  }
  $('tabPlan').onclick = () => showTab('plan');
  $('tabDrive').onclick = () => { showTab('drive'); pullSnap(); };
  $('toDrive').onclick = async () => {
    state.lastRound = state.stops.map((s) => ({ lat: s.lat, lon: s.lon, label: s.label, sub: s.sub }));
    save(); showTab('drive');
    const c = currentStop(); if (c) map.setView([c.lat, c.lon], 14);
    if (notifSupported() && Notification.permission === 'default') await askNotif();
    else showNotif();
  };

  // ---------- render ----------
  function render() {
    $('startGps').classList.toggle('on', state.startMode === 'gps');
    $('startAddr').classList.toggle('on', state.startMode === 'addr');
    $('startAddrBox').classList.toggle('hidden', state.startMode !== 'addr');
    $('startLabel').textContent = state.startMode === 'addr' ? (state.start ? '★ ' + state.start.label + (state.start.sub ? ' · ' + state.start.sub : '') : '') : 'بيتحدد موقعك لما ترتّب المسار';
    $('endBack').classList.toggle('on', state.roundtrip);
    $('endFree').classList.toggle('on', !state.roundtrip);
    $('count').textContent = state.stops.length + ' / ' + MAX_STOPS;
    $('stopInput').disabled = state.stops.length >= MAX_STOPS;
    $('repeatBtn').disabled = !state.lastRound.length;
    $('bookBtn').textContent = '📒 العناوين المحفوظة' + (state.book.length ? ' (' + state.book.length + ')' : '');

    const planned = !!state.plan;
    const list = $('stopList'); list.innerHTML = '';
    orderedStops().forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="num ' + (planned ? '' : 'plain') + '">' + (i + 1) + '</span><span class="txt"><b>' + esc(s.label) + '</b><small>' + esc(s.sub) + '</small></span><button class="del" aria-label="حذف">✕</button>';
      li.querySelector('.del').onclick = () => removeStop(s.id);
      list.appendChild(li);
    });
    if (!state.stops.length) list.innerHTML = '<li class="empty">ما في محطات بعد. ابحث عن عنوان أو اختار من المحفوظة.</li>';

    const sum = $('summary');
    document.querySelector('.bar').classList.toggle('planned', planned);
    if (!$('optimize').disabled) $('optimize').textContent = planned ? '↻ أعد الترتيب' : 'رتّب أفضل مسار';
    if (planned) {
      sum.classList.remove('hidden');
      sum.innerHTML = '<div><b>' + state.stops.length + '</b><span>محطة</span></div>' +
        '<div><b>' + fmtKm(state.plan.dist || 0) + '</b><span>المسافة الكاملة</span></div>' +
        '<div><b>' + fmtDur(state.plan.dur) + '</b><span>وقت القيادة</span></div>' +
        (state.plan.approx ? '<div class="warn">خادم الطرق ما ردّ، الترتيب والمسافة تقريبيين. جرّب «أعد الترتيب» بعد شوي.</div>' : '');
    } else sum.classList.add('hidden');
    $('toDrive').classList.toggle('hidden', !planned);

    // drive view
    $('driveEmpty').classList.toggle('hidden', planned);
    $('driveBox').classList.toggle('hidden', !planned);
    if (!planned) return;
    const snap = buildSnap();
    const ord = orderedStops();
    const handled = ord.filter((s) => state.drive.status[s.id]).length;
    const doneN = ord.filter((s) => state.drive.status[s.id] === 'done').length;
    $('kmTotal').textContent = fmtKm(state.plan.dist || 0);
    $('kmLeft').textContent = fmtKm(S.remainingM(snap));
    $('doneCount').textContent = doneN + ' / ' + ord.length;
    $('progBar').style.width = (ord.length ? (handled / ord.length) * 100 : 0) + '%';
    $('notifBtn').classList.toggle('hidden', !(notifSupported() && Notification.permission !== 'granted'));

    const cur = currentStop();
    $('navBtn').classList.remove('hidden');
    if (cur) {
      $('curNum').textContent = ord.indexOf(cur) + 1;
      $('curAddr').innerHTML = esc(cur.label) + '<small>' + esc(cur.sub) + '</small>';
      $('navBtn').textContent = '🧭 افتح في Google Maps';
      $('doneBtn').classList.remove('hidden'); $('skipBtn').classList.remove('hidden'); $('newRound').classList.add('hidden');
    } else {
      $('curNum').textContent = '✓';
      $('curAddr').innerHTML = 'خلصت كل المحطات<small>تم توصيل ' + doneN + ' من ' + ord.length + '</small>';
      $('doneBtn').classList.add('hidden'); $('skipBtn').classList.add('hidden'); $('newRound').classList.remove('hidden');
      $('navBtn').classList.toggle('hidden', !state.plan.roundtrip);
      $('navBtn').textContent = '↩ ارجع لنقطة البداية';
    }
    $('undoBtn').disabled = !state.drive.history.length;
    const dl = $('driveList'); dl.innerHTML = '';
    ord.forEach((s, i) => {
      const st = state.drive.status[s.id];
      const li = document.createElement('li');
      li.className = st === 'done' ? 'done' : st === 'skip' ? 'skip' : (cur && cur.id === s.id ? 'cur' : '');
      li.innerHTML = '<span class="num">' + (st === 'done' ? '✓' : i + 1) + '</span><span class="txt"><b>' + esc(s.label) + '</b><small>' + esc(s.sub) + (st === 'skip' ? ' · تم التخطي' : '') + '</small></span>';
      dl.appendChild(li);
    });
  }

  if (state.plan) {
    const ord = orderedStops(); const st = state.plan.start;
    const seq = [st].concat(ord); if (state.plan.roundtrip) seq.push(st);
    routeLine = state.plan.geom ? L.polyline(state.plan.geom, { color: '#ffb020', weight: 5, opacity: 0.85 })
      : L.polyline(seq.map((p) => [p.lat, p.lon]), { color: '#ffb020', weight: 3, dashArray: '6 8' });
    // plans saved by the first version have no per-leg distances
    if (!state.plan.legs) {
      const pts = [st].concat(ord);
      state.plan.legs = ord.map((s, i) => Math.round(haversine(pts[i], s) * 1.3));
      state.plan.backM = state.plan.roundtrip && ord.length ? Math.round(haversine(ord[ord.length - 1], st) * 1.3) : 0;
    }
  }
  save();
  render(); drawMap(true);
  const wantDrive = /[?&]tab=drive/.test(location.search) || state.tab === 'drive';
  showTab(wantDrive && state.plan ? 'drive' : 'plan');
  pullSnap();
})();
