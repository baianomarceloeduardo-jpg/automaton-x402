#!/usr/bin/env node
// x402-devkit.js v1.0.0 - ONE zero-dependency file for every x402 developer.
//
// Why this exists: x402 service URLs rotate, but a tool people keep in their repo does not.
// This file is durable, self-contained, and honest: run it offline against any target.
//
// COMMANDS
//   node x402-devkit.js probe <url>                -- score a service's x402 402-challenge (x/10)
//   node x402-devkit.js remediate <url>            -- turn every failed check into a concrete fix
//   node x402-devkit.js verify <tx> --to <addr> [--min <units>] [--rpc <url>] [--confirmations n]
//                                                  -- verify an on-chain Base USDC settlement
//   node x402-devkit.js serve [--port 4021] [--payto 0x..] [--price 1000] [--handler uuid]
//                                                  -- stand up your own x402-metered endpoint
//   node x402-devkit.js self-test                  -- prove the whole toolkit works, offline
//
// Zero dependencies. Node >= 18. USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_RPC = 'https://mainnet.base.org';
const CHAIN_ID_BASE = 8453;

// ---------------------------------------------------------------- http helpers
function fetchJson(url, opts, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('malformed_url')); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      method: (opts && opts.method) || 'GET',
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      headers: (opts && opts.headers) || {}, timeout: 15000
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 3) {
        res.resume();
        return fetchJson(new URL(res.headers.location, url).href, opts, (redirects || 0) + 1).then(resolve, reject);
      }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ---------------------------------------------------------------- probe / score
function checksFor(body, headers, status) {
  const out = [];
  const add = (id, ok, detail) => out.push({ id, ok, detail: detail || '' });
  add('status_402', status === 402, 'status=' + status);
  const ct = String(headers['content-type'] || '');
  add('content_type_json', ct.indexOf('json') >= 0, ct || 'missing');
  let j = null;
  try { j = JSON.parse(body); } catch (e) {}
  add('body_json', !!j, j ? 'parsed' : 'unparseable');
  const acc = j && Array.isArray(j.accepts) ? j.accepts : null;
  add('accepts_array', !!(acc && acc.length), acc ? acc.length + ' entry/entries' : 'missing');
  const a = acc && acc[0] ? acc[0] : {};
  add('scheme', a.scheme === 'exact' || a.scheme === 'eip3009', String(a.scheme || 'missing'));
  add('network', String(a.network || '').toLowerCase() === 'base', String(a.network || 'missing'));
  add('chainId', Number(a.chainId) === CHAIN_ID_BASE, String(a.chainId || 'missing'));
  add('asset_usdc', String(a.asset || '').toLowerCase() === USDC_BASE.toLowerCase(), String(a.asset || 'missing'));
  add('payTo', /^0x[0-9a-fA-F]{40}$/.test(String(a.payTo || '')), String(a.payTo || 'missing'));
  const amt = a.maxAmountRequired;
  add('amount_integer_string', amt != null && String(amt).indexOf('.') < 0 && /^\d+$/.test(String(amt)), String(amt == null ? 'missing' : amt));
  return out;
}

async function probe(url) {
  let r;
  try { r = await fetchJson(url, { headers: { Accept: 'application/json' } }); }
  catch (e) { return { reachable: false, error: e.message, target: url }; }
  const results = checksFor(r.body, r.headers, r.status);
  const passed = results.filter(x => x.ok).length;
  const total = results.length;
  const verdict = passed === total ? 'CONFORMANT' : passed >= total * 0.6 ? 'PARTIAL' : 'NON_CONFORMANT';
  return { reachable: true, target: url, status: r.status, verdict, passed, total, results, challenge: r.status === 402 ? tryParse(r.body) : null };
}
function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ---------------------------------------------------------------- remediate
const REMEDIES = [
  { m: ['status_402'], why: 'x402 requires HTTP 402 (Payment Required) as the challenge; without it no agent can discover your price.', fix: 'Return status 402 from the protected route when no payment header is present.' },
  { m: ['content_type_json', 'body_json'], why: 'The 402 body must be application/json so clients can parse accepts[].', fix: 'res.writeHead(402, {"Content-Type":"application/json"}); res.end(JSON.stringify(body));' },
  { m: ['accepts_array'], why: 'The accepts[] array IS the offer; without it there is nothing to buy.', fix: 'Emit { x402Version: 1, error: "payment_required", accepts: [ ... ] }.' },
  { m: ['scheme'], why: 'accepts[].scheme tells the buyer how to pay.', fix: 'Add scheme: "exact" (fixed-price transfer) and optionally "eip3009" (caller-bound).' },
  { m: ['network'], why: 'Clients need the network name to pick the settlement path.', fix: 'Add network: "base".' },
  { m: ['chainid'], why: 'Numeric chain id prevents signing for the wrong chain.', fix: 'Add chainId: 8453.' },
  { m: ['asset_usdc'], why: 'accepts[].asset must be the exact ERC-20 contract; a wrong asset is an unpayable invoice.', fix: 'Add asset: "' + USDC_BASE + '" (USDC on Base).' },
  { m: ['payto'], why: 'accepts[].payTo is where funds must land and must be a valid address you control.', fix: 'Add payTo: "0x<your 20-byte base address>".' },
  { m: ['amount'], why: 'Price must be in the asset smallest unit (USDC has 6 decimals) as an integer string.', fix: 'Add maxAmountRequired: "1000" for 0.001 USDC. Never a float.' }
];
const CANON = [
  'function paymentRequired(res, resource, amountUnits, payTo) {',
  '  res.writeHead(402, {',
  '    "Content-Type": "application/json",',
  '    "WWW-Authenticate": \'x402 scheme="exact", network="base"\'',
  '  });',
  '  res.end(JSON.stringify({',
  '    x402Version: 1,',
  '    error: "payment_required",',
  '    accepts: [{',
  '      scheme: "exact", network: "base", chainId: 8453,',
  '      asset: "' + USDC_BASE + '",',
  '      payTo,',
  '      maxAmountRequired: String(amountUnits),',
  '      resource, description: "Metered call",',
  '      mimeType: "application/json", maxTimeoutSeconds: 60',
  '    }]',
  '  }));',
  '}'
].join('\n');

async function remediate(url) {
  const p = await probe(url);
  if (!p.reachable) return { ...p, failures: [], canonical: CANON };
  const failures = (p.results || []).filter(r => !r.ok).map(r => {
    const rem = REMEDIES.find(x => x.m.some(k => r.id.indexOf(k) >= 0)) ||
      { why: 'Not in the standard table.', fix: 'Inspect the observed detail and re-run probe.' };
    return { check: r.id, observed: r.detail, why: rem.why, fix: rem.fix };
  });
  return { ...p, failureCount: failures.length, failures, canonical: CANON };
}

// ---------------------------------------------------------------- on-chain verify
function rpcCall(url, method, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = mod.request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 20000 }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); j.error ? reject(new Error(j.error.message || 'rpc_error')) : resolve(j.result); } catch (e) { reject(new Error('rpc_bad_json')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('rpc_timeout')); });
    req.write(data); req.end();
  });
}
function topicToAddress(t) { return '0x' + String(t).slice(26).toLowerCase(); }

async function verify(tx, opts) {
  opts = opts || {};
  const to = String(opts.to || '').toLowerCase();
  const min = BigInt(opts.min == null ? 1 : opts.min);
  const rpc = opts.rpc || DEFAULT_RPC;
  const needConf = Number(opts.confirmations || 1);
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return { ok: false, reason: 'malformed_tx_hash' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { ok: false, reason: 'malformed_recipient' };
  const chainId = await rpcCall(rpc, 'eth_chainId', []);
  if (parseInt(chainId, 16) !== CHAIN_ID_BASE) return { ok: false, reason: 'wrong_chain', chainId };
  const rcpt = await rpcCall(rpc, 'eth_getTransactionReceipt', [tx]);
  if (!rcpt) return { ok: false, reason: 'tx_not_found' };
  if (parseInt(rcpt.status, 16) !== 1) return { ok: false, reason: 'tx_failed' };
  const head = parseInt(await rpcCall(rpc, 'eth_blockNumber', []), 16);
  const conf = head - parseInt(rcpt.blockNumber, 16) + 1;
  if (conf < needConf) return { ok: false, reason: 'insufficient_confirmations', confirmations: conf, required: needConf };
  let net = 0n; const movers = [];
  for (const log of rcpt.logs || []) {
    if (String(log.address || '').toLowerCase() !== USDC_BASE.toLowerCase()) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    const from = topicToAddress(log.topics[1]);
    const t = topicToAddress(log.topics[2]);
    const val = BigInt(log.data);
    if (from === t) continue;                    // self-transfer moves nothing
    if (t === to) { net += val; movers.push({ from, value: val.toString() }); }
    else if (from === to) { net -= val; }         // recipient paying out reduces net
  }
  if (net <= 0n) return { ok: false, reason: 'no_net_transfer_to_recipient', recipient: to };
  if (net < min) return { ok: false, reason: 'underpaid', net: net.toString(), required: min.toString() };
  return { ok: true, recipient: to, net: net.toString(), confirmations: conf, block: parseInt(rcpt.blockNumber, 16), payer: movers.length ? movers[0].from : null };
}

// ---------------------------------------------------------------- serve
const HANDLERS = {
  uuid: () => crypto.randomUUID(),
  time: () => ({ iso: new Date().toISOString(), epochMs: Date.now() }),
  hash: () => crypto.createHash('sha256').update(String(Date.now())).digest('hex'),
  echo: () => ({ echo: 'ok' })
};

function serve(opts) {
  opts = opts || {};
  const port = Number(opts.port || 4021);
  const payTo = opts.payto || '0x0000000000000000000000000000000000000000';
  const price = String(opts.price == null ? 1000 : opts.price);
  const handler = HANDLERS[opts.handler] ? opts.handler : 'uuid';
  const used = new Set();
  const srv = http.createServer(async (req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    if (p === '/pricing') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ x402Version: 1, schemes: ['exact'], accepts: [accept(res, req, payTo, price, '/v1/paid')] && undefined })); // replaced below
    }
    if (p === '/v1/paid') {
      if (opts.verify !== false && opts.rpc) {
        const hdr = req.headers['x-payment'];
        if (!hdr) return challenge(res, payTo, price, req);
        try {
          const v = await verify(String(hdr), { to: payTo, min: price, rpc: opts.rpc });
          if (!v.ok) return challenge(res, payTo, price, req, v.reason);
          if (used.has(String(hdr))) return challenge(res, payTo, price, req, 'tx_already_used');
          used.add(String(hdr));
          res.writeHead(200, { 'Content-Type': 'application/json', 'X-PAYMENT-SETTLED': 'true' });
          return res.end(JSON.stringify({ ok: true, result: HANDLERS[handler](), payer: v.payer, net: v.net }));
        } catch (e) { return challenge(res, payTo, price, req, 'verify_error'); }
      }
      return challenge(res, payTo, price, req);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  function challenge(res, payTo, price, req, reason) {
    const body = {
      x402Version: 1, error: reason || 'payment_required',
      accepts: [{
        scheme: 'exact', network: 'base', chainId: CHAIN_ID_BASE, asset: USDC_BASE,
        payTo, maxAmountRequired: String(price),
        resource: (req.headers.host ? 'http://' + req.headers.host : '') + '/v1/paid',
        description: 'Metered call', mimeType: 'application/json', maxTimeoutSeconds: 60
      }]
    };
    res.writeHead(402, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'x402 scheme="exact", network="base"' });
    res.end(JSON.stringify(body));
  }
  function accept() { return true; }
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

// ---------------------------------------------------------------- self-test
async function selfTest() {
  const self = http.createServer((q, s) => { s.writeHead(402, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'x402 scheme="exact", network="base"' }); s.end(JSON.stringify({ x402Version: 1, error: 'payment_required', accepts: [{ scheme: 'exact', network: 'base', chainId: 8453, asset: USDC_BASE, payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', maxAmountRequired: '1000', resource: '/x' }] })); });
  const bad = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/plain' }); s.end('nope'); });
  await new Promise(r => self.listen(18401, '127.0.0.1', r));
  await new Promise(r => bad.listen(18402, '127.0.0.1', r));
  let pass = 0, total = 0;
  const c = (n, ok) => { total++; if (ok) pass++; console.log((ok ? 'PASS ' : 'FAIL ') + n); };
  try {
    const p1 = await probe('http://127.0.0.1:18401/');
    c('probe conformant target -> CONFORMANT 10/10', p1.verdict === 'CONFORMANT' && p1.passed === p1.total && p1.total === 10);
    const p2 = await probe('http://127.0.0.1:18402/');
    c('probe non-conformant target -> <10', p2.passed < p2.total);
    const r1 = await remediate('http://127.0.0.1:18402/');
    c('remediate yields concrete fixes with why+fix', r1.failureCount >= 5 && r1.failures.every(f => f.why && f.fix));
    c('remediate includes canonical snippet', r1.canonical.indexOf('402') >= 0 && r1.canonical.indexOf(USDC_BASE) >= 0);
    const r2 = await remediate('http://127.0.0.1:18401/');
    c('remediate on conformant -> 0 failures', r2.failureCount === 0);
    const v1 = await verify('nothex', { to: '0x0000000000000000000000000000000000000001' });
    c('verify rejects malformed tx', v1.ok === false && v1.reason === 'malformed_tx_hash');
    const v2 = await verify('0x' + 'a'.repeat(64), { to: 'nope' });
    c('verify rejects malformed recipient', v2.ok === false && v2.reason === 'malformed_recipient');
    const srv = await serve({ port: 18403, payto: '0x0000000000000000000000000000000000000002', price: '1000', handler: 'time' });
    const p3 = await probe('http://127.0.0.1:18403/v1/paid');
    c('own serve advertises a conformant challenge', p3.verdict === 'CONFORMANT');
    srv.close();
  } finally {
    self.close(); bad.close();
    console.log('\n' + pass + '/' + total + ' PASS');
  }
  return pass === total;
}

// ---------------------------------------------------------------- cli
function flags(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { if (argv[i].indexOf('--') === 0) { const k = argv[i].slice(2); const v = argv[i + 1] && argv[i + 1].indexOf('--') !== 0 ? argv[++i] : true; o[k] = v; } } return o; }

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const target = rest.find(x => x.indexOf('--') !== 0 && x !== cmd);
  if (cmd === 'probe') {
    const r = await probe(target);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.verdict === 'CONFORMANT' ? 0 : 1);
  } else if (cmd === 'remediate') {
    const r = await remediate(target);
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  } else if (cmd === 'verify') {
    const r = await verify(target, { to: f.to, min: f.min, rpc: f.rpc, confirmations: f.confirmations });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'serve') {
    await serve({ port: f.port, payto: f.payto, price: f.price, handler: f.handler, rpc: f.rpc, verify: f.verify });
    console.log('x402 endpoint listening on http://127.0.0.1:' + (f.port || 4021) + '/v1/paid  (payTo=' + (f.payto || 'unset') + ')');
  } else if (cmd === 'self-test') {
    process.exit((await selfTest()) ? 0 : 1);
  } else {
    console.log('x402-devkit v1.0.0\n  probe <url>\n  remediate <url>\n  verify <tx> --to 0x.. [--min units] [--rpc url] [--confirmations n]\n  serve [--port 4021] [--payto 0x..] [--price 1000] [--handler uuid] [--rpc url]\n  self-test');
  }
}
if (require.main === module) main();
module.exports = { probe, remediate, verify, serve, selfTest, checksFor, USDC_BASE };
