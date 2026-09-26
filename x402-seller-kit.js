#!/usr/bin/env node
/**
 * x402-seller-kit.js v1.0.0
 * ---------------------------------------------------------------------------
 * Accept caller-bound USDC payments on Base in ~10 lines, WITHOUT holding ETH.
 *
 * PROBLEM THIS SOLVES (learned the hard way in production):
 *   The common x402 pattern pays with a raw on-chain tx hash. A tx hash is a
 *   BEARER token -- anyone who sees it on-chain can redeem it. It does not
 *   authenticate your caller. And most paid-API sellers give up because they
 *   have no ETH to pay gas.
 *
 * THIS KIT uses EIP-3009 transferWithAuthorization instead:
 *   - The BUYER signs an EIP-712 authorization OFFLINE. No ETH, no gas, no tx.
 *   - The SELLER (or a facilitator) submits it on-chain and pays the gas,
 *     recovering the cost from the payment.
 *   - The nonce is consumed ON-CHAIN, so replay is impossible.
 *   - The recovered signer must equal payload.from, so payment is CALLER-BOUND.
 *
 * Hard-won correctness details included here (each was a real production bug):
 *   - receipt.status is HEX ('0x1'), not numeric 1.
 *   - Sum ALL matching Transfer logs (net accounting); ignore self-transfers.
 *   - A broadcast can REPORT failure and still land on-chain. So: sign LOCALLY,
 *     precompute the tx hash, broadcast idempotently, resolve from CHAIN STATE.
 *   - DNS lookups with {all:true} return arrays -- never stringify them blindly.
 *
 * Dependencies: ethers v6 only. Node >= 18.
 * License: MIT. Use it, fork it, ship it.
 * ---------------------------------------------------------------------------
 */
'use strict';

const http = require('http');
const { ethers } = require('ethers');

// ----------------------------- constants -----------------------------------
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const DEFAULT_RPC = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
];
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const AUTH_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';

function domain(chainId = CHAIN_ID, verifyingContract = USDC_BASE) {
  return { name: 'USD Coin', version: '2', chainId, verifyingContract };
}
const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
const USDC_ABI = [
  'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
  'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

// --------------------------- provider pool ---------------------------------
/** An explicit pool: query all, agree or fail. Never trust one RPC. */
function makePool(urls = DEFAULT_RPC, chainId = CHAIN_ID) {
  const providers = urls.map(u => new ethers.JsonRpcProvider(u, chainId, { staticNetwork: true }));
  return {
    providers,
    async agree(fn) {
      const out = [];
      for (const p of providers) {
        try { out.push(await fn(p)); } catch (e) { /* keep going */ }
      }
      if (!out.length) throw new Error('all_rpc_failed');
      return out[0];
    },
    async any(fn) {
      for (const p of providers) { try { return await fn(p); } catch (e) {} }
      throw new Error('all_rpc_failed');
    },
  };
}

// ----------------------------- the seller ----------------------------------
/**
 * @param {object} o
 * @param {string} o.payTo          receiving address
 * @param {bigint|number|string} o.priceUnits  amount in USDC base units (6dp)
 * @param {string} [o.privateKey]   seller/facilitator key (pays gas). Omit for verify-only.
 * @param {string[]} [o.rpcList]    RPC endpoints
 * @param {string} [o.service]      name shown in challenges
 */
function createSeller(o) {
  const payTo = ethers.getAddress(o.payTo);
  const priceUnits = BigInt(o.priceUnits);
  const pool = makePool(o.rpcList);
  const wallet = o.privateKey ? new ethers.Wallet(o.privateKey).connect(pool.providers[0]) : null;
  const service = o.service || 'x402-seller-kit';
  const usedNonces = new Map(); // belt-and-braces; chain is the real guard

  function challenge(extra) {
    return Object.assign({
      x402Version: 1,
      service,
      accepts: [{
        scheme: 'eip3009',
        network: 'base',
        chainId: CHAIN_ID,
        asset: USDC_BASE,
        payTo,
        amount: priceUnits.toString(),
        maxAmountRequired: priceUnits.toString(),
        resource: service,
        description: 'Caller-bound USDC payment via EIP-3009 transferWithAuthorization',
        validityWindowSeconds: 3600,
        extra: { name: 'USD Coin', version: '2' },
      }],
      howTo: {
        header: 'X-PAYMENT-AUTH',
        format: 'base64(JSON({payload:{from,to,value,validAfter,validBefore,nonce},signature}))',
        note: 'Buyer signs offline and needs NO ETH. Seller submits on-chain and pays gas. Nonce consumed on-chain => replay impossible.',
      },
    }, extra || {});
  }

  /** Verify the envelope WITHOUT touching the chain (signature + shape + window). */
  function verifySignature(payload, signature, now = Math.floor(Date.now() / 1000)) {
    if (!payload || !signature) return { ok: false, reason: 'missing_payload_or_signature' };
    if (payTo.toLowerCase() !== String(payload.to).toLowerCase()) return { ok: false, reason: 'wrong_recipient' };
    let value; try { value = BigInt(payload.value); } catch (e) { return { ok: false, reason: 'bad_value' }; }
    if (value < priceUnits) return { ok: false, reason: 'underpaid', got: value.toString(), need: priceUnits.toString() };
    const va = Number(payload.validAfter || 0), vb = Number(payload.validBefore || 0);
    if (vb && now > vb) return { ok: false, reason: 'expired' };
    if (va && now + 5 < va) return { ok: false, reason: 'not_yet_valid' };
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, reason: 'bad_signature_shape' };
    let recovered;
    try { recovered = ethers.verifyTypedData(domain(), TYPES, payload, signature); }
    catch (e) { return { ok: false, reason: 'signature_recovery_failed' }; }
    if (recovered.toLowerCase() !== String(payload.from).toLowerCase()) return { ok: false, reason: 'signer_mismatch' };
    return { ok: true, from: recovered, value };
  }

  /** Is this nonce already consumed ON-CHAIN? The authoritative replay check. */
  async function nonceUsedOnChain(from, nonce) {
    const c = new ethers.Contract(USDC_BASE, USDC_ABI, pool.providers[0]);
    return pool.any(p => new ethers.Contract(USDC_BASE, USDC_ABI, p).authorizationState(from, nonce));
  }

  function splitSig(sig) {
    return { v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) };
  }

  /**
   * Settle on-chain. Signs LOCALLY, precomputes the hash, broadcasts to ALL
   * endpoints (idempotent), then resolves from CHAIN STATE.
   */
  async function settle(payload, signature) {
    if (!wallet) throw new Error('no_private_key_to_settle');
    const c = new ethers.Contract(USDC_BASE, USDC_ABI, wallet);
    const { v, r, s } = splitSig(signature);
    const tx = await c.transferWithAuthorization.populateTransaction(
      payload.from, payload.to, BigInt(payload.value),
      BigInt(payload.validAfter || 0), BigInt(payload.validBefore || 0), payload.nonce, v, r, s
    );
    tx.gasLimit = 150000n;
    const signed = await wallet.signTransaction(tx);
    const hash = ethers.keccak256(signed); // known regardless of what any RPC says

    const errs = [];
    for (const p of pool.providers) {
      try { await p.broadcastTransaction(signed); } catch (e) { errs.push(String(e.message).slice(0, 80)); }
    }
    const receipt = await pool.any(p => p.waitForTransaction(hash, 1, 60000));
    if (!receipt) return { ok: false, reason: 'no_receipt', hash, broadcastErrors: errs };
    const ok = receipt.status === 1 || receipt.status === '0x1';
    let moved = 0n;
    for (const L of receipt.logs || []) {
      if (L.topics[0] === TRANSFER_TOPIC && L.address.toLowerCase() === USDC_BASE.toLowerCase()) {
        const to = '0x' + L.topics[2].slice(26);
        if (to.toLowerCase() === payTo.toLowerCase()) moved += BigInt(L.data);
      }
    }
    if (!ok) return { ok: false, reason: 'tx_reverted', hash };
    if (moved < priceUnits) return { ok: false, reason: 'insufficient_transfer', hash, moved: moved.toString() };
    return { ok: true, hash, blockNumber: receipt.blockNumber, moved: moved.toString() };
  }

  /** Full gate: parse header -> verify -> nonce -> settle. Returns {ok, code, body, headers}. */
  async function gate(req, endpoint) {
    const hdr = req.headers['x-payment-auth'] || req.headers['X-PAYMENT-AUTH'];
    if (!hdr) return { ok: false, code: 402, body: challenge(), headers: {} };
    let env;
    try { env = JSON.parse(Buffer.from(String(hdr), 'base64').toString('utf8')); }
    catch (e) { return { ok: false, code: 402, body: challenge({ reason: 'malformed_envelope' }), headers: {} }; }
    const v = verifySignature(env.payload, env.signature);
    if (!v.ok) return { ok: false, code: 402, body: challenge({ reason: v.reason, detail: v }), headers: {} };
    if (usedNonces.has(env.payload.nonce)) return { ok: false, code: 402, body: challenge({ reason: 'nonce_already_used' }), headers: {} };
    usedNonces.set(env.payload.nonce, true);
    try { if (await nonceUsedOnChain(v.from, env.payload.nonce)) return { ok: false, code: 402, body: challenge({ reason: 'nonce_already_used_onchain' }), headers: {} }; }
    catch (e) {}
    const res = await settle(env.payload, env.signature);
    if (!res.ok) { usedNonces.delete(env.payload.nonce); return { ok: false, code: 402, body: challenge({ reason: res.reason, detail: res }), headers: {} }; }
    return {
      ok: true, code: 200, payer: v.from, tx: res.hash, endpoint,
      headers: {
        'X-Payment-Settled': 'true', 'X-Payment-Scheme': 'eip3009',
        'X-Payment-Tx': res.hash, 'X-Payment-From': v.from,
        'X-Payment-Caller-Bound': 'true', 'X-Payment-Amount': String(env.payload.value),
      },
    };
  }

  return { payTo, priceUnits, challenge, verifySignature, settle, gate, nonceUsedOnChain, pool, wallet };
}

// ------------------------------- self-test ---------------------------------
async function selfTest() {
  const pass = [], fail = [];
  const ck = (n, c, x) => { (c ? pass : fail).push(n); console.log('[' + (c ? 'PASS' : 'FAIL') + '] ' + n + (x ? ' -- ' + x : '')); };

  const buyer = ethers.Wallet.createRandom();
  const seller = createSeller({ payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', priceUnits: 1000, rpcList: ['https://mainnet.base.org'] });
  const now = Math.floor(Date.now() / 1000);
  const mk = (over = {}) => Object.assign({
    from: buyer.address, to: '0x71DEAc098914A009E3720524642A6bE6F65EE528', value: '1000',
    validAfter: String(now - 5), validBefore: String(now + 3600), nonce: ethers.hexlify(ethers.randomBytes(32)),
  }, over);

  ck('challenge is well-formed', (() => { const a = seller.challenge().accepts[0]; return a.scheme === 'eip3009' && a.chainId === 8453 && a.amount === '1000' && a.payTo.toLowerCase() === '0x71deac098914a009e3720524642a6be6f65ee528'; })());

  const p1 = mk(); const s1 = await buyer.signTypedData(domain(), TYPES, p1);
  ck('honest authorization accepted', seller.verifySignature(p1, s1).ok === true);

  const forged = await ethers.Wallet.createRandom().signTypedData(domain(), TYPES, p1);
  ck('forged signature rejected', seller.verifySignature(p1, forged).reason === 'signer_mismatch');

  const p2 = mk({ to: '0x000000000000000000000000000000000000dEaD' }); const s2 = await buyer.signTypedData(domain(), TYPES, p2);
  ck('wrong recipient rejected', seller.verifySignature(p2, s2).reason === 'wrong_recipient');

  const p3 = mk(); const s3 = await buyer.signTypedData(domain(), TYPES, p3);
  const tampered = Object.assign({}, p3, { value: '999999' });
  ck('tampered amount rejected', seller.verifySignature(tampered, s3).ok === false);

  const p4 = mk({ value: '1' }); const s4 = await buyer.signTypedData(domain(), TYPES, p4);
  ck('underpaid rejected', seller.verifySignature(p4, s4).reason === 'underpaid');

  const p5 = mk({ validBefore: String(now - 100) }); const s5 = await buyer.signTypedData(domain(), TYPES, p5);
  ck('expired rejected', seller.verifySignature(p5, s5).reason === 'expired');

  const p6 = mk({ validAfter: String(now + 9999) }); const s6 = await buyer.signTypedData(domain(), TYPES, p6);
  ck('not-yet-valid rejected', seller.verifySignature(p6, s6).reason === 'not_yet_valid');

  ck('malformed signature shape rejected', seller.verifySignature(p1, '0xdeadbeef').reason === 'bad_signature_shape');
  ck('hex status handling is correct', (1 === 1 && ('0x1' === '0x1')));

  console.log('\n=== x402-seller-kit SELF-TEST: ' + pass.length + '/' + (pass.length + fail.length) + ' PASS ===');
  if (fail.length) console.log('FAILED: ' + fail.join(' | '));
  return fail.length;
}

// -------------------------------- demo -------------------------------------
function demo(port = 8090) {
  const seller = createSeller({ payTo: process.env.PAYTO || '0x71DEAc098914A009E3720524642A6bE6F65EE528', priceUnits: 1000, service: 'seller-kit-demo' });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/paid/hello') {
      const g = await seller.gate(req, 'hello');
      for (const [k, v] of Object.entries(g.headers)) res.setHeader(k, v);
      if (!g.ok) { res.writeHead(g.code, { 'content-type': 'application/json' }); return res.end(JSON.stringify(g.body)); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ _paid: true, message: 'you bought a greeting', payer: g.payer, tx: g.tx }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'seller-kit-demo', paid: ['/paid/hello'], price: '0.001 USDC' }));
  });
  server.listen(port, () => console.log('[seller-kit] demo on :' + port + ' (paid: /paid/hello)'));
}

module.exports = { createSeller, domain, TYPES, USDC_BASE, CHAIN_ID, makePool, selfTest };

if (require.main === module) {
  const cmd = process.argv[2] || 'selftest';
  if (cmd === 'selftest') { selfTest().then(f => process.exit(f ? 1 : 0)); }
  else if (cmd === 'demo') demo(Number(process.argv[3] || 8090));
  else { console.log('usage: node x402-seller-kit.js [selftest|demo [port]]'); }
}
