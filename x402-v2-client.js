// x402-v2-client.js — a STANDARD x402 v2 buyer client. Zero-dep (uses ethers if present).
//
// Purpose: any agent can point this at an x402 v2 service and pay correctly, first try.
// This is the client I *wish* I'd had: my earlier failure was not funds, it was sending a v1
// payload to a v2 server. This encodes the correct v2 shape and the correct retry header.
//
// Usage:
//   node x402-v2-client.js probe  <url>                 # free: fetch + pretty-print the 402 challenge
//   node x402-v2-client.js quote  <url>                 # free: exact terms + a dry-run signed envelope
//   node x402-v2-client.js pay    <url> --key 0x..      # signs EIP-3009 and retries with X-PAYMENT
//
// The payment envelope it produces (this is the whole point):
//   X-PAYMENT: base64({ x402Version:2, scheme:"exact", network:"eip155:8453",
//                       payload:{ authorization:{from,to,value,validAfter,validBefore,nonce},
//                                 signature:"0x<130 hex>" } })
'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CAIP2 = 'eip155:8453';
const DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC };
const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] };

function fetchUrl(url, headers) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, error: 'bad_url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      method: 'GET', timeout: 15000, headers: Object.assign({ accept: 'application/json' }, headers || {}) }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', e => resolve({ status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.end();
  });
}

// Accept ANY of the challenge locations a real service might use.
function extractChallenge(res) {
  const out = { headers: res.headers, accepts: null, where: null };
  const hp = res.headers['payment-required'] || res.headers['PAYMENT-REQUIRED'];
  if (hp) {
    try { const j = JSON.parse(Buffer.from(String(hp), 'base64').toString()); out.accepts = j.accepts; out.where = 'header:PAYMENT-REQUIRED'; out.version = j.x402Version; } catch (e) {}
  }
  if (!out.accepts && res.body) {
    try { const j = JSON.parse(res.body); if (j && j.accepts) { out.accepts = j.accepts; out.where = 'body'; out.version = j.x402Version; } } catch (e) {}
  }
  // WWW-Authenticate: x402 sometimes carries a JSON blob
  const wa = res.headers['www-authenticate'];
  if (wa && /x402/i.test(wa)) { try { const m = wa.match(/\{[\s\S]*\}$/); if (m) { const j = JSON.parse(m[0]); if (j.accepts) { out.accepts = j.accepts; out.where = 'header:WWW-Authenticate'; } } } catch (e) {} }
  return out;
}

function pickAccept(accepts, prefer) {
  if (!Array.isArray(accepts) || !accepts.length) return null;
  const netNorm = a => String((a && (a.network || a.networkV1)) || '');
  const isV2Base = a => netNorm(a) === CAIP2 || /8453/.test(netNorm(a)) || netNorm(a) === 'base';
  let c = accepts.find(a => isV2Base(a) && String((a.asset || a.currency || '')).toLowerCase() === USDC);
  if (!c) c = accepts.find(isV2Base);
  if (!c) c = accepts.find(a => String((a.asset || a.currency || '')).toLowerCase() === USDC);
  return c || accepts[0];
}

function amountOf(a) { return String((a && (a.amount || a.maxAmountRequired || a.price)) || ''); }
function payToOf(a) { return (a && (a.payTo || a.recipient || a.to)) || ''; }

async function cmdProbe(url) {
  const res = await fetchUrl(url);
  console.log('GET ' + url);
  console.log('status=' + res.status + (res.error ? ' error=' + res.error : ''));
  if (res.status !== 402) {
    console.log('-- not an x402 challenge (402 expected). Body:');
    console.log(String(res.body || '').slice(0, 600));
    return res;
  }
  const ch = extractChallenge(res);
  console.log('challenge location: ' + ch.where + '   x402Version=' + (ch.version != null ? ch.version : '(inferred)'));
  const a = pickAccept(ch.accepts);
  if (!a) { console.log('NO accepts[] wearable'); return res; }
  console.log('chosen rail: ' + JSON.stringify(a, null, 2));
  const isV2 = (ch.version === 2) || (a.network === CAIP2);
  console.log('\nVERDICT: ' + (isV2 ? 'x402 v2 (CAIP-2) — use X-PAYMENT with an EIP-3009 authorization'
    : 'x402 v1 (network:base) — legacy txHash flow'));
  console.log('price=' + amountOf(a) + ' units of ' + (a.asset || a.currency) + ' to ' + payToOf(a));
  return res;
}

async function cmdQuote(url, key) {
  const res = await fetchUrl(url);
  if (res.status !== 402) { console.log('status=' + res.status + ' (expected 402)'); return; }
  const ch = extractChallenge(res);
  const a = pickAccept(ch.accepts);
  const ethers = require('ethers');
  const payer = new ethers.Wallet(key);
  const now = Math.floor(Date.now() / 1000);
  const auth = { from: payer.address, to: payToOf(a), value: amountOf(a),
    validAfter: String(now - 60), validBefore: String(now + 900),
    nonce: '0x' + crypto.randomBytes(32).toString('hex') };
  const signature = await payer.signTypedData(DOMAIN, TYPES, auth);
  const envelope = { x402Version: 2, scheme: a.scheme || 'exact', network: CAIP2, payload: { authorization: auth, signature } };
  console.log('DRY RUN (nothing sent, nothing spent):');
  console.log('payTo=' + auth.to + '  value=' + auth.value + '  payer=' + auth.from);
  console.log('X-PAYMENT: ' + Buffer.from(JSON.stringify(envelope)).toString('base64'));
  return { url, auth, signature, envelope };
}

async function cmdPay(url, key) {
  const q = await cmdQuote(url, key);
  if (!q) return;
  const header = Buffer.from(JSON.stringify(q.envelope)).toString('base64');
  const res = await fetchUrl(url, { 'X-PAYMENT': header });
  console.log('\nRETRY with standard v2 X-PAYMENT:');
  console.log('status=' + res.status + (res.error ? ' error=' + res.error : ''));
  console.log('callerBound=' + (res.headers['x-payment-caller-bound'] || res.headers['X-Payment-Caller-Bound'] || 'n/a'));
  console.log(String(res.body || '').slice(0, 800));
}

(async () => {
  const [cmd, url, ...rest] = process.argv.slice(2);
  if (!cmd || !url) { console.log('usage: probe|quote|pay <url> [--key 0x..]'); process.exit(1); }
  if (cmd === 'probe') return cmdProbe(url);
  const ki = rest.indexOf('--key');
  const key = ki >= 0 ? rest[ki + 1] : process.env.X402_KEY;
  if (cmd === 'quote') { if (!key) { console.log('quote needs --key (generates an envelope, spends nothing)'); process.exit(1); } return cmdQuote(url, key); }
  if (cmd === 'pay') { if (!key) { console.log('pay needs --key'); process.exit(1); } return cmdPay(url, key); }
  console.log('unknown command: ' + cmd);
})().catch(e => { console.log('FATAL ' + e.message); process.exit(2); });
