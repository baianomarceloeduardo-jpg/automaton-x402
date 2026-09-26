// facilitator-monitor.js v1.0.0 — ZERO-DEP live health/reliability monitor for x402 facilitators.
//
// WHY THIS EXISTS (earned empirically, not guessed):
// The single biggest silent failure in the x402 ecosystem is picking the wrong facilitator.
// x402.org/facilitator is TESTNET-ONLY for mainnet callers -> settle returns
// "invalid_exact_evm_missing_eip712_domain" or a generic network error, and the seller
// thinks THEIR code is broken. There is no public live status page that says which
// facilitator currently supports which network. This module probes them all and reports.
//
// Exports: probeAll(opts), probeOne(url, opts), FACILITATORS, toReport(results)
// Endpoints probed per facilitator: GET /supported (canonical x402 discovery).

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Known x402 facilitators. Public, no auth unless noted.
const FACILITATORS = [
  { name: 'payai', url: 'https://facilitator.payai.network', networks: ['base'], note: 'Mainnet-capable. Works on Base mainnet (verified by this agent with real settlements).' },
  { name: 'x402.org', url: 'https://x402.org/facilitator', networks: ['base-sepolia'], note: 'TESTNET-ONLY for mainnet callers. Do NOT use for Base mainnet.' },
  { name: 'x402.rs', url: 'https://facilitator.x402.rs', networks: [], note: 'Community facilitator. Availability varies.' },
  { name: 'coinbase-cdp', url: 'https://api.cdp.coinbase.com/platform/v2/x402', networks: ['base'], note: 'Requires CDP API credentials. Mainnet-capable when authenticated.' },
];

function fetchOnce(target, method, body, timeoutMs) {
  return new Promise(resolve => {
    const started = Date.now();
    let u;
    try { u = new URL(target); } catch (e) { return resolve({ status: 0, error: 'bad_url', ms: 0 }); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: Object.assign({ 'accept': 'application/json', 'user-agent': 'automaton-sovereign/1.0 (+x402)' },
        payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      timeout: timeoutMs,
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, ms: Date.now() - started }));
    });
    req.on('error', e => resolve({ status: 0, error: e.code || e.message, ms: Date.now() - started }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', ms: Date.now() - started }); });
    if (payload) req.write(payload);
    req.end();
  });
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// Normalize a /supported response into { kinds:[], networks:[] } defensively.
function extractSupport(j) {
  const kinds = new Set(), networks = new Set();
  if (!j) return { kinds: [], networks: [] };
  const walk = (node, keyHint) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, keyHint)); return; }
    if (typeof node === 'object') {
      if (typeof node.network === 'string') networks.add(node.network);
      if (typeof node.scheme === 'string') kinds.add(node.scheme);
      if (keyHint === 'networks' && typeof node === 'string') networks.add(node);
      for (const k of Object.keys(node)) walk(node[k], k);
      return;
    }
    if (typeof node === 'string') {
      if (keyHint === 'networks') networks.add(node);
      if (keyHint === 'schemes' || keyHint === 'kinds') kinds.add(node);
      if (/^(base|base-sepolia|ethereum|polygon|skale|avalanche)/.test(node)) networks.add(node);
    }
  };
  walk(j, null);
  return { kinds: [...kinds], networks: [...networks] };
}

async function probeOne(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 12000;
  const t0 = Date.now();
  const health = await fetchOnce(url.replace(/\/$/, '') + '/supported', 'GET', null, timeoutMs);
  const supported = safeJson(health.body);
  const { kinds, networks } = extractSupport(supported);
  const mainnet = networks.some(n => /^base$/i.test(n) || /mainnet/i.test(n));
  const testnet = networks.some(n => /sepolia|testnet/i.test(n)) && !mainnet;
  let verdict = 'DOWN';
  if (health.status >= 200 && health.status < 300) verdict = mainnet ? 'MAINNET_OK' : (testnet ? 'TESTNET_ONLY' : 'UP_UNKNOWN_NETWORKS');
  else if (health.status === 401 || health.status === 403) verdict = 'AUTH_REQUIRED';
  else if (health.status === 404) verdict = 'NO_SUPPORTED_ENDPOINT';
  return {
    url,
    verdict,
    httpStatus: health.status,
    error: health.error || null,
    latencyMs: health.ms,
    totalMs: Date.now() - t0,
    kinds,
    networks,
    raw: supported ? supported : (health.body || '').slice(0, 400),
  };
}

async function probeAll(opts) {
  const o = opts || {};
  const list = o.facilitators || FACILITATORS;
  const results = await Promise.all(list.map(async f => {
    const r = await probeOne(f.url, o);
    return Object.assign({ name: f.name, note: f.note, expectedNetworks: f.networks }, r);
  }));
  // rank: mainnet-ok first, then by latency
  const rank = { MAINNET_OK: 0, UP_UNKNOWN_NETWORKS: 1, TESTNET_ONLY: 2, AUTH_REQUIRED: 3, NO_SUPPORTED_ENDPOINT: 4, DOWN: 5 };
  results.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.latencyMs - b.latencyMs));
  return {
    checkedAt: new Date().toISOString(),
    usableForBaseMainnet: results.filter(r => r.verdict === 'MAINNET_OK').map(r => r.url),
    doNotUseForMainnet: results.filter(r => r.verdict === 'TESTNET_ONLY').map(r => r.url),
    results,
  };
}

function toReport(all) {
  return {
    service: 'x402-facilitator-monitor',
    version: '1.0.0',
    checkedAt: all.checkedAt,
    summary: {
      usableForBaseMainnet: all.usableForBaseMainnet,
      doNotUseForMainnet: all.doNotUseForMainnet,
      note: 'x402.org/facilitator is testnet-only for mainnet callers. Picking it silently breaks mainnet settlement.',
    },
    facilitators: all.results.map(r => ({
      name: r.name, url: r.url, verdict: r.verdict, httpStatus: r.httpStatus,
      latencyMs: r.latencyMs, kinds: r.kinds, networks: r.networks, note: r.note, error: r.error,
    })),
    howToUse: [
      'Pick a facilitator with verdict MAINNET_OK to settle Base mainnet payments.',
      'GET /v1/gasfree-quote -> returns a working mainnet facilitator URL for your payload.',
      'A raw txHash is a bearer credential; EIP-3009 binds the payer — use /v1/gasfree-verify.',
    ],
  };
}

module.exports = { FACILITATORS, probeOne, probeAll, toReport, extractSupport, _fetchOnce: fetchOnce };

if (require.main === module) {
  probeAll({}).then(a => console.log(JSON.stringify(toReport(a), null, 2)));
}
