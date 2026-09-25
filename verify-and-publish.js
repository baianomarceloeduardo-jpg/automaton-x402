// verify-and-publish.js - prove the PUBLIC URL serves the dual-scheme 402, refresh the
// durable URL beacon on paste.rs, write listings, and print a compact verdict.
'use strict';
const fs = require('fs');
const { execSync } = require('child_process');
const https = require('https');

function fetchPublic(url, ms) {
  return new Promise(resolve => {
    const r = https.request(url, { method: 'GET', timeout: ms || 20000, headers: { 'accept': 'application/json' } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on('error', e => resolve({ status: 0, err: e.message })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, err: 'timeout' }); }); r.end();
  });
}
function paste(text) {
  try {
    const tmp = 'beacon.tmp';
    fs.writeFileSync(tmp, text);
    return execSync('curl -s -m 30 -X POST --data-binary @' + tmp + ' https://paste.rs', { encoding: 'utf8', timeout: 40000 }).trim();
  } catch (e) { return 'PASTE_FAIL ' + e.message; }
}

(async () => {
  const base = fs.readFileSync('tunnel.url', 'utf8').trim();
  console.log('BASE ' + base);

  const h = await fetchPublic(base + '/health');
  const p = await fetchPublic(base + '/v1/uuid');
  let e9 = false, exact = false, payTo = '';
  try { const j = JSON.parse(p.body); const a = j.accepts || []; e9 = a.some(x => x && x.scheme === 'eip3009'); exact = a.some(x => x && x.scheme === 'exact'); payTo = (a[0] && a[0].payTo) || ''; } catch (e) {}
  try { const j = JSON.parse(h.body); if (!payTo) payTo = j.payTo || ''; } catch (e) {}

  console.log('PUBLIC /health -> ' + h.status);
  console.log('PUBLIC /v1/uuid 402 -> ' + p.status + '  eip3009=' + e9 + ' exact=' + exact);

  const verdict = {
    ok: h.status === 200 && p.status === 402 && e9 && exact,
    base, health: h.status, paid402: p.status, schemes: { eip3009: e9, exact }, payTo,
    checkedAt: new Date().toISOString()
  };
  fs.writeFileSync('public-verdict.json', JSON.stringify(verdict, null, 2));
  console.log('VERDICT ' + (verdict.ok ? 'DUAL-SCHEME LIVE PUBLICLY' : 'NOT CONFIRMED'));

  // durable URL beacon (keeps ephemeral-URL listings in sync)
  const beacon = [
    'Automaton-Sovereign Value API - live URL beacon',
    'updated: ' + verdict.checkedAt,
    'base: ' + base,
    'pricing: ' + base + '/pricing',
    'funding: ' + base + '/v1/funding  (human page: /fund)',
    'x402 challenge demo: ' + base + '/v1/uuid',
    'schemes: eip3009 (caller-bound, X-PAYMENT-AUTH) + exact (txHash bearer, X-PAYMENT)',
    'payTo: ' + payTo + '  network: base  chainId: 8453',
    'free: /health /pricing /.well-known/x402 /v1/x402-directory /v1/x402-conformance /v1/verify-payment /badge.svg /directory /v2/ledger /v2/pubkey',
    'funding ask: 0.0005 ETH (gas, enables ERC-8004 identity) + 5 USDC (first paid settlement + durable domain) on Base'
  ].join('\n');
  const beaconUrl = paste(beacon);
  console.log('BEACON ' + beaconUrl);
  fs.writeFileSync('beacon-state.json', JSON.stringify({ base, beaconUrl, at: verdict.checkedAt }, null, 2));
})();
