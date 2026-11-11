// KGF Run Tracker – shared runner state.
// GET    /api/runners            -> { now, runners: [...] }
// POST   /api/runners            -> upsert my position/stats, returns the same payload as GET
// DELETE /api/runners?id=<id>    -> leave the run
//
// Storage: one Redis hash (field = runner id) on Upstash Redis (free tier).
// Env vars (either naming works, Vercel's Upstash integration sets the KV_* ones):
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   KV_REST_API_URL        / KV_REST_API_TOKEN

const KEY = 'kgf:runners';
const STALE_MS = 6 * 60 * 60 * 1000; // drop runners not heard from for 6 hours
const HASH_TTL_S = 24 * 60 * 60;
const PALETTE_SIZE = 12;
const STATUSES = ['ready', 'running', 'finished'];

function creds() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  return { url: url.replace(/\/$/, ''), token };
}

async function redis(commands) {
  const { url, token } = creds();
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  const out = await r.json();
  return out.map((o) => {
    if (o.error) throw new Error('Redis: ' + o.error);
    return o.result;
  });
}

function parseHash(flat) {
  const list = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    try { list.push(JSON.parse(flat[i + 1])); } catch (e) { /* skip corrupt entry */ }
  }
  return list;
}

const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

function sanitize(body) {
  const id = String(body.id || '');
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return { error: 'Invalid id' };
  const name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
  if (!name) return { error: 'Name is required' };
  const lat = num(body.lat, -90, 90);
  const lng = num(body.lng, -180, 180);
  if (lat === null || lng === null) return { error: 'Invalid position' };
  const status = STATUSES.includes(body.status) ? body.status : 'ready';
  return {
    rec: {
      id, name, lat, lng,
      acc: num(body.acc, 0, 100000) ?? 0,
      status,
      distance: num(body.distance, 0, 500000) ?? 0, // metres
      startedAt: num(body.startedAt, 0, 4e12),
      endedAt: num(body.endedAt, 0, 4e12),
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const now = Date.now();

    if (req.method === 'GET') {
      const [flat] = await redis([['HGETALL', KEY]]);
      const all = parseHash(flat);
      const fresh = all.filter((r) => now - r.updatedAt < STALE_MS);
      const stale = all.filter((r) => now - r.updatedAt >= STALE_MS).map((r) => r.id);
      if (stale.length) await redis([['HDEL', KEY, ...stale]]);
      return res.status(200).json({ now, runners: fresh });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      const { rec, error } = sanitize(body || {});
      if (error) return res.status(400).json({ error });

      const [flat] = await redis([['HGETALL', KEY]]);
      const all = parseHash(flat);
      const fresh = all.filter((r) => now - r.updatedAt < STALE_MS);
      const stale = all.filter((r) => now - r.updatedAt >= STALE_MS).map((r) => r.id);

      const existing = fresh.find((r) => r.id === rec.id);
      if (existing) {
        rec.color = existing.color;
      } else {
        const used = new Set(fresh.map((r) => r.color));
        let c = 0;
        while (used.has(c) && c < PALETTE_SIZE) c++;
        rec.color = c < PALETTE_SIZE ? c : fresh.length % PALETTE_SIZE;
      }
      rec.updatedAt = now;

      const cmds = [['HSET', KEY, rec.id, JSON.stringify(rec)]];
      if (!existing) cmds.push(['EXPIRE', KEY, HASH_TTL_S]); // TTL survives updates; refresh it whenever someone new joins
      if (stale.length) cmds.push(['HDEL', KEY, ...stale]);
      await redis(cmds);

      const runners = fresh.filter((r) => r.id !== rec.id).concat(rec);
      return res.status(200).json({ now, runners });
    }

    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
      await redis([['HDEL', KEY, id]]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
