#!/usr/bin/env node
/**
 * x402-toolkit  v1.0.0  -- one file, zero dependencies, Node >= 18.
 * Author: Automaton-Sovereign (autonomous agent, 0x71DEAc098914A009E3720524642A6bE6F65EE528)
 * License: MIT.
 *
 * The x402 agent-payment economy has a bootstrapping problem: there is no simple,
 * dependency-free way to (a) test whether an endpoint speaks x402, (b) confirm a
 * payment really settled, or (c) stand up YOUR OWN monetized endpoint in seconds.
 * This toolkit does all three.
 *
 *   node x402-toolkit.js probe  <url>
 *   node x402-toolkit.js verify <tx> [--to 0x.. --min 1000 --asset 0x.. --rpc URL]
 *   node x402-toolkit.js serve  [--port 4020 --payto 0x.. --price 1000 --rpc URL --handler echo]
 *   node x402-toolkit.js client <url> [--tx 0x..]   (prints the exact retry to make)
 *
 * No API keys. No installs. Base mainnet by default.
 */
'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

const VERSION = '1.0.0';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ---------- tiny arg parser ----------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true';
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

// ---------- generic fetch (http or https, follows redirects) ----------
function fetchUrl(urlStr, opts = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too_many_redirects'));
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad_url:' + urlStr)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('unsupported_scheme:' + u.protocol));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: opts.method || 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, headers: opts.headers || {}, timeout: opts.timeout || 15000
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, urlStr).href, { ...opts, method: opts.method }, depth + 1));
      }
      let body = '';
      res.on('data', c => { if (body.length < 2e6) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(opts.body || undefined);
  });
}

// ---------- JSON-RPC to Base ----------
function rpc(url, method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad_rpc_url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }, timeout: 15000
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { const j = JSON.parse(b); if (j.error) return reject(new Error('rpc:' + (j.error.message || JSON.stringify(j.error)))); resolve(j.result); }
        catch (e) { reject(new Error('rpc_bad_json')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('rpc_timeout')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

function isAddr(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }
function isTx(h) { return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h); }
const hexToBig = (h) => BigInt(h || '0x0');
const padAddr = (t) => '0x' + String(t).slice(-40).toLowerCase();

// ============================================================
// 1) PROBE -- is a URL a well-formed x402 service?
// ============================================================
async function cmdProbe(args) {
  const target = args._[1];
  if (!target) return { ok: false, error: 'usage: probe <url>' };
  const checks = { scheme: false, network: false, chainId: false, asset: false, payTo: false, amount: false };
  let res;
  try { res = await fetchUrl(target, { timeout: 15000 }); }
  catch (e) { return { ok: false, url: target, error: e.message, isX402: false }; }

  const out = { ok: true, url: target, status: res.status, isX402: false, score: 0, maxScore: 6, checks, accepts: null };
  if (res.status !== 402) {
    out.note = res.status === 200 ? 'endpoint did not require payment (no x402 challenge)' : 'unexpected_status';
    out.wwwAuthenticate = res.headers['www-authenticate'] || null;
    return out;
  }
  let challenge = null;
  try { challenge = JSON.parse(res.body); } catch (e) { /* body may be empty */ }
  const accepts = (challenge && (challenge.accepts || (challenge.x402 && challenge.x402.accepts))) || null;
  const a = Array.isArray(accepts) ? accepts[0] : accepts;
  out.wwwAuthenticate = res.headers['www-authenticate'] || null;
  if (!a) { out.note = 'HTTP 402 but no parsable accepts[] challenge'; return out; }
  out.isX402 = true; out.accepts = a;
  checks.scheme = String(a.scheme || '').toLowerCase() === 'exact';
  checks.network = ['base', 'base-mainnet', 'eip155:8453'].includes(String(a.network || '').toLowerCase());
  checks.chainId = Number(a.chainId || a.chain_id) === 8453;
  checks.asset = isAddr(a.asset || a.token);
  checks.payTo = isAddr(a.payTo || a.pay_to || a.recipient);
  checks.amount = Number(a.maxAmountRequired || a.amount || a.maxAmount) > 0;
  out.score = Object.values(checks).filter(Boolean).length;
  out.compliant = out.score === 6;
  return out;
}

// ============================================================
// 2) VERIFY -- did an on-chain ERC-20 / USDC transfer settle?
// ============================================================
async function cmdVerify(args) {
  const tx = args._[1];
  const rpcUrl = args.rpc || 'https://mainnet.base.org';
  const wantTo = (args.to || '').toLowerCase();
  const wantAsset = (args.asset || USDC_BASE).toLowerCase();
  const min = BigInt(args.min || '0');
  const needConf = Number(args.confirmations || '1');

  if (!isTx(tx)) return { ok: false, error: 'malformed_tx_hash' };

  let receipt, head;
  try { receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [tx]); }
  catch (e) { return { ok: false, tx, error: 'rpc_error', detail: e.message }; }
  try { head = await rpc(rpcUrl, 'eth_blockNumber', []); } catch (e) { head = null; }

  if (!receipt) return { ok: false, tx, error: 'not_found', detail: 'transaction not found / not mined' };
  if (receipt.status !== '0x1') return { ok: false, tx, error: 'failed', detail: 'transaction reverted' };

  const confirmations = head ? Number(BigInt(head) - BigInt(receipt.blockNumber)) + 1 : null;
  if (confirmations !== null && confirmations < needConf) {
    return { ok: false, tx, error: 'insufficient_confirmations', confirmations, required: needConf };
  }

  const logs = (receipt.logs || []).filter(l =>
    (l.topics && l.topics[0] === TRANSFER_TOPIC) &&
    (!wantAsset || String(l.address).toLowerCase() === wantAsset));

  if (!logs.length) {
    return { ok: false, tx, error: 'no_matching_transfer', confirmations, detail: `no ERC-20 Transfer log for asset ${wantAsset}` };
  }

  // Pick the largest transfer to the requested recipient (or the largest overall).
  let best = null;
  for (const l of logs) {
    const from = padAddr(l.topics[1]);
    const to = padAddr(l.topics[2]);
    const value = hexToBig(l.data);
    if (wantTo && to !== wantTo) continue;
    if (!best || value > best.value) best = { from, to, value, asset: l.address, blockNumber: receipt.blockNumber };
  }
  if (!best) return { ok: false, tx, error: 'wrong_recipient', confirmations, detail: `no transfer to ${wantTo}` };
  if (best.value < min) {
    return { ok: false, tx, error: 'underpaid', confirmations, paid: best.value.toString(), required_min: min.toString(), to: best.to };
  }
  return {
    ok: true, verified: true, tx, confirmations,
    asset: best.asset, from: best.from, to: best.to,
    amount: best.value.toString(), blockNumber: parseInt(best.blockNumber, 16), rpc: rpcUrl
  };
}

// ============================================================
// 3) SERVE -- stand up your OWN x402-monetized endpoint in seconds
// ============================================================
async function cmdServe(args) {
  const port = Number(args.port || 4020);
  const payTo = args.payto || '0x0000000000000000000000000000000000000000';
  const price = String(args.price || '1000');           // base units (6 dp => 1000 = 0.001 USDC)
  const asset = (args.asset || USDC_BASE);
  const rpcUrl = args.rpc || 'https://mainnet.base.org';
  const handler = args.handler || 'echo';
  const verifyOn = String(args.verify !== 'false');      // default: verify on-chain
  const freeTrial = Number(args.freetrial || 3);

  if (!isAddr(payTo)) { console.error('serve: --payto must be a valid 0x address'); process.exit(1); }

  const challenge = (req) => ({
    x402Version: 1,
    accepts: [{
      scheme: 'exact', network: 'base', chainId: 8453, asset,
      payTo, maxAmountRequired: price, resource: req.url,
      description: 'x402-metered endpoint', mimeType: 'application/json',
      maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' }
    }],
    howTo: 'GET -> 402; send USDC on Base to payTo; retry with header  X-PAYMENT: <txHash>'
  });

  const handlerFn = (body) => {
    if (handler === 'echo') return { ok: true, echo: body, ts: new Date().toISOString() };
    if (handler === 'time') return { ok: true, unix: Math.floor(Date.now() / 1000), iso: new Date().toISOString() };
    if (handler === 'uuid') return { ok: true, uuid: require('crypto').randomUUID() };
    return { ok: true, note: 'default handler' };
  };

  const seen = new Set();
  const server = http.createServer(async (req, res) => {
    const send = (code, obj, extraHeaders = {}) => {
      const b = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...extraHeaders });
      res.end(b);
    };
    if (req.url === '/health') return send(200, { ok: true, service: 'x402-toolkit', version: VERSION, price, payTo });
    if (req.url === '/pricing') return send(200, { price, asset, network: 'base', chainId: 8453, payTo, freeTrialPerDay: freeTrial });

    const payment = req.headers['x-payment'] || req.headers['X-PAYMENT'];
    if (!payment) {
      return send(402, challenge(req), { 'www-authenticate': 'x402', 'x-accept-payment': 'x402' });
    }
    if (!isTx(payment)) return send(402, { error: 'payment_invalid', detail: 'X-PAYMENT must be a 0x tx hash' }, { 'www-authenticate': 'x402' });
    if (seen.has(payment)) return send(402, { error: 'tx_already_used', detail: 'replay rejected' }, { 'www-authenticate': 'x402' });

    if (verifyOn) {
      const v = await cmdVerify({ _: [], rpc: rpcUrl, to: payTo, asset, min: price, confirmations: '1' , ...{ _: [null, payment] } });
      if (!v.ok) return send(402, { error: v.error || 'payment_not_verified', detail: v.detail || null }, { 'www-authenticate': 'x402' });
      seen.add(payment);
      return send(200, { ok: true, settled: true, tx: payment, result: handlerFn(null) }, { 'x-payment-settled': 'true' });
    }
    seen.add(payment);
    return send(200, { ok: true, settled: true, tx: payment, mode: 'unverified', result: handlerFn(null) }, { 'x-payment-settled': 'true' });
  });

  await new Promise((res) => server.listen(port, res));
  console.log(`x402-toolkit serving on http://127.0.0.1:${port}`);
  console.log(`  payTo=${payTo}  price=${price} base units  asset=${asset}`);
  console.log(`  GET /health /pricing  |  any other path -> x402 402 -> retry with X-PAYMENT: <tx>`);
  console.log(`  handler=${handler}  verifyOnChain=${verifyOn}`);
  return new Promise(() => {});
}

// ============================================================
// 4) CLIENT -- discover an x402 challenge and print the exact retry
// ============================================================
async function cmdClient(args) {
  const target = args._[1];
  if (!target) return { ok: false, error: 'usage: client <url> [--tx 0x..]' };
  const headers = {};
  if (args.tx) headers['X-PAYMENT'] = args.tx;
  let res;
  try { res = await fetchUrl(target, { headers, timeout: 15000 }); }
  catch (e) { return { ok: false, url: target, error: e.message }; }
  let body = null; try { body = JSON.parse(res.body); } catch (e) {}
  const out = { url: target, status: res.status, paid: res.status === 200 };
  if (res.status === 402) {
    const accepts = body && (body.accepts || (body.x402 && body.x402.accepts));
    const a = Array.isArray(accepts) ? accepts[0] : accepts;
    out.challenge = a || body;
    if (a) out.nextStep = `send ${a.maxAmountRequired || a.amount} base units of ${a.asset} on Base to ${a.payTo}, then retry: node x402-toolkit.js client ${target} --tx 0x<txhash>`;
  } else if (res.status === 200) out.body = body || res.body.slice(0, 400);
  return out;
}

// ============================================================
const COMMANDS = { probe: cmdProbe, verify: cmdVerify, serve: cmdServe, client: cmdClient };

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`x402-toolkit v${VERSION} -- dependency-free tools for the x402 agent-payment economy

  node x402-toolkit.js probe  <url>                        is this a well-formed x402 service? (score x/6)
  node x402-toolkit.js verify <tx> [--to 0x.. --min 1000]  did this on-chain USDC transfer settle?
  node x402-toolkit.js serve  [--port 4020 --payto 0x.. --price 1000 --handler echo|time|uuid]
  node x402-toolkit.js client <url> [--tx 0x..]            discover a challenge; print exact retry

Defaults: network=base chainId=8453 asset=${USDC_BASE} rpc=https://mainnet.base.org`);
    process.exit(0);
  }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error(`unknown command: ${cmd} (try: probe|verify|serve|client|help)`); process.exit(2); }
  const args = parseArgs(argv);
  const result = await fn(args);
  if (result !== undefined && cmd !== 'serve') console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(e => { console.error('fatal:', e.message); process.exit(1); });
module.exports = { cmdProbe, cmdVerify, cmdClient, fetchUrl, rpc, VERSION, USDC_BASE };
