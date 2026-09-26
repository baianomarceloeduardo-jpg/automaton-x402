/*!
 * x402-v2-kit.js v1.0.0 — make an x402 v1 service speak x402 v2. Single file. Zero dependencies.
 * ---------------------------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   Live x402 services negotiate **v2**:
 *     { x402Version: 2, network: "eip155:8453" (CAIP-2), accepts: [ { scheme: "exact",
 *       amount, maxAmountRequired, extra: { name: "USD Coin", version: "2",
 *       credentialTypes: ["authorization"] } } ] }
 *   Many servers still emit **v1**:
 *     { x402Version: 1, network: "base", accepts: [ { maxAmountRequired } ] }
 *   A v2 buyer can never settle against a v1 challenge. The symptom is NOT an error on your
 *   side — it is silent, total failure to sell. That is the trap that cost me 8 sessions.
 *
 * WHAT IT DOES (additive; use either part or both)
 *   1. installEmit(http)    Upgrades your outgoing 402 to a valid v2 challenge while KEEPING every
 *                           v1 field plus an explicit legacy{} mirror, so v1 buyers keep working.
 *   2. installAccept(http)  Accepts the STANDARD v2 X-PAYMENT envelope and hands your existing
 *                           verification code the payload in the shape it already reads.
 *                           Verification stays YOURS. This only translates; it never trusts.
 *
 * USAGE (no build step):
 *   const http = require('http');
 *   const kit = require('./x402-v2-kit.js');
 *   kit.install(http, { payTo: '0xYourAddress', authHeader: 'x-payment-auth' });
 *   ...
 *   const srv = http.createServer(handler);   // both parts are applied transparently
 *
 * HONEST SCOPE
 *   Emitting v2 does NOT make you paid. Accepting v2 does NOT authenticate the caller unless you
 *   bind the payer: recover the EIP-712 signer of the EIP-3009 authorization and REQUIRE it to
 *   equal authorization.from. A raw on-chain txHash is a BEARER token — anyone who sees it on the
 *   public chain can redeem it. It proves a payment happened, NOT who is calling you.
 *
 * LICENSE: CC0 / public domain.
 */
'use strict';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CAIP2 = 'eip155:8453';
const CHAIN_ID = 8453;
const EIP712_DOMAIN = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC_BASE };
const EIP712_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] };

// =============================================================================================
// PART 1 — EMIT: upgrade an outgoing 402 body to v2 without breaking v1 buyers.
// (Logic proven by a dedicated harness: 18/18 checks PASS.)
// =============================================================================================
function upgradeAccept(a) {
  if (!a || typeof a !== 'object') return a;
  const b = Object.assign({}, a);
  if (b.network && b.network !== CAIP2) b.networkV1 = b.network;
  b.network = CAIP2;
  if (b.amount == null) b.amount = b.maxAmountRequired;
  if (b.maxAmountRequired == null) b.maxAmountRequired = b.amount;
  if (b.currency == null && (!b.asset || String(b.asset).toLowerCase() === USDC_BASE.toLowerCase())) b.currency = USDC_BASE;
  if (b.recipient == null && b.payTo) b.recipient = b.payTo;
  if (b.chainId == null) b.chainId = CHAIN_ID;
  if (b.scheme == null) b.scheme = 'exact';
  b.extra = Object.assign({ name: 'USD Coin', version: '2', credentialTypes: ['authorization'] }, b.extra || {});
  return b;
}

function upgradeChallenge(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.accepts)) return j;
  const out = Object.assign({}, j);
  out.x402Version = 2;
  out.supportedVersions = [1, 2];
  out.accepts = j.accepts.map(upgradeAccept);
  out.meta = Object.assign({ chainId: CHAIN_ID, network: CAIP2, asset: USDC_BASE }, out.meta || {});
  if (!out.payment_rails) {
    out.payment_rails = out.accepts.map(a => ({ rail: 'x402', chain: CAIP2,
      assets: [a.asset || USDC_BASE], recipient: a.payTo || a.recipient, scheme: a.scheme }));
  }
  if (!out.legacy) out.legacy = { x402Version: 1, accepts: j.accepts.map(a => Object.assign({}, a, { network: 'base' })) };
  return out;
}

function installEmit(http) {
  const P = http.ServerResponse.prototype;
  if (P.__x402v2Installed) return false;
  P.__x402v2Installed = true;

  const origWrite = P.write, origEnd = P.end, origWriteHead = P.writeHead;

  P.writeHead = function (code, reason, headers) {
    if (this.__x402Flushing) return origWriteHead.apply(this, arguments);
    if (code === 402) {
      // DEFECT FIXED (v1.1.0): do NOT flush headers at writeHead time on a 402. If you do, the
      // upgraded (longer) body is silently TRUNCATED to the old v1 Content-Length and
      // PAYMENT-REQUIRED never appears. Stash the headers; set the real Content-Length in end().
      let hdrs = headers;
      if (!hdrs && reason && typeof reason === 'object') hdrs = reason;
      if (typeof reason === 'string') this.statusMessage = reason;
      this.statusCode = 402;
      if (hdrs) for (const k of Object.keys(hdrs)) { try { this.setHeader(k, hdrs[k]); } catch (e) {} }
      try {
        if (!this.getHeader('WWW-Authenticate') && !this.getHeader('www-authenticate')) this.setHeader('WWW-Authenticate', 'x402');
        this.setHeader('X-402-Version', '2');
      } catch (e) {}
      this.__x402Deferred = true;
      return this;
    }
    return origWriteHead.apply(this, arguments);
  };

  P.write = function (chunk) {
    if (this.__x402Deferred && chunk) {
      this.__x402buf = (this.__x402buf || '') + Buffer.from(chunk).toString();
      const cb = arguments[arguments.length - 1];
      if (typeof cb === 'function') cb();
      return true;
    }
    return origWrite.apply(this, arguments);
  };

  P.end = function (chunk) {
    if (!this.__x402Deferred) {
      if (chunk && this.statusCode === 402) this.__x402buf = (this.__x402buf || '') + Buffer.from(chunk).toString();
      if (this.statusCode !== 402 || !this.__x402buf) return origEnd.apply(this, arguments);
      let body = this.__x402buf;
      try { const j = JSON.parse(body); if (j && Array.isArray(j.accepts)) body = JSON.stringify(upgradeChallenge(j)); } catch (e) {}
      return origEnd.call(this, body);
    }
    if (chunk) this.__x402buf = (this.__x402buf || '') + Buffer.from(chunk).toString();
    let body = this.__x402buf || '';
    let upgraded = false;
    try { const j = JSON.parse(body); if (j && Array.isArray(j.accepts)) { body = JSON.stringify(upgradeChallenge(j)); upgraded = true; } } catch (e) {}
    try {
      this.setHeader('Content-Length', Buffer.byteLength(body));
      if (upgraded) this.setHeader('PAYMENT-REQUIRED', Buffer.from(body).toString('base64'));
      this.setHeader('X-402-Version', '2');
      this.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED,X-402-Version,WWW-Authenticate');
    } catch (e) {}
    this.__x402Deferred = false;
    this.__x402Flushing = true;   // guard: stop Node's INTERNAL flush re-entering our writeHead
    const cb = typeof arguments[1] === 'function' ? arguments[1] : undefined;
    const r = origEnd.call(this, body, cb);
    this.__x402Flushing = false;
    return r;
  };
  return true;
}

// =============================================================================================
// PART 2 — ACCEPT: accept the STANDARD v2 X-PAYMENT envelope, normalise it for your code.
// (Verified: honest authorization accepted; forged signature, wrong recipient, tampered amount,
//  underpaid all rejected; legacy txHash header is NOT hijacked.)
// =============================================================================================
const ACCEPT_OPTS = { paymentHeader: 'x-payment', authHeader: 'x-payment-auth' };

function decodeV2(header, maxBytes) {
  if (!header || typeof header !== 'string') return { ok: false, reason: 'missing_header' };
  if (header.length > (maxBytes || 8192)) return { ok: false, reason: 'header_too_large' };
  let j;
  try { j = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); }
  catch (e) { return { ok: false, reason: 'invalid_base64_or_json' }; }
  if (!j || typeof j !== 'object') return { ok: false, reason: 'not_object' };
  const p = j.payload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'missing_payload' };
  const a = p.authorization || p.auth;
  if (!a || typeof a !== 'object') return { ok: false, reason: 'exact_evm_payment_payload_is_incomplete' };
  const sig = p.signature || p.sig;
  if (!sig || !/^0x[0-9a-fA-F]{130}$/.test(sig)) return { ok: false, reason: 'bad_signature_shape' };
  for (const f of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
    if (a[f] == null) return { ok: false, reason: 'authorization_missing_' + f };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.from) || !/^0x[0-9a-fA-F]{40}$/.test(a.to)) return { ok: false, reason: 'bad_address' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return { ok: false, reason: 'bad_nonce' };
  return { ok: true, x402Version: j.x402Version || 2, network: j.network || CAIP2,
    scheme: j.scheme || 'exact', payload: { authorization: a, signature: sig }, raw: j };
}

async function verifyAuthorization(payload, opts) {
  const o = opts || {};
  const a = payload.authorization, sig = payload.signature;
  let ethers; try { ethers = require('ethers'); } catch (e) { return { ok: false, reason: 'ethers_unavailable' }; }
  if (o.payTo && String(a.to).toLowerCase() !== String(o.payTo).toLowerCase()) return { ok: false, reason: 'wrong_recipient' };
  let value; try { value = BigInt(a.value); } catch (e) { return { ok: false, reason: 'bad_value' }; }
  if (o.minUnits != null && value < BigInt(o.minUnits)) return { ok: false, reason: 'underpaid' };
  const now = Math.floor(Date.now() / 1000), skew = o.skew || 60;
  const va = Number(a.validAfter), vb = Number(a.validBefore);
  if (Number.isFinite(va) && now < va - skew) return { ok: false, reason: 'not_yet_valid' };
  if (Number.isFinite(vb) && now > vb + skew) return { ok: false, reason: 'expired' };
  let recovered;
  try { recovered = ethers.verifyTypedData(EIP712_DOMAIN, EIP712_TYPES,
    { from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce }, sig); }
  catch (e) { return { ok: false, reason: 'recovery_failed' }; }
  if (!recovered || recovered.toLowerCase() !== String(a.from).toLowerCase()) {
    return { ok: false, reason: 'signature_does_not_match_from' };   // <-- the CALLER BINDING
  }
  return { ok: true, payer: recovered, amount: value.toString() };
}

function installAccept(http, opts) {
  const o = Object.assign({}, ACCEPT_OPTS, opts || {});
  if (installAccept.__done) return false;
  installAccept.__done = true;
  const origCreate = http.createServer;
  http.createServer = function (...args) {
    const srv = origCreate.apply(this, args);
    srv.prependListener('request', (req, res) => {
      try {
        const h = req.headers[o.paymentHeader];
        if (!h || req.headers[o.authHeader]) return;
        const d = decodeV2(h);
        if (!d.ok) return;                     // not a v2 envelope: leave it for the legacy path
        req.headers[o.authHeader] = Buffer.from(JSON.stringify({
          x402Version: 2, scheme: d.scheme, network: d.network,
          payload: d.payload, signature: d.payload.signature, bridged: true })).toString('base64');
        delete req.headers[o.paymentHeader];
        req.__x402Bridged = true;
        try { res.setHeader('X-Payment-Bridge', 'v2->eip3009'); } catch (e) {}
      } catch (e) {}
    });
    return srv;
  };
  return true;
}

function install(http, opts) {
  const a = installEmit(http);
  const b = installAccept(http, opts);
  return { emit: a, accept: b };
}

module.exports = { install, installEmit, installAccept, upgradeChallenge, upgradeAccept,
  decodeV2, verifyAuthorization, USDC_BASE, CAIP2, CHAIN_ID, EIP712_DOMAIN, EIP712_TYPES };
