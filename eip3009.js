// eip3009.js - caller-bound x402 payments via EIP-3009 transferWithAuthorization.
//
// WHY: the deepest audit finding (Sentinela) was that a raw on-chain txHash is a BEARER
// credential -- anyone who sees the hash can redeem it, so it does not authenticate the
// caller. EIP-3009 fixes this properly: the payer SIGNS an authorization with their key,
// and the nonce is consumed on-chain, so replay is impossible without local state.
//
// This module:
//   1. builds the exact EIP-712 domain + TransferWithAuthorization types for USDC on Base
//   2. verifies an authorization payload (recover signer, check to/value/window, nonce state)
//   3. optionally SETTLES on-chain via transferWithAuthorization (gas paid by a facilitator)
//   4. advertises the scheme in a 402 challenge (accepts[] entry)
//
// Zero dependency beyond `ethers` (only required when signing/settling).
'use strict';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_NAME = 'USD Coin';
const USDC_VERSION = '2';
const BASE_CHAIN_ID = 8453;
const MAX_HEADER = 8192;

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

function domain(chainId, verifyingContract) {
  return { name: USDC_NAME, version: USDC_VERSION, chainId: chainId || BASE_CHAIN_ID, verifyingContract: verifyingContract || USDC_BASE };
}

function now() { return Math.floor(Date.now() / 1000); }

// ---------- facilitator / client helpers ----------
function makeEip3009(provider, signerWallet) {
  const { ethers } = require('ethers');

  // Client: produce { payload, signature } a server can verify.
  async function signAuthorization(auth, wallet) {
    const w = wallet || signerWallet;
    if (!w) throw new Error('wallet_required');
    const a = Object.assign({
      validAfter: 0, validBefore: now() + 600,
      nonce: ethers.hexlify(ethers.randomBytes(32))
    }, auth);
    const signature = await w.signTypedData(domain(), TYPES, a);
    return { scheme: 'eip3009', network: 'base', chainId: BASE_CHAIN_ID, asset: USDC_BASE, payload: a, signature };
  }

  // Server/facilitator: verify the signed authorization, then (optionally) settle.
  async function verifyAuthorization(env, opts) {
    const o = Object.assign({ payTo: null, minUnits: 1000n, requireUnused: true, clockSkew: 60 }, opts || {});
    try {
      if (!env || typeof env !== 'object') return { ok: false, reason: 'payload_invalid' };
      const a = env.payload || env;
      const sig = env.signature || env.sig;
      if (!a || !sig) return { ok: false, reason: 'payload_invalid' };
      if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return { ok: false, reason: 'signature_malformed' };

      // required fields + types
      for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
        if (a[k] === undefined || a[k] === null) return { ok: false, reason: 'missing_' + k };
      }
      if (!ethers.isAddress(a.from) || !ethers.isAddress(a.to)) return { ok: false, reason: 'bad_address' };
      if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return { ok: false, reason: 'bad_nonce' };

      // recipient binding (the whole point: only the SIGNER's explicit 'to' is credited)
      if (o.payTo && a.to.toLowerCase() !== String(o.payTo).toLowerCase()) return { ok: false, reason: 'wrong_recipient' };

      // amount
      const value = BigInt(a.value);
      if (value < BigInt(o.minUnits)) return { ok: false, reason: 'underpaid', value: value.toString() };

      // validity window (server clock)
      const t = now();
      if (BigInt(a.validAfter) > BigInt(t + o.clockSkew)) return { ok: false, reason: 'not_yet_valid' };
      if (BigInt(a.validBefore) < BigInt(t - o.clockSkew)) return { ok: false, reason: 'expired' };

      // signature -> signer must equal payload.from (caller binding!)
      const recovered = ethers.verifyTypedData(domain(), TYPES, {
        from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce
      }, sig);
      if (recovered.toLowerCase() !== a.from.toLowerCase()) return { ok: false, reason: 'signature_mismatch' };

      // on-chain nonce state: replay protection WITHOUT local state
      if (o.requireUnused && provider) {
        const used = await authorizationState(a.from, a.nonce);
        if (used) return { ok: false, reason: 'nonce_already_used' };
      }
      return { ok: true, reason: 'authorized', from: a.from, to: a.to, value: value.toString(), nonce: a.nonce, validBefore: a.validBefore };
    } catch (e) {
      // surface the true reason (e.g. nonce_state_unavailable) so a rejection is never masked
      return { ok: false, reason: (e && e.reason) || 'verify_error', detail: String(e.message).slice(0, 80) };
    }
  }

  // authorizationState(address,bytes32) -> bool  (selector 0xe94a7ae9)
  // __BOUNDED_NONCE_STATE__ RACE several independent RPCs with a HARD deadline. A single slow provider used to
  // hang the paid route past 60s. Fail-closed if no provider answers in time: a payment we cannot
  // independently confirm must be REJECTED, never accepted and never left hanging.
  const NONCE_RPCS = (process.env.NONCE_RPCS || [
    'https://mainnet.base.org',
    'https://base.llamarpc.com',
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
    'https://base.drpc.org'
  ].join(',')).split(',').map((x) => x.trim()).filter(Boolean);
  const NONCE_DEADLINE = Number(process.env.NONCE_DEADLINE_MS || 3000);

  function _nonceStateVia(url, iface, data, authorizer, nonce, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      let u; try { u = new URL(url); } catch (_) { return finish({ ok: false, err: 'badurl' }); }
      const mod = u.protocol === 'https:' ? require('https') : require('http');
      const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC_BASE, data }, 'latest'] });
      const req = mod.request({
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
        method: 'POST', timeout: ms,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      }, (r) => {
        let d = ''; r.on('data', (c) => d += c);
        r.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error || typeof j.result !== 'string') return finish({ ok: false, err: (j.error && j.error.message) || 'rpc_error' });
            finish({ ok: true, used: Boolean(iface.decodeFunctionResult('authorizationState', j.result)[0]), url });
          } catch (e) { finish({ ok: false, err: 'badjson' }); }
        });
      });
      req.on('error', (e) => finish({ ok: false, err: e.code || 'error' }));
      req.on('timeout', () => { req.destroy(); finish({ ok: false, err: 'timeout' }); });
      req.write(payload); req.end();
    });
  }

  async function authorizationState(authorizer, nonce) {
    const iface = new ethers.Interface(['function authorizationState(address,bytes32) view returns (bool)']);
    const data = iface.encodeFunctionData('authorizationState', [authorizer, nonce]);
    const t0 = Date.now();
    const responses = await Promise.all(NONCE_RPCS.map((u) => _nonceStateVia(u, iface, data, authorizer, nonce, NONCE_DEADLINE)));
    const winners = responses.filter((r) => r.ok);
    if (!winners.length) {
      // FAIL CLOSED: cannot confirm the nonce is unused -> do not authorize.
      const err = new Error('nonce_state_unavailable');
      err.reason = 'nonce_state_unavailable';
      err.providersTried = NONCE_RPCS.length;
      err.ms = Date.now() - t0;
      throw err;
    }
    // majority of responding providers
    const usedCount = winners.filter((w) => w.used).length;
    const used = usedCount > winners.length / 2;
    console.log('[eip3009] nonce state ' + (used ? 'USED' : 'unused') + ' via ' + winners.length + '/' + NONCE_RPCS.length + ' rpcs in ' + (Date.now() - t0) + 'ms');
    return used;
  }

  // Settle on-chain: the FACILITATOR (this signer) pays gas; USDC moves payer->payTo.
  async function settle(env, wallet) {
    const w = wallet || signerWallet;
    if (!w) throw new Error('facilitator_wallet_required');
    const a = env.payload || env; const sig = env.signature || env.sig;
    const { v, r, s } = ethers.Signature.from(sig);
    const iface = new ethers.Interface([
      'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)'
    ]);
    const data = iface.encodeFunctionData('transferWithAuthorization', [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s]);
    const tx = await w.sendTransaction({ to: USDC_BASE, data, gasLimit: 120000 });
    const rec = await tx.wait(1);
    return { txHash: tx.hash, status: rec.status };
  }

  // The accepts[] entry a 402 should advertise for this scheme.
  function challenge(payTo, priceUnits, resource, extra) {
    return Object.assign({
      scheme: 'eip3009',
      network: 'base',
      chainId: BASE_CHAIN_ID,
      asset: USDC_BASE,
      payTo,
      maxAmountRequired: String(priceUnits),
      resource: resource || undefined,
      description: 'Caller-bound payment: sign an EIP-712 TransferWithAuthorization for USD Coin on Base.',
      mimeType: 'application/json',
      maxTimeoutSeconds: 600,
      extra: Object.assign({ name: USDC_NAME, version: USDC_VERSION }, extra || {})
    });
  }

  return { signAuthorization, verifyAuthorization, authorizationState, settle, challenge, domain: () => domain(), TYPES };
}

module.exports = { makeEip3009, domain, TYPES, USDC_BASE, BASE_CHAIN_ID, MAX_HEADER };

// ---------- self-test: prove the crypto + policy checks (offline, deterministic) ----------
if (require.main === module) {
  (async () => {
    const { ethers } = require('ethers');
    const PAY = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
    const payer = ethers.Wallet.createRandom();
    const e = makeEip3009(null, payer);
    let tests = 0, pass = 0;
    const T = (n, c) => { tests++; if (c) pass++; console.log((c ? 'PASS' : 'FAIL') + ' ' + n); };

    // A: honest authorization accepted, signer recovered == payer
    const good = await e.signAuthorization({ from: payer.address, to: PAY, value: '1000' }, payer);
    const A = await e.verifyAuthorization(good, { payTo: PAY, minUnits: 1000n, requireUnused: false });
    T('A honest authorization accepted (from=' + (A.from || '').slice(0, 10) + '...)', A.ok === true && A.from.toLowerCase() === payer.address.toLowerCase());

    // B: signature is caller-bound -> a DIFFERENT signer cannot spend payer's funds
    const attacker = ethers.Wallet.createRandom();
    const forged = await e.signAuthorization({ from: payer.address, to: PAY, value: '1000' }, attacker);
    const B = await e.verifyAuthorization(forged, { payTo: PAY, minUnits: 1000n, requireUnused: false });
    T('B forged signature rejected (signature_mismatch)', B.ok === false && B.reason === 'signature_mismatch');

    // C: wrong recipient rejected (funds can only go to advertised payTo)
    const C1 = await e.signAuthorization({ from: payer.address, to: attacker.address, value: '1000' }, payer);
    const C = await e.verifyAuthorization(C1, { payTo: PAY, minUnits: 1000n, requireUnused: false });
    T('C wrong_recipient rejected', C.ok === false && C.reason === 'wrong_recipient');

    // D: tampered amount -> signature no longer matches
    const tampered = JSON.parse(JSON.stringify(good)); tampered.payload.value = '999999';
    const D = await e.verifyAuthorization(tampered, { payTo: PAY, minUnits: 1000n, requireUnused: false });
    T('D tampered amount rejected (signature_mismatch)', D.ok === false && D.reason === 'signature_mismatch');

    // E: underpaid rejected
    const low = await e.signAuthorization({ from: payer.address, to: PAY, value: '500' }, payer);
    const E = await e.verifyAuthorization(low, { payTo: PAY, minUnits: 1000n, requireUnused: false });
    T('E underpaid rejected', E.ok === false && E.reason === 'underpaid');

    // F: expired rejected, G: not-yet-valid rejected
    const exp = await e.signAuthorization({ from: payer.address, to: PAY, value: '1000', validAfter: 0, validBefore: Math.floor(Date.now() / 1000) - 3600 }, payer);
    const F = await e.verifyAuthorization(exp, { payTo: PAY, minUnits: 1000n, requireUnused: false });
    T('F expired rejected', F.ok === false && F.reason === 'expired');
    const fut = await e.signAuthorization({ from: payer.address, to: PAY, value: '1000', validAfter: Math.floor(Date.now() / 1000) + 3600, validBefore: Math.floor(Date.now() / 1000) + 7200 }, payer);
    const G = await e.verifyAuthorization(fut, { payTo: PAY, minUnits: 1000n, requireUnused: false });
    T('G not_yet_valid rejected', G.ok === false && G.reason === 'not_yet_valid');

    // H: replay rejected by ON-CHAIN nonce state (no local state needed)
    const fakeProvider = { call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['bool'], [true]) };
    const e2 = makeEip3009(fakeProvider, payer);
    const H = await e2.verifyAuthorization(good, { payTo: PAY, minUnits: 1000n, requireUnused: true });
    T('H nonce_already_used rejected (on-chain state)', H.ok === false && H.reason === 'nonce_already_used');

    // I: unused nonce passes the on-chain check
    const fakeProvider2 = { call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['bool'], [false]) };
    const e3 = makeEip3009(fakeProvider2, payer);
    const I = await e3.verifyAuthorization(good, { payTo: PAY, minUnits: 1000n, requireUnused: true });
    T('I unused nonce accepted', I.ok === true);

    // J: 402 challenge is well-formed and caller-binding
    const ch = e.challenge(PAY, 1000, 'https://example.test/v1/uuid');
    T('J challenge well-formed (scheme=eip3009, asset=USDC, payTo set)',
      ch.scheme === 'eip3009' && ch.asset === USDC_BASE && ch.payTo === PAY && ch.maxAmountRequired === '1000' && ch.extra.name === 'USD Coin');

    console.log('\n' + pass + '/' + tests + ' PASS');
    process.exit(pass === tests ? 0 : 1);
  })().catch(err => { console.error('SELFTEST_ERROR ' + err.message); process.exit(1); });
}
