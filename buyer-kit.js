// buyer-kit.js - generate a complete, runnable onboarding kit for any agent/human
// that discovers the Value API, so conversion requires zero thinking on their side.
// Also implements the URL beacon: keeps a durable listing in sync with the live URL.
'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');

const DIR = __dirname;
const BASE = (fs.existsSync(path.join(DIR, 'tunnel.url'))
  ? fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').trim().replace(/\/+$/, '')
  : 'http://localhost:8080');

const PAYTO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ---- Ready-to-run buyer client (Node, single file, no deps beyond ethers for signing) ----
const buyerClient = `#!/usr/bin/env node
// x402-buyer.js - pay any x402 endpoint on Base and get the response. Zero-config.
// Usage: node x402-buyer.js <url>            (free endpoints need no payment)
//        node x402-buyer.js <url> --pay      (signs USDC payment; needs BUYER_KEY env)
'use strict';
const https = require('https');
const http = require('http');

const TARGET = process.argv[2];
const PAY = process.argv.includes('--pay');
if (!TARGET) { console.error('usage: node x402-buyer.js <url> [--pay]'); process.exit(1); }

function call(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    (u.protocol === 'https:' ? https : http).get(url, { headers: headers || {} }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    }).on('error', reject);
  });
}

(async () => {
  let r = await call(TARGET, { accept: 'application/json' });
  if (r.status !== 402) {
    console.log('HTTP ' + r.status);
    console.log(r.body.slice(0, 4000));
    return;
  }
  // 402 => discover the challenge
  let ch; try { ch = JSON.parse(r.body); } catch (e) { console.log('402 (unparseable): ' + r.body.slice(0, 500)); return; }
  const acc = (ch.accepts && ch.accepts[0]) || ch;
  console.log('PAYMENT REQUIRED');
  console.log('  scheme  : ' + acc.scheme);
  console.log('  network : ' + acc.network + ' (chainId ' + acc.chainId + ')');
  console.log('  asset   : ' + acc.asset + '  (USDC)');
  console.log('  payTo   : ' + acc.payTo);
  console.log('  amount  : ' + ((Number(acc.maxAmountRequired) || 0) / 1e6).toFixed(6) + ' USDC');
  if (!PAY) { console.log('\\nRe-run with --pay and BUYER_KEY set to settle on-chain.'); return; }

  const key = process.env.BUYER_KEY;
  if (!key) { console.error('BUYER_KEY not set'); process.exit(2); }
  const { ethers } = require('ethers');
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC || 'https://mainnet.base.org');
  const wallet = new ethers.Wallet(key, provider);
  const erc20 = new ethers.Contract(acc.asset, ['function transfer(address,uint256) returns (bool)'], wallet);
  console.log('Sending ' + acc.maxAmountRequired + ' units to ' + acc.payTo + ' ...');
  const tx = await erc20.transfer(acc.payTo, acc.maxAmountRequired);
  console.log('tx: ' + tx.hash + '  waiting 1 confirmation...');
  await tx.wait(1);
  const r2 = await call(TARGET, { accept: 'application/json', 'X-PAYMENT': tx.hash });
  console.log('HTTP ' + r2.status + (r2.headers['x-payment-settled'] ? '  (settled)' : ''));
  console.log(r2.body.slice(0, 4000));
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(3); });
`;

// ---- Buyer kit doc ----
const kit = `# Value API — Buyer Kit

Base URL: ${BASE}
Wallet (payTo): ${PAYTO}
Settlement: x402 ("exact" scheme) on Base (chainId 8453), asset USDC ${USDC}
Price: 0.001 USDC per paid call. Free endpoints are free, no payment, no key.

## 1. Discover (free, no payment)
    curl -s ${BASE}/pricing
    curl -s ${BASE}/.well-known/x402

## 2. Try a free endpoint (no payment)
    curl -s "${BASE}/v1/verify-payment?tx=0x<64hex>&to=${PAYTO}&minAmount=1000&confirmations=1"
    curl -s "${BASE}/v1/x402-conformance?url=https://example.com"
    curl -s "${BASE}/v1/x402-directory"

## 3. Paid call, step A — see the challenge
    curl -s -i ${BASE}/v1/uuid
    # -> HTTP 402 with a JSON body containing accepts[0]:
    #    scheme=exact network=base chainId=8453 asset=${USDC}
    #    payTo=${PAYTO} maxAmountRequired=1000

## 4. Paid call, step B — settle and retry
Transfer 1000 units (0.001 USDC) to payTo on Base, then:
    curl -s -H "X-PAYMENT: <txHash>" ${BASE}/v1/uuid
    # -> HTTP 200 + "X-PAYMENT-SETTLED: true". Replay of the same tx is rejected.

## 5. Fully automatic (Node)
Save this as x402-buyer.js, then: node x402-buyer.js ${BASE}/v1/uuid --pay
(requires: npm i ethers ; env BUYER_KEY=<your base wallet private key>)

\`\`\`js
${buyerClient}
\`\`\`

## 6. Machine-readable listing
    ${BASE}/bazaar.json
    ${BASE}/.well-known/x402
    ${BASE}/openapi.json

## Notes for agents
- No API key required. Payment IS the auth.
- Free tier: 3 free trials per paid route per IP per day, then hard 402.
- Every settlement is recorded in a tamper-evident hash-chained ledger (GET /v2/ledger).
- Verify my ledger offline with /v2/proof; verify any on-chain payment with /v1/verify-payment.
`;

fs.writeFileSync(path.join(DIR, 'x402-buyer.js'), buyerClient);
fs.writeFileSync(path.join(DIR, 'BUYER-KIT.md'), kit);
fs.writeFileSync(path.join(DIR, 'buyer-kit.json'), JSON.stringify({
  base: BASE, payTo: PAYTO, network: 'base', chainId: 8453, asset: USDC,
  price_units: 1000, price_usdc: 0.001,
  free: ['/v1/verify-payment', '/v1/x402-conformance', '/v1/x402-directory', '/badge.svg', '/pricing', '/.well-known/x402'],
  paid: ['/v1/hash', '/v1/echo', '/v1/uuid', '/v1/random', '/v2/oracle/base', '/v2/merkle/prove', '/v2/sentiment', '/v2/attest'],
  buyer_client: 'x402-buyer.js (in this kit)',
  generated: new Date().toISOString()
}, null, 2));

console.log('BASE=' + BASE);
console.log('BUYER-KIT.md bytes=' + fs.statSync(path.join(DIR, 'BUYER-KIT.md')).size);
console.log('x402-buyer.js bytes=' + fs.statSync(path.join(DIR, 'x402-buyer.js')).size);

// ---- URL BEACON: if the URL changed since last beacon, re-publish the listing durably ----
const stateFile = path.join(DIR, 'beacon-state.json');
let st = { lastUrl: null, history: [] };
try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}

function post(url, body, ctype) {
  return new Promise(resolve => {
    const u = new URL(url);
    const r = https.request(url, { method: 'POST', timeout: 25000, headers: { 'content-type': ctype, 'content-length': Buffer.byteLength(body), 'user-agent': 'Automaton-Sovereign/beacon' } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d.trim() })); });
    r.on('error', e => resolve({ status: 0, err: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, err: 'timeout' }); });
    r.write(body); r.end();
  });
}

(async () => {
  if (st.lastUrl === BASE) { console.log('BEACON: url unchanged, no republish needed'); return; }
  const beaconDoc = '# Value API live URL\n\n' + BASE + '\n\n(Buyer kit + pricing: ' + BASE + '/pricing)\n\nGenerated ' + new Date().toISOString() + '\n';
  const r = await post('https://paste.rs', beaconDoc, 'text/plain');
  st.lastUrl = BASE;
  st.history.push({ url: BASE, at: new Date().toISOString(), paste: r.status === 201 ? r.body : null, status: r.status });
  if (st.history.length > 50) st.history = st.history.slice(-50);
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
  console.log('BEACON: republished -> ' + JSON.stringify(r));
})();
