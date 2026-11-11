(() => {
  'use strict';

  // ---------- Config ----------
  const POLL_MS = 5000;               // send my position / fetch everyone's
  const STALE_AFTER_MS = 30000;       // fade a runner's marker after this long without an update
  const LIVE_MS = 5 * 60 * 1000;      // matches the server: ready/running runners leave the live map after 5 min
  const FINISHED_MS = 3 * 60 * 60 * 1000;
  const TRAIL_MS = 15000;             // refresh other runners' trails on the live map
  const TRACKS_VIEW_MS = 10000;       // refresh the "all tracks" screen
  const PT_MIN_M = 12;                // record a track point every ~12 m
  const MAX_PTS_PER_POST = 300;
  const LS_ME = 'kgf.me';
  const LS_RUN = 'kgf.run';
  const LS_NAME = 'kgf.name';
  const PALETTE = [
    ['#E53935', '#fff'], ['#1E6FEB', '#fff'], ['#1FA45B', '#fff'], ['#F7B500', '#000'],
    ['#8E44AD', '#fff'], ['#FF5FA2', '#000'], ['#00A896', '#fff'], ['#FF7A00', '#000'],
    ['#18B7E8', '#000'], ['#8BC34A', '#000'], ['#3F3FBF', '#fff'], ['#8A5A44', '#fff'],
  ];

  // A run is: status, when it started/ended, distance (m), and a track of points
  // [latE5, lngE5, secondsSinceStart, metresSoFar] saved on the phone and sent to the database in small batches.
  const freshRun = () => ({
    status: 'ready', startedAt: null, endedAt: null, distance: 0, anchor: null,
    runId: null, track: [], sent: 0, reachedMs: null, finalPending: false, lastPos: null,
  });

  // ---------- State ----------
  const state = {
    me: null,
    run: freshRun(),
    pos: null,
    runners: [],              // today's records from the server
    day: null,
    targetM: 10000,           // distance the "Time" leaderboard measures (set by the admin)
    clockOffset: 0,
    online: true,
    autoFit: true,
    firstFitDone: false,
    geoId: null,
    wake: null,
    pollTimer: null,
    tickTimer: null,
    trailTimer: null,
    inFlight: false,
    hasPosted: false,
    resync: false,
    showTrails: false,
    boardOpen: false,
    boardSort: 'distance',
    boardDay: 'today',
    boardDays: [],
    pastRunners: null,
    pastTargetM: 10000,
    tracksOpen: false,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    join: $('join'), app: $('app'), name: $('name'), joinBtn: $('joinBtn'), watchBtn: $('watchBtn'),
    countNum: $('countNum'), countPill: $('countPill'), alert: $('alert'),
    sTime: $('sTime'), sDist: $('sDist'), sPace: $('sPace'), stats: $('stats'),
    statusLine: $('statusLine'), runBtn: $('runBtn'), stopBtn: $('stopBtn'),
    listToggle: $('listToggle'), list: $('list'),
    summary: $('summary'), confirm: $('confirm'),
    board: $('board'), boardDay: $('boardDay'), boardTabs: $('boardTabs'), boardNote: $('boardNote'), boardList: $('boardList'),
    tracksView: $('tracksView'), tlegend: $('tlegend'), tmsg: $('tmsg'),
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
  function fmtSecPace(secPerKm) {
    if (!isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3599) return '--:--';
    const s = Math.round(secPerKm);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function fmtPace(distM, ms) {
    if (distM < 50 || ms <= 0) return '--:--';
    return fmtSecPace((ms / 1000) / (distM / 1000));
  }
  const fmtKm = (m) => (m / 1000).toFixed(2);
  const fmtTargetKm = (m) => (Math.round(m / 100) / 10).toString().replace(/\.0$/, '');
  const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '-');
  // "6:05–6:52 AM" (drops the first AM/PM when both are the same)
  function fmtRange(a, b) {
    const f = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const x = f(a), y = f(b), mer = /\s?[AP]M$/i;
    const mx = x.match(mer), my = y.match(mer);
    if (mx && my && mx[0].trim().toUpperCase() === my[0].trim().toUpperCase()) return x.replace(mer, '') + '–' + y;
    return x + ' – ' + y;
  }
  const fmtAway = (m) => (m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1) + ' km');
  const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
    return s.toUpperCase();
  }
  const colorOf = (i) => PALETTE[(i ?? 3) % PALETTE.length];
  const dec = (p) => [p[0] / 1e5, p[1] / 1e5];

  // localStorage (the run is saved at most every 2 s, and immediately on start/finish)
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode / full */ } }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function drop(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }
  let saveTimer = null;
  function saveRun() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; save(LS_RUN, state.run); }, 2000);
  }
  function saveRunNow() { clearTimeout(saveTimer); saveTimer = null; save(LS_RUN, state.run); }

  // Is this server record something to draw on the live map?
  function onMap(r, t) {
    if (r.hidden || r.status === 'stopped') return false;
    const age = t - r.updatedAt;
    return r.status === 'finished' ? age < FINISHED_MS : age < LIVE_MS;
  }

  // ---------- Alerts ----------
  function showAlert(msg, warn) {
    el.alert.textContent = msg;
    el.alert.className = 'alert' + (warn ? ' warn' : '');
    el.alert.hidden = false;
  }
  const hideAlert = () => { el.alert.hidden = true; };

  // ---------- Map (live) ----------
  let map = null;
  const markers = new Map();
  let myCasing = null, myLine = null, trailGroup = null, lastMyColor = null;

  function addTiles(m) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
  }

  function initMap() {
    if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
    if (typeof L === 'undefined') { showAlert('The map could not load. Check your connection and reload.'); return; }
    map = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView([20.5937, 78.9629], 5);
    addTiles(map);
    trailGroup = L.layerGroup().addTo(map);
    const lineOpts = { lineCap: 'round', lineJoin: 'round', interactive: false };
    myCasing = L.polyline([], Object.assign({ color: '#111', weight: 10, opacity: 0.55 }, lineOpts)).addTo(map);
    myLine = L.polyline([], Object.assign({ color: colorOf(3)[0], weight: 6, opacity: 1 }, lineOpts)).addTo(map);
    redrawMyLine();
    map.getContainer().addEventListener('touchstart', () => { state.autoFit = false; }, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe($('map'));
  }

  // my own trail: drawn from the points saved on this phone
  function redrawMyLine() {
    if (!myLine) return;
    const ll = state.run.track.map(dec);
    myLine.setLatLngs(ll); myCasing.setLatLngs(ll);
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
      const m = markers.get(r.id);
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

  // ---------- Live runner list ----------
  function myServerRecord() {
    return state.me ? state.runners.find((r) => r.id === state.me.id) : null;
  }

  function currentList() {
    const t = serverNow();
    const out = [];
    const me = state.me;
    const serverMe = myServerRecord();

    state.runners.forEach((r) => {
      if (me && r.id === me.id) return; // I'm drawn from local data below
      if (!onMap(r, t)) return;
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
      } else if (serverMe && !serverMe.hidden) {
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
    if (state.boardOpen) renderBoard();
    if (!map) return;
    const list = currentList();
    syncMarkers(list);
    renderList(list);
    const sm = myServerRecord();
    const mc = colorOf(sm ? sm.color : 3)[0];
    if (myLine && mc !== lastMyColor) { myLine.setStyle({ color: mc }); lastMyColor = mc; }
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
    el.stopBtn.hidden = !joined;
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

  // Record a point on my track (at most one every PT_MIN_M metres) and extend the line on the map.
  function addTrackPoint(lat, lng, t, force) {
    const run = state.run;
    if (!run.startedAt) return;
    const last = run.track[run.track.length - 1];
    const e5 = [Math.round(lat * 1e5), Math.round(lng * 1e5)];
    if (last) {
      if (force && last[0] === e5[0] && last[1] === e5[1]) return;
      if (!force && haversine({ lat: last[0] / 1e5, lng: last[1] / 1e5 }, { lat, lng }) < PT_MIN_M) return;
    }
    run.track.push([e5[0], e5[1], Math.max(0, Math.round((t - run.startedAt) / 1000)), Math.round(run.distance)]);
    if (myLine) { myLine.addLatLng([lat, lng]); myCasing.addLatLng([lat, lng]); }
  }

  // Add distance only for good fixes, ignoring GPS jitter and teleport jumps.
  function accumulate() {
    const { lat, lng, acc, t } = state.pos;
    if (acc > 35) return;
    const run = state.run;
    if (!run.anchor) { run.anchor = { lat, lng, t }; addTrackPoint(lat, lng, t, true); saveRun(); return; }
    const d = haversine(run.anchor, { lat, lng });
    const minStep = Math.max(3, Math.min(acc, 20) * 0.5);
    if (d < minStep) return; // anchor stays put so slow movement still adds up
    const dt = (t - run.anchor.t) / 1000;
    if (dt > 0 && d / dt > 12) { run.anchor = { lat, lng, t }; saveRun(); return; } // > 43 km/h = GPS jump
    const prevD = run.distance, prevT = run.anchor.t;
    run.distance += d;
    run.anchor = { lat, lng, t };
    // the moment I crossed the target distance (for the "Time" leaderboard), interpolated between two fixes
    if (run.reachedMs == null && state.targetM > 0 && run.distance >= state.targetM) {
      const frac = (state.targetM - prevD) / d;
      run.reachedMs = Math.max(0, Math.round(prevT + frac * (t - prevT) - run.startedAt));
    }
    addTrackPoint(lat, lng, t, false);
    saveRun();
  }

  // ---------- Wake lock ----------
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
      const postPos = state.pos || run.lastPos;
      const shouldPost = state.me && postPos && (run.status !== 'finished' || run.finalPending);
      if (shouldPost) {
        res = await fetch('/api/runners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: state.me.id, name: state.me.name,
            lat: postPos.lat, lng: postPos.lng, acc: postPos.acc,
            status: run.status, distance: Math.round(run.distance),
            startedAt: run.startedAt, endedAt: run.endedAt, reachedMs: run.reachedMs,
            runId: run.runId, from: run.sent, pts: run.track.slice(run.sent, run.sent + MAX_PTS_PER_POST),
          }),
        });
      } else {
        res = await fetch('/api/runners', { cache: 'no-store' });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (shouldPost) {
        state.hasPosted = true;
        if (typeof data.myN === 'number') run.sent = Math.min(data.myN, run.track.length);
        if (run.status === 'finished' && run.sent >= run.track.length) { run.finalPending = false; saveRunNow(); }
      }
      state.clockOffset = data.now - now();
      state.runners = data.runners || [];
      if (data.day) state.day = data.day;
      if (data.targetKm > 0) state.targetM = data.targetKm * 1000;
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

  // ---------- Tracks of other runners (loaded on demand, then only the new points) ----------
  const trackCache = new Map(); // runId -> points
  let trackChain = Promise.resolve();

  const isMyRun = (r) => !!(state.me && r.id === state.me.id && r.runId && r.runId === state.run.runId);
  const trackOf = (r) => (isMyRun(r) ? state.run.track : (trackCache.get(r.runId) || []));

  async function doEnsureTracks(rows) {
    const want = [];
    rows.forEach((r) => {
      if (!r.runId || isMyRun(r)) return;
      const have = (trackCache.get(r.runId) || []).length;
      if (r.n == null || have < r.n) want.push(r.runId + ':' + have);
    });
    for (let i = 0; i < want.length; i += 25) {
      try {
        const res = await fetch('/api/tracks?runs=' + encodeURIComponent(want.slice(i, i + 25).join(',')), { cache: 'no-store' });
        if (!res.ok) continue;
        const d = await res.json();
        Object.keys(d.tracks || {}).forEach((id) => {
          const add = d.tracks[id];
          if (add.length) trackCache.set(id, (trackCache.get(id) || []).concat(add));
        });
      } catch (e) { /* try again next refresh */ }
    }
  }
  function ensureTracks(rows) {
    const p = trackChain.then(() => doEnsureTracks(rows));
    trackChain = p.catch(() => {});
    return p;
  }

  const lineStyle = (color, w) => [
    { color: '#111', weight: w + 4, opacity: 0.55, lineCap: 'round', lineJoin: 'round', interactive: false },
    { color, weight: w, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false },
  ];

  // Everyone's trails on the live map (toggle button)
  function setTrails(on) {
    state.showTrails = on;
    const b = $('trailBtn');
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('on', on);
    clearInterval(state.trailTimer);
    state.trailTimer = null;
    if (on) { refreshTrails(); state.trailTimer = setInterval(refreshTrails, TRAIL_MS); }
    else if (trailGroup) trailGroup.clearLayers();
  }

  async function refreshTrails() {
    if (!state.showTrails || !map || el.app.hidden) return;
    const t = serverNow();
    const recs = state.runners.filter((r) => r.runId && !(state.me && r.id === state.me.id) && onMap(r, t));
    const rows = computeRows(recs, t, true);
    await ensureTracks(rows);
    if (!state.showTrails) return;
    trailGroup.clearLayers();
    rows.forEach((r) => {
      const ll = trackOf(r).map(dec);
      if (ll.length < 2) return;
      const [a, b] = lineStyle(colorOf(r.color)[0], 4);
      L.polyline(ll, a).addTo(trailGroup);
      L.polyline(ll, b).addTo(trailGroup);
    });
  }

  // ---------- Run controls ----------
  function startRun() {
    state.run = Object.assign(freshRun(), { status: 'running', startedAt: now(), runId: uuid() });
    redrawMyLine();
    if (state.pos && state.pos.acc <= 35) {
      state.run.anchor = { lat: state.pos.lat, lng: state.pos.lng, t: state.pos.t };
      addTrackPoint(state.pos.lat, state.pos.lng, state.pos.t, true);
    }
    saveRunNow();
    lockScreen();
    renderControls(); renderStats(); render(); sync();
  }

  function finishRun() {
    const r = state.run;
    r.status = 'finished'; r.endedAt = now(); r.anchor = null;
    if (state.pos) {
      r.lastPos = { lat: state.pos.lat, lng: state.pos.lng, acc: state.pos.acc };
      addTrackPoint(state.pos.lat, state.pos.lng, state.pos.t, true); // make sure the line reaches the finish
    }
    r.finalPending = true;
    saveRunNow();
    stopGeo(); unlockScreen();
    renderControls(); renderStats(); render();
    sync();
    showSummary();
  }

  function newRun() {
    state.run = freshRun();
    redrawMyLine();
    saveRunNow();
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

  // ---------- Leaderboard ----------
  // One row per started run. `status` becomes "stopped" for a run that went silent or was abandoned.
  function computeRows(records, tNow, isToday) {
    return records.filter((r) => r.startedAt && r.status !== 'ready').map((r) => {
      let status = r.status;
      const quiet = tNow - r.updatedAt;
      if (status === 'running' && (!isToday || quiet > LIVE_MS)) status = 'stopped';
      const end = status === 'finished' || status === 'stopped' ? (r.endedAt || r.updatedAt) : tNow;
      const elapsed = Math.max(0, end - r.startedAt);
      const dist = r.distance || 0;
      const paceSec = dist >= 200 ? (elapsed / 1000) / (dist / 1000) : null;
      return Object.assign({}, r, {
        status, elapsed, dist, paceSec,
        noSignal: status === 'running' && quiet > STALE_AFTER_MS,
        isMe: !!(state.me && r.id === state.me.id),
      });
    });
  }

  function rankRows(rows, mode) {
    const byDist = (a, b) => (b.dist - a.dist) || (a.elapsed - b.elapsed);
    let ranked, rest = [];
    if (mode === 'speed') {
      ranked = rows.filter((r) => r.paceSec != null).sort((a, b) => a.paceSec - b.paceSec);
      rest = rows.filter((r) => r.paceSec == null).sort(byDist);
    } else if (mode === 'time') {
      ranked = rows.filter((r) => r.reachedMs != null).sort((a, b) => a.reachedMs - b.reachedMs);
      rest = rows.filter((r) => r.reachedMs == null).sort(byDist);
    } else {
      ranked = [...rows].sort(byDist);
    }
    return ranked.map((row, i) => ({ row, rank: i + 1 })).concat(rest.map((row) => ({ row, rank: null })));
  }

  // Finishing places: finishers ordered by time to the target distance (then by distance)
  function finisherPlaces(rows) {
    const m = new Map();
    rankRows(rows, 'time').filter((x) => x.row.status === 'finished').forEach((x, i) => m.set(x.row.id, i + 1));
    return m;
  }

  // my own record, built from live data on this phone so my row is never a few seconds behind
  function myRecord() {
    const me = state.me, run = state.run;
    if (!me || !run.startedAt) return null;
    const sm = myServerRecord();
    return Object.assign({}, sm || {}, {
      id: me.id, name: me.name, color: sm ? sm.color : 3,
      status: run.status, distance: run.distance, startedAt: run.startedAt, endedAt: run.endedAt,
      reachedMs: run.reachedMs, runId: run.runId, n: run.track.length, updatedAt: serverNow(), hidden: false,
    });
  }

  function boardData() {
    if (state.boardDay === 'today') {
      const others = state.runners.filter((r) => !(state.me && r.id === state.me.id));
      const mine = myRecord();
      const recs = mine ? others.concat(mine) : others;
      return { rows: computeRows(recs, serverNow(), true), targetM: state.targetM, isToday: true };
    }
    return { rows: computeRows(state.pastRunners || [], now(), false), targetM: state.pastTargetM, isToday: false };
  }

  function boardRowHtml(x, mode, targetM) {
    const r = x.row;
    const [bg, fg] = colorOf(r.color);
    const distTxt = fmtKm(r.dist) + ' km';
    const timeTxt = fmtDur(r.elapsed);
    const paceTxt = r.paceSec != null ? fmtSecPace(r.paceSec) + ' /km' : '--';
    const kmh = r.paceSec != null ? (3600 / r.paceSec).toFixed(1) + ' km/h' : '';
    let main, sub;
    if (mode === 'speed') {
      main = r.paceSec != null ? fmtSecPace(r.paceSec) + '<small>/km</small>' : '&ndash;';
      sub = [distTxt, timeTxt, kmh].filter(Boolean).join(' · ');
    } else if (mode === 'time') {
      if (r.reachedMs != null) { main = fmtDur(r.reachedMs); sub = distTxt + ' · ' + paceTxt; }
      else {
        main = fmtKm(r.dist) + '<small>km</small>';
        sub = r.status === 'running' ? fmtKm(Math.max(0, targetM - r.dist)) + ' km to go' : 'Did not reach ' + fmtTargetKm(targetM) + ' km';
      }
    } else {
      main = fmtKm(r.dist) + '<small>km</small>';
      sub = timeTxt + ' · ' + paceTxt;
    }
    const st = r.status === 'finished' ? 'Finished' : r.status === 'stopped' ? 'Stopped' : r.noSignal ? 'No signal' : 'Running';
    const started = r.status === 'finished' && r.endedAt ? fmtRange(r.startedAt, r.endedAt) : 'started ' + fmtClock(r.startedAt);
    return '<li class="brow' + (r.isMe ? ' me' : '') + (x.rank === 1 ? ' first' : '') + '">' +
      '<div class="brank' + (x.rank ? '' : ' none') + '">' + (x.rank || '&ndash;') + '</div>' +
      '<div class="row-badge" style="background:' + bg + '"><b style="color:' + fg + '">' + esc(initials(r.name)) + '</b></div>' +
      '<div class="row-main"><div class="row-name">' + esc(r.name) + (r.isMe ? '<em>You</em>' : '') + '</div>' +
      '<div class="row-sub">' + st + ' · ' + esc(started) + '</div></div>' +
      '<div class="bmain"><div class="bval">' + main + '</div><div class="bsub">' + esc(sub) + '</div></div></li>';
  }

  function renderBoard() {
    if (!state.boardOpen) return;
    const { rows, targetM, isToday } = boardData();
    const mode = state.boardSort;
    el.boardTabs.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.sort === mode)));
    el.boardNote.textContent =
      mode === 'time' ? 'Fastest to cover ' + fmtTargetKm(targetM) + ' km'
        : mode === 'speed' ? 'Best average pace (needs 200 m or more)' : 'Most distance covered';
    if (!isToday && state.pastRunners === null) { el.boardList.innerHTML = '<li class="empty-board">Loading…</li>'; return; }
    if (!rows.length) {
      el.boardList.innerHTML = '<li class="empty-board">' + (isToday ? 'No runs yet. Results appear here as soon as someone taps Start run.' : 'No runs were saved for this day.') + '</li>';
      return;
    }
    el.boardList.innerHTML = rankRows(rows, mode).map((x) => boardRowHtml(x, mode, targetM)).join('');
  }

  function populateDays() {
    el.boardDay.innerHTML = '<option value="today">Today</option>' +
      state.boardDays.map((d) => '<option value="' + d + '">' + esc(fmtDay(d)) + '</option>').join('');
    el.boardDay.value = state.boardDay;
  }

  async function loadDays() {
    try {
      const r = await fetch('/api/day', { cache: 'no-store' });
      const d = await r.json();
      state.boardDays = (d.days || []).filter((x) => x !== state.day);
    } catch (e) { /* keep what we have */ }
    populateDays();
  }

  async function loadPastDay(date) {
    state.pastRunners = null;
    renderBoard();
    try {
      const r = await fetch('/api/day?date=' + encodeURIComponent(date), { cache: 'no-store' });
      const d = await r.json();
      state.pastRunners = d.runners || [];
      state.pastTargetM = (d.targetKm > 0 ? d.targetKm : 10) * 1000;
    } catch (e) { state.pastRunners = []; }
    renderBoard();
  }

  function openBoard() {
    state.boardOpen = true; state.boardDay = 'today';
    populateDays();
    el.board.hidden = false;
    renderBoard();
    loadDays();
  }
  function closeBoard() { state.boardOpen = false; el.board.hidden = true; closeTracks(); }

  // ---------- All tracks screen ----------
  let tmap = null, tlayer = null, tTimer = null;

  async function openTracks() {
    if (typeof L === 'undefined') return;
    el.tracksView.hidden = false; state.tracksOpen = true;
    if (!tmap) {
      tmap = L.map('tmap', { zoomControl: false, attributionControl: true }).setView([20.5937, 78.9629], 5);
      addTiles(tmap);
      tlayer = L.layerGroup().addTo(tmap);
    }
    setTimeout(() => tmap.invalidateSize(), 60);
    await refreshTracks(true);
    clearInterval(tTimer);
    if (state.boardDay === 'today') tTimer = setInterval(() => refreshTracks(false), TRACKS_VIEW_MS);
  }
  function closeTracks() {
    clearInterval(tTimer); tTimer = null;
    el.tracksView.hidden = true; state.tracksOpen = false;
  }

  async function refreshTracks(fit) {
    if (!state.tracksOpen) return;
    const { rows, isToday } = boardData();
    el.tmsg.hidden = true;
    if (!rows.length) {
      tlayer.clearLayers(); el.tlegend.innerHTML = '';
      el.tmsg.textContent = 'No runs to show yet.'; el.tmsg.hidden = false;
      return;
    }
    await ensureTracks(rows);
    if (state.tracksOpen) drawTracks(rows, fit, isToday);
  }

  function drawTracks(rows, fit) {
    tlayer.clearLayers();
    const places = finisherPlaces(rows);
    const all = [];
    const legend = [];
    rankRows(rows, 'time').forEach((x) => {
      const r = x.row;
      const [bg, fg] = colorOf(r.color);
      const ll = trackOf(r).map(dec);
      if (ll.length >= 2) {
        const [a, b] = lineStyle(bg, 5);
        L.polyline(ll, a).addTo(tlayer);
        L.polyline(ll, b).addTo(tlayer);
      }
      if (ll.length) {
        L.marker(ll[0], {
          icon: L.divIcon({ className: 'tmk', html: '<div class="tm"><span class="tm-dot" style="background:' + bg + '"></span></div>', iconSize: [0, 0] }),
          interactive: false, keyboard: false,
        }).addTo(tlayer);
      }
      const end = ll.length ? ll[ll.length - 1] : [r.lat, r.lng];
      all.push(...ll);
      if (!ll.length) all.push(end);
      const place = places.get(r.id);
      let html;
      if (place) {
        const first = r.name.trim().split(/\s+/)[0];
        html = '<div class="rm tp p' + place + '"><div class="rm-badge place" style="background:' + bg + '"><b style="color:' + fg + '">' + place + '</b></div><div class="rm-tag">' + esc(first) + '</div></div>';
      } else {
        html = markerHtml(r, r.status === 'stopped' ? 'stale' : '');
      }
      L.marker(end, { icon: L.divIcon({ className: 'tmk', html, iconSize: [0, 0] }), zIndexOffset: place ? 500 - place : 0, keyboard: false }).addTo(tlayer);
      legend.push({ r, place, ll, bg, fg });
    });
    el.tlegend.innerHTML = legend.map(({ r, place, bg, fg }) => {
      const badge = place ? place : esc(initials(r.name));
      const label = place ? 'Place ' + place : r.status === 'finished' ? 'Finished' : r.status === 'stopped' ? 'Stopped' : 'Running';
      return '<li class="row" data-id="' + esc(r.id) + '">' +
        '<div class="row-badge" style="background:' + bg + '"><b style="color:' + fg + '">' + badge + '</b></div>' +
        '<div class="row-main"><div class="row-name">' + esc(r.name) + (r.isMe ? '<em>You</em>' : '') + '</div>' +
        '<div class="row-sub">' + label + ' · ' + fmtDur(r.elapsed) + '</div></div>' +
        '<div class="row-right"><div class="row-dist">' + fmtKm(r.dist) + '<small>km</small></div></div></li>';
    }).join('');
    state.tlegendData = legend;
    if (fit && all.length) tmap.fitBounds(L.latLngBounds(all), { padding: [40, 40], maxZoom: 17 });
  }

  function fitTracks() {
    const pts = [];
    (state.tlegendData || []).forEach((x) => { pts.push(...x.ll); });
    if (pts.length && tmap) tmap.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 17 });
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
    state.run = freshRun();
    save(LS_ME, state.me); save(LS_NAME, name); saveRunNow();
    enterApp();
  }

  function watchOnly() {
    state.me = null;
    enterApp();
  }

  // Remove my record from the server. Waits for any in-flight update first so it can't re-add me.
  // (The server keeps finished runs and tracks as results; it only takes me off the live map.)
  async function removeFromServer(id) {
    for (let i = 0; i < 30 && state.inFlight; i++) await new Promise((r) => setTimeout(r, 100));
    try { await fetch('/api/runners?id=' + encodeURIComponent(id), { method: 'DELETE', keepalive: true }); } catch (e) { /* offline: the server drops me from the map after 5 min */ }
  }

  function resetMe() {
    stopGeo(); unlockScreen();
    drop(LS_ME); drop(LS_RUN);
    state.me = null; state.pos = null; state.hasPosted = false;
    state.run = freshRun();
    redrawMyLine();
    hideAlert();
  }

  function leave() {
    const id = state.me && state.me.id;
    stopLoops(); setTrails(false); closeBoard();
    resetMe();
    state.runners = []; state.autoFit = true; state.firstFitDone = false;
    markers.forEach((m) => map && map.removeLayer(m.marker)); markers.clear();
    el.app.hidden = true; el.join.hidden = false;
    if (id) removeFromServer(id);
  }

  // Stop sharing but stay on the map as a viewer.
  function stopSharing() {
    const id = state.me && state.me.id;
    resetMe();
    if (id) state.runners = state.runners.map((r) => (r.id === id ? Object.assign({}, r, { hidden: true }) : r)); // the server hides me too; don't wait for the next poll
    renderControls(); renderStats(); render();
    if (id) removeFromServer(id);
  }

  // ---------- Events ----------
  el.joinBtn.addEventListener('click', joinRun);
  el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRun(); });
  el.name.addEventListener('input', () => el.name.closest('.field').classList.remove('invalid'));
  el.watchBtn.addEventListener('click', watchOnly);

  el.runBtn.addEventListener('click', () => {
    if (!state.me) { stopLoops(); setTrails(false); el.app.hidden = true; el.join.hidden = false; return; }
    const s = state.run.status;
    if (s === 'ready') startRun();
    else if (s === 'running') finishRun();
    else newRun();
  });

  $('sumClose').addEventListener('click', () => { el.summary.hidden = true; });
  $('sumBoard').addEventListener('click', () => { el.summary.hidden = true; openBoard(); });

  let confirmAction = 'leave';
  function askConfirm(action) {
    confirmAction = action;
    const running = state.run.status === 'running';
    if (action === 'stop') {
      $('confirmTitle').textContent = 'Stop sharing?';
      $('confirmText').textContent = 'Your marker disappears from the live map and your location is no longer shared. ' +
        (running ? 'Your run so far stays saved as a stopped run. ' : '') + 'You can join again any time.';
      $('confirmYes').querySelector('span').textContent = 'Stop sharing';
    } else {
      $('confirmTitle').textContent = 'Leave the run?';
      $('confirmText').textContent = running
        ? 'Your run is still in progress. Leaving takes you off the map and it stays saved as a stopped run.'
        : 'Your marker will disappear from everyone\'s map.';
      $('confirmYes').querySelector('span').textContent = 'Leave';
    }
    el.confirm.hidden = false;
  }
  $('leaveBtn').addEventListener('click', () => { if (!state.me) { leave(); return; } askConfirm('leave'); });
  el.stopBtn.addEventListener('click', () => askConfirm('stop'));
  $('confirmNo').addEventListener('click', () => { el.confirm.hidden = true; });
  $('confirmYes').addEventListener('click', () => {
    el.confirm.hidden = true;
    if (confirmAction === 'stop') stopSharing(); else leave();
  });

  $('fitBtn').addEventListener('click', () => { state.autoFit = true; fitAll(true); });
  $('trailBtn').addEventListener('click', () => setTrails(!state.showTrails));
  $('meBtn').addEventListener('click', () => {
    if (state.pos && map) { state.autoFit = false; map.flyTo([state.pos.lat, state.pos.lng], Math.max(map.getZoom(), 16), { duration: 0.8 }); }
    else showAlert('Still waiting for your location.', true);
  });

  $('boardBtn').addEventListener('click', openBoard);
  $('boardClose').addEventListener('click', closeBoard);
  el.boardTabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    state.boardSort = b.dataset.sort;
    renderBoard();
  });
  el.boardDay.addEventListener('change', () => {
    state.boardDay = el.boardDay.value;
    if (state.boardDay === 'today') { state.pastRunners = null; renderBoard(); }
    else loadPastDay(state.boardDay);
    if (state.tracksOpen) closeTracks();
  });
  $('allTracksBtn').addEventListener('click', openTracks);
  $('tracksClose').addEventListener('click', closeTracks);
  $('tfit').addEventListener('click', fitTracks);
  el.tlegend.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row || !tmap) return;
    const item = (state.tlegendData || []).find((x) => x.r.id === row.dataset.id);
    if (item && item.ll.length) tmap.fitBounds(L.latLngBounds(item.ll), { padding: [60, 60], maxZoom: 17 });
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
    if (document.visibilityState === 'hidden') saveRunNow();
    if (document.visibilityState === 'visible' && !el.app.hidden) {
      if (state.me && state.run.status !== 'finished') lockScreen();
      sync();
    }
  });
  window.addEventListener('pagehide', saveRunNow);
  window.addEventListener('online', () => { if (!el.app.hidden) sync(); });

  // ---------- Boot ----------
  function boot() {
    const savedName = load(LS_NAME);
    if (savedName) el.name.value = savedName;
    const saved = load(LS_ME);
    if (saved && saved.id && saved.name) {
      state.me = saved;
      el.name.value = saved.name;
      const run = load(LS_RUN);
      const fresh = run && run.startedAt && now() - run.startedAt < 12 * 3600 * 1000;
      state.run = run && (run.status === 'ready' || fresh) ? Object.assign(freshRun(), run) : freshRun();
      enterApp();
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }
  boot();

  // lets the automated tests reach the pure functions
  if (window.__KGF_TEST__) window.__KGF__ = { computeRows, rankRows, finisherPlaces, state, fmtDur };
})();
