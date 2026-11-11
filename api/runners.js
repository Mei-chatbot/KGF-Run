// KGF Run Tracker: live state for today's run.
//   GET    /api/runners         -> { now, day, targetKm, runners }
//   POST   /api/runners         -> save my position, stats and new track points; returns the same payload + myN
//   DELETE /api/runners?id=<id> -> stop sharing (never-started runners are removed, started runs are kept as results)
const L = require('./_lib');
const { K, redis, parseHash, dayKeyOf, onMap, getTargetKm, ID_RE, PALETTE_SIZE } = L;

const STATUSES = ['ready', 'running', 'finished'];
const MAX_PTS = 400;

const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

function sanitizePoint(p) {
  if (!Array.isArray(p) || p.length !== 4) return null;
  const a = num(p[0], -9000000, 9000000), b = num(p[1], -18000000, 18000000);
  const t = num(p[2], 0, 172800), d = num(p[3], 0, 500000);
  if (a === null || b === null || t === null || d === null) return null;
  return [Math.round(a), Math.round(b), Math.round(t), Math.round(d)];
}

function sanitize(body) {
  const id = String(body.id || '');
  if (!ID_RE.test(id)) return { error: 'Invalid id' };
  const name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  if (!name) return { error: 'Name is required' };
  const lat = num(body.lat, -90, 90), lng = num(body.lng, -180, 180);
  if (lat === null || lng === null) return { error: 'Invalid position' };
  const runId = body.runId ? String(body.runId) : null;
  if (runId && !ID_RE.test(runId)) return { error: 'Invalid runId' };
  const pts = (Array.isArray(body.pts) ? body.pts.slice(0, MAX_PTS) : []).map(sanitizePoint).filter(Boolean);
  return {
    rec: {
      id, name, lat, lng,
      acc: num(body.acc, 0, 100000) ?? 0,
      status: STATUSES.includes(body.status) ? body.status : 'ready',
      distance: num(body.distance, 0, 500000) ?? 0, // metres
      startedAt: num(body.startedAt, 0, 4e12),
      endedAt: num(body.endedAt, 0, 4e12),
      reachedMs: num(body.reachedMs, 0, 86400000),   // time taken to cover the target distance
      runId,
    },
    pts,
    from: num(body.from, 0, 1e7) ?? 0,
  };
}

const visibleRecords = (all, now) => all.filter((r) => r.status !== 'ready' || onMap(r, now));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const now = Date.now();
    const day = dayKeyOf(now);

    if (req.method === 'GET') {
      const [flat] = await redis([['HGETALL', K.day(day)]]);
      const all = parseHash(flat);
      const stale = all.filter((r) => r.status === 'ready' && !onMap(r, now)).map((r) => r.id); // never started, long gone
      if (stale.length) await redis([['HDEL', K.day(day), ...stale]]);
      return res.status(200).json({ now, day, targetKm: await getTargetKm(), runners: visibleRecords(all, now) });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const { rec, pts, from, error } = sanitize(body || {});
      if (error) return res.status(400).json({ error });

      const [flat] = await redis([['HGETALL', K.day(day)]]);
      const all = parseHash(flat);
      const existing = all.find((r) => r.id === rec.id);

      // colour: keep mine, otherwise the first one nobody on the map is using
      if (existing) rec.color = existing.color;
      else {
        const used = new Set(all.filter((r) => onMap(r, now)).map((r) => r.color));
        let c = 0;
        while (used.has(c) && c < PALETTE_SIZE) c++;
        rec.color = c < PALETTE_SIZE ? c : all.length % PALETTE_SIZE;
      }

      // how many track points are already stored for this run?
      let n = 0;
      if (rec.runId) {
        if (existing && existing.runId === rec.runId) n = existing.n || 0;
        else { const [len] = await redis([['LLEN', K.track(rec.runId)]]); n = len || 0; }
      }
      // pts start at index `from`; skip any we already have (retries), ignore if there is a gap (client resends from myN)
      const append = rec.runId && pts.length && from <= n ? pts.slice(n - from) : [];
      rec.n = n + append.length;
      rec.updatedAt = now;
      rec.date = day;
      rec.hidden = false;

      const cmds = [['HSET', K.day(day), rec.id, JSON.stringify(rec)]];
      if (append.length) cmds.push(['RPUSH', K.track(rec.runId), ...append.map((p) => JSON.stringify(p))]);
      if (!existing) cmds.push(['SADD', K.days, day]);
      const stale = all.filter((r) => r.status === 'ready' && r.id !== rec.id && !onMap(r, now)).map((r) => r.id);
      if (stale.length) cmds.push(['HDEL', K.day(day), ...stale]);
      await redis(cmds);

      const runners = visibleRecords(all.filter((r) => r.id !== rec.id && !stale.includes(r.id)), now).concat(rec);
      return res.status(200).json({ now, day, targetKm: await getTargetKm(), runners, myN: rec.n });
    }

    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id' });
      const [raw] = await redis([['HGET', K.day(day), id]]);
      let rec = null;
      try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
      if (!rec) return res.status(200).json({ ok: true });
      if (rec.status === 'ready' || !rec.startedAt) {
        await redis([['HDEL', K.day(day), id]]);
      } else {
        // keep the result and the track, just take the runner off the live map
        rec.hidden = true;
        if (rec.status === 'running') { rec.status = 'stopped'; rec.endedAt = now; }
        rec.updatedAt = now;
        await redis([['HSET', K.day(day), id, JSON.stringify(rec)]]);
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
