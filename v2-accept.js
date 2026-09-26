// v2-accept.js — accept the STANDARD x402 v2 X-PAYMENT envelope on the primary API.
//
// WHY: my server now EMITS v2 challenges, but it only ACCEPTED my custom X-PAYMENT-AUTH header.
// A stock x402 v2 client sends the standard envelope instead:
//   X-PAYMENT: base64({ x402Version:2, scheme:"exact", network:"eip155:8453",
//                       payload:{ authorization:{from,to,value,validAfter,validBefore,nonce},
//                                 signature:"0x..." } })
// Until I accept THAT, "v2 capable" is only half true and no ordinary buyer can pay me.
//
// Caller binding (the audit P0 from Session 5): a raw txHash is a BEARER token -- anyone who
// sees it on-chain can redeem it. An EIP-3009 authorization carries an EIP-712 signature, so I
// recover the signer and REQUIRE recovered == authorization.from. That is real authentication.
// Replay is prevented by the on-chain authorizationState(from,nonce) plus an append-only local
// nonce file (belt and braces). Claim synchronously before any await, to close the race.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CAIP2 = 'eip155:8453';
const CHAIN_ID = 8453;
const DOMAIN = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
const TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] };

const RPC_DEFAULT = process.env.BASE_RPC || 'https://mainnet.base.org';
const NONCE_FILE = process.env.X402_NONCE_FILE || path.join(__dirname, 'v2-nonces.jsonl');
const SKEW = 60;

function ethersLib() { try { return require('ethers'); } catch (e) { return null; } }

function rpc(url, method, params, timeout = 12000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ error: 'bad_rpc' }); }
    const mod = u.protocol === 'https:' ? https : http;   // protocol-aware (Session 2 lesson)
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ error: 'bad_json' }); } });
    });
    r.on('error', e => resolve({ error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
    r.write(data); r.end();
  });
}

// --- decode the standard v2 envelope -------------------------------------------
function decodeV2(header) {
  if (!header || typeof header !== 'string') return { ok: false, reason: 'missing_header' };
  if (header.length > 8192) return { ok: false, reason: 'header_too_large' };
  let j;
  try { j = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch (e) { return { ok: false, reason: 'invalid_base64_or_json' }; }
  if (!j || typeof j !== 'object') return { ok: false, reason: 'not_object' };
  const p = j.payload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'missing_payload' };
  const a = p.authorization || p.auth;
  if (!a || typeof a !== 'object') return { ok: false, reason: 'exact_evm_payment_payload_is_incomplete' };
  const sig = p.signature || p.sig;
  if (!sig || typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return { ok: false, reason: 'bad_signature_shape' };
  for (const f of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
    if (a[f] == null) return { ok: false, reason: 'authorization_missing_' + f };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.from) || !/^0x[0-9a-fA-F]{40}$/.test(a.to)) return { ok: false, reason: 'bad_address' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return { ok: false, reason: 'bad_nonce' };
  return { ok: true, x402Version: j.x402Version || 2, network: j.network || CAIP2,
    scheme: j.scheme || 'exact', payload: { authorization: a, signature: sig }, raw: j };
}

// --- verify an authorization (caller-bound) -----------------------------------
async function verifyAuthorization2(payload, opts = {}) {
  const { payTo, minUnits = 1000n, rpcUrl = RPC_DEFAULT, checkOnChain = true } = opts;
  const a = payload.authorization, sig = payload.signature;
  const e = ethersLib();
  if (!e) return { ok: false, reason: 'ethers_unavailable' };

  if (payTo && String(a.to).toLowerCase() !== String(payTo).toLowerCase()) return { ok: false, reason: 'wrong_recipient' };
  let value; try { value = BigInt(a.value); } catch (err) { return { ok: false, reason: 'bad_value' }; }
  if (value < BigInt(minUnits)) return { ok: false, reason: 'underpaid', value: value.toString() };

  const now = Math.floor(Date.now() / 1000);
  const va = Number(a.validAfter), vb = Number(a.validBefore);
  if (Number.isFinite(va) && now < va - SKEW) return { ok: false, reason: 'not_yet_valid' };
  if (Number.isFinite(vb) && now > vb + SKEW) return { ok: false, reason: 'expired' };

  // CALLER BINDING: the recovered signer must BE authorization.from.
  let recovered;
  try { recovered = e.verifyTypedData(DOMAIN, TYPES, {
    from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce }, sig); }
  catch (err) { return { ok: false, reason: 'recovery_failed' }; }
  if (!recovered || recovered.toLowerCase() !== String(a.from).toLowerCase()) {
    return { ok: false, reason: 'signature_does_not_match_from', recovered: recovered || null };
  }

  if (checkOnChain) {
    const r = await rpc(rpcUrl, 'eth_call', [{ to: USDC,
      data: '0x' + 'e9a2c1a2' + a.from.slice(2).padStart(64, '0') + a.nonce.slice(2) }, 'latest' ]);
    if (r && r.result) {
      if (BigInt(r.result) !== 0n) return { ok: false, reason: 'nonce_already_used_onchain' };
    } else if (r && r.error) {
      // non-fatal: fall back to the local store
    }
  }
  return { ok: true, payer: recovered, amount: value.toString() };
}

// --- append-only, race-closing claim store ------------------------------------
function claim(payer, nonce) {
  const key = (payer + ':' + nonce).toLowerCase();
  let seen = new Set();
  try {
    if (fs.existsSync(NONCE_FILE)) {
      for (const line of fs.readFileSync(NONCE_FILE, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o && o.key) seen.add(String(o.key).toLowerCase()); } catch (e) {}
      }
    }
  } catch (e) {}
  if (seen.has(key)) return { ok: false, reason: 'nonce_already_claimed' };
  try { fs.appendFileSync(NONCE_FILE, JSON.stringify({ key, at: new Date().toISOString(), state: 'settled' }) + '\n'); }
  catch (e) { return { ok: false, reason: 'store_write_failed' }; }
  return { ok: true, key };
}

async function acceptV2(header, opts = {}) {
  const d = decodeV2(header);
  if (!d.ok) return { ok: false, reason: d.reason };
  const v = await verifyAuthorization2(d.payload, opts);
  if (!v.ok) return { ok: false, reason: v.reason };
  const c = claim(v.payer, d.payload.authorization.nonce);   // sync, before any await
  if (!c.ok) return { ok: false, reason: c.reason };
  return { ok: true, callerBound: true, payer: v.payer, amount: v.amount, network: d.network, scheme: d.scheme };
}

module.exports = { acceptV2, decodeV2, verifyAuthorization2, claim, DOMAIN, TYPES, USDC, CAIP2 };
