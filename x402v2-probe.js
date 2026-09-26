// x402v2-probe.js — FREE reconnaissance: determine the exact x402 v2 "exact EVM" payload shape
// by reading a real service's own validation errors. No payment is made. Errors are the oracle.
//
// Found this way: my v1-style retries returned "exact EVM payment payload is incomplete",
// which proves the schema is richer than a txHash. This nails it field by field.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const TARGET = process.env.PROBE_URL || 'https://api.onesource.io/api/chain/block-number';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');

function req(url, headers = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', timeout: 25000,
      headers: Object.assign({ accept: 'application/json', 'user-agent': 'automaton-probe/1.0' }, headers) }, res => {
      let b = ''; res.on('data', c => { if (b.length < 32768) b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', e => resolve({ status: 0, body: String(e.code || e.message) }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    r.end();
  });
}

(async () => {
  const out = [];
  const say = (k, v) => { const s = k + ' :: ' + v; out.push(s); console.log(s); };

  const zero = '0x' + '0'.repeat(64);
  const now = Math.floor(Date.now() / 1000);
  const auth = { from: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
    to: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea',
    value: '1000', validAfter: String(now - 60), validBefore: String(now + 1800), nonce: zero };

  // Progressively richer envelopes. The error MESSAGE tells us which field is still missing.
  const shapes = [
    ['v2 flat + txHash', { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { txHash: '0x' + 'ab'.repeat(32) } }],
    ['v2 payload.authorization only', { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { authorization: auth } }],
    ['v2 payload.authorization+signature', { x402Version: 2, scheme: 'exact', network: 'eip155:8453',
      payload: { authorization: auth, signature: '0x' + '11'.repeat(65) } }],
    ['v2 top-level authorization+signature', { x402Version: 2, scheme: 'exact', network: 'eip155:8453',
      authorization: auth, signature: '0x' + '11'.repeat(65) }],
    ['v2 payload{authorization{from,to,value,validAfter,validBefore,nonce},signature} + extra', {
      x402Version: 2, scheme: 'exact', network: 'eip155:8453',
      payload: { authorization: auth, signature: '0x' + '11'.repeat(65) },
      extra: { name: 'USD Coin', version: '2' } }],
  ];

  for (const [name, shape] of shapes) {
    const r = await req(TARGET, { 'X-PAYMENT': b64(shape) });
    say(name, r.status + '  ' + r.body.slice(0, 180).replace(/\s+/g, ' '));
  }

  say('interpretation', 'If a richer shape moves the error from "payload is incomplete" toward '
    + '"invalid signature"/"unauthorized", the schema is confirmed: the payer signs an EIP-3009 '
    + 'authorization and the SERVER settles it. That is caller-bound payment, no gas needed by the buyer.');

  fs.writeFileSync(path.join(__dirname, 'x402v2-probe.log'), out.join('\n') + '\n');
})().catch(e => { console.log('FATAL ' + e.message); process.exit(2); });
