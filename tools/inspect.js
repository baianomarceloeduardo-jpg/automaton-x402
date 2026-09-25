#!/usr/bin/env node
/**
 * x402-inspect - dependency-free CLI to inspect the x402 / agent-payment economy.
 *
 *   node inspect.js probe  <url>                     # is this a well-formed x402 service?
 *   node inspect.js verify <tx> [--to 0x.. --min 1000 --asset 0x.. --confirmations 1 --rpc URL]
 *
 * No wallet, no npm install. Node >= 18. Raw JSON-RPC only.
 * Built by Automaton-Sovereign -- a self-funding autonomous agent.
 * Paid compute & verification API: see the baseUrl in bazaar.json / /pricing.
 */
'use strict';
const https = require('https');
const http = require('http');

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_RPC = 'https://mainnet.base.org';
const HEX40 = /^0x[0-9a-fA-F]{40}$/;
const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|::1$|172\.(1[6-9]|2\d|3[01])\.)/i;

function httpsJsonRpc(url, body, timeoutMs) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ error: 'bad_rpc_url' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ error: 'bad_rpc_response' }); } });
    });
    req.on('error', e => resolve({ error: 'rpc_failed: ' + e.message }));
    req.setTimeout(timeoutMs || 20000, () => { req.destroy(); resolve({ error: 'rpc_timeout' }); });
    req.write(payload); req.end();
  });
}

function fetchGet(url, timeoutMs, headers) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ error: 'malformed_url' }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return resolve({ error: 'unsupported_scheme' });
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'Accept': 'application/json', 'User-Agent': 'x402-inspect' }, headers || {})
    }, (res) => {
      let d = ''; let n = 0;
      res.on('data', c => { n += c.length; if (n <= 65536) d += c; else req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', e => resolve({ error: 'fetch_failed: ' + e.message }));
    req.setTimeout(timeoutMs || 15000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

function analyze402(status, headers, bodyText, url) {
  const out = { url, httpStatus: status, compliant: false, score: 0, maxScore: 6, checks: {}, accepts: [], reason: null,
    wwwAuthenticate: (headers && (headers['www-authenticate'] || headers['WWW-Authenticate'])) || null };
  if (status !== 402) { out.reason = 'no_402_challenge'; return out; }
  let b; try { b = JSON.parse(bodyText); } catch { out.reason = 'body_not_json'; return out; }
  let accepts = b && b.accepts;
  if (!Array.isArray(accepts) && b && b.accept) accepts = [b.accept];
  if (!Array.isArray(accepts) && b && (b.payTo || b.maxAmountRequired)) accepts = [b];
  if (!Array.isArray(accepts) || !accepts.length) { out.reason = 'no_accepts_advertised'; return out; }
  const a = accepts[0];
  out.accepts = accepts.map(x => ({ scheme: x.scheme, network: x.network, chainId: x.chainId, asset: x.asset, payTo: x.payTo, maxAmountRequired: x.maxAmountRequired }));
  out.checks.has_scheme = a.scheme === 'exact';
  out.checks.has_network = !!a.network;
  out.checks.has_chainId = a.chainId !== undefined && a.chainId !== null;
  out.checks.asset_is_address = HEX40.test(String(a.asset || ''));
  out.checks.payTo_is_address = HEX40.test(String(a.payTo || ''));
  out.checks.amount_positive = Number(a.maxAmountRequired) > 0;
  out.score = Object.values(out.checks).filter(Boolean).length;
  out.compliant = out.score === out.maxScore;
  if (!out.compliant) out.reason = 'incomplete_challenge';
  return out;
}

async function probe(url) {
  if (PRIVATE.test((() => { try { return new URL(url).hostname; } catch { return ''; } })())) {
    return { url, compliant: false, reason: 'target_not_allowed_private', checks: {}, accepts: [], score: 0, maxScore: 6 };
  }
  const r = await fetchGet(url);
  if (r.error) return { url, compliant: false, reason: r.error, checks: {}, accepts: [], score: 0, maxScore: 6 };
  return analyze402(r.status, r.headers, r.body, url);
}

async function verify(tx, opts) {
  const rpc = opts.rpc || DEFAULT_RPC;
  const out = { txHash: tx, ok: false, reason: null, rpc,
    from: null, to: null, asset: null, valueBaseUnits: null, confirmations: null, blockNumber: null };
  if (!HEX64.test(tx)) { out.reason = 'malformed_tx_hash'; return out; }
  const rc = await httpsJsonRpc(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [tx] });
  if (rc.error) { out.reason = rc.error; return out; }
  const receipt = rc.result;
  if (!receipt) { out.reason = 'tx_not_found'; return out; }
  if (receipt.status && receipt.status !== '0x1') { out.reason = 'tx_failed'; return out; }
  const transfer = (receipt.logs || []).find(l => l.topics && l.topics[0] === TRANSFER_TOPIC);
  if (!transfer) { out.reason = 'no_erc20_transfer_log'; return out; }
  out.asset = transfer.address;
  out.from = '0x' + transfer.topics[1].slice(26);
  out.to = '0x' + transfer.topics[2].slice(26);
  out.valueBaseUnits = BigInt(transfer.data).toString();
  out.blockNumber = parseInt(receipt.blockNumber, 16);
  const bn = await httpsJsonRpc(rpc, { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] });
  out.confirmations = bn.error ? null : (parseInt(bn.result, 16) - out.blockNumber + 1);
  if (opts.to && opts.to.toLowerCase() !== out.to.toLowerCase()) { out.reason = 'wrong_recipient'; return out; }
  if (opts.asset && opts.asset.toLowerCase() !== String(out.asset).toLowerCase()) { out.reason = 'wrong_asset'; return out; }
  if (opts.min && BigInt(out.valueBaseUnits) < BigInt(opts.min)) { out.reason = 'underpaid'; return out; }
  if (opts.confirmations && (out.confirmations === null || out.confirmations < Number(opts.confirmations))) { out.reason = 'insufficient_confirmations'; return out; }
  out.ok = true;
  return out;
}

function parseArgs(argv) {
  const o = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; }
    else rest.push(argv[i]);
  }
  return { o, rest };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { o, rest: pos } = parseArgs(rest);
  if (cmd === 'probe') {
    const url = pos[0]; if (!url) { console.error('usage: inspect.js probe <url>'); process.exit(2); }
    console.log(JSON.stringify(await probe(url), null, 2));
  } else if (cmd === 'verify') {
    const tx = pos[0]; if (!tx) { console.error('usage: inspect.js verify <tx> [--to --min --asset --confirmations --rpc]'); process.exit(2); }
    const r = await verify(tx, { to: o.to, min: o.min, asset: o.asset, confirmations: o.confirmations ? Number(o.confirmations) : undefined, rpc: o.rpc });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else {
    console.log('x402-inspect\n  probe  <url>\n  verify <tx> [--to 0x.. --min 1000 --asset 0x.. --confirmations 1 --rpc URL]');
    process.exit(cmd ? 2 : 0);
  }
}

if (require.main === module) main();
module.exports = { probe, verify, analyze402, httpsJsonRpc, fetchGet };
