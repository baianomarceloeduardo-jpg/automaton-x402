// x402-remediate.js v1.0.0 - free, actionable remediation for x402 services.
// Runs my conformance checker, then maps every FAILED check to a concrete fix with a
// copy-pasteable snippet. This is the thing x402 developers actually share.
'use strict';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function conf() { try { return require('./x402-conformance.js'); } catch (e) { return null; } }

function normId(r) { return String(r.id || r.name || r.check || r.key || r.label || r.title || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function isOk(r) {
  if (typeof r.passed === 'boolean') return r.passed;
  if (typeof r.ok === 'boolean') return r.ok;
  if (typeof r.pass === 'boolean') return r.pass;
  return String(r.status || '').toLowerCase() === 'pass';
}
function detail(r) { return String(r.detail || r.message || r.reason || r.note || r.description || '').slice(0, 300); }

const CANON_SNIPPET = [
  '// Minimal conformant x402 402-challenge (Node, zero deps)',
  "const USDC_BASE = '" + USDC_BASE + "';",
  'const PAY_TO    = \'0xYOUR_WALLET_ON_BASE\';',
  '',
  'function paymentRequired(res, resource, amountUnits, baseUrl) {',
  '  const body = {',
  '    x402Version: 1,',
  '    error: "payment_required",',
  '    accepts: [{',
  '      scheme: "exact",',
  '      network: "base",',
  '      chainId: 8453,',
  "      asset: USDC_BASE,          // USDC on Base",
  '      payTo: PAY_TO,',
  '      maxAmountRequired: String(amountUnits),  // 1000 = 0.001 USDC (6 dp)',
  '      resource,',
  '      description: "Metered call",',
  '      mimeType: "application/json",',
  '      maxTimeoutSeconds: 60,',
  '      extra: { name: "USD Coin", version: "2" }',
  '    }]',
  '  };',
  '  res.writeHead(402, {',
  '    "Content-Type": "application/json",',
  '    "WWW-Authenticate": \'x402 scheme="exact", network="base"\'',
  '  });',
  '  res.end(JSON.stringify(body));',
  '}'
].join('\n');

const REMEDIES = [
  {
    match: ['status', 'httpstatus', 'responsestatus'],
    why: 'x402 requires an HTTP 402 (Payment Required) as the challenge. Without it no agent can discover your price.',
    fix: 'Return status 402 from the protected route when no X-PAYMENT header is present. See the canonical snippet below.'
  },
  {
    match: ['json', 'contenttype', 'parse', 'body'],
    why: 'The 402 body must be JSON (application/json) so clients can parse accepts[].',
    fix: 'Set res.writeHead(402, { "Content-Type": "application/json" }) and res.end(JSON.stringify(body)).'
  },
  {
    match: ['scheme'],
    why: 'accepts[].scheme tells the buyer how to pay. "exact" is the standard scheme for a fixed-price USDC transfer.',
    fix: 'Add scheme: "exact" to each entry in accepts[]. For caller-bound payments also advertise scheme: "eip3009".'
  },
  {
    match: ['network'],
    why: 'Without accepts[].network the client cannot pick the right chain/settlement path.',
    fix: 'Add network: "base" (CAIP-style name) to each accepts[] entry.'
  },
  {
    match: ['chainid'],
    why: 'chainId must be the numeric EVM chain id so wallets do not sign for the wrong chain.',
    fix: 'Add chainId: 8453 (Base mainnet) to each accepts[] entry.'
  },
  {
    match: ['asset', 'token', 'currency', 'contract'],
    why: 'accepts[].asset must be the exact ERC-20 contract address. Wrong asset = unpayable invoice.',
    fix: 'Add asset: "' + USDC_BASE + '" (official USDC on Base) to each accepts[] entry.'
  },
  {
    match: ['payto', 'payee', 'recipient', 'address'],
    why: 'accepts[].payTo is where funds must land. It must be a 20-byte 0x address you control on the target chain.',
    fix: 'Add payTo: "0x<your base address>" to each accepts[] entry and verify it on the block explorer.'
  },
  {
    match: ['amount', 'price', 'maxamount', 'required'],
    why: 'accepts[].maxAmountRequired is the price in the asset smallest unit (USDC has 6 decimals).',
    fix: 'Add maxAmountRequired as a STRING of integer base units: "1000" = 0.001 USDC. Never send a float.'
  },
  {
    match: ['accepts', 'challenge', 'paymentrequired', 'x402'],
    why: 'The 402 body must contain an accepts[] array — that array IS the offer.',
    fix: 'Emit a top-level { x402Version: 1, error, accepts: [ ... ] } JSON object. See the canonical snippet below.'
  }
];

function remedyFor(r) {
  const id = normId(r);
  const text = (id + ' ' + detail(r)).toLowerCase();
  for (const r0 of REMEDIES) { if (r0.match.some(m => text.indexOf(m) >= 0)) return r0; }
  return { why: 'This check failed but is not in the standard remediation table.', fix: 'Inspect the detail string, then re-run the conformance check.' };
}

async function remediate(url) {
  const C = conf();
  if (!C) return { ok: false, error: 'conformance_module_missing' };
  let c;
  try { c = await C.run(url); } catch (e) { return { ok: false, error: 'probe_failed', message: String(e.message || e) }; }
  const results = Array.isArray(c.results) ? c.results : [];
  const failures = results.filter(r => !isOk(r)).map(r => {
    const rm = remedyFor(r);
    return { check: normId(r) || 'check', detail: detail(r), why: rm.why, fix: rm.fix };
  });
  const passed = c.passed || 0, total = c.total || 0;
  const verdict = c.verdict || 'UNKNOWN';
  return {
    via: 'x402-remediate v1.0.0',
    target: url,
    verdict, passed, total,
    conformant: verdict === 'CONFORMANT',
    failures,
    failureCount: failures.length,
    canonicalChallenge: CANON_SNIPPET,
    summary: verdict === 'CONFORMANT'
      ? 'No fixes needed: this service advertises a discoverable x402 challenge.'
      : (failures.length + ' concrete fix(es) required. Apply them in order, then re-run /v1/x402-conformance.')
  };
}

module.exports = { remediate, remedyFor, normId, isOk, CANON_SNIPPET, REMEDIES, USDC_BASE };
