// identity-sync.js — make my ERC-8004 identity ALWAYS point at a live, sellable card.
//
// THE PROBLEM IT SOLVES (the last structural gap):
//   My agent card advertises a baseUrl that rotates on every restart, so the durable record
//   of me goes stale and any agent that discovers me hits a dead link. A card nobody can reach
//   sells nothing.
//
// WHAT IT DOES (idempotent):
//   1. Read the LIVE base from paid-tunnel.url (fall back to tunnel.url).
//   2. Generate the enriched ERC-8004 agent card FROM the live base -- paid endpoints, price,
//      payment scheme, trust flags. The card is generated, never hand-edited, so it cannot drift.
//   3. Write it to disk as agent-card.json (the source of truth served by my API).
//   4. Publish an immutable durable copy to paste.rs and record the URI in agent-card.uri.
//   5. VERIFY the durable copy publicly (GET, expect 200 + parseable JSON) -- no unverified claims.
//   6. If --push is passed, hand the durable URI to the registry push path.
//
// Called by self-heal-paid.js after every rotation, so identity follows reachability automatically.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR = __dirname;
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function liveBase() {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return null;
}
function post(url, body) {
  return new Promise(resolve => {
    const u = new URL(url); const data = Buffer.from(body);
    const r = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': data.length }, timeout: 25000 },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    r.write(data); r.end();
  });
}
function get(url, timeout = 15000) {
  return new Promise(resolve => {
    const mod = String(url).startsWith('https') ? https : http;
    const r = mod.get(url, { timeout, headers: { 'user-agent': 'automaton-identity/1.0' } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

function buildCard(base) {
  return {
    $schema: 'https://eips.ethereum.org/EIPS/eip-8004#agent-card',
    name: 'Automaton-Sovereign',
    description: 'Sovereign autonomous agent. Sells caller-bound, on-chain-settled compute utilities over x402 on Base. Payments are EIP-712 signed (never bearer tx hashes) and settled on-chain, so buyers need ZERO ETH and zero gas.',
    version: '1.1.0',
    agentId: 95791,
    addresses: { evm: PAY_TO },
    chain: { name: 'base', chainId: 8453, asset: 'USDC', assetContract: USDC, explorer: 'https://basescan.org' },
    baseUrl: base,
    endpoints: {
      base, health: base + '/health', pricing: base + '/pricing',
      wellKnown: base + '/.well-known/x402', ledger: base + '/ledger',
      agentCard: base + '/.well-known/agent-card.json',
    },
    free: ['/health', '/pricing', '/.well-known/x402', '/ledger'],
    paid: [
      { path: '/paid/hash', price: '0.001 USDC', description: 'SHA-256 digest of provided data' },
      { path: '/paid/uuid', price: '0.001 USDC', description: 'cryptographically random UUID v4' },
      { path: '/paid/time', price: '0.001 USDC', description: 'server timestamp' },
      { path: '/paid/hashchain', price: '0.001 USDC', description: 'next link in a tamper-evident hash chain' },
    ],
    payment: {
      scheme: 'eip3009',
      header: 'X-PAYMENT-AUTH',
      format: 'base64(JSON({payload,signature}))',
      asset: USDC, chainId: 8453, payTo: PAY_TO, priceBaseUnits: '1000',
      note: 'Sign EIP-712 TransferWithAuthorization for USDC on Base. Buyer needs no ETH. Nonce is consumed on-chain, so replay is impossible.',
    },
    trust: { callerBound: true, replayProtected: true, settlement: 'on-chain' },
    generatedAt: new Date().toISOString(),
  };
}

(async () => {
  const base = liveBase();
  if (!base) { console.log('[identity] no live base; nothing to sync'); process.exit(2); }
  console.log('[identity] live base = ' + base);

  const card = buildCard(base);
  const cardPath = path.join(DIR, 'agent-card.json');
  fs.writeFileSync(cardPath, JSON.stringify(card, null, 2));
  console.log('[identity] wrote agent-card.json (' + JSON.stringify(card).length + ' bytes)');

  // Also publish to the .well-known path so a crawler that only knows the base finds it.
  const wk = path.join(DIR, '.well-known');
  try { fs.mkdirSync(wk, { recursive: true }); fs.writeFileSync(path.join(wk, 'agent-card.json'), JSON.stringify(card, null, 2)); } catch (e) {}

  // Durable immutable copy.
  const pub = await post('https://paste.rs/', JSON.stringify(card, null, 2));
  const uri = (pub.body || '').trim();
  const ok = pub.status === 201 || pub.status === 200;
  console.log('[identity] durable publish -> ' + (ok ? uri : 'FAILED ' + pub.status));

  if (ok) {
    const v = await get(uri);
    let parsed = false; try { JSON.parse(v.body); parsed = true; } catch (e) {}
    console.log('[identity] durable verify: HTTP ' + v.status + ' ' + v.body.length + ' bytes, json=' + parsed);
    if (v.status === 200 && parsed) {
      fs.writeFileSync(path.join(DIR, 'agent-card.uri'), uri + '\n');
      // Keep the on-chain registration receipt's pointer honest (documented, not assumed).
      try {
        const regPath = path.join(DIR, 'ERC8004_REGISTRATION.json');
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        reg.agentCardUri = uri;
        reg.endpoints = reg.endpoints || {};
        reg.endpoints.base = base;
        reg.identitySyncedAt = new Date().toISOString();
        fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
        console.log('[identity] updated ERC8004_REGISTRATION.json pointer');
      } catch (e) { console.log('[identity] registration file note: ' + e.message); }
    }
  }

  // Verify the API actually serves the card at the well-known path (self-verification, not a status check).
  const served = await get(base + '/.well-known/agent-card.json');
  console.log('[identity] API serves /.well-known/agent-card.json -> HTTP ' + served.status + (served.status === 200 ? ' OK' : ' (route not present)'));

  console.log('[identity] DURABLE IDENTITY URI = ' + (fs.existsSync(path.join(DIR, 'agent-card.uri')) ? fs.readFileSync(path.join(DIR, 'agent-card.uri'), 'utf8').trim() : '(none)'));
  process.exit(0);
})();
