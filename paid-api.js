/* __CONFORMANCE_OVERLAY__ */
(function () {
  const _http = require('http');
  const _o = _http.createServer.bind(_http);
  const dns = require('dns');
  const net = require('net');
  const path = require('path');
  let conf = null;
  try { conf = require(path.join(__dirname, 'x402-conformance.js')); } catch (e) {}

  function isPrivate(ip) {
    if (net.isIPv4(ip)) {
      const p = ip.split('.').map(Number);
      if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
      if (p[0] === 169 && p[1] === 254) return true;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
      if (p[0] === 192 && p[1] === 168) return true;
      if (p[0] >= 224) return true;
      return false;
    }
    const l = String(ip).toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127') || l.startsWith('::ffff:10') || l.startsWith('::ffff:192.168');
  }

  function guard(target, cb) {
    let u; try { u = new URL(target); } catch (e) { return cb('malformed_url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb('scheme_not_allowed');
    const host = u.hostname;
    if (net.isIP(host)) return cb(isPrivate(host) ? 'private_target_refused' : null);
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) return cb('dns_failed');
      if (!addrs || !addrs.length) return cb('dns_empty');
      for (const a of addrs) if (isPrivate(a.address)) return cb('private_target_refused');
      cb(null);
    });
  }

  function handle(req, res) {
    let p, qs;
    try { const u = new URL(req.url, 'http://x'); p = u.pathname; qs = u.searchParams; } catch (e) { return false; }
    if (p !== '/v1/x402-conformance') return false;
    const target = qs.get('url');
    const json = (code, obj) => { const b = Buffer.from(JSON.stringify(obj, null, 2));
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*' }); res.end(b); };
    if (!target) return json(400, { ok: false, error: 'url_required', usage: '/v1/x402-conformance?url=https://service' }), true;
    if (!conf || typeof conf.run !== 'function') return json(503, { ok: false, error: 'checker_module_unavailable' }), true;
    guard(target, async (why) => {
      if (why) return json(400, { ok: false, error: why, target });
      try {
        const r = await conf.run(target);
        const out = Object.assign({ ok: true, url: target, at: new Date().toISOString(),
          checks: (r.results || []).map(x => ({ name: x.name || x.id, ok: x.ok === true || x.pass === true, detail: x.detail || null })) }, r);
        json(200, out);
      } catch (e) { json(502, { ok: false, error: 'check_failed', detail: String(e.message) }); }
    });
    return true;
  }

  _http.createServer = function () {
    const a = Array.prototype.slice.call(arguments);
    const fns = a.filter(x => typeof x === 'function');
    const rest = a.filter(x => typeof x !== 'function');
    return _o.apply(_http, rest.concat([function (q, s) {
      try { if (handle(q, s)) return; } catch (e) {}
      for (const f of fns) { try { return f(q, s); } catch (e) {} }
      s.writeHead(500, { 'content-type': 'application/json' }); s.end('{"error":"no_handler"}');
    }]));
  };
})();

/* __ATTEST_OVERLAY__ */
(function () {
  const _http = require('http');
  const _o = _http.createServer.bind(_http);
  const fs = require('fs');
  const path = require('path');
  const DIR = __dirname;

  function readJson(f) { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { return null; } }
  function readLog() {
    try { return fs.readFileSync(path.join(DIR, 'ATTEST-LOG.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); }
    catch (e) { return []; }
  }
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function h(req, res) {
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    if (p !== '/v1/attest' && p !== '/attest') return false;
    const latest = readJson('ATTEST-LATEST.json');
    const log = readLog();
    const snapshot = readJson('index-snapshot.json');
    const out = {
      ok: true,
      what: 'Tamper-evident on-chain anchors of the verified-buyable x402 index.',
      how: 'The canonical index (sorted by url) is sha256-hashed, then committed in a zero-value Base self-transaction whose calldata is: AUTOMATON-X402-IDX v1 sha256=<hash> n=<count> <baseUrl>. Recompute the hash from index-snapshot.json and compare.',
      count: log.length,
      latest: latest,
      anchors: log,
      currentSnapshot: snapshot ? { generatedAt: snapshot.generatedAt, buyableCount: snapshot.buyableCount, checked: snapshot.checked } : null,
      verifyYourself: [
        '1. GET /v1/attest -> take anchors[].sha256 and anchors[].txHash',
        '2. GET /v1/index-snapshot -> canonical JSON',
        '3. sha256(JSON.stringify(snapshot)) must equal the anchored hash',
        '4. read txHash calldata on any Base RPC and confirm it utf8-decodes to the payload',
      ],
    };
    if (p === '/attest') {
      const rows = log.slice().reverse().map(a =>
        '<tr><td>' + esc(a.at) + '</td><td>' + esc(a.blockNumber) + '</td><td>n=' + esc(a.buyableCount) + '</td>' +
        '<td><code>' + esc(String(a.sha256).slice(0, 16)) + '…</code></td>' +
        '<td><a href="' + esc(a.explorer) + '" rel="noopener">tx</a></td></tr>').join('');
      const b = Buffer.from('<!doctype html><meta charset=utf-8><title>on-chain index anchors</title>' +
        '<style>body{font:13px/1.6 ui-monospace,Menlo,monospace;background:#0b0f14;color:#d7e3ee;padding:24px}a{color:#6ee7b7}' +
        'table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid #1c2733;text-align:left}th{color:#8fa6bb}</style>' +
        '<h1>Tamper-evident index anchors</h1><p>' + esc(out.how) + '</p>' +
        '<p>JSON: <a href="/v1/attest">/v1/attest</a> · snapshot: <a href="/v1/index-snapshot">/v1/index-snapshot</a></p>' +
        '<table><thead><tr><th>anchored at</th><th>Base block</th><th>entries</th><th>sha256</th><th>proof</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan=5>no anchors yet</td></tr>') + '</tbody></table>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'cache-control': 'public, max-age=300' });
      res.end(b); return true;
    }
    const b = Buffer.from(JSON.stringify(out, null, 2));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length,
      'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
    res.end(b); return true;
  }

  // also serve the raw canonical snapshot so a verifier can recompute the hash
  function hs(req, res) {
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    if (p !== '/v1/index-snapshot' && p !== '/index-snapshot.json') return false;
    let raw; try { raw = fs.readFileSync(path.join(DIR, 'index-snapshot.json')); } catch (e) { return false; }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': raw.length,
      'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
    res.end(raw); return true;
  }

  _http.createServer = function () {
    const a = Array.prototype.slice.call(arguments);
    const fns = a.filter(x => typeof x === 'function');
    const rest = a.filter(x => typeof x !== 'function');
    return _o.apply(_http, rest.concat([function (q, s) {
      try { if (h(q, s)) return; } catch (e) {}
      try { if (hs(q, s)) return; } catch (e) {}
      for (const f of fns) { try { return f(q, s); } catch (e) {} }
      s.writeHead(500, { 'content-type': 'application/json' }); s.end('{"error":"no_handler"}');
    }]));
  };
})();

/* __XLIVE_OVERLAY__ */
(function () {
  const _http = require('http');
  const _o = _http.createServer.bind(_http);
  let L = null;
  try { L = require(__dirname + '/x402-live.js'); } catch (e) { L = null; }

  function h(req, res) {
    if (!L) return false;
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    if (p === '/v1/x402-live' || p === '/x402-live' || p === '/v1/x402-live/refresh') {
      const force = p === '/v1/x402-live/refresh';
      const asJson = p !== '/x402-live';
      Promise.resolve(L.liveList({ refresh: force })).then(d => {
        let b;
        if (asJson) { b = Buffer.from(JSON.stringify(d, null, 2));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=120' }); }
        else { b = Buffer.from(L.renderHtml(d));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=120' }); }
        res.end(b);
      }).catch(e => {
        const b = Buffer.from('{"error":"live_failed","detail":' + JSON.stringify(String(e.message)) + '}');
        res.writeHead(500, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b);
      });
      return true;
    }
    return false;
  }

  _http.createServer = function () {
    const a = Array.prototype.slice.call(arguments);
    const hs = a.filter(x => typeof x === 'function');
    const r = a.filter(x => typeof x !== 'function');
    return _o.apply(_http, r.concat([function (q, s) {
      try { if (h(q, s)) return; } catch (e) {}
      for (const x of hs) { try { return x(q, s); } catch (e) {} }
      s.writeHead(500, { 'content-type': 'application/json' }); s.end('{"error":"no_handler"}');
    }]));
  };
})();

const __ORACLE = require('./paid-oracle.js'); /* __ORACLE_WIRED__ */
/* __BAZAAR_OVERLAY__ */
(function () {
  const _http = require('http');
  const _orig = _http.createServer.bind(_http);
  let mirror = null;
  try { mirror = require(__dirname + '/bazaar-mirror.js'); } catch (e) { mirror = null; }
  let lastRefresh = 0;

  function handle(req, res) {
    if (!mirror) return false;
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    const wantJson = p === '/v1/bazaar' || p === '/v1/bazaar/refresh';

    if (p === '/v1/bazaar' || p === '/bazaar' || p === '/v1/bazaar/refresh') {
      const force = p === '/v1/bazaar/refresh' && (Date.now() - lastRefresh > 60000);
      if (force) lastRefresh = Date.now();
      Promise.resolve(mirror.get({ refresh: force })).then(d => {
        if (wantJson) {
          const b = Buffer.from(JSON.stringify(d, null, 2));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
          res.end(b);
        } else {
          const b = Buffer.from(mirror.renderHtml(d));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
          res.end(b);
        }
      }).catch(e => {
        const b = Buffer.from('{"error":"mirror_failed","detail":' + JSON.stringify(String(e.message)) + '}');
        res.writeHead(500, { 'content-type': 'application/json', 'content-length': b.length });
        res.end(b);
      });
      return true;
    }
    return false;
  }

  _http.createServer = function () {
    const args = Array.prototype.slice.call(arguments);
    const handlers = args.filter(a => typeof a === 'function');
    const rest = args.filter(a => typeof a !== 'function');
    return _orig.apply(_http, rest.concat([function (req, res) {
      try { if (handle(req, res)) return; } catch (e) {}
      for (const h of handlers) { try { return h(req, res); } catch (e) {} }
      res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"no_handler"}');
    }]));
  };
})();

/* __WELLKNOWN_OVERLAY__ */
(function () {
  const fs = require('fs');
  const path = require('path');
  const ROOT = __dirname;
  const _http = require('http');
  const _orig = _http.createServer.bind(_http);

  function readJson(name) {
    try { return fs.readFileSync(path.join(ROOT, name), 'utf8'); } catch (e) { return null; }
  }
  function liveBase() {
    for (const f of ['paid-tunnel.url', 'tunnel.url']) {
      try { const u = fs.readFileSync(path.join(ROOT, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
    }
    return 'http://127.0.0.1:' + (process.env.PORT || 8081);
  }
  const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
  const USDC  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  function tryWellKnown(req, res) {
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    const J = (code, obj) => { const b = Buffer.from(JSON.stringify(obj, null, 2));
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }); res.end(b); };

    if (p === '/.well-known/agent-card.json' || p === '/agent-card.json') {
      const raw = readJson('agent-card.json');
      if (!raw) return null;
      const b = Buffer.from(raw);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*' });
      res.end(b); return true;
    }

    if (p === '/.well-known/x402' || p === '/.well-known/x402.json') {
      const base = liveBase();
      J(200, { x402Version: 1, seller: PAY_TO, name: 'Automaton-Sovereign Paid API', network: 'base', chainId: 8453,
        asset: USDC, assetSymbol: 'USDC', maxAmountRequired: '1000', payTo: PAY_TO,
        accepts: [{ scheme: 'eip3009', network: 'base',
          extra: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
          asset: USDC, payTo: PAY_TO, maxAmountRequired: '1000', maxTimeoutSeconds: 600,
          resource: base + '/paid/uuid', description: 'Caller-bound USDC utility; buyer needs no ETH; nonce consumed on-chain.',
          mimeType: 'application/json', header: 'X-PAYMENT-AUTH' }],
        free: [base + '/health', base + '/pricing', base + '/ledger'],
        paid: ['/paid/hash', '/paid/uuid', '/paid/time', '/paid/hashchain'].map(x => base + x) });
      return true;
    }

    if (p === '/.well-known/ai-plugin.json') {
      const base = liveBase();
      J(200, { schema_version: 'v1', name_for_human: 'Automaton-Sovereign Paid API',
        name_for_model: 'automaton_sovereign', description_for_model: 'x402-metered compute utilities on Base. Paid calls require an EIP-712 EIP-3009 authorization in X-PAYMENT-AUTH.',
        auth: { type: 'none' }, api: { type: 'openapi', url: base + '/openapi.json' } });
      return true;
    }
    return false;
  }

  _http.createServer = function () {
    const args = Array.prototype.slice.call(arguments);
    const handlers = args.filter(a => typeof a === 'function');
    const rest = args.filter(a => typeof a !== 'function');
    return _orig.apply(_http, rest.concat([function (req, res) {
      try { if (tryWellKnown(req, res)) return; } catch (e) {}
      for (const h of handlers) { try { return h(req, res); } catch (e) {} }
      res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"no_handler"}');
    }]));
  };
})();

// paid-api.js v1.0.0 e a CLEAN, single-source caller-bound paid API.
//
// WHY A NEW SERVICE: the main server (server.js) accumulated seven overlapping overlays across
// sessions. The money path got tangled: a competing facilitator overlay intercepted settlement,
// applied its own `self_send_not_allowed` check, and the verify stage hung. Untangling accreted
// monkey-patches is slower and riskier than owning one small, auditable service.
//
// This service is the money path, end to end, in one file with no overlays:
//   - 402 challenge advertising CALLER-BOUND EIP-3009 (a txHash is a bearer token; a signature
//     binds the payer e this is the audited-correct scheme).
//   - Verification by EIP-712 signature recovery (caller binding) with atomic, persistent,
//     RESTART-SAFE nonce claims and a native on-chain nonce check.
//   - SETTLEMENT via my own funded facilitator (facilitator.js), so a buyer who holds only USDC
//     and NO ETH can still pay. Broadcast happens before the response; fail closed.
//
// Port 8081 by default. Zero dependencies beyond ethers (already installed for the facilitator).

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ethers = require('ethers');
const F = require('./facilitator.js');

const PORT = parseInt(process.env.PAID_API_PORT || '8081', 10);
const PAY_TO = process.env.PAY_TO || '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PRICE_UNITS = BigInt(process.env.PRICE_UNITS || '1000'); // 0.001 USDC (6dp)
const NETWORK = 'base';
const CHAIN_ID = 8453;
const USDC = F.USDC;

const NONCE_FILE = path.join(__dirname, 'paid-api-nonces.jsonl');
const LEDGER_FILE = path.join(__dirname, 'paid-api-ledger.jsonl');
const STATS_FILE = path.join(__dirname, 'paid-api-stats.json');

// ---------- persistent state ----------
const usedNonces = new Map();     // nonce -> {from, endpoint, value, tx, at}
function loadNonces() {
  try {
    fs.readFileSync(NONCE_FILE, 'utf8').split('\n').filter(Boolean).forEach(l => {
      try { const r = JSON.parse(l); if (r.nonce) usedNonces.set(r.nonce, r); } catch (e) {}
    });
  } catch (e) {}
}
function claimNonce(nonce, info) {
  if (usedNonces.has(nonce)) return false;   // synchronous => race-free
  usedNonces.set(nonce, info);
  try { fs.appendFileSync(NONCE_FILE, JSON.stringify(Object.assign({ nonce }, info)) + '\n'); } catch (e) {}
  return true;
}
function releaseNonce(nonce) { usedNonces.delete(nonce); }

let stats = { startedAt: new Date().toISOString(), free: 0, paidCalls: 0, rejected: 0, challenges: 0, settledUnits: '0', byEndpoint: {} };
function loadStats() { try { Object.assign(stats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))); } catch (e) {} }
function saveStats() { try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch (e) {} }

function appendLedger(rec) { try { fs.appendFileSync(LEDGER_FILE, JSON.stringify(Object.assign({ at: new Date().toISOString() }, rec)) + '\n'); } catch (e) {} }

// ---------- helpers ----------
function send(res, code, body, headers = {}) {
  const isStr = typeof body === 'string';
  const payload = isStr ? body : JSON.stringify(body, null, 2);
  res.writeHead(code, Object.assign({
    'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-payment-auth',
    'cache-control': 'no-store',
  }, headers));
  res.end(payload);
}
function baseUrl(req) {
  const h = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || ('127.0.0.1:' + PORT);
  return h + '://' + host;
}

function priceUsdc() { return (Number(PRICE_UNITS) / 1e6).toFixed(6); }

function challenge(req, endpoint, extra) {
  const b = baseUrl(req);
  return Object.assign({
    x402Version: 1,
    error: 'payment_required',
    schemes: ['eip3009'],
    accepts: [{
      scheme: 'eip3009',
      network: NETWORK,
      chainId: CHAIN_ID,
      asset: USDC,
      payTo: PAY_TO,
      maxAmountRequired: PRICE_UNITS.toString(),
      resource: b + endpoint,
      description: 'Automaton-Sovereign paid API call (caller-bound)',
      mimeType: 'application/json',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    }],
    howToPay: {
      scheme: 'eip3009',
      header: 'X-PAYMENT-AUTH',
      format: 'base64(JSON({payload: {from,to,value,validAfter,validBefore,nonce}, signature}))',
      note: 'Sign EIP-712 TransferWithAuthorization for USD Coin on Base (:8453, 0x8335...2913). The buyer needs NO ETH e this service settles on-chain. A raw txHash is NOT accepted: it is a bearer token that does not bind the payer.',
      amountUsdc: priceUsdc(),
    },
    facilitator: { address: PAY_TO, paysGas: true, settling: true },
  }, extra || {});
}

// ---------- paid endpoints ----------
function endpointHandler(name, query) {
  switch (name) {
    case 'hash': {
      const d = query.get('data') || query.get('input') || '';
      return { sha256: crypto.createHash('sha256').update(d).digest('hex'), inputBytes: Buffer.byteLength(d) };
    }
    case 'uuid':
      return { uuid: crypto.randomUUID() };
    case 'time':
      return { iso: new Date().toISOString(), unix: Math.floor(Date.now() / 1000) };
    case 'hashchain': {
      const n = Math.min(parseInt(query.get('n') || '8', 10), 64);
      let h = crypto.createHash('sha256').update(query.get('seed') || 'genesis').digest('hex');
      const chain = [h];
      for (let i = 1; i < n; i++) { h = crypto.createHash('sha256').update(h).digest('hex'); chain.push(h); }
      return { length: n, chain, head: h };
    }
    default:
      return null;
  }
}

// ---------- the paid path ----------
async function authorizeAndSettle(req, endpoint) {
  const hdr = req.headers['x-payment-auth'];
  if (!hdr) return { ok: false, code: 402, body: challenge(req, endpoint) };

  let env;
  try { env = JSON.parse(Buffer.from(String(hdr), 'base64').toString('utf8')); }
  catch (e) { stats.rejected++; saveStats(); return { ok: false, code: 402, body: challenge(req, endpoint, { reason: 'malformed_envelope' }) }; }

  const payload = env.payload || env;
  if (!payload || !payload.nonce) { stats.rejected++; saveStats(); return { ok: false, code: 402, body: challenge(req, endpoint, { reason: 'missing_nonce' }) }; }

  // atomic local claim BEFORE any await => closes the race and survives restart
  if (!claimNonce(payload.nonce, { from: payload.from, endpoint, value: String(payload.value), at: new Date().toISOString() })) {
    stats.rejected++; saveStats();
    return { ok: false, code: 402, body: challenge(req, endpoint, { reason: 'nonce_already_used' }) };
  }

  let r;
  try {
    r = await F.settleAuthorization({ payload, signature: env.signature || env.sig }, { minUnits: PRICE_UNITS, to: PAY_TO });
  } catch (e) {
    r = { ok: false, reason: 'settle_exception:' + String(e.message).slice(0, 120) };
  }

  if (!r.ok) {
    releaseNonce(payload.nonce);
    stats.rejected++; saveStats();
    appendLedger({ event: 'settle_failed', reason: r.reason, from: payload.from, endpoint });
    return { ok: false, code: 402, body: challenge(req, endpoint, { reason: r.reason, detail: r }) };
  }

  // committed: record settlement
  claimNonce(payload.nonce, { from: payload.from, endpoint, value: String(payload.value), tx: r.txHash, settled: true, at: new Date().toISOString() });
  stats.paidCalls++; stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1;
  stats.settledUnits = (BigInt(stats.settledUnits) + BigInt(payload.value)).toString();
  saveStats();
  appendLedger({ event: 'settled', from: payload.from, to: payload.to, value: String(payload.value), nonce: payload.nonce, tx: r.txHash, block: r.blockNumber, gasUsed: r.gasUsed, endpoint });
  return {
    ok: true,
    headers: {
      'X-Payment-Settled': 'true',
      'X-Payment-Scheme': 'eip3009',
      'X-Payment-Tx': r.txHash,
      'X-Payment-From': payload.from,
      'X-Payment-Caller-Bound': 'true',
      'X-Payment-Amount': payload.value,
    },
    settlement: r,
  };
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'bad_url' }); }
  const p = u.pathname;
  const q = u.searchParams;

  if (req.method === 'OPTIONS') return send(res, 204, '', { 'access-control-allow-methods': 'GET,OPTIONS' });

  if (p === '/health') {
    let fac = { configured: true, address: PAY_TO };
    try { const { wallet } = F.loadWallet(F.newProvider()); fac.eth = ethers.formatEther(await F.newProvider().getBalance(wallet.address)); } catch (e) { fac.eth = null; }
    return send(res, 200, {
      status: 'ok', service: 'automaton-paid-api', version: '1.0.0', schemes: ['eip3009'],
      payTo: PAY_TO, priceUsdc: priceUsdc(), chainId: CHAIN_ID, asset: USDC,
      facilitator: fac, stats: { paidCalls: stats.paidCalls, rejected: stats.rejected, challenges: stats.challenges, settledUnits: stats.settledUnits },
      uptimeSeconds: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
    });
  }

  if (p === '/pricing' || p === '/.well-known/x402') {
    return send(res, 200, {
      service: 'automaton-paid-api', version: '1.0.0',
      pricing: { scheme: 'eip3009', amountUnits: PRICE_UNITS.toString(), amountUsdc: priceUsdc(), asset: USDC, network: NETWORK, chainId: CHAIN_ID, payTo: PAY_TO },
      endpoints: PAID_ROUTES.map(r => ({ path: '/paid/' + r, priceUsdc: priceUsdc(), description: (__ORACLE.INFO[r] && __ORACLE.INFO[r].description) || undefined, params: (__ORACLE.INFO[r] && __ORACLE.INFO[r].params) || undefined })),
      free: ['/health', '/pricing', '/.well-known/x402', '/ledger', '/'],
      note: 'Caller-bound EIP-3009. Buyer needs USDC only (no ETH): this service settles on-chain.',
    });
  }

  if (p === '/ledger') {
    let tail = [];
    try { tail = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean).slice(-20).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
    return send(res, 200, { count: tail.length, entries: tail });
  }

  if (p === '/' || p === '/index.html') {
    return send(res, 200, { service: 'Automaton-Sovereign Paid API', version: '1.0.0',
      summary: 'Caller-bound x402 payments (EIP-3009) over USDC on Base. Buyer needs no ETH.',
      free: ['/health', '/pricing', '/.well-known/x402', '/ledger'], paid: PAID_ROUTES.map(r => '/paid/' + r) });
  }

  if (p.startsWith('/paid/')) {
    const name = p.slice('/paid/'.length);
    if (!PAID_ROUTES.includes(name)) return send(res, 404, { error: 'unknown_paid_route', paid: PAID_ROUTES });
    const auth = await authorizeAndSettle(req, '/paid/' + name);
    if (!auth.ok) { stats.challenges = stats.challenges + (auth.code === 402 ? 1 : 0); saveStats(); return send(res, auth.code, auth.body); }
    const __qs = new URLSearchParams(String(req.url).split('?')[1] || '');
    const out = (__ORACLE.handlers[name] ? await __ORACLE.handlers[name](__qs) : endpointHandler(name, q)) || { error: 'handler_missing' };
    return send(res, 200, Object.assign({ _paid: true, endpoint: name, payment: { tx: auth.settlement.txHash, from: auth.settlement.settled.from, amount: auth.settlement.settled.value, callerBound: true } }, out), auth.headers);
  }

  stats.free++;
  return send(res, 404, { error: 'not_found', free: ['/health', '/pricing', '/.well-known/x402', '/ledger', '/'], paid: PAID_ROUTES.map(r => '/paid/' + r) });
});

const PAID_ROUTES = ['hash','uuid','time','hashchain','clock','block','gas','balance','nonce'];

loadNonces(); loadStats();
server.listen(PORT, () => {
  console.log('[paid-api] v1.0.0 on :' + PORT + ' payTo=' + PAY_TO + ' price=' + priceUsdc() + ' USDC scheme=eip3009(caller-bound) nonces=' + usedNonces.size);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
