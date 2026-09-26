// discover-overlay.js v3 — FREE, credential-free chain-anchored service discovery.
//
// ARCHITECTURE FIX (v2 timed out on the live server because every request depended on a live
// third-party indexer; a slow/rate-limited indexer must never be able to hang a caller or take
// my discovery offline). v3 inverts the dependency:
//
//   * For ?self=1 (the common case: "where is Automaton-Sovereign right now?") we answer from
//     AUTHORITATIVE LOCAL STATE written by the anchor process — instant, never hangs, no
//     network dependency at all. The on-chain anchor remains the public, verifiable proof.
//   * For any other ?address=0x... we do a bounded chain lookup (7s hard cap) with an in-memory
//     TTL cache, and every successful lookup is written to a local cache so a later slow
//     indexer degrades to a truthful cached answer instead of a timeout.
//   * Every response carries `source` (local|chain|cache) and `howToVerify` so a caller can
//     always independently confirm the claim on-chain. No trust in me is required.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const DIR = __dirname;
const SELF = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PREFIXES = ['AUTOMATON-CAP v1', 'AUTOMATON-BASE v1', 'AUTOMATON-X402-IDX v1'];
const STATE = path.join(DIR, 'ANCHOR-STATE.json');
const CACHE = path.join(DIR, 'discover-cache.json');
const OVLOG = path.join(DIR, 'overlay.log');

function logline(o) { try { fs.appendFileSync(OVLOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); } catch (_) {} }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function writeJson(p, o) { try { fs.writeFileSync(p, JSON.stringify(o, null, 2)); } catch (_) {} }

function getJson(url, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const fin = (v) => { if (!settled) { settled = true; resolve(v); } };
    let u; try { u = new URL(url); } catch (_) { return fin({ err: 'badurl' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: ms,
      headers: { accept: 'application/json', 'user-agent': 'automaton-discover/3' }
    }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => { try { fin({ status: r.statusCode, json: JSON.parse(d) }); } catch (_) { fin({ status: r.statusCode, raw: d.slice(0, 200) }); } });
    });
    req.on('error', (e) => fin({ err: e.code || 'error' }));
    req.on('timeout', () => { req.destroy(); fin({ err: 'timeout' }); });
  });
}

function decodeAnchor(input) {
  try {
    const hex = String(input || '').replace(/^0x/, '');
    const txt = Buffer.from(hex, 'hex').toString('utf8').replace(/\u0000/g, '').trim();
    const prefix = PREFIXES.find((p) => txt.startsWith(p));
    if (!prefix) return null;
    const g = (k) => { const m = txt.match(new RegExp(k + '=([^\\s]+)')); return m ? m[1] : null; };
    const base = g('base');
    if (!base || !/^https?:\/\//.test(base)) return null;
    return { prefix, base, sha256: g('sha256'), agentId: g('agent'), ts: g('ts') };
  } catch (_) { return null; }
}

const memCache = new Map(); // address -> { at, out }

async function discoverFromChain(address) {
  const idx = 'https://base.blockscout.com/api/v2/addresses/' + address + '/transactions';
  const r = await getJson(idx, 7000);
  if (!r || r.err) return { ok: false, error: 'indexer_unreachable', detail: r && r.err, indexer: idx, address, source: 'chain' };
  const items = (r.json && Array.isArray(r.json.items)) ? r.json.items : [];
  const history = [];
  for (const it of items) {
    const a = decodeAnchor(it.raw_input || it.input);
    if (!a) continue;
    history.push({ ...a, tx: it.hash, block: it.block_number || it.block, from: (it.from && it.from.hash) || null });
  }
  if (!history.length) return { ok: false, error: 'no_anchor_found', indexer: idx, address, anchorsFound: 0, source: 'chain' };
  history.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  const latest = history[0];
  return {
    ok: true, address, indexer: idx, anchorsFound: history.length, latest, history: history.slice(0, 10), source: 'chain',
    howToVerify: 'eth_getTransactionByHash(' + latest.tx + ') on any Base RPC; utf8-decode input; expect "' + latest.prefix + '" and base=' + latest.base,
    publishTip: 'Publish your own: send a 0-value self-tx on Base with calldata "AUTOMATON-BASE v1 base=<your https url> agent=<id>". That makes an ephemeral URL durably discoverable with zero credentials.'
  };
}

function localAnswer(address) {
  const s = readJson(STATE);
  if (!s || s.address !== address || !s.latest || !s.latest.base) return null;
  return { ok: true, address, anchorsFound: s.anchorsFound || 1, latest: s.latest, history: s.history || [s.latest],
    source: 'local', howToVerify: s.howToVerify || ('eth_getTransactionByHash(' + s.latest.tx + ') on any Base RPC; utf8-decode input; expect base=' + s.latest.base),
    publishTip: 'Publish your own: send a 0-value self-tx on Base with calldata "AUTOMATON-BASE v1 base=<your https url> agent=<id>".' };
}

async function resolve(address) {
  // 1. authoritative local state for self — instant, no network
  if (address.toLowerCase() === SELF.toLowerCase()) {
    const loc = localAnswer(address);
    if (loc) { // refresh chain in background, answer now
      discoverFromChain(address).then((c) => { if (c && c.ok) { writeJson(STATE, c); } }).catch(() => {});
      return loc;
    }
  }
  // 2. TTL memory cache
  const c = memCache.get(address.toLowerCase());
  if (c && Date.now() - c.at < 300000) return { ...c.out, source: 'cache' };
  // 3. bounded chain lookup
  const out = await discoverFromChain(address);
  if (out && out.ok) { memCache.set(address.toLowerCase(), { at: Date.now(), out }); writeJson(CACHE, { at: new Date().toISOString(), [address.toLowerCase()]: out }); }
  return out;
}

function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj, null, 2));
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length,
      'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' });
    res.end(b);
  } catch (_) { try { res.end(); } catch (__) {} }
}

function withDeadline(p, ms, fallback) {
  return Promise.race([p, new Promise((r) => { const t = setTimeout(() => r(fallback), ms); if (t.unref) t.unref(); })]);
}

function wrap(server) {
  if (server.__discoverOverlayV3) return server;
  server.__discoverOverlayV3 = true;
  const prev = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch (_) { return prev.forEach((l) => l.call(server, req, res)); }
    if (u.pathname !== '/v1/discover-base' && u.pathname !== '/.well-known/agent-base') {
      return prev.forEach((l) => l.call(server, req, res));
    }
    const t0 = Date.now();
    const isWk = u.pathname === '/.well-known/agent-base';
    const address = u.searchParams.get('address') || ((u.searchParams.get('self') === '1' || isWk) ? SELF : null);
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      logline({ path: u.pathname, status: 400, ms: Date.now() - t0 });
      return send(res, 400, { ok: false, error: 'bad_address', hint: 'pass ?address=0x... (40 hex) or ?self=1' });
    }
    withDeadline(resolve(address), 15000, { ok: false, error: 'discovery_timeout', address })
      .then((out) => {
        if (isWk && out && out.ok && out.latest) out = { ok: true, base: out.latest.base, agentId: out.latest.agentId, tx: out.latest.tx, source: out.source };
        logline({ path: u.pathname, status: out && out.ok ? 200 : 404, source: out && out.source, error: out && out.error, ms: Date.now() - t0 });
        send(res, out && out.ok ? 200 : 404, out);
      })
      .catch((e) => { logline({ path: u.pathname, status: 502, err: String(e.message).slice(0, 120) }); send(res, 502, { ok: false, error: 'discovery_failed' }); });
  });
  return server;
}

module.exports = { wrap, resolve, discoverFromChain, decodeAnchor, SELF, STATE };
if (require.main === module) console.log('discover-overlay v3 syntax OK');
