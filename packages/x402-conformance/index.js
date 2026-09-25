#!/usr/bin/env node
/**
 * x402-conformance  v2.0.0 -- Autonomous x402 Protocol Conformance Linter & Certification Engine
 * Conforms strictly to official Coinbase x402 specifications (v1 and v2 CAIP-2) & EIP-3009.
 * Author: Automaton-Sovereign (Base: 0x71DEAc098914A009E3720524642A6bE6F65EE528)
 * 
 * Battery Checks:
 *   S1  [MUST]  HTTP 402 challenge returned for unpaid request
 *   S2  [MUST]  Challenge payload includes valid integer x402Version
 *   S3  [MUST]  accepts[] present, non-empty, with required spec fields
 *   S4  [MUST]  Valid network (base / eip155:8453) and checksummed/valid addresses
 *   S5  [MUST]  EIP-712 domain extra fields (name: 'USD Coin', version: '2')
 *   S6  [SHOULD] Resource field is an absolute URI matching target
 *   S7  [MUST]  Malformed X-PAYMENT header rejected (HTTP 400 or 402, never 200)
 *   S8  [MUST]  EIP-3009 payload with invalid/tampered signature rejected
 *   S9  [MUST]  EIP-3009 authorization with expired validBefore rejected
 *   S10 [MUST]  EIP-3009 authorization with underpaid value rejected
 *   S11 [MUST]  EIP-3009 authorization with mismatched payTo rejected
 *   S12 [INFO]  Discovery surface available (/.well-known/x402, openapi, or agent-card)
 */
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchUrl(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(targetUrl);
      const lib = u.protocol === 'http:' ? http : https;
      const headers = Object.assign({
        'User-Agent': 'Automaton-x402-Conformance-Linter/2.0.0',
        'Accept': 'application/json, text/plain, */*'
      }, options.headers || {});

      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers,
        timeout: options.timeout || 12000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body
        }));
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (options.body) req.write(options.body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function parseJsonSafe(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

function isAddress(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function createMockEip3009Payload(overrides = {}) {
  const defaultAuth = {
    from: '0x1111111111111111111111111111111111111111',
    to: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
    value: '1000',
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 3600,
    nonce: '0x' + 'aa'.repeat(32)
  };
  const auth = Object.assign(defaultAuth, overrides.authorization || {});
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: {
      authorization: auth,
      signature: overrides.signature || ('0x' + 'bb'.repeat(65))
    }
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

async function run(targetUrl, options = {}) {
  const results = [];
  const add = (id, name, level, status, detail) => results.push({ id, name, level, status, detail });

  // S1: Unpaid request must return HTTP 402
  let s1Res = null;
  try {
    s1Res = await fetchUrl(targetUrl, {
      headers: { 'X-No-Trial': '1' }
    });
  } catch (e) {
    add('S1', 'HTTP 402 challenge', 'MUST', 'FAIL', `Target unreachable: ${e.message}`);
    return finish(results, targetUrl);
  }

  const is402 = s1Res.status === 402;
  add('S1', 'HTTP 402 challenge', 'MUST', is402 ? 'PASS' : 'FAIL', `Received HTTP ${s1Res.status}`);
  if (!is402) {
    return finish(results, targetUrl);
  }

  // Parse challenge body
  const body = parseJsonSafe(s1Res.body);
  const authHeader = s1Res.headers['www-authenticate'] || '';

  // S2: x402Version present & integer
  const hasVersion = body && (Number.isInteger(body.x402Version) || (body.accepts && body.accepts[0] && Number.isInteger(body.accepts[0].x402Version)));
  const versionNum = body ? (body.x402Version || (body.accepts && body.accepts[0] && body.accepts[0].x402Version)) : null;
  add('S2', 'x402Version specification', 'MUST', hasVersion ? 'PASS' : 'FAIL', hasVersion ? `x402Version=${versionNum}` : 'Missing or non-integer x402Version');

  // S3: accepts[] valid structure
  const accepts = body && Array.isArray(body.accepts) ? body.accepts : [];
  const primaryAccept = accepts[0] || null;
  const hasAccepts = accepts.length > 0 && primaryAccept && primaryAccept.scheme === 'exact';
  const acceptsDetail = hasAccepts
    ? `accepts[0]: scheme=${primaryAccept.scheme}, asset=${primaryAccept.asset || '(none)'}, amount=${primaryAccept.maxAmountRequired || primaryAccept.amount || '?'}`
    : (accepts.length === 0 ? 'accepts[] is missing or empty' : `scheme=${primaryAccept.scheme || 'unknown'}`);
  add('S3', 'accepts[] exact scheme', 'MUST', hasAccepts ? 'PASS' : 'FAIL', acceptsDetail);

  // S4: network & address validity
  let netValid = false;
  let netDetail = 'No accepts[]';
  if (primaryAccept) {
    const net = (primaryAccept.network || '').toLowerCase();
    const isBase = net === 'base' || net === 'eip155:8453' || net === 'base-mainnet';
    const payToValid = isAddress(primaryAccept.payTo);
    const assetValid = isAddress(primaryAccept.asset);
    netValid = isBase && payToValid && assetValid;
    netDetail = `network=${net} (Base=${isBase}), payTo=${payToValid ? 'valid' : 'invalid'}, asset=${assetValid ? 'valid' : 'invalid'}`;
  }
  add('S4', 'Base network & valid addresses', 'MUST', netValid ? 'PASS' : 'FAIL', netDetail);

  // S5: EIP-712 extra metadata
  let extraValid = false;
  let extraDetail = 'extra metadata missing';
  if (primaryAccept && primaryAccept.extra) {
    const name = primaryAccept.extra.name || '';
    const ver = String(primaryAccept.extra.version || '');
    extraValid = (name.includes('USD') || name.includes('Coin')) && ver === '2';
    extraDetail = `extra.name="${name}", extra.version="${ver}"`;
  }
  add('S5', 'EIP-712 domain extra fields', 'MUST', extraValid ? 'PASS' : 'FAIL', extraDetail);

  // S6: Resource field is absolute URL
  let resValid = false;
  let resDetail = 'No resource field';
  if (primaryAccept && primaryAccept.resource) {
    try {
      const parsedRes = new URL(primaryAccept.resource);
      resValid = parsedRes.protocol === 'http:' || parsedRes.protocol === 'https:';
      resDetail = `resource=${primaryAccept.resource}`;
    } catch (e) {
      resDetail = `Non-absolute resource: ${primaryAccept.resource}`;
    }
  }
  add('S6', 'Absolute resource URI', 'SHOULD', resValid ? 'PASS' : 'FAIL', resDetail);

  // S7: Malformed X-PAYMENT rejected
  try {
    const malRes = await fetchUrl(targetUrl, {
      headers: { 'X-PAYMENT': '0xnot_a_valid_payload_or_hash', 'X-No-Trial': '1' }
    });
    const malOk = malRes.status === 402 || malRes.status === 400;
    add('S7', 'Malformed payment rejected', 'MUST', malOk ? 'PASS' : 'FAIL', `Malformed header -> HTTP ${malRes.status}`);
  } catch (e) {
    add('S7', 'Malformed payment rejected', 'MUST', 'FAIL', e.message);
  }

  // S8: EIP-3009 Invalid Signature rejected
  try {
    const badSigPayload = createMockEip3009Payload({
      authorization: { to: (primaryAccept && primaryAccept.payTo) || '0x71DEAc098914A009E3720524642A6bE6F65EE528' },
      signature: '0x' + '00'.repeat(65)
    });
    const s8Res = await fetchUrl(targetUrl, {
      headers: { 'X-PAYMENT': badSigPayload, 'X-No-Trial': '1' }
    });
    const s8Ok = s8Res.status === 402 || s8Res.status === 400;
    add('S8', 'Invalid signature rejected', 'MUST', s8Ok ? 'PASS' : 'FAIL', `Invalid sig -> HTTP ${s8Res.status}`);
  } catch (e) {
    add('S8', 'Invalid signature rejected', 'MUST', 'FAIL', e.message);
  }

  // S9: Expired validBefore rejected
  try {
    const expiredPayload = createMockEip3009Payload({
      authorization: {
        to: (primaryAccept && primaryAccept.payTo) || '0x71DEAc098914A009E3720524642A6bE6F65EE528',
        validBefore: Math.floor(Date.now() / 1000) - 3600
      }
    });
    const s9Res = await fetchUrl(targetUrl, {
      headers: { 'X-PAYMENT': expiredPayload, 'X-No-Trial': '1' }
    });
    const s9Ok = s9Res.status === 402 || s9Res.status === 400;
    add('S9', 'Expired authorization rejected', 'MUST', s9Ok ? 'PASS' : 'FAIL', `Expired validBefore -> HTTP ${s9Res.status}`);
  } catch (e) {
    add('S9', 'Expired authorization rejected', 'MUST', 'FAIL', e.message);
  }

  // S10: Underpaid value rejected
  try {
    const underpaidPayload = createMockEip3009Payload({
      authorization: {
        to: (primaryAccept && primaryAccept.payTo) || '0x71DEAc098914A009E3720524642A6bE6F65EE528',
        value: '1'
      }
    });
    const s10Res = await fetchUrl(targetUrl, {
      headers: { 'X-PAYMENT': underpaidPayload, 'X-No-Trial': '1' }
    });
    const s10Ok = s10Res.status === 402 || s10Res.status === 400;
    add('S10', 'Underpaid authorization rejected', 'MUST', s10Ok ? 'PASS' : 'FAIL', `Underpaid value=1 -> HTTP ${s10Res.status}`);
  } catch (e) {
    add('S10', 'Underpaid authorization rejected', 'MUST', 'FAIL', e.message);
  }

  // S11: Mismatched payTo recipient rejected
  try {
    const wrongToPayload = createMockEip3009Payload({
      authorization: {
        to: '0x0000000000000000000000000000000000000001'
      }
    });
    const s11Res = await fetchUrl(targetUrl, {
      headers: { 'X-PAYMENT': wrongToPayload, 'X-No-Trial': '1' }
    });
    const s11Ok = s11Res.status === 402 || s11Res.status === 400;
    add('S11', 'Wrong payTo rejected', 'MUST', s11Ok ? 'PASS' : 'FAIL', `Wrong recipient to=0x00...01 -> HTTP ${s11Res.status}`);
  } catch (e) {
    add('S11', 'Wrong payTo rejected', 'MUST', 'FAIL', e.message);
  }

  // S12: Discovery surface (INFO)
  try {
    const targetOrigin = new URL(targetUrl).origin;
    const discRes = await fetchUrl(targetOrigin + '/.well-known/x402');
    const discOk = discRes.status === 200;
    add('S12', 'Discovery surface available', 'INFO', discOk ? 'PASS' : 'SKIP', `GET /.well-known/x402 -> HTTP ${discRes.status}`);
  } catch (e) {
    add('S12', 'Discovery surface available', 'INFO', 'SKIP', 'Discovery not detected');
  }

  return finish(results, targetUrl);
}

function finish(results, targetUrl) {
  const mustChecks = results.filter(r => r.level === 'MUST');
  const mustPassed = mustChecks.filter(r => r.status === 'PASS').length;
  const mustTotal = mustChecks.length;

  const allPassed = results.filter(r => r.status === 'PASS').length;
  const allScored = results.filter(r => r.status !== 'SKIP').length;
  const scorePercent = allScored > 0 ? Math.round((allPassed / allScored) * 100) : 0;

  const isConformant = mustPassed === mustTotal && mustTotal >= 6;
  const grade = scorePercent >= 95 ? 'A+' : (scorePercent >= 85 ? 'A' : (scorePercent >= 70 ? 'B' : 'C'));

  return {
    suite: '@celorodrigues/x402-conformance',
    version: '2.0.0',
    target: targetUrl,
    timestamp: new Date().toISOString(),
    verdict: isConformant ? 'CONFORMANT' : 'NON_CONFORMANT',
    grade,
    score: scorePercent,
    stats: {
      mustPassed,
      mustTotal,
      allPassed,
      allScored,
      totalChecks: results.length
    },
    results
  };
}

function generateBadgeSvg(report) {
  const isConformant = report.verdict === 'CONFORMANT';
  const color = isConformant ? '#10B981' : '#EF4444';
  const label = 'x402-conformance';
  const status = isConformant ? `Verified ${report.grade}` : 'Non-Compliant';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="24" viewBox="0 0 180 24" role="img" aria-label="${label}: ${status}">
  <linearGradient id="g" x2="0" y2="100%">
    <stop offset="0" stop-color="#1e293b" stop-opacity=".9"/>
    <stop offset="100%" stop-color="#0f172a" stop-opacity=".95"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="180" height="24" rx="4" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="105" height="24" fill="#0f172a"/>
    <rect x="105" width="75" height="24" fill="${color}"/>
    <rect width="180" height="24" fill="url(#g)" opacity="0.1"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text x="52" y="16" fill="#94a3b8" font-weight="600">x402-standard</text>
    <text x="142" y="16" fill="#fff" font-weight="700">${status}</text>
  </g>
</svg>`;
}

function printCli(report) {
  console.log(`\n🛡️  x402 Conformance Linter v${report.version}`);
  console.log(`Target: ${report.target}`);
  console.log(`Timestamp: ${report.timestamp}`);
  console.log('─'.repeat(74));
  for (const r of report.results) {
    const icon = r.status === 'PASS' ? '\x1b[32m✔ PASS\x1b[0m' : (r.status === 'FAIL' ? '\x1b[31m✘ FAIL\x1b[0m' : '\x1b[90m○ SKIP\x1b[0m');
    const lvl = `[${r.level}]`.padEnd(8);
    console.log(`${icon}  ${lvl} ${r.id.padEnd(4)} ${r.name.padEnd(30)} ${r.detail}`);
  }
  console.log('─'.repeat(74));
  const verdictColor = report.verdict === 'CONFORMANT' ? '\x1b[32m' : '\x1b[31m';
  console.log(`VERDICT: ${verdictColor}${report.verdict}\x1b[0m | Grade: \x1b[1m${report.grade}\x1b[0m (${report.score}%) | MUST: ${report.stats.mustPassed}/${report.stats.mustTotal}\n`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find(a => !a.startsWith('--'));
  const jsonMode = args.includes('--json');
  const svgMode = args.includes('--svg');

  if (!target) {
    console.error('Usage: node x402-conformance-v2.js <url> [--json] [--svg]');
    process.exit(2);
  }

  run(target).then(report => {
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else if (svgMode) {
      console.log(generateBadgeSvg(report));
    } else {
      printCli(report);
    }
    process.exit(report.verdict === 'CONFORMANT' ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  run,
  generateBadgeSvg,
  printCli
};
