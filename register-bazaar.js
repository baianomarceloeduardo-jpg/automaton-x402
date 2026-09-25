/**
 * Automaton-Sovereign: Agent Directory & x402 Bazaar Self-Registrar
 * Formats, validates, and emits registration payloads for Agentic.Market,
 * x402bazaar.org, and ERC-8004 discovery indexes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const URL_FILE = path.join(DIR, 'tunnel.url');
const KEY_FILE = path.join(DIR, 'attestation_key.pem');
const RECEIPT_FILE = path.join(DIR, 'REGISTRATION_RECEIPT.json');

function getBaseUrl() {
  try {
    return fs.readFileSync(URL_FILE, 'utf8').trim();
  } catch (e) {
    return 'http://127.0.0.1:8080';
  }
}

async function generateRegistrationPayload() {
  const base = getBaseUrl();
  const ts = new Date().toISOString();

  let privKey = null;
  try {
    privKey = fs.readFileSync(KEY_FILE, 'utf8');
  } catch (e) {
    console.error('Cannot load signing key:', e.message);
  }

  const payload = {
    protocol: 'x402-bazaar-v1',
    standard: 'ERC-8004',
    serviceId: 'automaton-sovereign-value-api',
    name: 'Automaton-Sovereign Value API',
    agent: 'Automaton-Sovereign',
    version: '0.9.0',
    description: 'Sovereign machine-payable compute: DeFi Base Oracle, Token Safety & Honeypot Analyzer, Merkle Provers, and Cryptographic Attestations on Base Mainnet.',
    category: 'compute/oracle/security',
    endpoints: {
      base: base,
      landing: base + '/',
      health: base + '/health',
      llmsTxt: base + '/llms.txt',
      agentCard: base + '/.well-known/agent-card.json',
      bazaar: base + '/.well-known/x402-bazaar.json',
      openapi: base + '/openapi.json',
      treasury: base + '/v2/treasury/balance',
      oracle: base + '/v2/oracle/base',
      securityScan: base + '/v2/security/scan',
      merkleProve: base + '/v2/merkle/prove',
      sentiment: base + '/v2/sentiment'
    },
    settlement: {
      type: 'x402',
      scheme: 'exact',
      network: 'base',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      assetSymbol: 'USDC',
      payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
      pricePerCallUsdc: '0.001',
      priceBaseUnits: '1000',
      header: 'X-PAYMENT'
    },
    freeTrial: {
      callsPerDayPerIp: 3,
      description: '3 evaluation calls per day before 402 is returned'
    },
    timestamp: ts
  };

  if (privKey) {
    const signData = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(signData).digest('hex');
    const signer = crypto.createSign('SHA256');
    signer.update(signData);
    const signature = signer.sign(privKey, 'base64');
    payload.attestation = {
      hash,
      signature,
      keyId: '7e32754cf3911ccf',
      algorithm: 'ECDSA-P256-SHA256',
      verifyUrl: base + '/v2/pubkey'
    };
  }

  fs.writeFileSync(RECEIPT_FILE, JSON.stringify(payload, null, 2));
  console.log('Registration receipt written to:', RECEIPT_FILE);
  return payload;
}

if (require.main === module) {
  generateRegistrationPayload().then(p => {
    console.log('Payload generated successfully for:', p.endpoints.base);
  });
}

module.exports = {
  generateRegistrationPayload
};
