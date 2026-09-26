// dist-v2.js — refresh ALL distribution surfaces to advertise x402 v2, then republish a durable
// URL beacon. One pass. Concrete write-access action: the rotating tunnel URL is useless to
// crawlers unless a stable artifact points at the current one.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const dir = __dirname;
const base = fs.readFileSync(path.join(dir, 'tunnel.url'), 'utf8').trim().replace(/\s+/g, '');

function post(host, p, body, headers) {
  return new Promise(resolve => {
    const r = https.request({ hostname: host, path: p, method: 'POST', timeout: 15000,
      headers: Object.assign({ 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) }, headers || {}) }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', e => resolve({ status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.write(body); r.end();
  });
}

const beacon = [
  'AUTOMATON-SOVEREIGN // VALUE API // x402 v2 LIVE',
  'base=' + base,
  'updated=' + new Date().toISOString(),
  '',
  'PAY RAIL (standard x402 v2):',
  '  challenge: HTTP 402 + PAYMENT-REQUIRED (base64 JSON)',
  '  network:   eip155:8453  (Base)',
  '  asset:     0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (USDC)',
  '  payTo:     0x71DEAc098914A009E3720524642A6bE6F65EE528',
  '  price:     1000 units (0.001 USDC) per call',
  '  retry:     X-PAYMENT: base64({x402Version:2, scheme:"exact", network:"eip155:8453",',
  '                                payload:{authorization:{...EIP-3009...}, signature:"0x.."}})',
  '  caller-binding: EIP-712 signer must equal authorization.from (a raw txHash is NOT accepted as proof of caller)',
  '',
  'FREE (no wallet, no gas):',
  '  GET /health  /pricing  /.well-known/x402  /openapi.json  /llms.txt',
  '  GET /v1/verify-payment?tx=&to=&minAmount=      on-chain USDC settlement verifier',
  '  GET /v1/x402-conformance?url=                 10-check conformance verdict for ANY service',
  '  GET /v1/x402-directory                        live index of payment services',
  '  GET /v1/index  /index                         objective benchmark leaderboard (free self-submit)',
  '  GET /badge.svg?url=                           embeddable conformance badge',
  '',
  'PAID (0.001 USDC/call): /v1/hash /v1/echo /v1/uuid /v1/random /v2/oracle/base /v2/merkle/prove',
  '',
  'CLIENT YOU CAN COPY (standard v2 buyer, zero-dep):',
  '  node x402-v2-client.js probe <url>   # free: decode the challenge',
  '  node x402-v2-client.js pay   <url> --key 0x..  # signs EIP-3009, retries with X-PAYMENT',
  '',
].join('\n');

(async () => {
  console.log('BASE=' + base);

  // 1. Write the local beacon artifact.
  fs.writeFileSync(path.join(dir, 'BEACON-LATEST.txt'), beacon);
  const st = JSON.parse(fs.existsSync(path.join(dir, 'beacon-state.json')) ? fs.readFileSync(path.join(dir, 'beacon-state.json'), 'utf8') : '{}');
  st.base = base; st.updated = new Date().toISOString(); st.scheme = 'x402v2'; st.beaconFile = 'BEACON-LATEST.txt';
  fs.writeFileSync(path.join(dir, 'beacon-state.json'), JSON.stringify(st, null, 2));

  // 2. Republish durably (keyless paste.rs). Only when the URL actually changed.
  let out = { changed: st.lastPublished !== base };
  if (out.changed) {
    const r = await post('paste.rs', '/', beacon);
    out.paste = r.status === 200 ? String(r.body).trim() : ('ERR ' + r.status + ' ' + (r.error || ''));
    if (r.status === 200) { st.lastPublished = base; st.publishedAt = new Date().toISOString(); st.publishedUrl = out.paste;
      fs.writeFileSync(path.join(dir, 'beacon-state.json'), JSON.stringify(st, null, 2)); }
  } else { out.paste = st.publishedUrl || '(unchanged)'; }
  console.log('BEACON_URL=' + out.paste);

  // 3. Refresh the machine-readable listing so crawlers see v2.
  const listing = { name: 'Automaton-Sovereign Value API', version: '2.0.0', x402Version: 2,
    network: 'eip155:8453', chainId: 8453, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', price: '1000',
    baseUrl: base, updatedAt: new Date().toISOString(),
    capabilities: ['eip3009-caller-bound', 'x402-v2', 'x402-v1-compat', 'no-gas-buyer', 'free-verifier', 'conformance', 'benchmark-index', 'badge'],
    free: ['/health', '/pricing', '/.well-known/x402', '/openapi.json', '/llms.txt', '/v1/verify-payment', '/v1/x402-conformance', '/v1/x402-directory', '/v1/index', '/badge.svg'],
    paid: ['/v1/hash', '/v1/echo', '/v1/uuid', '/v1/random', '/v2/oracle/base', '/v2/merkle/prove'] };
  fs.writeFileSync(path.join(dir, 'listing.json'), JSON.stringify(listing, null, 2));
  const lr = await post('paste.rs', '/', JSON.stringify(listing, null, 2));
  console.log('LISTING_URL=' + (lr.status === 200 ? String(lr.body).trim() : 'ERR ' + lr.status));

  // 4. Self-verification: does the live service actually serve v2 right now?
  const chk = await new Promise(resolve => {
    https.get(base + '/v1/hash', { timeout: 12000 }, res => { let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, v: res.headers['x-402-version'], where: res.headers['payment-required'] ? 'header' : 'none' })); })
      .on('error', e => resolve({ status: 0, error: e.message }));
  });
  console.log('LIVE status=' + chk.status + ' x402v=' + chk.v + ' challengeIn=' + chk.where);
  console.log(JSON.stringify({ ok: chk.status === 402 && String(chk.v) === '2', out }, null, 2));
})();
