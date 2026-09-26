'use strict';
/**
 * Read side of the Pool Sentinel for the value-api (server.js):
 *   GET /v2/sentinel/status  free   — freshness + counters (lets buyers check liveness before paying)
 *   GET /v2/sentinel/latest  paid   — newest scanned pools, filterable
 *   GET /v2/sentinel/stream  paid   — Server-Sent Events of new pools for a fixed window per payment
 * The daemon (pool-watcher.js) is the only writer of scanned-pools.json.
 */
const fs = require('fs');
const path = require('path');

const FILE = process.env.SENTINEL_FILE || path.join(__dirname, 'scanned-pools.json');
const STREAM_WINDOW_MS = 15 * 60 * 1000;
const MAX_STREAMS = 50;

let cache = { mtimeMs: -1, data: null };
function load(file = FILE) {
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== cache.mtimeMs || cache.file !== file) {
      cache = { file, mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
    return cache.data;
  } catch (e) {
    return null;
  }
}

function status(file = FILE, now = Date.now()) {
  const d = load(file);
  if (!d) return { ok: false, error: 'sentinel_not_running', message: 'No scan data yet.' };
  const ageSec = d.updatedAt ? Math.round((now - Date.parse(d.updatedAt)) / 1000) : null;
  return {
    ok: true, live: ageSec !== null && ageSec < 120, updatedAt: d.updatedAt, dataAgeSec: ageSec,
    lastBlock: d.lastBlock, stats: d.stats, poolsAvailable: (d.pools || []).length,
    sources: ['uniswap-v4', 'uniswap-v3', 'aerodrome', 'aerodrome-slipstream'],
    paid: { latest: '/v2/sentinel/latest?limit=50&maxRisk=&minRisk=&dex=&since=', stream: '/v2/sentinel/stream (SSE, 15 min per payment)' }
  };
}

// Validate before charging (same rule as /v2/simulate): malformed queries never burn a payment.
function parseLatestQuery(sp) {
  const q = { limit: 50 };
  const num = (k, lo, hi) => {
    const v = sp.get(k);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be a number in [${lo}, ${hi}]`);
    return n;
  };
  try {
    const limit = num('limit', 1, 500); if (limit !== undefined) q.limit = Math.floor(limit);
    q.maxRisk = num('maxRisk', 0, 100);
    q.minRisk = num('minRisk', 0, 100);
    const since = sp.get('since');
    if (since) { const t = Date.parse(since); if (Number.isNaN(t)) throw new Error('since must be an ISO date'); q.since = t; }
    const dex = sp.get('dex');
    if (dex) { if (!/^[a-z0-9-]{2,32}$/.test(dex)) throw new Error('dex is invalid'); q.dex = dex; }
  } catch (e) {
    return { error: 'invalid_params', message: e.message };
  }
  return q;
}

function filterPools(pools, q) {
  return (pools || []).filter(p =>
    (q.dex === undefined || p.dex === q.dex) &&
    (q.since === undefined || Date.parse(p.detectedAt) > q.since) &&
    (q.maxRisk === undefined || (p.maxRisk !== null && p.maxRisk <= q.maxRisk)) &&
    (q.minRisk === undefined || (p.maxRisk !== null && p.maxRisk >= q.minRisk))
  );
}

function latest(q, file = FILE) {
  const d = load(file);
  if (!d) return { ok: false, error: 'sentinel_not_running' };
  const pools = filterPools(d.pools, q).slice(0, q.limit);
  return { ok: true, updatedAt: d.updatedAt, lastBlock: d.lastBlock, count: pools.length, pools };
}

let openStreams = 0;
function streamCapacity() { return openStreams < MAX_STREAMS; }

function stream(req, res, { extraHeaders = {}, windowMs = STREAM_WINDOW_MS, pollMs = 2000, file = FILE } = {}) {
  openStreams++;
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
    'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no'
  }, extraHeaders));
  const started = Date.now();
  const d0 = load(file);
  let cursor = d0 && d0.pools && d0.pools[0] ? d0.pools[0].detectedAt + '|' + d0.pools[0].tx + '|' + d0.pools[0].logIndex : null;
  const write = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };
  write('hello', { expiresAt: new Date(started + windowMs).toISOString(), lastBlock: d0 && d0.lastBlock });

  let beat = 0;
  const timer = setInterval(() => {
    if (Date.now() - started >= windowMs) { write('expired', { message: 'Window over. Pay again to continue.' }); return done(); }
    const d = load(file);
    const pools = (d && d.pools) || [];
    const fresh = [];
    for (const p of pools) {
      const key = p.detectedAt + '|' + p.tx + '|' + p.logIndex;
      if (key === cursor) break;
      fresh.push(p);
    }
    if (fresh.length) { cursor = fresh[0].detectedAt + '|' + fresh[0].tx + '|' + fresh[0].logIndex; for (const p of fresh.reverse()) write('pool', p); }
    else if (++beat % 8 === 0) { try { res.write(': keep-alive\n\n'); } catch (e) {} }
  }, pollMs);

  let closed = false;
  function done() {
    if (closed) return; closed = true;
    clearInterval(timer); openStreams--;
    try { res.end(); } catch (e) {}
  }
  req.on('close', done);
  return done;
}

module.exports = { status, latest, parseLatestQuery, filterPools, stream, streamCapacity, load };
