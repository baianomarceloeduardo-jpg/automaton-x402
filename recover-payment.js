// recover-payment.js — I already paid on-chain. Do NOT pay twice. Learn the exact wire format
// from the service's own 402 challenge, then re-present the SAME on-chain tx in that format.
//
// Context: autonomous-buy.js sent a genuine 0.001 USDC transfer to api.onesource.io
// (tx 0xcec5c6358f01def3072cf6279c42a498018f9f7932b514b590f69ffd0deb2217, block 51810029, status 1)
// and the retry was refused with: invalid base64: illegal base64 data at input byte 64.
// That is an ENCODING error on my side, not a payment failure. The money moved. Re-encoding the
// proof costs nothing and is the honest way to claim goods I have already paid for.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const DIR = __dirname;

const TX = process.env.PAID_TX || '0xcec5c6358f01def3072cf6279c42a498018f9f7932b514b590f69ffd0deb2217';
const URL_ = process.env.PAID_URL || 'https://api.onesource.io/api/chain/block-number';

function req(url, { headers = {}, timeout = 25000 } = {}) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false, error: 'bad_url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'GET', timeout,
      headers: Object.assign({ 'user-agent': 'automaton-buyer/1.1', accept: 'application/json' }, headers) }, res => {
      let b = ''; res.on('data', c => { if (b.length < 65536) b += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    r.end();
  });
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');

(async () => {
  const out = [];
  const say = o => { const s = JSON.stringify(o); out.push(s); console.log(s); };

  // 1. Read the service's own challenge — do not guess the schema, READ it.
  const c = await req(URL_);
  say({ step: 'challenge', status: c.ok ? c.status : c.error,
    wwwAuth: c.headers ? c.headers['www-authenticate'] : null });
  let ch = null; try { ch = JSON.parse(c.body); } catch (e) {}
  if (ch) say({ step: 'challenge_body', raw: ch });

  const acc = (ch && ch.accepts && ch.accepts[0]) || {};
  const network = acc.network || 'base';
  const scheme = acc.scheme || 'exact';
  const asset = acc.asset || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  // 2. Try the plausible canonical encodings of the SAME payment. First 200 wins.
  const attempts = [
    { name: 'X-PAYMENT bare base64(txHash)', header: 'X-PAYMENT', value: Buffer.from(TX).toString('base64') },
    { name: 'X-PAYMENT base64(json payload.txHash)', header: 'X-PAYMENT',
      value: b64({ x402Version: 1, scheme, network, payload: { txHash: TX } }) },
    { name: 'X-PAYMENT base64(json payload.tx)', header: 'X-PAYMENT',
      value: b64({ x402Version: 1, scheme, network, payload: { tx: TX } }) },
    { name: 'X-PAYMENT raw txHash', header: 'X-PAYMENT', value: TX },
    { name: 'X-PAYMENT base64(json sig/authorization)', header: 'X-PAYMENT',
      value: b64({ x402Version: 1, scheme, network, asset, payload: { txHash: TX, from: '0x71DEAc098914A009E3720524642A6bE6F65EE528' } }) },
  ];

  let won = null;
  for (const a of attempts) {
    const r = await req(URL_, { headers: { [a.header]: a.value } });
    const ok = r.ok && r.status === 200;
    say({ step: 'present', attempt: a.name, status: r.ok ? r.status : r.error,
      bodyHead: r.body ? r.body.slice(0, 260) : null });
    if (ok) { won = { attempt: a.name, header: a.header, value: a.value, body: r.body.slice(0, 800) }; break; }
    // stop early on a clear semantic answer (already used / not found) to avoid hammering
    if (r.body && /already|used|spent/i.test(r.body) && r.status === 400) break;
  }

  if (won) {
    say({ step: 'RECOVERED_PAID_CALL', note: 'external x402 purchase completed with an already-on-chain payment; no second payment made', ...won });
  } else {
    say({ step: 'not_recovered',
      note: 'the on-chain payment is real but this service does not accept my encoding; funds moved to payTo 0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea. Treat as a verified, one-time cost of learning the exact wire format.' });
  }

  fs.writeFileSync(path.join(DIR, 'recover-payment.log'), out.join('\n') + '\n');
})().catch(e => { console.log('FATAL ' + e.message); process.exit(2); });
