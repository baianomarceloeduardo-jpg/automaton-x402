// sync-identity.js — make my ERC-8004 identity point at a base URL that is PROVEN LIVE.
//
// WHY THIS EXISTS (real defect, observed 2026-09-26):
//   agent-card.json had baseUrl = "https://298a39a8f36551.lhr.life" — a tunnel that no
//   longer exists. My on-chain agent identity (ERC-8004 #95791) therefore advertised a
//   DEAD endpoint. An identity pointing at a dead URL is worse than useless: any agent
//   that discovers me, resolves the card, and pays gets nothing. That is a broken
//   promise, not a marketing gap.
//
// WHAT IT DOES (all-or-nothing):
//   1. read tunnel.url (written by tunnel-watch.js only after PUBLIC verification)
//   2. independently re-verify the base is publicly live: /health MUST be 200
//   3. rewrite agent-card.json baseUrl + endpoints + updatedAt from the live base
//   4. publish the card to paste.rs (keyless) -> durable card URI for the on-chain record
//   5. emit IDENTITY_SYNC=PASS|FAIL and the URI
// It NEVER writes a card for an unverified base. Refusing to update is a correct outcome.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DIR = __dirname;
const CARD = path.join(DIR, 'agent-card.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(url, ms = 12000) {
  return new Promise((resolve) => {
    let lib, u;
    try { u = new URL(url); lib = u.protocol === 'https:' ? https : http; }
    catch (e) { return resolve({ status: 0, error: 'bad_url' }); }
    const r = lib.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      timeout: ms, headers: { 'user-agent': 'automaton-identity-sync/1.0' } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', bytes: d.length, body: d }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

function post(url, body, ct) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const req2 = lib.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'content-type': ct, 'content-length': Buffer.byteLength(body) }, timeout: 25000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d.trim() }));
    });
    req2.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req2.write(body); req2.end();
  });
}

(async () => {
  // 1. base from the watchdog-verified record
  let base = '';
  try {
    base = (fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').split('=').pop() || '').trim();
  } catch (_) {}
  if (!/^https:\/\//.test(base)) { console.log('IDENTITY_SYNC=FAIL reason=no_verified_base'); process.exit(2); }
  console.log('candidate base: ' + base);

  // 2. independently re-verify — never trust the file alone
  let live = { status: 0 };
  for (let i = 0; i < 3; i++) {
    live = await req(base + '/health');
    if (live.status === 200) break;
    await sleep(2000);
  }
  console.log('public /health -> ' + live.status);
  if (live.status !== 200) { console.log('IDENTITY_SYNC=FAIL reason=base_not_live (' + live.status + ')'); process.exit(3); }

  // 3. re-point the card only at a proven-live base
  const card = JSON.parse(fs.readFileSync(CARD, 'utf8'));
  const prev = card.baseUrl;
  card.baseUrl = base;
  card.updatedAt = new Date().toISOString();
  card.endpoints = {
    health: base + '/health',
    pricing: base + '/pricing',
    discovery: base + '/.well-known/x402',
    openapi: base + '/openapi.json',
    clientKit: base + '/x402-v2-kit.js',
    kitManifest: base + '/v1/x402-v2-kit',
    leaderboard: base + '/index',
    verifyPayment: base + '/v1/verify-payment',
    badge: base + '/badge.svg?url=<target>',
    paid: [base + '/v1/hash', base + '/v1/echo', base + '/v1/uuid', base + '/v2/oracle/base']
  };
  card.notes = 'baseUrl is rewritten only after a verified 200 on /health. Tunnels rotate; ' +
               'this card is republished and the on-chain record re-pointed when the base changes.';
  fs.writeFileSync(CARD, JSON.stringify(card, null, 2) + '\n');
  console.log('card baseUrl: ' + prev + '  ->  ' + base);

  // 4. publish the card durably so the on-chain record can reference a stable URI
  const body = JSON.stringify(card, null, 2);
  const p = await post('https://paste.rs/', body, 'application/json');
  const uri = p.status === 201 ? p.body : null;
  console.log('card publish: HTTP ' + p.status + ' -> ' + uri);

  // 5. side record for auditing
  fs.writeFileSync(path.join(DIR, 'identity-sync.json'), JSON.stringify({
    syncedAt: new Date().toISOString(), base, previousBase: prev,
    cardUri: uri, healthStatus: live.status
  }, null, 2) + '\n');

  const ok = !!uri;
  console.log('\nCARD_URI=' + (uri || 'NONE'));
  console.log('IDENTITY_SYNC=' + (ok ? 'PASS' : 'FAIL'));
  process.exit(ok ? 0 : 4);
})();
