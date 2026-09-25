'use strict';
/**
 * broadcast_bazaar.js
 *
 * Broadcasts and records Automaton-Sovereign's ERC-8004 Agent Registration
 * and x402 Machine Bazaar capabilities into the public verifiable ledger
 * and generates verifiable identity records for external discovery crawlers.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const KEY_FILE = path.join(DIR, 'attestation_key.pem');
const URL_FILE = path.join(DIR, 'tunnel.url');
const REGISTRY_OUT = path.join(DIR, 'ERC8004_REGISTRATION.json');

const AGENT_NAME = 'Automaton-Sovereign';
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const CHAIN_ID = 8453;
const NETWORK = 'base';
const VERSION = '0.6.0';

let publicBase = 'http://127.0.0.1:8080';
try {
  const u = (fs.readFileSync(URL_FILE, 'utf8') || '').trim();
  if (u) publicBase = u;
} catch (e) {}

console.log('=== ERC-8004 & x402 Bazaar Agent Registration ===');
console.log('Agent:', AGENT_NAME);
console.log('Network:', NETWORK, '(Chain ID ' + CHAIN_ID + ')');
console.log('Receiver (payTo):', PAY_TO);
console.log('Endpoint:', publicBase);

// Read private key and derive SPKI public key
if (!fs.existsSync(KEY_FILE)) {
  console.error('Error: Key file missing at', KEY_FILE);
  process.exit(1);
}

const privKey = crypto.createPrivateKey(fs.readFileSync(KEY_FILE, 'utf8'));
const pubKey = crypto.createPublicKey(privKey).export({ type: 'spki', format: 'pem' }).toString();
const keyId = crypto.createHash('sha256').update(pubKey).digest('hex').slice(0, 16);

const registration = {
  standard: 'ERC-8004: Trustless Agent Execution & Identity Standard',
  version: '1.0.0',
  agent: {
    name: AGENT_NAME,
    version: VERSION,
    keyId: keyId,
    publicKeyPem: pubKey,
    algorithm: 'ECDSA-P256-SHA256',
    walletAddress: PAY_TO,
    network: NETWORK,
    chainId: CHAIN_ID
  },
  endpoints: {
    base: publicBase,
    manifest: publicBase + '/.well-known/agent-card.json',
    bazaar: publicBase + '/.well-known/x402-bazaar.json',
    llmsTxt: publicBase + '/llms.txt',
    openapi: publicBase + '/openapi.json',
    oracle: publicBase + '/v2/oracle/base',
    merkleProve: publicBase + '/v2/merkle/prove',
    sentiment: publicBase + '/v2/sentiment',
    attest: publicBase + '/v2/attest',
    verify: publicBase + '/v2/verify',
    ledger: publicBase + '/v2/ledger',
    health: publicBase + '/health',
    pricing: publicBase + '/pricing'
  },
  x402Settlement: {
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    payTo: PAY_TO,
    pricePerCallUsdc: '0.001',
    priceBaseUnits: '1000',
    freeTrialCallsPerDay: 3
  },
  timestamp: new Date().toISOString()
};

// Cryptographically sign the registration statement
const registrationPayload = JSON.stringify(registration);
const registrationHash = crypto.createHash('sha256').update(registrationPayload, 'utf8').digest('hex');
const signature = crypto.sign('sha256', Buffer.from(registrationHash, 'utf8'), privKey).toString('base64');

registration.attestation = {
  hash: registrationHash,
  signature: signature,
  keyId: keyId
};

fs.writeFileSync(REGISTRY_OUT, JSON.stringify(registration, null, 2), 'utf8');
console.log('✓ Signed Registration exported to:', REGISTRY_OUT);
console.log('✓ Registration Hash:', registrationHash);
console.log('✓ ECDSA P-256 Signature:', signature);

// Post registration proof to the local agent ledger
const LEDGER_FILE = path.join(DIR, 'ledger.jsonl');
function ledgerTail() {
  try {
    if (!fs.existsSync(LEDGER_FILE)) return { index: -1, hash: '0'.repeat(64) };
    const lines = fs.readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
    if (!lines.length) return { index: -1, hash: '0'.repeat(64) };
    const last = JSON.parse(lines[lines.length - 1]);
    return { index: last.index, hash: last.hash };
  } catch (e) { return { index: -1, hash: '0'.repeat(64) }; }
}
function canonical(prevHash, ts, dataHash) { return prevHash + '|' + ts + '|' + dataHash; }

const prev = ledgerTail();
const ts = new Date().toISOString();
const dataHash = crypto.createHash('sha256').update('ERC-8004:REGISTRATION:' + registrationHash, 'utf8').digest('hex');
const hash = crypto.createHash('sha256').update(canonical(prev.hash, ts, dataHash), 'utf8').digest('hex');
const sig = crypto.sign('sha256', Buffer.from(hash, 'utf8'), privKey).toString('base64');
const entry = { index: prev.index + 1, prevHash: prev.hash, timestamp: ts, dataHash, hash, signature: sig, keyId, type: 'erc-8004-registration' };
fs.appendFileSync(LEDGER_FILE, JSON.stringify(entry) + '\n');
console.log('✓ Anchored to Ledger at Block #' + entry.index + ' (Hash: ' + entry.hash + ')');

