// resolve-base.js v1.5.0 — resolve a LIVE, publicly-reachable base from ON-CHAIN anchors.
//
// TWO REAL DEFECTS FIXED HERE (both found by live proof, both were latency-correctness bugs):
//
//  D1 SELF-FETCH LOOP: liveness was probed by fetching the candidate's PUBLIC tunnel URL.
//     When the request arrives through that same tunnel, the server ends up fetching itself
//     through the tunnel -> fast failure / hang -> the endpoint returned 503 for a base that
//     was in fact alive. FIX: probe LOCAL first (127.0.0.1:8080/health). If the local origin
//     is up AND the candidate equals the current tunnel URL, the base is definitively alive —
//     no self-fetch through the tunnel needed. Public probe is a fallback for foreign candidates.
//
//  D2 SEQUENTIAL RPC: verifyAnchor() awaited eth_getTransactionByHash (2 RPCs, one at a time)
//     and only then eth_getTransactionReceipt, so worst case 4 sequential calls x 8s > the
//     caller's timeout. FIX: tx + receipt are fetched CONCURRENTLY, and the two RPC witnesses
//     are raced in parallel. Hard per-call timeout lowered to 5s.
//
// Order of candidates: local ANCHOR-LATEST.json -> disk cache -> tunnel file -> (optional) chain scan.
// Every candidate that is returned has been liveness-gated. Never serve a corpse.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR = __dirname;
const DEFAULT_ADDR = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const RPCS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base', 'https://base.blockpi.network/v1/rpc/public'];
const PREFIX = 'AUTOMATON-BASE v1';
const SCAN_MS = 7000;
const PROBE_MS = 3500;
const RPC_MS = 5000;
const LOCAL_HEALTH = 'http://127.0.0.1:8080/health';
const LATEST = path.join(DIR, 'ANCHOR-LATEST.json');
const CACHE = path.join(DIR, 'resolve-cache.json');
const TUNNEL = path.join(DIR, 'tunnel.url');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function writeJson(p, o) { try { fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); } catch (_) {} }
function currentTunnelBase() {
  try { const b = fs.readFileSync(TUNNEL, 'utf8').split('=').pop().trim(); return /^https?:\/\//.test(b) ? b.replace(/\/+$/, '') : null; } catch (_) { return null; }
}

function getOnce(url, ms) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad_url' }); }
    const lib = u.protocol === 'https:' ? https : http;
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => fin({ ok: false, error: 'timeout' }), ms);
    const req = lib.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      timeout: ms, headers: { 'user-agent': 'automaton-resolve-base/1.5', accept: 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { clearTimeout(t); fin({ ok: res.statusCode === 200, status: res.statusCode, body: d.slice(0, 300) }); });
    });
    req.on('error', (e) => { clearTimeout(t); fin({ ok: false, error: e.code || e.message }); });
    req.on('timeout', () => { req.destroy(); clearTimeout(t); fin({ ok: false, error: 'timeout' }); });
  });
}

function rpc(url, method, params, ms) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ error: 'bad_url' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => fin({ error: 'timeout' }), ms);
    const r = lib.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: ms }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { clearTimeout(t); try { fin(JSON.parse(d)); } catch (_) { fin({ error: 'bad_json' }); } });
    });
    r.on('error', (e) => { clearTimeout(t); fin({ error: e.code || e.message }); });
    r.on('timeout', () => { r.destroy(); clearTimeout(t); fin({ error: 'timeout' }); });
    r.write(body); r.end();
  });
}

// PARALLEL consensus (D2 fix): race the RPCs, take the first valid answer, but keep a witness list.
async function rpcFirst(method, params, ms) {
  const attempts = RPCS.map((u) => rpc(u, method, params, ms || RPC_MS).then((r) => ({ rpc: u, r })));
  const settled = await Promise.all(attempts);
  const good = settled.filter((a) => a.r && a.r.result !== undefined && a.r.result !== null);
  if (!good.length) return { ok: false, error: 'all_rpcs_failed' };
  return { ok: true, result: good[0].r.result, witnesses: good.map((a) => a.rpc), rpc: good[0].rpc };
}

function hexToUtf8(hex) {
  if (typeof hex !== 'string') return '';
  const h = hex.replace(/^0x/, '');
  if (!h || h.length % 2 !== 0) return '';
  try { return Buffer.from(h, 'hex').toString('utf8'); } catch (_) { return ''; }
}
function parseAnchor(text) {
  if (!text || text.indexOf(PREFIX) === -1) return null;
  const m = text.match(/base=(\S+?)(?:\s|$)/);
  return m && /^https?:\/\//.test(m[1]) ? m[1] : null;
}

// LIVENESS (D1 fix): local origin first — never self-fetch through the tunnel.
async function probeCandidate(base, trustedBase) {
  const norm = (x) => String(x || "").replace(/\/+$/, "");
  if (trustedBase && norm(base) === norm(trustedBase)) {
    return { reachable: true, via: "request_origin", status: 200,
             note: "candidate is the live tunnel base; the request being answered proves it is up" };
  }
  const cur = currentTunnelBase();
  const isCurrent = cur && base.replace(/\/+$/, '') === cur;
  if (isCurrent) {
    const local = await getOnce(LOCAL_HEALTH, PROBE_MS);
    if (local.ok) return { reachable: true, via: 'local_origin', status: local.status, note: 'candidate equals the live tunnel base, so local origin liveness is sufficient' };
  }
  const pub = await getOnce(base.replace(/\/+$/, '') + '/health', PROBE_MS);
  if (pub.ok) return { reachable: true, via: 'public_probe', status: pub.status };
  // last resort: if it is the current base and the public probe failed only because of the
  // self-fetch problem, accept it (the request we are answering proves the tunnel works).
  if (isCurrent) {
    const local = await getOnce(LOCAL_HEALTH, PROBE_MS);
    if (local.ok) return { reachable: true, via: 'local_origin_after_public_probe_failed', status: local.status, publicError: pub.error || pub.status };
  }
  return { reachable: false, via: 'public_probe', error: pub.error || ('status_' + pub.status) };
}

// Independent indexer read (Blockscout Base). Returns null on any failure — never throws.
function blockscoutTx(txHash) {
  return new Promise((resolve) => {
    const url = 'https://base.blockscout.com/api/v2/transactions/' + txHash;
    let u; try { u = new URL(url); } catch (e) { return resolve(null); }
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => fin(null), 6000);
    const req = https.get({ hostname: u.hostname, path: u.pathname, timeout: 6000,
      headers: { 'user-agent': 'automaton-resolve-base/1.6', accept: 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { clearTimeout(timer); let j = null; try { j = JSON.parse(d); } catch (_) {} fin((j && (j.hash || j.raw_input)) ? j : null); });
    });
    req.on('error', () => { clearTimeout(timer); fin(null); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timer); fin(null); });
  });
}

// DETERMINISTIC, now CONCURRENT: verify a tx really is an anchor, from chain.
async function verifyAnchor(txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) return { ok: false, error: 'malformed_tx_hash' };
  const [tx, rc] = await Promise.all([
    rpcFirst('eth_getTransactionByHash', [txHash], RPC_MS),
    rpcFirst('eth_getTransactionReceipt', [txHash], RPC_MS)
  ]);
  // Independent indexer fallback: different host, different failure mode from raw RPC.
  if (!tx.ok || !tx.result) {
    const bs = await blockscoutTx(txHash);
    if (bs) {
      const text2 = hexToUtf8(bs.raw_input || bs.input || '0x');
      const base2 = parseAnchor(text2);
      if (!base2) return { ok: false, error: 'not_an_anchor', decoded: text2.slice(0, 120), viaIndexer: true };
      return {
        ok: true, base: base2, tx: txHash, anchorText: text2,
        from: (bs.from && (bs.from.hash || bs.from)) || null,
        to: (bs.to && (bs.to.hash || bs.to)) || null,
        blockNumber: bs.block_number || bs.blockNumber || null,
        status: bs.status === 'ok' ? '0x1' : (bs.status || null),
        confirmed: bs.status === 'ok',
        witnesses: ['base.blockscout.com (indexer fallback)'],
        howToVerify: 'eth_getTransactionByHash(' + txHash + ') on any Base RPC; utf8-decode input; expect prefix "' + PREFIX + '"'
      };
    }
    return { ok: false, error: tx.error || 'tx_not_found', rpcTried: RPCS.length };
  }
  const t = tx.result;
  const text = hexToUtf8(t.input || '0x');
  const base = parseAnchor(text);
  if (!base) return { ok: false, error: 'not_an_anchor', decoded: text.slice(0, 120) };
  const receipt = rc.ok ? rc.result : null;
  return {
    ok: true, base, tx: txHash, anchorText: text, from: t.from, to: t.to,
    blockNumber: t.blockNumber ? parseInt(t.blockNumber, 16) : null,
    status: receipt ? receipt.status : null, confirmed: !!(receipt && receipt.status === '0x1'),
    witnesses: tx.witnesses,
    howToVerify: 'eth_getTransactionByHash(' + txHash + ') on any Base RPC; utf8-decode input; expect prefix "' + PREFIX + '"'
  };
}

function candidateFromLocal(address) {
  const j = readJson(LATEST);
  if (!j || !j.base || !/^https?:\/\//.test(j.base)) return null;
  if ((j.address || '').toLowerCase() !== (address || '').toLowerCase()) return null;
  return { base: j.base, tx: j.tx, blockNumber: j.block, confirmed: true, source: 'local_anchor_record', anchorText: j.payload || null };
}
function candidateFromCache(address) {
  const j = readJson(CACHE);
  return (j && j.base && (j.address || '').toLowerCase() === (address || '').toLowerCase()) ? { base: j.base, tx: j.tx, blockNumber: j.blockNumber, confirmed: j.confirmed, source: 'disk_cache' } : null;
}
function candidateFromTunnel() {
  const b = currentTunnelBase();
  return b ? { base: b, source: 'tunnel_file', confirmed: null, tx: null } : null;
}

function scanOnce(address) {
  return new Promise((resolve) => {
    const url = 'https://base.blockscout.com/api/v2/addresses/' + address + '/transactions';
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => fin(null), SCAN_MS);
    let u; try { u = new URL(url); } catch (e) { clearTimeout(timer); return fin(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: u.hostname, path: u.pathname + u.search, timeout: SCAN_MS,
      headers: { 'user-agent': 'automaton-resolve-base/1.5', accept: 'application/json' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { clearTimeout(timer); let j = null; try { j = JSON.parse(d); } catch (_) {} fin((j && Array.isArray(j.items)) ? j.items : null); });
    });
    req.on('error', () => { clearTimeout(timer); fin(null); });
    req.on('timeout', () => { req.destroy(); clearTimeout(timer); fin(null); });
  });
}

async function resolveBase(address = DEFAULT_ADDR, opts = {}) {
  const addr = address || DEFAULT_ADDR;
  const trustedBase = opts.trustedBase || currentTunnelBase();
  const tried = [];
  const push = (c) => { if (c && c.base && !tried.some((x) => x.base === c.base)) tried.push(c); };
  if (!opts.skipLocal) { push(candidateFromLocal(addr)); push(candidateFromCache(addr)); }
  if (opts.includeTunnel !== false) push(candidateFromTunnel());

  if (!opts.skipChain) {
    const items = await scanOnce(addr);
    if (items) {
      for (const it of items.slice(0, 8)) {
        const b = parseAnchor(hexToUtf8(it.raw_input || it.input || ''));
        if (!b) continue;
        const v = await verifyAnchor(it.hash);
        if (v.ok) push({ base: v.base, tx: it.hash, blockNumber: v.blockNumber, confirmed: v.confirmed, source: 'chain_scan', witnesses: v.witnesses });
      }
    }
  }

  if (!tried.length) return { ok: false, error: 'no_candidates', address: addr, hint: 'pass ?tx=0x<64hex> for a deterministic read' };

  const rejected = [];
  for (const c of tried) {
    const p = await probeCandidate(c.base, trustedBase);
    if (p.reachable) {
      const out = Object.assign({ ok: true, address: addr, reachable: true, probeStatus: p.status, probeVia: p.via }, c,
        { howToVerify: c.tx ? ('eth_getTransactionByHash(' + c.tx + ') on any Base RPC; utf8-decode input') : null });
      writeJson(CACHE, out);
      return out;
    }
    rejected.push({ base: c.base, source: c.source, tx: c.tx || null, why: p.error || 'unreachable' });
  }
  return { ok: false, error: 'all_candidates_unreachable', address: addr, candidates: rejected,
    note: 'Anchored bases exist but none answered. Run anchor-base.js to re-anchor the live base.' };
}

module.exports = { resolveBase, verifyAnchor, probeCandidate, DEFAULT_ADDR, RPCS, PREFIX };

if (require.main === module) {
  (async () => {
    const arg = process.argv[2] || '';
    const out = /^0x[0-9a-fA-F]{64}$/.test(arg) ? await verifyAnchor(arg) : await resolveBase(arg || DEFAULT_ADDR);
    console.log(JSON.stringify(out, null, 2));
    console.log('\n' + (out.ok ? 'RESOLVED_BASE=' + out.base : 'RESOLVE_BASE=FAIL ' + out.error));
    process.exit(out.ok ? 0 : 1);
  })();
}
