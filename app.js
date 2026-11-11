(() => {
  'use strict';

  // ---------- Config ----------
  const POLL_MS = 5000;          // how often we send our position and fetch everyone's
  const STALE_AFTER_MS = 30000;  // fade a runner's marker if we haven't heard from them
  const LS_ME = 'kgf.me';
  const LS_RUN = 'kgf.run';
  const PALETTE = [
    ['#E53935', '#fff'], ['#1E6FEB', '#fff'], ['#1FA45B', '#fff'], ['#F7B500', '#000'],
    ['#8E44AD', '#fff'], ['#FF5FA2', '#000'], ['#00A896', '#fff'], ['#FF7A00', '#000'],
    ['#18B7E8', '#000'], ['#8BC34A', '#000'], ['#3F3FBF', '#fff'], ['#8A5A44', '#fff'],
  ];

  // ---------- State ----------
  const state = {
    me: null,                                   // { id, name } when joined, null when only watching
    run: { status: 'ready', startedAt: null, endedAt: null, distance: 0, anchor: null },
    pos: null,                                  // latest GPS fix { lat, lng, acc, t }
    runners: [],                                // last list from the server
    clockOffset: 0,                             // server time - device time
    online: true,
    needsFinalSync: false,
    autoFit: true,
    firstFitDone: false,
    geoId: null,
    wake: null,
    pollTimer: null,
    tickTimer: null,
    inFlight: false,
    hasPosted: false,
    resync: false,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    join: $('join'), app: $('app'), name: $('name'), joinBtn: $('joinBtn'), watchBtn: $('watchBtn'),
    countNum: $('countNum'), countPill: $('countPill'), alert: $('alert'),
    sTime: $('sTime'), sDist: $('sDist'), sPace: $('sPace'), stats: $('stats'),
    statusLine: $('statusLine'), runBtn: $('runBtn'),
    listToggle: $('listToggle'), list: $('list'),
    summary: $('summary'), confirm: $('confirm'),
  };

  // ---------- Helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now();
  const serverNow = () => now() + state.clockOffset;

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
  }
  function fmtPace(distM, ms) {
    if (distM < 50 || ms <= 0) return '--:--';
    const secPerKm = (ms / 1000) / (distM / 1000);
    if (!isFinite(secPerKm) || secPerKm > 3599) return '--:--';
    return Math.floor(secPerKm / 60) + ':' + String(Math.round(secPerKm % 60) % 60).padStart(2, '0');
  }
  const fmtKm = (m) => (m / 1000).toFixed(2);
  const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '-');
  const fmtAway = (m) => (m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km');

  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
    return s.toUpperCase();
  }
  const colorOf = (i) => PALETTE[(i ?? 3) % PALETTE.length];

  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode */ } }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function drop(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  const saveRun = () => save(LS_RUN, state.run);

  // ---------- Alerts ----------
  function showAlert(msg, warn) {
    el.alert.textContent = msg;
    el.alert.className = 'alert' + (warn ? ' warn' : '');
    el.alert.hidden = false;
  }
  const hideAlert = () => { el.alert.hidden = true; };

  // ---------- Map ----------
  let map = null;
  const markers = new Map(); // id -> { marker, sig }

  function initMap() {
    if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
    if (typeof L === 'undefined') { showAlert('The map could not load. Check your connection and reload.'); return; }
    map = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView([20.5937, 78.9629], 5);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.getContainer().addEventListener('touchstart', () => { state.autoFit = false; }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe($('map'));
  }

  function markerHtml(r, flags) {
    const [bg, fg] = colorOf(r.color);
    const first = r.name.trim().split(/\s+/)[0];
    return '<div class="rm ' + flags + '">' +
      '<div class="rm-badge" style="background:' + bg + '"><b style="color:' + fg + '">' + esc(initials(r.name)) + '</b></div>' +
      '<div class="rm-tag">' + esc(first) + '</div></div>';
  }

  function syncMarkers(list) {
    const seen = new Set();
    list.forEach((r) => {
      seen.add(r.id);
      const flags = [r.isMe ? 'me' : '', r.status === 'finished' ? 'finished' : '', r.stale ? 'stale' : ''].join(' ').trim();
      const sig = [r.name, r.color, flags].join('|');
      const ll = [r.lat, r.lng];
      let m = markers.get(r.id);
      if (!m) {
        const marker = L.marker(ll, {
          icon: L.divIcon({ className: 'runner-marker', html: markerHtml(r, flags), iconSize: [0, 0] }),
          zIndexOffset: r.isMe ? 1000 : 0,
          keyboard: false,
        }).addTo(map);
        marker.on('click', () => focusRunner(r.id));
        markers.set(r.id, { marker, sig });
      } else {
        m.marker.setLatLng(ll);
        if (m.sig !== sig) {
          m.marker.setIcon(L.divIcon({ className: 'runner-marker', html: markerHtml(r, flags), iconSize: [0, 0] }));
          m.sig = sig;
        }
      }
    });
    markers.forEach((m, id) => { if (!seen.has(id)) { map.removeLayer(m.marker); markers.delete(id); } });
  }

  function fitAll(force) {
    if (!map) return;
    const pts = [...markers.values()].map((m) => m.marker.getLatLng());
    if (!pts.length) return;
    if (pts.length === 1) {
      if (force || !state.firstFitDone) map.setView(pts[0], 16, { animate: true });
      state.firstFitDone = true;
      return;
    }
    const b = L.latLngBounds(pts);
    if (force || !state.firstFitDone || !map.getBounds().pad(-0.1).contains(b)) {
      map.fitBounds(b, { padding: [50, 50], maxZoom: 17, animate: true, duration: 0.8 });
    }
    state.firstFitDone = true;
  }

  function focusRunner(id) {
    const m = markers.get(id);
    if (!m) return;
    state.autoFit = false;
    map.flyTo(m.marker.getLatLng(), Math.max(map.getZoom(), 16), { duration: 0.8 });
  }

  // ---------- Runner list / rendering ----------
  function currentList() {
    const t = serverNow();
    const out = [];
    const me = state.me;
    const serverMe = me ? state.runners.find((r) => r.id === me.id) : null;

    state.runners.forEach((r) => {
      if (me && r.id === me.id) return; // we draw ourselves from local data below
      const stale = r.status !== 'finished' && t - r.updatedAt > STALE_AFTER_MS;
      out.push({ ...r, isMe: false, stale, age: t - r.updatedAt });
    });

    if (me) {
      const color = serverMe ? serverMe.color : 3;
      if (state.pos) {
        out.push({
          id: me.id, name: me.name, color, lat: state.pos.lat, lng: state.pos.lng,
          status: state.run.status, distance: state.run.distance,
          startedAt: state.run.startedAt, endedAt: state.run.endedAt, isMe: true, stale: false, age: 0,
        });
      } else if (serverMe) {
        out.push({ ...serverMe, isMe: true, stale: false, age: 0 });
      }
    }
    return out;
  }

  function statusText(r) {
    if (r.stale) return 'No signal for ' + fmtDur(r.age);
    if (r.status === 'running') return 'Running since ' + fmtClock(r.startedAt);
    if (r.status === 'finished') return 'Finished in ' + fmtDur((r.endedAt || 0) - (r.startedAt || 0));
    return 'Ready, not started yet';
  }

  function renderList(list) {
    el.countNum.textContent = list.length;
    if (!list.length) {
      el.list.innerHTML = '<li class="empty">Nobody has joined yet. Share the link with the group.</li>';
      return;
    }
    const sorted = [...list].sort((a, b) => (b.isMe - a.isMe) || (b.distance - a.distance) || a.name.localeCompare(b.name));
    el.list.innerHTML = sorted.map((r) => {
      const [bg, fg] = colorOf(r.color);
      const away = !r.isMe && state.pos ? fmtAway(haversine(state.pos, r)) + ' from you' : '';
      const dist = r.status === 'ready'
        ? '<div class="row-dist">&ndash;</div>'
        : '<div class="row-dist">' + fmtKm(r.distance) + '<small>km</small></div>';
      return '<li class="row" data-id="' + esc(r.id) + '">' +
        '<div class="row-badge" style="background:' + bg + '"><b style="color:' + fg + '">' + esc(initials(r.name)) + '</b></div>' +
        '<div class="row-main"><div class="row-name">' + esc(r.name) + (r.isMe ? '<em>You</em>' : '') + '</div>' +
        '<div class="row-sub">' + esc(statusText(r)) + '</div></div>' +
        '<div class="row-right">' + dist + '<div class="row-away">' + esc(away) + '</div></div></li>';
    }).join('');
  }

  function render() {
    if (!map) return;
    const list = currentList();
    syncMarkers(list);
    renderList(list);
    if (state.autoFit) fitAll(false);
  }

  function renderStats() {
    const r = state.run;
    if (!state.me) return;
    const end = r.status === 'finished' ? r.endedAt : now();
    const ms = r.startedAt ? end - r.startedAt : 0;
    el.sTime.textContent = r.startedAt ? fmtDur(ms) : '0:00';
    el.sDist.textContent = fmtKm(r.distance);
    el.sPace.textContent = r.status === 'ready' ? '--:--' : fmtPace(r.distance, ms);
  }

  function renderControls() {
    const joined = !!state.me;
    el.stats.hidden = !joined;
    el.statusLine.hidden = !joined;
    el.runBtn.classList.remove('stop');
    const label = el.runBtn.querySelector('span');
    if (!joined) { label.textContent = 'Join the run'; return; }
    const s = state.run.status;
    if (s === 'ready') label.textContent = 'Start run';
    if (s === 'running') { label.textContent = 'Finish run'; el.runBtn.classList.add('stop'); }
    if (s === 'finished') label.textContent = 'Start new run';
    renderStatusLine();
  }

  function renderStatusLine() {
    if (!state.me) return;
    const s = state.run.status;
    let text, cls = '';
    if (!state.online) { text = 'No connection. Retrying…'; cls = 'bad'; }
    else if (s === 'finished') { text = 'Finished. Location sharing is off.'; }
    else if (!state.pos) { text = 'Getting your location…'; }
    else if (s === 'running') { text = 'Live. Everyone can see you (GPS ±' + Math.round(state.pos.acc) + ' m)'; cls = 'good'; }
    else { text = 'Sharing your location. Tap Start run when you set off.'; cls = 'good'; }
    el.statusLine.textContent = text;
    el.statusLine.className = 'status-line ' + cls;
    el.countPill.classList.toggle('offline', !state.online);
  }

  // ---------- Geolocation ----------
  function startGeo() {
    if (state.geoId !== null || !('geolocation' in navigator)) {
      if (!('geolocation' in navigator)) showAlert('This browser cannot share location.');
      return;
    }
    state.geoId = navigator.geolocation.watchPosition(onFix, onGeoError, {
      enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
    });
  }
  function stopGeo() {
    if (state.geoId !== null) navigator.geolocation.clearWatch(state.geoId);
    state.geoId = null;
  }

  function onFix(p) {
    const c = p.coords;
    state.pos = { lat: c.latitude, lng: c.longitude, acc: c.accuracy || 0, t: p.timestamp || now() };
    hideAlert();
    if (state.run.status === 'running') accumulate();
    render();
    renderStatusLine();
    renderStats();
    if (state.me && !state.hasPosted) sync(); // first fix: show up on the map straight away
  }

  function onGeoError(err) {
    if (err.code === 1) {
      showAlert('Location is blocked. Allow location for this site in your browser settings, then reload.');
    } else {
      showAlert('No GPS signal yet. Move to open sky and keep the screen on.', true);
    }
  }

  // Add distance only for good fixes, ignoring GPS jitter and teleport jumps.
  function accumulate() {
    const { lat, lng, acc, t } = state.pos;
    if (acc > 35) return;
    const run = state.run;
    if (!run.anchor) { run.anchor = { lat, lng, t }; saveRun(); return; }
    const d = haversine(run.anchor, { lat, lng });
    const minStep = Math.max(3, Math.min(acc, 20) * 0.5);
    if (d < minStep) return; // anchor stays put so slow movement still adds up
    const dt = (t - run.anchor.t) / 1000;
    if (dt > 0 && d / dt > 12) { run.anchor = { lat, lng, t }; saveRun(); return; } // > 43 km/h = GPS jump
    run.distance += d;
    run.anchor = { lat, lng, t };
    saveRun();
  }

  // ---------- Wake lock (keeps the screen on so GPS keeps flowing) ----------
  async function lockScreen() {
    try {
      if ('wakeLock' in navigator && !state.wake) {
        state.wake = await navigator.wakeLock.request('screen');
        state.wake.addEventListener('release', () => { state.wake = null; });
      }
    } catch (e) { /* not allowed, ignore */ }
  }
  function unlockScreen() { if (state.wake) { state.wake.release().catch(() => {}); state.wake = null; } }

  // ---------- Network ----------
  async function sync() {
    if (state.inFlight) { state.resync = true; return; }
    state.inFlight = true;
    try {
      let res;
      const run = state.run;
      const shouldPost = state.me && state.pos && (run.status !== 'finished' || state.needsFinalSync);
      if (shouldPost) {
        res = await fetch('/api/runners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: state.me.id, name: state.me.name,
            lat: state.pos.lat, lng: state.pos.lng, acc: state.pos.acc,
            status: run.status, distance: Math.round(run.distance),
            startedAt: run.startedAt, endedAt: run.endedAt,
          }),
        });
        if (res.ok) state.hasPosted = true;
        if (res.ok && run.status === 'finished') state.needsFinalSync = false;
      } else {
        res = await fetch('/api/runners', { cache: 'no-store' });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.clockOffset = data.now - now();
      state.runners = data.runners || [];
      state.online = true;
    } catch (e) {
      state.online = false;
    } finally {
      state.inFlight = false;
    }
    render();
    renderStatusLine();
    if (state.resync) { state.resync = false; sync(); }
  }

  function startLoops() {
    stopLoops();
    sync();
    state.pollTimer = setInterval(sync, POLL_MS);
    state.tickTimer = setInterval(() => { renderStats(); }, 1000);
  }
  function stopLoops() {
    clearInterval(state.pollTimer); clearInterval(state.tickTimer);
    state.pollTimer = state.tickTimer = null;
  }

  // ---------- Run controls ----------
  function startRun() {
    state.run = { status: 'running', startedAt: now(), endedAt: null, distance: 0, anchor: null };
    if (state.pos && state.pos.acc <= 35) state.run.anchor = { lat: state.pos.lat, lng: state.pos.lng, t: state.pos.t };
    saveRun();
    lockScreen();
    renderControls(); renderStats(); render(); sync();
  }

  function finishRun() {
    const r = state.run;
    r.status = 'finished'; r.endedAt = now(); r.anchor = null;
    saveRun();
    state.needsFinalSync = true;
    stopGeo(); unlockScreen();
    renderControls(); renderStats(); render();
    sync().then(() => { if (state.needsFinalSync) setTimeout(sync, 2000); });
    showSummary();
  }

  function newRun() {
    state.run = { status: 'ready', startedAt: null, endedAt: null, distance: 0, anchor: null };
    saveRun();
    state.pos = null; state.hasPosted = false;
    startGeo(); lockScreen();
    renderControls(); renderStats(); render();
  }

  function showSummary() {
    const r = state.run, ms = r.endedAt - r.startedAt;
    $('sumDist').textContent = fmtKm(r.distance);
    $('sumStart').textContent = fmtClock(r.startedAt);
    $('sumEnd').textContent = fmtClock(r.endedAt);
    $('sumTime').textContent = fmtDur(ms);
    $('sumPace').textContent = fmtPace(r.distance, ms) + ' /km';
    el.summary.hidden = false;
  }

  // ---------- Screens ----------
  function enterApp() {
    el.join.hidden = true;
    el.app.hidden = false;
    initMap();
    renderControls(); renderStats();
    if (state.me) {
      if (state.run.status !== 'finished') { startGeo(); lockScreen(); }
    }
    startLoops();
    render();
  }

  function joinRun() {
    const name = el.name.value.trim().replace(/\s+/g, ' ').slice(0, 24);
    const field = el.name.closest('.field');
    if (!name) { field.classList.add('invalid'); el.name.focus(); return; }
    field.classList.remove('invalid');
    state.me = { id: uuid(), name };
    state.run = { status: 'ready', startedAt: null, endedAt: null, distance: 0, anchor: null };
    save(LS_ME, state.me); saveRun();
    enterApp();
  }

  function watchOnly() {
    state.me = null;
    enterApp();
  }

  function leave() {
    if (state.me) {
      fetch('/api/runners?id=' + encodeURIComponent(state.me.id), { method: 'DELETE', keepalive: true }).catch(() => {});
    }
    stopGeo(); stopLoops(); unlockScreen();
    drop(LS_ME); drop(LS_RUN);
    state.me = null; state.pos = null; state.runners = []; state.hasPosted = false;
    state.run = { status: 'ready', startedAt: null, endedAt: null, distance: 0, anchor: null };
    state.autoFit = true; state.firstFitDone = false;
    markers.forEach((m) => map && map.removeLayer(m.marker)); markers.clear();
    hideAlert();
    el.app.hidden = true; el.join.hidden = false;
  }

  // ---------- Events ----------
  el.joinBtn.addEventListener('click', joinRun);
  el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRun(); });
  el.name.addEventListener('input', () => el.name.closest('.field').classList.remove('invalid'));
  el.watchBtn.addEventListener('click', watchOnly);

  el.runBtn.addEventListener('click', () => {
    if (!state.me) { stopLoops(); el.app.hidden = true; el.join.hidden = false; return; }
    const s = state.run.status;
    if (s === 'ready') startRun();
    else if (s === 'running') finishRun();
    else newRun();
  });

  $('sumClose').addEventListener('click', () => { el.summary.hidden = true; });

  $('leaveBtn').addEventListener('click', () => {
    if (!state.me) { leave(); return; }
    $('confirmText').textContent = state.run.status === 'running'
      ? 'Your run is still in progress. Leaving removes you from everyone\'s map and clears your stats.'
      : 'Your marker will disappear from everyone\'s map.';
    el.confirm.hidden = false;
  });
  $('confirmNo').addEventListener('click', () => { el.confirm.hidden = true; });
  $('confirmYes').addEventListener('click', () => { el.confirm.hidden = true; leave(); });

  $('fitBtn').addEventListener('click', () => { state.autoFit = true; fitAll(true); });
  $('meBtn').addEventListener('click', () => {
    if (state.pos && map) { state.autoFit = false; map.flyTo([state.pos.lat, state.pos.lng], Math.max(map.getZoom(), 16), { duration: 0.8 }); }
    else showAlert('Still waiting for your location.', true);
  });

  el.listToggle.addEventListener('click', () => {
    const open = el.list.classList.toggle('open');
    el.listToggle.setAttribute('aria-expanded', String(open));
  });
  el.list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) focusRunner(row.dataset.id);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !el.app.hidden) {
      if (state.me && state.run.status !== 'finished') lockScreen();
      sync();
    }
  });
  window.addEventListener('online', () => { if (!el.app.hidden) sync(); });

  // ---------- Boot ----------
  function boot() {
    const saved = load(LS_ME);
    if (saved && saved.id && saved.name) {
      state.me = saved;
      el.name.value = saved.name;
      const run = load(LS_RUN);
      const fresh = run && run.startedAt && now() - run.startedAt < 12 * 3600 * 1000;
      if (run && (run.status === 'ready' || fresh)) state.run = Object.assign(state.run, run);
      else state.run = { status: 'ready', startedAt: null, endedAt: null, distance: 0, anchor: null };
      if (state.run.status === 'finished') state.needsFinalSync = false;
      enterApp();
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }
  boot();
})();
