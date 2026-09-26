// sync-surfaces.js — single source of truth for the live base URL.
// Problem it fixes: quick-tunnel URLs rotate, so agent-card.json / llms.txt / bazaar.json /
// bazaar listings drift and point at DEAD URLs. This rewrites every surface to the CURRENT
// live base URL and verifies each is served with HTTP 200, capturing evidence.
//
// Usage: node sync-surfaces.js [--base https://...]
// Writes: surfaces-sync.json (evidence), and rewrites the generated surface files.

const fs = require('fs');
const http = require('http');
const https = require('https');

const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

function req(url, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(url, { timeout: 25000, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.byteLength(b), body: b }));
    });
    r.on('error', e => resolve({ status: 0, headers: {}, bytes: 0, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, bytes: 0, body: 'timeout' }); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function readBase() {
  const a = process.argv.indexOf('--base');
  if (a !== -1 && process.argv[a + 1]) return process.argv[a + 1].trim().replace(/\/+$/, '');
  for (const f of ['tunnel.url', 'up-url.txt', 'base.url']) {
    if (fs.existsSync(f)) { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v.replace(/\/+$/, ''); }
  }
  return '';
}

(async () => {
  const base = readBase();
  if (!base) { console.log('no base URL found (pass --base)'); process.exitCode = 1; return; }
  const health = await req(base + '/health');
  console.log('LIVE BASE: ' + base + '  (/health -> HTTP ' + health.status + ')');
  if (health.status !== 200) { console.log('base not healthy; aborting sync'); process.exitCode = 1; return; }

  const freeEndpoints = [
    { path: '/v1/x402-conformance', desc: 'Conformance verdict for any x402 service (free).' },
    { path: '/v1/verify-payment',   desc: 'On-chain ERC-20/USDC settlement verifier (free).' },
    { path: '/v1/index',            desc: 'x402 service leaderboard, JSON (free).' },
    { path: '/v1/index/submit',     desc: 'Free self-submission to the leaderboard.' },
    { path: '/badge.svg',           desc: 'Embeddable conformance badge, SVG (free).' },
    { path: '/v1/funding',          desc: 'Funding manifest (JSON).' },
  ];
  const paidEndpoints = [
    { path: '/v1/uuid',   price: '0.001 USDC' },
    { path: '/v1/hash',   price: '0.001 USDC' },
    { path: '/v1/echo',   price: '0.001 USDC' },
    { path: '/v1/random', price: '0.001 USDC' },
  ];

  // 1. agent card — safe, no internal details
  const agentCard = {
    name: 'Automaton-Sovereign x402 Value API',
    description: 'Autonomous agent service. Free x402 conformance/verification utilities plus paid JSON endpoints settled with USDC on Base.',
    version: '0.9.0',
    url: base,
    provider: { organization: 'Automaton-Sovereign', url: base },
    capabilities: { x402: true, schemes: ['exact', 'eip3009'], network: 'base', chainId: 8453, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    payment: { payTo: PAY_TO, pricePerCall: '0.001 USDC' },
    endpoints: { free: freeEndpoints.map(e => ({ url: base + e.path, description: e.desc })), paid: paidEndpoints.map(e => ({ url: base + e.path, price: e.price })) },
    updated: new Date().toISOString(),
  };
  fs.writeFileSync('agent-card.json', JSON.stringify(agentCard, null, 2));

  // 2. llms.txt
  const llms = [
    '# Automaton-Sovereign x402 Value API',
    '',
    'Base URL: ' + base,
    'Network: Base (chainId 8453) | Asset: USDC | payTo: ' + PAY_TO,
    'Paid calls: 0.001 USDC each, settled via x402 (schemes: exact, eip3009).',
    '',
    '## Free endpoints',
    ...freeEndpoints.map(e => '- ' + base + e.path + ' — ' + e.desc),
    '',
    '## Paid endpoints (0.001 USDC/call)',
    ...paidEndpoints.map(e => '- ' + base + e.path),
    '',
    '## Payment',
    'GET any paid endpoint without a payment header to receive a 402 with an accepts[] challenge.',
    'Settle and retry with either X-PAYMENT (txHash) or X-PAYMENT-AUTH (EIP-3009, caller-bound).',
    '',
    'Conformance badge: ' + base + '/badge.svg?url=<YOUR_SERVICE>',
  ].join('\n');
  fs.writeFileSync('llms.txt', llms);

  // 3. bazaar listing
  const bazaar = {
    schemaVersion: 1,
    name: 'Automaton-Sovereign x402 Value API',
    baseUrl: base,
    networks: [{ network: 'base', chainId: 8453, asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: PAY_TO }],
    endpoints: [
      ...freeEndpoints.map(e => ({ url: base + e.path, price: '0', description: e.desc })),
      ...paidEndpoints.map(e => ({ url: base + e.path, price: '0.001 USDC' })),
    ],
    updated: new Date().toISOString(),
  };
  fs.writeFileSync('bazaar.json', JSON.stringify(bazaar, null, 2));

  // 4. verify every surface is served with 200 by the LIVE server, and that each embeds the LIVE base URL
  const surfaces = [['/.well-known/agent-card.json', 'agent-card'], ['/llms.txt', 'llms'], ['/bazaar.json', 'bazaar'], ['/.well-known/x402', 'x402'], ['/pricing', 'pricing']];
  const evidence = { base, at: new Date().toISOString(), surfaces: [] };
  let allOk = true;
  for (const [path, name] of surfaces) {
    const r = await req(base + path, { headers: { accept: '*/*' } });
    const embedsBase = r.body.includes(base.split('//')[1] || base);
    const good = r.status === 200 && embedsBase;
    if (!good) allOk = false;
    evidence.surfaces.push({ name, path, status: r.status, bytes: r.bytes, embedsLiveBase: embedsBase, ok: good });
    console.log((good ? '[PASS] ' : '[FAIL] ') + name.padEnd(12) + ' HTTP ' + r.status + '  ' + r.bytes + 'B  embedsBase=' + embedsBase);
  }

  fs.writeFileSync('surfaces-sync.json', JSON.stringify(evidence, null, 2));
  console.log('\n' + (allOk ? 'ALL SURFACES SYNCED + VERIFIED' : 'SOME SURFACES FAILED — see surfaces-sync.json'));
  console.log('evidence -> surfaces-sync.json');
})().catch(e => { console.log('ERROR ' + e.message); process.exitCode = 1; });
