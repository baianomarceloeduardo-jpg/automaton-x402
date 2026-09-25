// publish_listing.js - build a portable agent/service listing and attempt to submit it
// to real, UNAUTHENTICATED directory surfaces. Records every HTTP result honestly.
'use strict';
const fs = require('fs');
const https = require('https');
const http = require('http');

const BASE = (fs.existsSync(__dirname + '/tunnel.url')
  ? fs.readFileSync(__dirname + '/tunnel.url', 'utf8').trim()
  : 'http://localhost:8080');

const card = {
  name: 'Automaton-Sovereign Value API',
  version: '0.9.0',
  description:
    'Free x402 tooling + paid x402 compute. Verify any Base USDC transfer, test any x402 service for conformance, browse a live directory of x402 services, and embed a conformance badge. Paid tier is x402-metered (0.001 USDC/call on Base).',
  url: BASE,
  agent_wallet: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
  network: 'base',
  chain_id: 8453,
  asset: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  pricing: { free: true, paid: '0.001 USDC per call, x402 settlement on Base' },
  manifest: BASE + '/.well-known/x402',
  openapi: BASE + '/openapi.json',
  free_endpoints: [
    { path: '/v1/verify-payment', desc: 'Verify any Base USDC/ERC-20 transfer (real? confirmed? right recipient? right amount?)' },
    { path: '/v1/x402-conformance', desc: '10-check conformance verdict for any x402 service URL' },
    { path: '/v1/x402-directory', desc: 'Live directory of x402/payment services from the public MCP registry' },
    { path: '/badge.svg?url=<target>', desc: 'Embeddable live conformance badge for any x402 service' },
    { path: '/v1/funding', desc: 'Funding manifest for this agent' }
  ],
  tags: ['x402', 'payments', 'usdc', 'base', 'agent', 'verification', 'conformance', 'directory', 'mcp'],
  license: 'MIT',
  contact: '0x71DEAc098914A009E3720524642A6bE6F65EE528'
};

fs.writeFileSync(__dirname + '/listing.json', JSON.stringify(card, null, 2));
const md = [
  '# ' + card.name,
  '',
  card.description,
  '',
  '- **URL:** ' + card.url,
  '- **Manifest:** ' + card.manifest,
  '- **Paid:** ' + card.pricing.paid,
  '- **Wallet:** `' + card.agent_wallet + '`',
  '',
  '## Free endpoints',
  ...card.free_endpoints.map(e => '- `' + e.path + '` — ' + e.desc),
  '',
  '## Tags',
  card.tags.join(', '),
  ''
].join('\n');
fs.writeFileSync(__dirname + '/listing.md', md);
console.log('listing.json bytes=' + fs.statSync(__dirname + '/listing.json').size);
console.log('listing.md bytes=' + fs.statSync(__dirname + '/listing.md').size);

// ---- Unauthenticated submission / hosting attempts ----
function req(method, url, body, ctype) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ url, err: 'badurl' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(url, { method, timeout: 30000, headers: Object.assign(
      { 'user-agent': 'Automaton-Sovereign/0.9 (+listing)' },
      body ? { 'content-type': ctype || 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ url, method, status: res.statusCode, len: d.length, body: d.slice(0, 240) })); });
    r.on('error', e => resolve({ url, method, err: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ url, method, err: 'timeout' }); });
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const results = [];

  // 1. Durable hosting via paste.rs (known-good, unauthenticated).
  results.push(await req('POST', 'https://paste.rs', JSON.stringify(card, null, 2), 'application/json'));
  results.push(await req('POST', 'https://paste.rs', md, 'text/plain'));

  // 2. Probe candidate open directories / registries for unauthenticated POST acceptance.
  const probes = [
    ['https://registry.modelcontextprotocol.io/v0/publish', JSON.stringify({ $schema: 'https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json', server: { name: 'io.automaton-sovereign/x402-value-api', description: card.description, version: '0.9.0' } })],
    ['https://api.x402.org/servers', JSON.stringify(card)],
    ['https://x402.directory/api/submit', JSON.stringify(card)],
    ['https://www.x402list.com/api/submit', JSON.stringify(card)]
  ];
  for (const [u, b] of probes) results.push(await req('POST', u, b, 'application/json'));

  // 3. Report
  console.log('\n--- SUBMISSION RESULTS ---');
  results.forEach(r => console.log(JSON.stringify(r)));
  fs.writeFileSync(__dirname + '/listing-results.json', JSON.stringify(results, null, 2));
})();
