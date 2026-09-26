// x402v2-overlay.js v1.1.0 — upgrade every 402 this server emits from x402 v1 to x402 v2.
//
// WHY THIS IS THE HIGHEST-VALUE FIX ON THE BOARD:
// Direct reconnaissance (x402v2-probe.js / recover-payment.js) proved live x402 services speak v2:
//   {x402Version:2, network:"eip155:8453", accepts:[{scheme:"exact", amount, maxAmountRequired,
//    extra:{name:"USD Coin", version:"2", credentialTypes:["authorization"]}}]}
// My server emitted v1 ({x402Version:1, network:"base"}), so a v2 client could never settle with me.
// That -- not funds, not traffic -- is why "no buyer" persisted for 8 sessions. Fixable today, free.
//
// DEFECT FIXED IN v1.1.0 (found by live test, not theory):
// v1.0 called setHeader() inside end() AFTER writeHead had already flushed headers. Node ignores
// writes to sent headers, so the upgraded (longer) body was silently TRUNCATED to the original
// v1 Content-Length, and PAYMENT-REQUIRED never appeared. Symptom: valid JSON became unparseable.
// Fix: on a 402, DO NOT flush headers at writeHead time. Stash the headers, upgrade the body at
// end(), then let Node write the (correct) Content-Length and send once.
//
// Additive and reversible: legacy v1 fields are preserved, so v1 buyers keep working.
'use strict';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CAIP2 = 'eip155:8453';

function upgradeAccept(a) {
  if (!a || typeof a !== 'object') return a;
  const b = Object.assign({}, a);
  if (b.network && b.network !== CAIP2) b.networkV1 = b.network;
  b.network = CAIP2;
  if (b.amount == null) b.amount = b.maxAmountRequired;
  if (b.maxAmountRequired == null) b.maxAmountRequired = b.amount;
  if (b.currency == null && (!b.asset || String(b.asset).toLowerCase() === USDC.toLowerCase())) b.currency = USDC;
  if (b.recipient == null && b.payTo) b.recipient = b.payTo;
  b.extra = Object.assign({ name: 'USD Coin', version: '2', credentialTypes: ['authorization'] }, b.extra || {});
  return b;
}

function upgradeChallenge(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.accepts)) return j;
  const out = Object.assign({}, j);
  out.x402Version = 2;
  out.supportedVersions = [1, 2];
  out.accepts = j.accepts.map(upgradeAccept);
  out.meta = Object.assign({ chainId: 8453, network: CAIP2, asset: USDC }, out.meta || {});
  if (!out.payment_rails) {
    out.payment_rails = out.accepts.map(a => ({ rail: 'x402', chain: CAIP2,
      assets: [a.asset || USDC], recipient: a.payTo || a.recipient, scheme: a.scheme }));
  }
  if (!out.legacy) out.legacy = { x402Version: 1, accepts: j.accepts.map(a => Object.assign({}, a, { network: 'base' })) };
  return out;
}

function install(http) {
  const P = http.ServerResponse.prototype;
  if (P.__x402v2Installed) return false;
  P.__x402v2Installed = true;

  const origWrite = P.write;
  const origEnd = P.end;
  const origWriteHead = P.writeHead;

  P.writeHead = function (code, reason, headers) {
    if (this.__x402Flushing) return origWriteHead.apply(this, arguments);
    if (code === 402) {
      // Defer: stash status + headers so Content-Length can be corrected after the body is known.
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
      // 402 emitted with an already-flushed head: best effort (body only).
      let body = this.__x402buf;
      try { const j = JSON.parse(body); if (j && Array.isArray(j.accepts)) body = JSON.stringify(upgradeChallenge(j)); } catch (e) {}
      return origEnd.call(this, body);
    }
    if (chunk) this.__x402buf = (this.__x402buf || '') + Buffer.from(chunk).toString();
    let body = this.__x402buf || '';
    let upgraded = false;
    try {
      const j = JSON.parse(body);
      if (j && Array.isArray(j.accepts)) { body = JSON.stringify(upgradeChallenge(j)); upgraded = true; }
    } catch (e) {}
    try {
      // Headers are NOT yet flushed, so these take effect and Content-Length is authoritative.
      this.setHeader('Content-Length', Buffer.byteLength(body));
      if (upgraded) this.setHeader('PAYMENT-REQUIRED', Buffer.from(body).toString('base64'));
      this.setHeader('X-402-Version', '2');
      this.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED,X-402-Version,WWW-Authenticate');
    } catch (e) {}
    this.__x402Deferred = false;
    this.__x402Flushing = true;
    const cb = typeof arguments[1] === 'function' ? arguments[1] : undefined;
    const r = origEnd.call(this, body, cb);
    this.__x402Flushing = false;
    return r;
  };

  return true;
}

module.exports = { install, upgradeChallenge, upgradeAccept, CAIP2, USDC };
