// GET /api/tracks?runs=<runId>:<from>,<runId>:<from>,...
// Returns { tracks: { runId: [[latE5,lngE5,sec,metres], ...] } } holding only the points at index >= from,
// so the app can keep what it already has and ask for new points only.
const { K, redis, ID_RE } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const items = String((req.query && req.query.runs) || '').split(',').filter(Boolean).slice(0, 40);
    const wanted = [];
    for (const it of items) {
      const [id, f] = it.split(':');
      if (!ID_RE.test(id || '')) continue;
      const from = Math.max(0, parseInt(f || '0', 10) || 0);
      wanted.push({ id, from });
    }
    if (!wanted.length) return res.status(200).json({ tracks: {} });
    const lists = await redis(wanted.map((w) => ['LRANGE', K.track(w.id), w.from, -1]));
    // points are already JSON strings in Redis, so stitch the response together without re-parsing them
    const body = '{"tracks":{' + wanted.map((w, i) => '"' + w.id + '":[' + (lists[i] || []).join(',') + ']').join(',') + '}}';
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(body);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
