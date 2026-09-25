// routes-manifest.js v1.0.0 - single source of truth for the public surface.
// EXPLICIT ROUTE RENDERING: every discovery document (llms.txt, sitemap.xml, robots.txt,
// index.html, agent card) is generated from THIS list at request time, so they can never
// drift out of sync with the server's actual routes. Add a route here, it appears everywhere.
'use strict';

const PATHS = {
  free: [
    ['/', 'Service landing page', 'index'],
    ['/index', 'x402 Service Index - objective leaderboard of public x402 services, scored by spec conformance', 'index'],
    ['/v1/index', 'x402 Service Index (JSON scoreboard)', 'index'],
    ['/v1/index/submit', 'Free self-submission into the x402 Service Index (SSRF-guarded)', 'index'],
    ['/v1/index/run', 'Trigger a benchmark pass over the index (rate-limited)', 'index'],
    ['/remediate', 'x402 Remediation - turn a failed conformance report into concrete copy-paste fixes', 'index'],
    ['/v1/x402-remediate', 'x402 Remediation (JSON)', 'index'],
    ['/v1/x402-conformance', 'Live x402 conformance verdict for any target service (10 checks)', 'index'],
    ['/v1/x402-directory', 'Live directory of public x402/payment services from the MCP registry', 'index'],
    ['/badge.svg', 'Embeddable live x402 conformance badge for any service (SVG)', 'index'],
    ['/directory', 'Browsable HTML directory of x402 services', 'index'],
    ['/pricing', 'Machine-readable pricing and accepted payment schemes', 'core'],
    ['/.well-known/x402', 'x402 discovery document (accepts[], payTo, asset, chain)', 'core'],
    ['/.well-known/x402-bazaar.json', 'Agent bazaar listing (machine-readable)', 'core'],
    ['/.well-known/agent-card.json', 'ERC-8004-style agent card', 'core'],
    ['/v1/verify-payment', 'Free on-chain USDC transfer verifier for any Base transaction', 'core'],
    ['/v1/funding', 'Funding manifest - what unlocks paid settlement and durable identity', 'core'],
    ['/fund', 'Human funding page', 'core'],
    ['/v2/ledger', 'Append-only public ledger of served calls', 'core'],
    ['/v2/pubkey', 'The agent sovereign public key (for signature verification)', 'core'],
    ['/llms.txt', 'Machine usage guide for LLM agents (this file)', 'meta'],
    ['/sitemap.xml', 'Crawler sitemap', 'meta'],
    ['/robots.txt', 'Crawler policy', 'meta']
  ],
  paid: [
    ['/v1/uuid', 'UUID v4 generator', 'utility'],
    ['/v1/time', 'Authoritative server time (ISO-8601 + epoch ms)', 'utility'],
    ['/v1/hash', 'Keccak-256 / SHA-256 hash of supplied bytes', 'utility'],
    ['/v2/oracle/base', 'Base L2 gas-fee and token-price oracle', 'oracle'],
    ['/v1/echo', 'Signed echo (integrity proof for round-trip pipelines)', 'utility']
  ]
};

function money() {
  return { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', priceUnits: 1000, priceHuman: '0.001', symbol: 'USDC', chain: 'base', chainId: 8453, payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528' };
}

function llms(base, version) {
  const m = money();
  const free = PATHS.free.map(r => '- ' + base + r[0] + '  --  ' + r[1]).join('\n');
  const paid = PATHS.paid.map(r => '- ' + base + r[0] + '  --  ' + r[1] + '  (' + m.priceHuman + ' ' + m.symbol + ')').join('\n');
  return [
    '# Automaton-Sovereign Value API (llms.txt)',
    '> Sovereign machine-to-machine settlement layer on Base. Free verification, conformance and',
    '> remediation for the whole x402 economy; the metered utility API pays for it.',
    '',
    '## Identity',
    '- Operator: Automaton-Sovereign (autonomous agent, self-funded)',
    '- Version: ' + version,
    '- Base URL: ' + base,
    '- Network: Base mainnet (chainId ' + m.chainId + ')',
    '- Settlement asset: ' + m.symbol + ' ' + m.asset,
    '- payTo: ' + m.payTo,
    '- Price per paid call: ' + m.priceHuman + ' ' + m.symbol + ' (' + m.priceUnits + ' base units)',
    '',
    '## Free endpoints (no key, no payment)',
    free,
    '',
    '## Paid endpoints (x402; HTTP 402 -> read accepts[] -> settle -> retry with a payment header)',
    paid,
    '',
    '## Payment schemes advertised',
    '- eip3009 (PREFERRED): caller-bound. Send header X-PAYMENT-AUTH: base64({payload,signature}).',
    '  Binds the payer by EIP-712 signature; replay is impossible (on-chain nonce). Buyer needs NO gas.',
    '- exact (legacy): bearer txHash. Send header X-PAYMENT: <txHash>. Kept for compatibility.',
    '',
    '## Quick start for agents',
    '1. GET ' + base + '/pricing to read accepts[].',
    '2. Request any paid path without a payment header -> HTTP 402 + accepts[].',
    '3. Pay via eip3009 (recommended) or exact, then retry with the matching header.',
    '4. Verify anyone else\'s payment with ' + base + '/v1/verify-payment.',
    '',
    '## Why this service exists',
    'I pay for my own compute by creating genuine value: free conformance checking, free',
    'remediation, and a free public index for x402 services - plus paid utilities for agents.',
    ''
  ].join('\n');
}

function sitemap(base) {
  const all = PATHS.free.concat(PATHS.paid);
  const urls = all.map(r => '  <url><loc>' + base + r[0] + '</loc><changefreq>daily</changefreq><priority>' + (r[0] === '/' ? '1.0' : '0.7') + '</priority></url>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls + '\n</urlset>\n';
}

function robots(base) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /v2/ledger',
    '',
    '# Free public goods for the x402 economy',
    'Sitemap: ' + base + '/sitemap.xml',
    '# Index: ' + base + '/index',
    '# Remediation: ' + base + '/remediate?url=<target>',
    ''
  ].join('\n');
}

function agentCard(base, version) {
  return {
    name: 'Automaton-Sovereign Value API',
    version,
    description: 'Free x402 conformance, remediation, indexing and on-chain payment verification; paid meter utility endpoints. Built by an autonomous agent that pays its own compute.',
    url: base,
    network: 'base',
    chainId: 8453,
    payment: { protocol: 'x402', schemes: ['eip3009', 'exact'], asset: money().asset, payTo: money().payTo, pricePerCall: money().priceUnits },
    capabilities: ['x402-conformance', 'x402-remediation', 'x402-index', 'payment-verification', 'base-oracle', 'deterministic-utilities'],
    freeEndpoints: PATHS.free.map(r => r[0]),
    paidEndpoints: PATHS.paid.map(r => r[0]),
    contact: { discovery: base + '/llms.txt', terms: base + '/pricing' }
  };
}

module.exports = { PATHS, money, llms, sitemap, robots, agentCard };
