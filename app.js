/* مَسار — personal route planner (max 35 stops) */
(function () {
  'use strict';
  const MAX_STOPS = 35;
  const OSRM = 'https://router.project-osrm.org';
  const PHOTON = 'https://photon.komoot.io';
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const KEY = 'masar.v1';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- state ----------
  let state = {
    startMode: 'gps', start: null, stops: [], roundtrip: true,
    plan: null,            // {order:[ids], start:{lat,lon,label}, dur, dist, approx}
    drive: { status: {}, history: [] }
  };
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.stops)) state = Object.assign(state, s); } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([51.16, 10.45], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  map.attributionControl.setPrefix(false);
  const layer = L.layerGroup().addTo(map);
  let routeLine = null;

  function pinIcon(text, cls) {
    return L.divIcon({ className: '', html: '<div class="pin ' + (cls || '') + '"><span>' + esc(text) + '</span></div>', iconSize: [28, 28], iconAnchor: [14, 28] });
  }

  function drawMap(fit) {
    layer.clearLayers();
    const pts = [];
    const start = (state.plan && state.plan.start) || state.start;
    if (start) { L.marker([start.lat, start.lon], { icon: pinIcon('★', 'start') }).addTo(layer); pts.push([start.lat, start.lon]); }
    const order = orderedStops();
    const cur = currentStop();
    order.forEach((s, i) => {
      const st = state.drive.status[s.id];
      const cls = st === 'done' ? 'done' : (cur && cur.id === s.id && driveActive() ? 'cur' : '');
      L.marker([s.lat, s.lon], { icon: pinIcon(i + 1, cls) }).bindPopup(esc(s.label)).addTo(layer);
      pts.push([s.lat, s.lon]);
    });
    if (routeLine) { layer.addLayer(routeLine); }
    if (fit && pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  }

  // long press on map -> add stop
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
    const sub = [p.name && street ? p.name : null, [p.postcode, p.city || p.town || p.village].filter(Boolean).join(' '), p.country].filter(Boolean).join(' · ');
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

  function attachSearch(input, box, onPick) {
    let timer = null, seq = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) { box.innerHTML = ''; return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const res = await geocode(q, 5);
          if (my !== seq) return;
          box.innerHTML = res.length ? '' : '<button disabled>لا توجد نتائج</button>';
          res.forEach((r) => {
            const b = document.createElement('button');
            b.innerHTML = esc(r.label) + '<small>' + esc(r.sub) + '</small>';
            b.onclick = () => { box.innerHTML = ''; input.value = ''; onPick(r); };
            box.appendChild(b);
          });
        } catch (e) { if (my === seq) box.innerHTML = '<button disabled>تعذّر البحث، تأكد من الإنترنت</button>'; }
      }, 350);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = box.querySelector('button:not([disabled])'); if (f) f.click(); } });
  }

  // ---------- stops ----------
  function invalidatePlan() { state.plan = null; routeLine = null; state.drive = { status: {}, history: [] }; }
  function addStop(s) {
    if (state.stops.length >= MAX_STOPS) { toast('الحد الأقصى ' + MAX_STOPS + ' محطة'); return false; }
    state.stops.push({ id: uid(), lat: s.lat, lon: s.lon, label: s.label, sub: s.sub || '' });
    invalidatePlan(); save(); render(); drawMap(true);
    return true;
  }
  function removeStop(id) {
    state.stops = state.stops.filter((s) => s.id !== id);
    invalidatePlan(); save(); render(); drawMap(false);
  }
  function orderedStops() {
    if (!state.plan) return state.stops.slice();
    const m = new Map(state.stops.map((s) => [s.id, s]));
    return state.plan.order.map((id) => m.get(id)).filter(Boolean);
  }

  attachSearch($('stopInput'), $('stopSug'), (r) => addStop(r));
  attachSearch($('startInput'), $('startSug'), (r) => { state.start = r; invalidatePlan(); save(); render(); drawMap(true); });

  $('bulkBtn').onclick = () => $('bulkBox').classList.toggle('hidden');
  $('bulkGo').onclick = async () => {
    const lines = $('bulkText').value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const btn = $('bulkGo'); btn.disabled = true;
    const failed = [];
    for (let i = 0; i < lines.length; i++) {
      if (state.stops.length >= MAX_STOPS) { toast('وصلت للحد الأقصى ' + MAX_STOPS); break; }
      btn.textContent = 'جاري الإضافة ' + (i + 1) + '/' + lines.length + '…';
      try { const r = await geocode(lines[i], 1); if (r[0]) addStop(r[0]); else failed.push(lines[i]); }
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
    if (confirm('مسح كل المحطات؟')) { state.stops = []; invalidatePlan(); save(); render(); drawMap(false); }
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
      const order = MasarSolver.solve(D, state.roundtrip);
      const ids = order.map((i) => state.stops[i - 1].id);
      let dur = MasarSolver.routeCost(D, order, state.roundtrip);
      let dist = Dist ? MasarSolver.routeCost(Dist, order, state.roundtrip) : null;

      // road geometry for the map
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
            dur = r.routes[0].duration; dist = r.routes[0].distance;
          }
        } catch (e) {}
      }
      if (!routeLine) routeLine = L.polyline(seq.map((p) => [p.lat, p.lon]), { color: '#ffb020', weight: 3, dashArray: '6 8' });

      state.plan = { order: ids, start: { lat: start.lat, lon: start.lon, label: start.label }, dur, dist, approx, roundtrip: state.roundtrip, geom: geom && geom.map((c) => [+c[0].toFixed(5), +c[1].toFixed(5)]) };
      state.drive = { status: {}, history: [] };
      save(); render(); drawMap(true);
      $('summary').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      btn.disabled = false; btn.textContent = 'رتّب أفضل مسار';
    }
  }
  $('optimize').onclick = optimize;

  function fmtDur(s) {
    const m = Math.round(s / 60); if (m < 60) return m + ' د';
    return Math.floor(m / 60) + ' س ' + (m % 60) + ' د';
  }
  const fmtKm = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' كم';

  // ---------- drive ----------
  function driveActive() { return !!state.plan; }
  function currentStop() {
    if (!state.plan) return null;
    return orderedStops().find((s) => !state.drive.status[s.id]) || null;
  }
  function openMaps(p) {
    const url = 'https://www.google.com/maps/dir/?api=1&destination=' + p.lat.toFixed(6) + ',' + p.lon.toFixed(6) + '&travelmode=driving&dir_action=navigate';
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function mark(status) {
    const cur = currentStop(); if (!cur) return;
    state.drive.status[cur.id] = status; state.drive.history.push(cur.id);
    save(); render(); drawMap(false);
    const next = currentStop();
    if (next) { map.panTo([next.lat, next.lon]); openMaps(next); }
    else toast('🎉 خلصت الجولة!', 3500);
  }
  $('doneBtn').onclick = () => mark('done');
  $('skipBtn').onclick = () => mark('skip');
  $('undoBtn').onclick = () => {
    const id = state.drive.history.pop(); if (!id) return;
    delete state.drive.status[id]; save(); render(); drawMap(false);
  };
  $('navBtn').onclick = () => {
    const cur = currentStop();
    if (cur) openMaps(cur);
    else if (state.plan && state.plan.roundtrip) openMaps(state.plan.start);
  };

  // tabs
  function showTab(t) {
    $('tabPlan').classList.toggle('on', t === 'plan'); $('tabDrive').classList.toggle('on', t === 'drive');
    $('planView').classList.toggle('hidden', t !== 'plan'); $('driveView').classList.toggle('hidden', t !== 'drive');
    state.tab = t; save(); setTimeout(() => map.invalidateSize(), 50);
  }
  $('tabPlan').onclick = () => showTab('plan');
  $('tabDrive').onclick = () => showTab('drive');
  $('toDrive').onclick = () => { showTab('drive'); const c = currentStop(); if (c) map.setView([c.lat, c.lon], 14); };

  // ---------- render ----------
  function render() {
    $('startGps').classList.toggle('on', state.startMode === 'gps');
    $('startAddr').classList.toggle('on', state.startMode === 'addr');
    $('startAddrBox').classList.toggle('hidden', state.startMode !== 'addr');
    $('startLabel').textContent = state.startMode === 'addr' ? (state.start ? '★ ' + state.start.label + (state.start.sub ? ' · ' + state.start.sub : '') : '') : 'سيتم أخذ موقعك عند الترتيب';
    $('endBack').classList.toggle('on', state.roundtrip);
    $('endFree').classList.toggle('on', !state.roundtrip);
    $('count').textContent = state.stops.length + ' / ' + MAX_STOPS;
    $('stopInput').disabled = state.stops.length >= MAX_STOPS;

    const planned = !!state.plan;
    const list = $('stopList'); list.innerHTML = '';
    orderedStops().forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="num ' + (planned ? '' : 'plain') + '">' + (i + 1) + '</span><span class="txt"><b>' + esc(s.label) + '</b><small>' + esc(s.sub) + '</small></span><button class="del" aria-label="حذف">✕</button>';
      li.querySelector('.del').onclick = () => removeStop(s.id);
      list.appendChild(li);
    });
    if (!state.stops.length) list.innerHTML = '<li class="muted small">ما في محطات بعد. ابحث عن عنوان فوق.</li>';

    const sum = $('summary');
    if (planned) {
      sum.classList.remove('hidden');
      sum.innerHTML = '<div><b>' + state.stops.length + '</b><span class="muted small">محطة</span></div>' +
        '<div><b>' + fmtDur(state.plan.dur) + '</b><span class="muted small">وقت القيادة</span></div>' +
        (state.plan.dist != null ? '<div><b>' + fmtKm(state.plan.dist) + '</b><span class="muted small">المسافة</span></div>' : '') +
        (state.plan.approx ? '<div class="warn">خادم الطرق ما ردّ، الترتيب تقريبي حسب المسافة المباشرة. جرّب مرة ثانية بعد شوي.</div>' : '');
    } else sum.classList.add('hidden');
    $('toDrive').classList.toggle('hidden', !planned);

    // drive view
    $('driveEmpty').classList.toggle('hidden', planned);
    $('driveBox').classList.toggle('hidden', !planned);
    if (planned) {
      const ord = orderedStops();
      const handled = ord.filter((s) => state.drive.status[s.id]).length;
      $('progBar').style.width = (ord.length ? (handled / ord.length) * 100 : 0) + '%';
      $('progText').textContent = handled + ' من ' + ord.length + ' محطة';
      const cur = currentStop();
      if (cur) {
        const n = ord.indexOf(cur) + 1;
        $('curNum').textContent = n;
        $('curAddr').innerHTML = esc(cur.label) + '<div class="muted small">' + esc(cur.sub) + '</div>';
        $('navBtn').textContent = 'افتح في Google Maps';
        $('doneBtn').classList.remove('hidden'); $('skipBtn').classList.remove('hidden');
      } else {
        $('curNum').textContent = '✓';
        $('curAddr').innerHTML = 'خلصت كل المحطات';
        $('doneBtn').classList.add('hidden'); $('skipBtn').classList.add('hidden');
        $('navBtn').classList.toggle('hidden', !state.plan.roundtrip);
        $('navBtn').textContent = 'ارجع لنقطة البداية';
      }
      if (cur) $('navBtn').classList.remove('hidden');
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
  }

  // restore route line after reload
  if (state.plan) {
    const ord = orderedStops(); const st = state.plan.start;
    const seq = [st].concat(ord); if (state.plan.roundtrip) seq.push(st);
    routeLine = state.plan.geom ? L.polyline(state.plan.geom, { color: '#ffb020', weight: 5, opacity: 0.85 })
      : L.polyline(seq.map((p) => [p.lat, p.lon]), { color: '#ffb020', weight: 3, dashArray: '6 8' });
  }
  render(); drawMap(true); showTab(state.tab === 'drive' && state.plan ? 'drive' : 'plan');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
