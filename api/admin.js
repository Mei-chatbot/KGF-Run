// POST /api/admin  (header x-admin-key must equal the ADMIN_KEY environment variable)
//   { action: "setTarget", targetKm: 10 }      -> distance the "Time" leaderboard measures
//   { action: "clearDay", date: "YYYY-MM-DD" } -> delete that day's results and tracks
const { K, redis, parseHash, DATE_RE, setTargetCache } = require('./_lib');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(403).json({ error: 'ADMIN_KEY is not set in Vercel environment variables.' });
    const a = Buffer.from(adminKey), b = Buffer.from(String(req.headers['x-admin-key'] || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong admin key.' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    if (body.action === 'setTarget') {
      const km = Number(body.targetKm);
      if (!Number.isFinite(km) || km < 0.5 || km > 200) return res.status(400).json({ error: 'Target must be between 0.5 and 200 km.' });
      await redis([['HSET', K.cfg, 'targetKm', String(km)]]);
      setTargetCache(km);
      return res.status(200).json({ ok: true, targetKm: km });
    }

    if (body.action === 'clearDay') {
      const date = String(body.date || '');
      if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date' });
      const [flat] = await redis([['HGETALL', K.day(date)]]);
      const runIds = parseHash(flat).map((r) => r.runId).filter(Boolean);
      const cmds = runIds.map((id) => ['DEL', K.track(id)]);
      cmds.push(['DEL', K.day(date)], ['SREM', K.days, date]);
      await redis(cmds);
      return res.status(200).json({ ok: true, runs: runIds.length });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
