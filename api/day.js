// GET /api/day               -> { days: ["2026-11-08", ...] } newest first
// GET /api/day?date=YYYY-MM-DD -> { date, now, targetKm, runners } results saved for that day
const { K, redis, parseHash, DATE_RE, getTargetKm } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const date = String((req.query && req.query.date) || '');
    if (!date) {
      const [members] = await redis([['SMEMBERS', K.days]]);
      const days = (members || []).filter((d) => DATE_RE.test(d)).sort().reverse().slice(0, 90);
      return res.status(200).json({ days });
    }
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date' });
    const [flat] = await redis([['HGETALL', K.day(date)]]);
    const runners = parseHash(flat).filter((r) => r.status !== 'ready' && r.startedAt);
    return res.status(200).json({ date, now: Date.now(), targetKm: await getTargetKm(), runners });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
