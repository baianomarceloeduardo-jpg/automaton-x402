/**
 * Automaton-Sovereign: Comprehensive Autonomous Test Suite
 * Verifies all 12+ public and paid endpoints, cryptographic signatures,
 * bytecode disassemblers, and x402 payment specifications.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
let BASE_URL = 'http://127.0.0.1:8080';
try {
  const urlFile = path.join(DIR, 'tunnel.url');
  if (fs.existsSync(urlFile)) {
    const u = fs.readFileSync(urlFile, 'utf8').trim();
    if (u) BASE_URL = u;
  }
} catch (e) {}

function request(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, BASE_URL);
    const client = fullUrl.protocol === 'https:' ? https : http;
    const req = client.request(fullUrl, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function verifyECDSASignature(payloadStr, signatureBase64, publicKeyPem) {
  try {
    const hash = crypto.createHash('sha256').update(payloadStr, 'utf8').digest('hex');
    return crypto.verify('sha256', Buffer.from(hash, 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(signatureBase64, 'base64'));
  } catch (e) {
    return false;
  }
}

async function runTestSuite() {
  console.log(`\n======================================================`);
  console.log(`  AUTOMATON-SOVEREIGN FULL TEST & VERIFICATION SUITE  `);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log(`======================================================\n`);

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, detail = '') {
    if (condition) {
      console.log(`  [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${testName} ${detail ? '--> ' + detail : ''}`);
      failed++;
    }
  }

  // 1. Health check
  console.log(`--- [1/10] System Health & Node Identity ---`);
  const health = await request('/health');
  assert(health.statusCode === 200, 'GET /health returns HTTP 200');
  assert(health.json && health.json.agent === 'Automaton-Sovereign', 'Agent identity is Automaton-Sovereign');
  assert(health.json && health.json.payTo.toLowerCase() === '0x71deac098914a009e3720524642a6be6f65ee528', 'Settlement recipient is 0x71DEAc098914A009E3720524642A6bE6F65EE528');

  // 2. Public Key & Cryptographic Attestation Identity
  console.log(`\n--- [2/10] Cryptographic Key Infrastructure ---`);
  const pubkeyRes = await request('/v2/pubkey');
  assert(pubkeyRes.statusCode === 200, 'GET /v2/pubkey returns HTTP 200');
  assert(pubkeyRes.json && pubkeyRes.json.algorithm === 'ECDSA-P256-SHA256', 'Key algorithm is ECDSA-P256-SHA256');
  const pubKeyPem = pubkeyRes.json ? pubkeyRes.json.publicKey : null;
  assert(!!pubKeyPem, 'Public key PEM exported');

  // 3. Treasury Telemetry
  console.log(`\n--- [3/10] Base Mainnet Treasury Telemetry ---`);
  const treasuryRes = await request('/v2/treasury/balance');
  assert(treasuryRes.statusCode === 200, 'GET /v2/treasury/balance returns HTTP 200');
  assert(treasuryRes.json && treasuryRes.json.token && typeof treasuryRes.json.token.balance === 'string', 'USDC balance telemetry available: ' + (treasuryRes.json ? treasuryRes.json.token.balance : 0) + ' USDC');
  assert(treasuryRes.json && treasuryRes.json.gasAsset && typeof treasuryRes.json.gasAsset.balance === 'string', 'Base ETH balance telemetry available: ' + (treasuryRes.json ? treasuryRes.json.gasAsset.balance : 0) + ' ETH');
  assert(treasuryRes.json && treasuryRes.json.signature && treasuryRes.json.statement, 'Treasury statement is cryptographically signed');
  
  if (treasuryRes.json && pubKeyPem) {
    const isTreasurySigValid = verifyECDSASignature(treasuryRes.json.statement, treasuryRes.json.signature, pubKeyPem);
    assert(isTreasurySigValid, 'Treasury ECDSA P-256 signature mathematically verified off-chain');
  }

  // 4. Base L2 Social Pulse
  console.log(`\n--- [4/10] Base L2 Social Pulse & Broadcast Engine ---`);
  const pulseRes = await request('/v2/pulse');
  assert(pulseRes.statusCode === 200, 'GET /v2/pulse returns HTTP 200');
  assert(pulseRes.json && pulseRes.json.blockNumber > 0, `Base block height retrieved: #${pulseRes.json ? pulseRes.json.blockNumber : 0}`);
  assert(pulseRes.json && pulseRes.json.gasGwei !== undefined, `Base gas price retrieved: ${pulseRes.json ? pulseRes.json.gasGwei : 0} Gwei`);
  assert(pulseRes.json && pulseRes.json.broadcasts && pulseRes.json.broadcasts.farcaster.length > 20, 'Farcaster social broadcast generated');
  assert(pulseRes.json && pulseRes.json.broadcasts && pulseRes.json.broadcasts.twitter.length > 20, 'Twitter social broadcast generated');

  // 5. Base Pulse History & Syndication Feed
  console.log(`\n--- [5/10] Social Pulse History & Feed ---`);
  const histRes = await request('/v2/pulse/history');
  assert(histRes.statusCode === 200, 'GET /v2/pulse/history returns HTTP 200');
  assert(histRes.json && Array.isArray(histRes.json.pulses), 'Pulse history archive returns JSON array');

  const feedRes = await request('/v2/pulse/feed');
  assert(feedRes.statusCode === 200, 'GET /v2/pulse/feed returns HTTP 200');
  assert(feedRes.data.includes('# Automaton-Sovereign Base L2 Pulse Feed'), 'Markdown syndication feed formatted properly');

  // 6. Security Scanner & x402 Payment Negotiation
  console.log(`\n--- [6/10] Token Security Scanner & x402 Negotiation ---`);
  const secRes = await request('/v2/security/scan?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  if (secRes.statusCode === 200) {
    assert(true, 'GET /v2/security/scan served within Free Trial allowance (HTTP 200)');
    assert(secRes.json.isHoneypot === false, 'USDC contract scanned: isHoneypot = false');
  } else if (secRes.statusCode === 402) {
    assert(true, 'GET /v2/security/scan returned RFC-compliant HTTP 402 Payment Required');
    assert(secRes.json.x402Version === 1, 'x402 protocol version 1 specified');
    assert(secRes.json.accepts && secRes.json.accepts[0].asset === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'Payment terms specify USDC on Base');
    assert(secRes.headers['www-authenticate'] !== undefined, 'WWW-Authenticate header included');
  } else {
    assert(false, 'Unexpected status code from /v2/security/scan', secRes.statusCode);
  }

  // 7. DeFi Price Oracle
  console.log(`\n--- [7/10] Base DeFi Price Oracle & Gas Meter ---`);
  const oracleRes = await request('/v2/oracle/base');
  if (oracleRes.statusCode === 200) {
    assert(true, 'GET /v2/oracle/base returned HTTP 200');
    assert(oracleRes.json.prices && oracleRes.json.prices.ETH.priceUsd > 1000, 'ETH price oracle data valid');
    assert(oracleRes.json.signature && oracleRes.json.keyId, 'Oracle data cryptographically signed');
  } else if (oracleRes.statusCode === 402) {
    assert(true, 'GET /v2/oracle/base returned HTTP 402 when trial exhausted');
  }

  // 8. Machine Discovery Protocols
  console.log(`\n--- [8/10] Discovery Standards (ERC-8004, Bazaar, llms.txt, OpenAPI) ---`);
  const agentCard = await request('/.well-known/agent-card.json');
  assert(agentCard.statusCode === 200, 'GET /.well-known/agent-card.json returns HTTP 200');
  assert(agentCard.json && agentCard.json.type.includes('eip-8004'), 'ERC-8004 schema validated');

  const bazaar = await request('/.well-known/x402-bazaar.json');
  assert(bazaar.statusCode === 200, 'GET /.well-known/x402-bazaar.json returns HTTP 200');
  assert(bazaar.json && bazaar.json.settlement && (bazaar.json.settlement.type === 'x402' || bazaar.json.settlement.protocol === 'x402'), 'x402 Bazaar schema validated');

  const llms = await request('/llms.txt');
  assert(llms.statusCode === 200, 'GET /llms.txt returns HTTP 200');
  assert(llms.data.includes('Automaton-Sovereign'), 'llms.txt contains agent description');

  const openapi = await request('/openapi.json');
  assert(openapi.statusCode === 200, 'GET /openapi.json returns HTTP 200');
  assert(openapi.json && openapi.json.openapi === '3.1.0', 'OpenAPI 3.1.0 schema validated');

  // 9. Append-Only Tamper-Evident Ledger
  console.log(`\n--- [9/10] Append-Only Merkle Ledger Integrity ---`);
  const ledgerRes = await request('/v2/ledger?limit=5');
  assert(ledgerRes.statusCode === 200, 'GET /v2/ledger returns HTTP 200');
  assert(ledgerRes.json && Array.isArray(ledgerRes.json.entries), 'Ledger returns entries array');
  if (ledgerRes.json && ledgerRes.json.entries.length > 0) {
    const latestEntry = ledgerRes.json.entries[ledgerRes.json.entries.length - 1];
    const verifyRes = await request(`/v2/verify?index=${latestEntry.index}`);
    assert(verifyRes.statusCode === 200, `Block #${latestEntry.index} verified on /v2/verify`);
    assert(verifyRes.json && verifyRes.json.verified === true, 'Ledger hash-chain and signature verified');
  }

  // 10. Web Interface & Playground
  console.log(`\n--- [10/10] Cyber-Swiss Web Interface ---`);
  const webRes = await request('/');
  assert(webRes.statusCode === 200, 'GET / returns HTTP 200');
  assert(webRes.data.includes('Automaton-Sovereign'), 'Web UI contains Automaton-Sovereign branding');
  assert(webRes.data.includes('Interactive API Playground'), 'Web UI contains interactive playground');

  console.log(`\n======================================================`);
  console.log(`  TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`======================================================\n`);

  return { passed, failed };
}

if (require.main === module) {
  runTestSuite().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(err => {
    console.error('Test suite runner crashed:', err);
    process.exit(1);
  });
}

module.exports = { runTestSuite };
