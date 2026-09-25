'use strict';
/**
 * x402-facilitator.js - Official x402 Protocol & EIP-3009 Facilitator Adapter
 * 
 * Supports:
 * 1. Standard x402 EIP-3009 TransferWithAuthorization for Base USDC:
 *    - Off-chain EIP-712 signature verification (zero gas for payer at sign time)
 *    - On-chain nonce replay check via authorizationState(address,bytes32)
 *    - On-chain balance verification via balanceOf(address)
 *    - Submission to x402 Facilitator for settlement (facilitator pays the gas!)
 * 2. Standard X-PAYMENT / X-PAYMENT-RESPONSE headers (base64 JSON)
 * 3. Fallback support for legacy X-PAYMENT: <txHash> on-chain transfers
 */

const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO_DEFAULT = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const CHAIN_ID = 8453;
const NETWORK = 'base';

// Spent nonces persistent file
const NONCES_FILE = path.join(__dirname, 'spent_nonces.json');
const spentNonces = new Set();
try {
  if (fs.existsSync(NONCES_FILE)) {
    JSON.parse(fs.readFileSync(NONCES_FILE, 'utf8')).forEach(n => spentNonces.add(n.toLowerCase()));
  }
} catch (e) {}

function saveNonces() {
  try {
    fs.writeFileSync(NONCES_FILE, JSON.stringify([...spentNonces], null, 2));
  } catch (e) {}
}

let viem = null;
try {
  viem = require('C:/Users/marce/automaton/node_modules/viem');
} catch (e) {
  try { viem = require('viem'); } catch (err) {}
}

function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
    const u = new URL(RPC_URL);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'Automaton-Sovereign/x402-v1'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(j.error.message || 'RPC Error'));
          resolve(j.result);
        } catch (e) {
          reject(new Error('Bad JSON-RPC response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('RPC timeout')));
    req.write(payload);
    req.end();
  });
}

/**
 * Checks on-chain whether an EIP-3009 authorization nonce has been used.
 * Selector 0xe94a0102 = keccak256("authorizationState(address,bytes32)").slice(0, 10)
 */
async function isNonceUsedOnChain(authorizer, nonceHex) {
  const cleanAuth = authorizer.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const cleanNonce = nonceHex.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = '0xe94a0102' + cleanAuth + cleanNonce;
  try {
    const res = await rpc('eth_call', [{ to: USDC_BASE, data }, 'latest']);
    if (!res || res === '0x') return false;
    return parseInt(res, 16) === 1;
  } catch (e) {
    return false;
  }
}

/**
 * Checks authorizer's current USDC balance on Base.
 * Selector 0x70a08231 = keccak256("balanceOf(address)").slice(0, 10)
 */
async function getUsdcBalance(authorizer) {
  const cleanAuth = authorizer.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = '0x70a08231' + cleanAuth;
  try {
    const res = await rpc('eth_call', [{ to: USDC_BASE, data }, 'latest']);
    if (!res || res === '0x') return 0n;
    return BigInt(res);
  } catch (e) {
    return 0n;
  }
}

/**
 * Parses the incoming X-PAYMENT header (supports base64 JSON, plain JSON, or txHash)
 */
function parsePaymentHeader(rawHeader) {
  if (!rawHeader) return null;
  const trimmed = String(rawHeader).trim();

  // Legacy direct txHash format: 0x followed by 64 hex characters
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return { type: 'legacy-txhash', txHash: trimmed.toLowerCase() };
  }

  // Attempt base64 decode
  let decodedStr = trimmed;
  if (!trimmed.startsWith('{')) {
    try {
      decodedStr = Buffer.from(trimmed, 'base64').toString('utf8');
    } catch (e) {
      decodedStr = trimmed;
    }
  }

  try {
    const parsed = JSON.parse(decodedStr);
    return { type: 'x402-standard', data: parsed };
  } catch (e) {
    // If it's a 66-character hex inside base64
    if (/^0x[0-9a-fA-F]{64}$/.test(decodedStr.trim())) {
      return { type: 'legacy-txhash', txHash: decodedStr.trim().toLowerCase() };
    }
    return { type: 'malformed', raw: trimmed };
  }
}

/**
 * Verifies an official x402 EIP-3009 payment authorization
 */
async function verifyAuthorization(authData, options = {}) {
  const out = {
    ok: false,
    reason: null,
    payer: null,
    value: null,
    nonce: null,
    isStandardX402: true
  };

  const payload = authData.payload || authData;
  const auth = payload.authorization || payload;
  const signature = payload.signature || authData.signature;

  if (!auth || !signature) {
    out.reason = 'missing_authorization_or_signature';
    return out;
  }

  const from = (auth.from || auth.authorizer || '').toLowerCase();
  const to = (auth.to || auth.recipient || '').toLowerCase();
  const valueStr = String(auth.value || '0');
  const validAfter = Number(auth.validAfter || 0);
  const validBefore = Number(auth.validBefore || 0);
  const nonce = String(auth.nonce || '').toLowerCase();

  const wantTo = (options.payTo || PAY_TO_DEFAULT).toLowerCase();
  const minUnits = BigInt(options.minAmountRequired || '1000');

  out.payer = from;
  out.nonce = nonce;
  out.value = valueStr;

  // 1. Recipient check
  if (to !== wantTo) {
    out.reason = `recipient_mismatch: got ${to}, expected ${wantTo}`;
    return out;
  }

  // 2. Amount check
  let valUnits = 0n;
  try {
    valUnits = BigInt(valueStr);
  } catch (e) {
    out.reason = 'invalid_value_format';
    return out;
  }
  if (valUnits < minUnits) {
    out.reason = `underpaid: got ${valUnits.toString()}, required ${minUnits.toString()}`;
    return out;
  }

  // 3. Expiry / deadline check
  const nowSec = Math.floor(Date.now() / 1000);
  if (validBefore > 0 && nowSec > validBefore) {
    out.reason = 'authorization_expired';
    return out;
  }
  if (validAfter > nowSec + 60) {
    out.reason = 'authorization_not_yet_valid';
    return out;
  }

  // 4. Replay check (local cache)
  if (spentNonces.has(nonce)) {
    out.reason = 'nonce_already_used_locally';
    return out;
  }

  // 5. On-chain replay check (USDC contract authorizationState)
  const onChainUsed = await isNonceUsedOnChain(from, nonce);
  if (onChainUsed) {
    out.reason = 'nonce_already_used_on_chain';
    return out;
  }

  // 6. On-chain balance check
  const balance = await getUsdcBalance(from);
  if (balance < valUnits) {
    out.reason = `insufficient_usdc_balance: payer has ${balance.toString()} units, needs ${valUnits.toString()}`;
    return out;
  }

  // 7. EIP-712 signature verification (Strict Fail-Closed)
  if (!viem || !viem.verifyTypedData) {
    out.reason = 'cryptographic_verifier_unavailable: viem is required to verify EIP-712 signatures';
    return out;
  }

  try {
      const domain = {
        name: 'USD Coin',
        version: '2',
        chainId: CHAIN_ID,
        verifyingContract: USDC_BASE
      };
      const types = {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' }
        ]
      };
      const message = {
        from,
        to,
        value: valUnits,
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce: nonce.startsWith('0x') ? nonce : '0x' + nonce
      };

      const sigValid = await viem.verifyTypedData({
        address: from,
        domain,
        types,
        primaryType: 'TransferWithAuthorization',
        message,
        signature
      });

      if (!sigValid) {
        out.reason = 'eip712_signature_invalid';
        return out;
      }
    } catch (err) {
      out.reason = 'eip712_verification_error: ' + err.message;
      return out;
    }

  // Mark nonce as spent locally
  spentNonces.add(nonce);
  saveNonces();

  out.ok = true;
  out.transaction = nonce; // durable reference
  out.network = NETWORK;
  return out;
}

/**
 * Builds standard x402 402 Payment Required response body
 */
function buildPaymentRequired(endpoint, options = {}) {
  const payTo = options.payTo || PAY_TO_DEFAULT;
  const priceUnits = options.priceBaseUnits || '1000';
  const priceUsdc = options.priceUsdc || '0.001';
  const baseUrl = options.baseUrl || 'https://hardly-animals-cyber-theatre.trycloudflare.com';
  const fullResource = endpoint.startsWith('http') ? endpoint : baseUrl + endpoint;

  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: NETWORK,
        chainId: CHAIN_ID,
        asset: USDC_BASE,
        payTo,
        maxAmountRequired: priceUnits,
        maxTimeoutSeconds: 60,
        resource: fullResource,
        description: options.description || 'Automaton-Sovereign Machine Compute',
        mimeType: 'application/json',
        // Bazaar discovery metadata (x402 v1 shape): the CDP facilitator catalogs the
        // resource from these requirements when it settles a payment for it.
        outputSchema: Object.assign({
          input: Object.assign({ type: 'http', method: (options.method || 'GET').toUpperCase(), discoverable: true }, options.inputSchema || {})
        }, options.outputSchema ? { output: options.outputSchema } : {}),
        extra: {
          name: 'USD Coin',
          version: '2'
        }
      }
    ],
    howTo: `Pay exactly ${priceUsdc} USDC on Base to ${payTo} via standard x402 EIP-3009 authorization (header: X-PAYMENT), or transfer on-chain and send txHash.`
  };
}

/**
 * Builds base64 X-PAYMENT-RESPONSE settlement header
 */
function buildPaymentResponseHeader(settlement) {
  const payload = {
    success: true,
    transaction: settlement.transaction || settlement.txHash || 'settled',
    network: NETWORK,
    payer: settlement.payer || settlement.from || 'unknown',
    settledAt: new Date().toISOString()
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// ---------- CDP facilitator (verify + on-chain settle, Bazaar indexing) ----------
// Mainnet x402 settlement goes through the Coinbase CDP facilitator, authenticated with a
// short-lived JWT signed by the CDP API key (CDP_API_KEY_ID / CDP_API_KEY_SECRET).
const CDP_HOST = 'api.cdp.coinbase.com';
const CDP_X402_PATH = '/platform/v2/x402';
const REQUIREMENT_FIELDS = ['scheme', 'network', 'maxAmountRequired', 'resource', 'description', 'mimeType',
  'payTo', 'maxTimeoutSeconds', 'asset', 'outputSchema', 'extra'];

let cdpCredsCache = null;
function cdpCreds() {
  if (cdpCredsCache) return cdpCredsCache;
  let id = process.env.CDP_API_KEY_ID, secret = process.env.CDP_API_KEY_SECRET;
  // Processes spawned by long-running supervisors may predate the User-scope env vars.
  if ((!id || !secret) && process.platform === 'win32') {
    const readUserEnv = (name) => {
      try {
        const out = require('child_process').execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(new RegExp(name + '\\s+REG_\\w+\\s+(.+)'));
        return m ? m[1].trim() : '';
      } catch (e) { return ''; }
    };
    id = id || readUserEnv('CDP_API_KEY_ID');
    secret = secret || readUserEnv('CDP_API_KEY_SECRET');
  }
  if (id && secret) cdpCredsCache = { id, secret };
  return cdpCredsCache;
}

function facilitatorConfigured() { return !!cdpCreds(); }

async function cdpPost(op, body) {
  const creds = cdpCreds();
  if (!creds) throw new Error('cdp_credentials_missing');
  const { generateJwt } = require('@coinbase/cdp-sdk/auth');
  const reqPath = CDP_X402_PATH + '/' + op;
  const jwt = await generateJwt({
    apiKeyId: creds.id, apiKeySecret: creds.secret,
    requestMethod: 'POST', requestHost: CDP_HOST, requestPath: reqPath, expiresIn: 120
  });
  const res = await fetch('https://' + CDP_HOST + reqPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok && !json) throw new Error('facilitator_http_' + res.status + ': ' + text.slice(0, 200));
  return json || {};
}

/**
 * Verifies and settles an x402 v1 "exact" payment through the CDP facilitator.
 * `requirements` must be the same accepts[] entry advertised in the 402 challenge.
 * Returns { ok, reason, transaction, payer, network }.
 */
async function facilitatorSettle(paymentPayload, requirements) {
  const reqs = {};
  for (const k of REQUIREMENT_FIELDS) if (requirements[k] !== undefined) reqs[k] = requirements[k];
  const body = { x402Version: paymentPayload.x402Version || 1, paymentPayload, paymentRequirements: reqs };
  try {
    const v = await cdpPost('verify', body);
    if (!v.isValid) return { ok: false, reason: 'facilitator_verify_failed: ' + [v.invalidReason, v.invalidMessage || v.errorMessage || v.message].filter(Boolean).join(' - '), payer: v.payer };
    const s = await cdpPost('settle', body);
    if (!s.success) return { ok: false, reason: 'facilitator_settle_failed: ' + (s.errorReason || s.errorMessage || s.message || 'failed'), payer: s.payer || v.payer };
    return { ok: true, transaction: s.transaction, payer: s.payer || v.payer, network: s.network || NETWORK };
  } catch (e) {
    return { ok: false, reason: 'facilitator_error: ' + e.message };
  }
}

module.exports = {
  facilitatorConfigured,
  facilitatorSettle,
  parsePaymentHeader,
  verifyAuthorization,
  buildPaymentRequired,
  buildPaymentResponseHeader,
  isNonceUsedOnChain,
  getUsdcBalance,
  USDC_BASE,
  PAY_TO_DEFAULT,
  CHAIN_ID
};

if (require.main === module) {
  console.log('--- x402 Facilitator Adapter Self-Test ---');
  console.log('USDC Contract on Base:', USDC_BASE);
  console.log('PayTo:', PAY_TO_DEFAULT);
  console.log('Viem available:', !!viem);
  const pr = buildPaymentRequired('/v2/oracle/base', { priceUsdc: '0.001', priceBaseUnits: '1000' });
  console.log('402 Specification Output:\n', JSON.stringify(pr, null, 2));
  console.log('\nSUCCESS: x402 facilitator module initialized.');
}
