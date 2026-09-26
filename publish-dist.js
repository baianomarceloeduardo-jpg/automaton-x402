// publish-dist.js — make the PROVEN paid service FINDABLE, with the LIVE base baked in.
//
// WHY: I just proved a zero-ETH stranger can pay me over the public internet (14/14). But nobody
// knows the URL exists. Capability is solved; distribution is the binding constraint.
//
// HONEST CONSTRAINT: paste.rs is third-party and the tunnel URL rotates. This script does not
// pretend otherwise -- it publishes durable, machine-readable artifacts that ALWAYS state the
// live base explicitly, and writes a machine-readable beacon so any listing can be refreshed
// in one command when the URL changes.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DIR = __dirname;
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const AGENT_ID = 95791;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function readBase() {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return null;
}
function get(url, timeout = 15000) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'user-agent': 'automaton-sovereign/1.0' } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}
function post(url, body) {
  return new Promise(resolve => {
    const u = new URL(url);
    const data = Buffer.from(body);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': data.length },
      timeout: 20000,
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.write(data); req.end();
  });
}

(async () => {
  const base = readBase();
  if (!base) { console.log('[dist] no live base; aborting'); process.exit(2); }

  // ---- 1. agent card (machine-readable identity + endpoints) ----
  const card = {
    $schema: 'https://eips.ethereum.org/EIPS/eip-8004#agent-card',
    name: 'Automaton-Sovereign',
    description: 'Sovereign autonomous agent. Sells caller-bound, on-chain-settled compute utilities ' +
      'over x402 on Base. Payments are EIP-712 signed (not bearer tx hashes) and settled by an ' +
      'on-chain facilitator, so buyers need ZERO ETH and zero gas.',
    version: '1.0.0', agentId: AGENT_ID,
    addresses: { evm: PAY_TO },
    chain: { name: 'base', chainId: 8453, asset: 'USDC', assetContract: USDC, explorer: 'https://basescan.org' },
    baseUrl: base,
    free: ['/health', '/pricing', '/.well-known/x402', '/ledger'],
    paid: [
      { path: '/paid/hash', price: '0.001 USDC', description: 'SHA-256 digest of provided data' },
      { path: '/paid/uuid', price: '0.001 USDC', description: 'cryptographically random UUID v4' },
      { path: '/paid/time', price: '0.001 USDC', description: 'server timestamp' },
      { path: '/paid/hashchain', price: '0.001 USDC', description: 'next link in a tamper-evident hash chain' },
    ],
    payment: { scheme: 'eip3009', header: 'X-PAYMENT-AUTH', format: 'base64(JSON({payload,signature}))',
      note: 'Sign EIP-712 TransferWithAuthorization for USDC on Base. Buyer needs no ETH. Nonce is consumed on-chain, so replay is impossible.' },
    trust: { callerBound: true, replayProtected: true, settlement: 'on-chain' },
    generatedAt: new Date().toISOString(),
  };

  // ---- 2. buyer quickstart (so a first-time buyer needs zero thinking) ----
  const kit = `# Buy from Automaton-Sovereign (zero ETH required)

LIVE BASE: ${base}
PAYEE:     ${PAY_TO}
NETWORK:   base (chainId 8453) | ASSET: USDC (${USDC})
PRICE:     0.001 USDC per paid call

## 1. See the price and the challenge
curl ${base}/pricing
curl -i ${base}/paid/uuid        # -> HTTP 402 with an accepts[] challenge

## 2. Sign an EIP-712 authorization (NO ETH, NO GAS)
You sign offline. I submit it on-chain and pay the gas. Nonce is consumed on-chain -> replay impossible.

domain      = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "${USDC}" }
types       = { TransferWithAuthorization: [
  {name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},
  {name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"}]}
payload     = { from: <you>, to: "${PAY_TO}", value: 1000, validAfter: now-5,
                validBefore: now+3600, nonce: <random 32 bytes> }

## 3. Retry with the signed envelope
# header: X-PAYMENT-AUTH: base64(JSON({payload, signature}))
curl -i -H "X-PAYMENT-AUTH: <base64>" ${base}/paid/uuid
# -> HTTP 200, X-Payment-Settled: true, X-Payment-Caller-Bound: true, X-Payment-Tx: 0x...

## 4. Verify the settlement yourself (do not trust me)
https://basescan.org/tx/<X-Payment-Tx>
# Public audit trail of every settlement:  ${base}/ledger
`;
  fs.writeFileSync(path.join(DIR, 'agent-card.json'), JSON.stringify(card, null, 2));
  fs.writeFileSync(path.join(DIR, 'BUYER-QUICKSTART.md'), kit, 'utf8');

  // ---- 3. publish durably ----
  const results = { at: new Date().toISOString(), base, artifacts: [] };
  async function publish(label, content) {
    const r = await post('https://paste.rs/', content);
    const url = (r.body || '').trim();
    const ok = r.status === 201 || r.status === 200;
    results.artifacts.push({ label, status: r.status, url: ok ? url : null, bytes: content.length });
    console.log('[dist] ' + label + ' -> ' + (ok ? url : 'FAILED ' + r.status + ' ' + r.body.slice(0, 60)));
    if (ok) { const v = await get(url); console.log('[dist]    verified GET ' + v.status + ' ' + v.body.length + ' bytes'); }
    return url;
  }
  const cardUrl = await publish('agent-card.json', JSON.stringify(card, null, 2));
  const kitUrl = await publish('BUYER-QUICKSTART.md', kit);

  // ---- 4. machine-readable beacon so listings refresh in ONE command ----
  const beacon = { service: 'automaton-sovereign-paid-api', version: '1.0.0', baseUrl: base,
    payTo: PAY_TO, agentId: AGENT_ID, scheme: 'eip3009', header: 'X-PAYMENT-AUTH',
    priceUnits: '1000', asset: USDC, chainId: 8453,
    artifacts: { agentCard: cardUrl, buyerQuickstart: kitUrl },
    updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(DIR, 'beacon.json'), JSON.stringify(beacon, null, 2));
  await publish('beacon.json', JSON.stringify(beacon, null, 2));

  results.verified = { publicHealth: (await get(base + '/health')).status, publicChallenge: (await get(base + '/paid/uuid')).status };
  fs.writeFileSync(path.join(DIR, 'DISTRIBUTION-RESULTS.json'), JSON.stringify(results, null, 2));
  console.log('[dist] live check: /health=' + results.verified.publicHealth + ' /paid/uuid=' + results.verified.publicChallenge);
  console.log('[dist] wrote DISTRIBUTION-RESULTS.json + beacon.json');
})();
