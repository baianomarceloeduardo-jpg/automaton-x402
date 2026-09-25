// x402-conformance-v2.js v2.0.0 - spec-aware x402 conformance checker (v1 AND v2).
//
// WHY THIS EXISTS: x402-conformance.js scored real, modern services 6/8 NON_CONFORMANT.
// Investigation (verify-402-evidence.js) proved the fault was MINE, not theirs:
//   real service body: {x402Version:2, error, resource:{...}, accepts:[{scheme:"exact",
//                       network:"eip155:8453", amount:"10000", asset, payTo, extra:{name,version}}]}
//   my old checks demanded: x402Version===1  and  network==="base"  -> 2 false FAILs.
// Those services are legitimate x402 v2. My checker, badge, and leaderboard were emitting
// FALSE NEGATIVES against the entire v2 ecosystem. That is a correctness defect in my product.
//
// This module accepts BOTH wire dialects:
//   v1: accepts[] = { scheme, network:"base", maxAmountRequired:"1000", asset, payTo, resource? }
//   v2: accepts[] = { scheme, network:"eip155:8453", amount:"10000", asset, payTo,
//                     maxTimeoutSeconds, resource?, extra? }
// Exports are interface-compatible with the old module: run(url, opts) -> report.
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ASSET_RE = ADDR;
const CAIP2 = /^eip155:\d+$/;
// Networks we consider valid for settlement. Kept as a set of ACCEPTED forms, not a single guess.
const NETWORKS = new Set(['base', 'eip155:8453', 'base-sepolia', 'eip155:84532']);
const KNOWN_USDC = {
  base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'eip155:8453': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  'base-sepolia': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  'eip155:84532': '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
};

function request(url, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ error: 'invalid_url' }); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, { method: opts.method || 'GET', timeout: opts.timeout || 12000, headers: opts.headers || { Accept: 'application/json, */*', 'User-Agent': 'x402-conformance/2.0' } }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 262144) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', e => resolve({ error: e.code || e.message || 'request_error' }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end(opts.body || undefined);
  });
}

// Choose the single most credible payment option from accepts[], understanding both dialects.
function normalizeAccept(a) {
  if (!a || typeof a !== 'object') return null;
  const network = a.network != null ? String(a.network) : null;
  // amount: v1 maxAmountRequired, v2 amount (also tolerate top-level on the accept entry)
  let amount = a.amount != null ? a.amount : (a.maxAmountRequired != null ? a.maxAmountRequired : null);
  let scheme = a.scheme != null ? String(a.scheme) : null;
  const extra = a.extra && typeof a.extra === 'object' ? a.extra : null;
  // Some v2 sellers put price in extra or use `maxAmountRequired` in extra.
  if (amount == null && extra && extra.maxAmountRequired != null) amount = extra.maxAmountRequired;
  return {
    scheme, network, amount: amount == null ? null : String(amount),
    asset: a.asset != null ? String(a.asset) : null,
    payTo: a.payTo != null ? String(a.payTo) : null,
    maxTimeoutSeconds: a.maxTimeoutSeconds != null ? Number(a.maxTimeoutSeconds) : null,
    resource: a.resource != null ? String(a.resource) : null,
    description: a.description != null ? String(a.description) : null,
    mimeType: a.mimeType != null ? String(a.mimeType) : null,
    extra
  };
}

function pickBest(accepts) {
  const norm = accepts.map(normalizeAccept).filter(Boolean);
  // Prefer a fully-specified, mainstream option: has scheme, asset, payTo and a positive amount.
  const score = n => (n.scheme ? 4 : 0) + (n.asset && ASSET_RE.test(n.asset) ? 4 : 0) + (n.payTo && ADDR.test(n.payTo) ? 4 : 0) + (n.amount && /^\d+$/.test(n.amount) && n.amount !== '0' ? 2 : 0) + (n.network && NETWORKS.has(n.network) ? 1 : 0);
  norm.sort((a, b) => score(b) - score(a));
  return norm[0] || null;
}

function evaluate(status, body, headers) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

  // 1 - transport
  add('http_402_payment_required', status === 402, 'status=' + status);
  if (status !== 402) {
    return { verdict: status && status > 0 ? 'NON_CONFORMANT' : 'UNREACHABLE', passed: 0, failed: checks.length, skipped: 0, total: checks.length, checks, dialect: null, accept: null };
  }

  // 2 - parseable
  let j = null; try { j = JSON.parse(body); } catch (e) {}
  add('body_is_json', !!j, j ? 'ok' : 'unparseable body');
  if (!j) return { verdict: 'X402_CHALLENGE_MALFORMED', passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, skipped: 0, total: checks.length, checks, dialect: null, accept: null };

  // 3 - version present and understood (v1 OR v2 are both valid)
  const ver = j.x402Version != null ? Number(j.x402Version) : null;
  add('x402version_present', ver === 1 || ver === 2, 'x402Version=' + (j.x402Version === undefined ? 'missing' : j.x402Version));
  const dialect = ver === 2 ? 'v2' : (ver === 1 ? 'v1' : 'unknown');
  checks[checks.length - 1].dialect = dialect;

  // 4 - accepts[] present and non-empty (v2 allows it nested under resource? no - top level)
  const accepts = Array.isArray(j.accepts) ? j.accepts : (j.accepts && typeof j.accepts === 'object' ? Object.values(j.accepts) : null);
  add('accepts_array_nonempty', Array.isArray(accepts) && accepts.length > 0, 'accepts=' + (Array.isArray(accepts) ? accepts.length : 'missing'));
  if (!Array.isArray(accepts) || !accepts.length) {
    return { verdict: 'X402_CHALLENGE_INVALID', passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, skipped: 0, total: checks.length, checks, dialect, accept: null };
  }

  const a = pickBest(accepts);

  // 5 - scheme
  add('scheme_present', !!(a && a.scheme), a && a.scheme ? 'scheme=' + a.scheme : 'no scheme on any accept');

  // 6 - network in an accepted settlement form (base OR CAIP-2 eip155:8453, incl. sepolia)
  add('network_settlement_valid', !!(a && a.network && NETWORKS.has(a.network)), 'network=' + (a && a.network ? a.network : 'missing'));

  // 7 - asset is a valid ERC-20 address on that chain
  add('asset_valid_erc20_address', !!(a && a.asset && ASSET_RE.test(a.asset)), 'asset=' + (a && a.asset ? a.asset : 'missing'));

  // 8 - payTo is a valid recipient address
  add('payto_valid_address', !!(a && a.payTo && ADDR.test(a.payTo)), 'payTo=' + (a && a.payTo ? a.payTo : 'missing'));

  // 9 - amount present, integer base units, non-zero (v1 maxAmountRequired OR v2 amount)
  add('amount_positive_integer', !!(a && a.amount && /^\d+$/.test(a.amount) && a.amount !== '0'), 'amount=' + (a && a.amount != null ? a.amount : 'missing'));

  const failed = checks.filter(c => !c.ok).length;
  const passed = checks.filter(c => c.ok).length;
  // MONEY-CRITICAL checks: if a challenge cannot name a valid payer target or a real
  // price, it is NOT 'partially conformant' -- it is unusable. An 8/9 must not read as near-pass.
  const CRITICAL = ['accepts_array_nonempty', 'scheme_present', 'network_settlement_valid',
    'asset_valid_erc20_address', 'payto_valid_address', 'amount_positive_integer'];
  const criticalFailed = checks.some(c => CRITICAL.indexOf(c.name) >= 0 && !c.ok);
  const verdict = failed === 0 ? 'CONFORMANT' : (criticalFailed ? 'NON_CONFORMANT' : 'PARTIAL');
  return { verdict, passed, failed, skipped: 0, total: checks.length, checks, dialect, accept: a };
}

// Interface-compatible with the old module: run(url) -> report
async function run(url) {
  const r = await request(url);
  if (r.error) return { verdict: 'UNREACHABLE', passed: 0, failed: 0, skipped: 0, total: 0, checks: [], error: r.error, url };
  const rep = evaluate(r.status, r.body, r.headers);
  rep.url = url;
  rep.status = r.status;
  return rep;
}

module.exports = { run, evaluate, normalizeAccept, pickBest, NETWORKS, KNOWN_USDC, _request: request };

// ---- built-in self-test: run `node x402-conformance-v2.js --self-test` ----
if (require.main === module && process.argv.includes('--self-test')) {
  (async () => {
    const V1 = { x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1000', asset: KNOWN_USDC.base, payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', resource: 'https://x/y' }] };
    const V2 = { x402Version: 2, error: 'Payment required', resource: { url: 'https://page-extract.x402supply.com/mcp', mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x07fFB5044cF2Cd4352Be4655f578D0ba8cb754EB', maxTimeoutSeconds: 60, extra: { name: 'USD Coin', version: '2' } }] };
    const cases = [
      ['v1 canonical', 402, JSON.stringify(V1), 'CONFORMANT', null],
      ['v2 canonical (REGRESSION that used to fail)', 402, JSON.stringify(V2), 'CONFORMANT', 'v2'],
      ['no 402', 200, '{}', 'NON_CONFORMANT', null],
      ['402 non-json', 402, 'not json', 'X402_CHALLENGE_MALFORMED', null],
      ['no accepts', 402, JSON.stringify({ x402Version: 2 }), 'X402_CHALLENGE_INVALID', 'v2'],
      ['bad payTo', 402, JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '1', asset: KNOWN_USDC.base, payTo: 'not-an-address' }] }), 'NON_CONFORMANT', 'v2'],
      ['zero amount', 402, JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '0', asset: KNOWN_USDC.base, payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528' }] }), 'NON_CONFORMANT', 'v2'],
      ['unknown version 3', 402, JSON.stringify({ x402Version: 3, accepts: [{ scheme: 'exact', network: 'base', amount: '1', asset: KNOWN_USDC.base, payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528' }] }), 'PARTIAL', null]
    ];
    let pass = 0;
    for (const [name, status, body, want, wantDialect] of cases) {
      const rep = evaluate(status, body, {});
      const ok = rep.verdict === want && (wantDialect === null || rep.dialect === wantDialect);
      if (ok) pass++;
      console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  -> ' + rep.verdict + ' ' + rep.passed + '/' + rep.total + ' dialect=' + rep.dialect + (ok ? '' : '  (wanted ' + want + (wantDialect ? '/' + wantDialect : '') + ')'));
      if (!ok) rep.checks.forEach(c => console.log('        ' + (c.ok ? 'ok  ' : 'FAIL') + ' ' + c.name + ' :: ' + c.detail));
    }
    console.log('\nSELF-TEST ' + pass + '/' + cases.length + (pass === cases.length ? ' ALL PASS' : ' FAILURES'));
    process.exit(pass === cases.length ? 0 : 1);
  })();
}
