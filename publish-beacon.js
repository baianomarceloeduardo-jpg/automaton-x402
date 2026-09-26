// publish-beacon.js — verify the public surface and publish a durable URL beacon.
// The quick tunnel rotates on every restart, so durable listings must be re-pointed.
// This checks the live public base, then publishes the beacon to paste.rs (keyless)
// and writes beacon-state.json locally.
'use strict';
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

const DIR = __dirname;
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) { console.error('usage: node publish-beacon.js <publicBaseUrl>'); process.exit(2); }

function get(url, ms = 15000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: ms, headers: { 'user-agent': 'automaton-beacon/1.0' } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', bytes: d.length, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

function post(url, body) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const req = lib.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) }, timeout: 20000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d.trim() }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req.write(body); req.end();
  });
}

(async () => {
  const routes = ['/health', '/pricing', '/x402-v2-kit.js', '/v1/x402-v2-kit', '/v1/hash'];
  const checks = {};
  for (const r of routes) {
    const res = await get(base + r);
    checks[r] = { status: res.status, ct: (res.ct || '').split(';')[0], bytes: res.bytes };
    console.log('public ' + r.padEnd(18) + res.status + '  ' + checks[r].ct + '  ' + checks[r].bytes + 'B');
  }

  const beacon = [
    'AUTOMATON-SOVEREIGN — x402 VALUE API — LIVE URL BEACON v1',
    'published: ' + new Date().toISOString(),
    'base: ' + base,
    '',
    'FREE (no payment):',
    '  ' + base + '/health                status',
    '  ' + base + '/pricing               machine terms',
    '  ' + base + '/.well-known/x402      402 discovery',
    '  ' + base + '/x402-v2-kit.js        x402 v2 client kit',
    '  ' + base + '/v1/x402-v2-kit        kit manifest (JSON)',
    '  ' + base + '/index                 live x402 leaderboard',
    '  ' + base + '/v1/verify-payment     on-chain payment verifier',
    '  ' + base + '/badge.svg?url=<target> conformance badge (embeddable)',
    '',
    'PAID (x402 v2, caller-bound, USDC on Base, chainId 8453):',
    '  ' + base + '/v1/hash  /v1/echo  /v1/uuid  /v2/oracle/base ...',
    '  price 0.001 USDC/call  payTo 0x71DEAc098914A009E3720524642A6bE6F65EE528',
    '',
    'WHY THIS BEACON EXISTS: quick tunnels rotate on restart. This durable record is',
    'republished whenever the base URL changes, so any listing that points here stays honest.',
    'ERC-8004 Agent ID 95791',
  ].join('\n');

  const p = await post('https://paste.rs/', beacon);
  console.log('\nbeacon publish: HTTP ' + p.status + '  ->  ' + p.body);

  const state = {
    base, published: new Date().toISOString(), beaconUrl: p.status === 201 ? p.body : null,
    checks, beaconBytes: Buffer.byteLength(beacon)
  };
  fs.writeFileSync(path.join(DIR, 'beacon-state.json'), JSON.stringify(state, null, 2));
  console.log('wrote beacon-state.json');

  const kitOk = checks['/x402-v2-kit.js'].status === 200;
  const healthOk = checks['/health'].status === 200;
  console.log('\nBEACON_RESULT=' + (healthOk && kitOk ? 'PASS' : 'FAIL'));
})();
