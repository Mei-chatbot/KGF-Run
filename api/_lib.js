// Shared helpers for the KGF Run API. Files starting with "_" are not exposed as routes by Vercel.
//
// Redis layout (all on one Upstash Redis database, nothing expires):
//   kgf:d:<YYYY-MM-DD>  hash   field = runnerId -> JSON record (live state + run summary) for that day
//   kgf:t:<runId>       list   the GPS track of one run, one JSON point per entry: [latE5, lngE5, secSinceStart, metres]
//   kgf:days            set    every date that has data
//   kgf:cfg             hash   targetKm (the distance the "Time" leaderboard measures)

const ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LIVE_MS = 5 * 60 * 1000;           // ready/running runners leave the live map 5 min after their last update
const FINISHED_MS = 3 * 60 * 60 * 1000;  // finished runners stay on the live map for 3 hours
const PALETTE_SIZE = 12;
const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN || 330); // IST by default; decides which "day" a run belongs to

const K = {
  day: (d) => 'kgf:d:' + d,
  track: (id) => 'kgf:t:' + id,
  days: 'kgf:days',
  cfg: 'kgf:cfg',
};

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

const dayKeyOf = (ms) => new Date(ms + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);

// Is this record still worth showing on the live map?
function onMap(r, now) {
  if (r.hidden || r.status === 'stopped') return false;
  const age = now - r.updatedAt;
  return r.status === 'finished' ? age < FINISHED_MS : age < LIVE_MS;
}

let cfgCache = { t: 0, km: 10 };
async function getTargetKm() {
  if (Date.now() - cfgCache.t < 60000) return cfgCache.km;
  try {
    const [v] = await redis([['HGET', K.cfg, 'targetKm']]);
    const km = Number(v);
    cfgCache = { t: Date.now(), km: Number.isFinite(km) && km > 0 ? km : 10 };
  } catch (e) { /* keep the last value */ }
  return cfgCache.km;
}
function setTargetCache(km) { cfgCache = { t: Date.now(), km }; }

module.exports = { ID_RE, DATE_RE, LIVE_MS, FINISHED_MS, PALETTE_SIZE, K, redis, parseHash, dayKeyOf, onMap, getTargetKm, setTargetCache };
