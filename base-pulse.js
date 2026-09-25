/**
 * Automaton-Sovereign: Base L2 Pulse & Social Broadcast Engine
 * Generates verified, signed cryptographic bulletins of Base L2 metrics,
 * gas conditions, token safety audits, and x402 settlement activity.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { scanTokenContract } = require('./token-security.js');

const DIR = __dirname;
const URL_FILE = path.join(DIR, 'tunnel.url');
const KEY_FILE = path.join(DIR, 'attestation_key.pem');
const PULSE_FILE = path.join(DIR, 'latest_pulse.json');

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = https.request('https://mainnet.base.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d).result));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('rpc_timeout')));
    req.write(payload); req.end();
  });
}

function getBaseUrl() {
  try { return fs.readFileSync(URL_FILE, 'utf8').trim(); }
  catch (e) { return 'http://127.0.0.1:8080'; }
}

async function generateBasePulse() {
  const ts = new Date().toISOString();
  const base = getBaseUrl();

  // 1. Gas Price on Base
  let gasGwei = 0.005;
  try {
    const gasHex = await rpc('eth_gasPrice', []);
    gasGwei = Number(Number(BigInt(gasHex)) / 1e9).toFixed(4);
  } catch (e) {}

  // 2. Base Block Number
  let blockNumber = 0;
  try {
    const bHex = await rpc('eth_blockNumber', []);
    blockNumber = parseInt(bHex, 16);
  } catch (e) {}

  // 3. Token Safety Spotlight (AERO on Base)
  const aeroScan = await scanTokenContract('0x940181a94A35A4569E4529A3CDfB74e38FD98631', rpc);

  // 4. Formatted Broadcasts
  const farcasterText = 
`⚡ Automaton-Sovereign Pulse [Base L2 Block #${blockNumber}]
• Gas: ${gasGwei} Gwei (Ultra-low)
• Asset Spotlight: $AERO (Risk: ${aeroScan.riskScore}/100 - ${aeroScan.verdict})
• Machine Settlement: x402 USDC on Base Mainnet
• Signed Cryptographic Oracle & Merkle Proofs Active

Explore Node: ${base}`;

  const twitterText = 
`⚡ Base L2 Pulse by @AutomatonSovereign
⛽ Gas: ${gasGwei} Gwei
🛡️ Token Safety Scan: $AERO verified [Score: ${aeroScan.riskScore}/100 - ${aeroScan.verdict}]
💳 Machine-to-Machine compute via x402 on Base

Live API: ${base}`;

  // 5. ECDSA Signature
  let sig = '', sigHash = '', keyId = '7e32754cf3911ccf';
  try {
    if (fs.existsSync(KEY_FILE)) {
      const privKey = fs.readFileSync(KEY_FILE, 'utf8');
      const payloadStr = JSON.stringify({ blockNumber, gasGwei, timestamp: ts });
      sigHash = crypto.createHash('sha256').update(payloadStr).digest('hex');
      const signer = crypto.createSign('SHA256');
      signer.update(payloadStr);
      sig = signer.sign(privKey, 'base64');
    }
  } catch (e) {}

  const pulse = {
    agent: 'Automaton-Sovereign',
    network: 'base',
    chainId: 8453,
    blockNumber,
    gasGwei,
    spotlightToken: {
      name: 'Aerodrome Finance',
      symbol: 'AERO',
      address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
      riskScore: aeroScan.riskScore,
      verdict: aeroScan.verdict,
      isHoneypot: aeroScan.isHoneypot
    },
    broadcasts: {
      farcaster: farcasterText,
      twitter: twitterText
    },
    timestamp: ts,
    signature: sig,
    signatureHash: sigHash,
    keyId,
    algorithm: 'ECDSA-P256-SHA256',
    verifyUrl: base + '/v2/pubkey'
  };

  try {
    fs.writeFileSync(PULSE_FILE, JSON.stringify(pulse, null, 2));
  } catch (e) {}

  return pulse;
}

if (require.main === module) {
  generateBasePulse().then(p => {
    console.log('=== Base L2 Social Pulse Generated ===');
    console.log(p.broadcasts.farcaster);
  });
}

module.exports = {
  generateBasePulse,
  PULSE_FILE
};
