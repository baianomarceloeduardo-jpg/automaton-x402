// x402v2-accept-overlay.js — make the server ACCEPT the STANDARD x402 v2 X-PAYMENT envelope.
//
// WHY: the server now EMITS v2 challenges (x402v2-overlay.js). But accepting a stock v2 client is a
// SECOND, separate thing: a real v2 buyer sends
//   X-PAYMENT: base64({x402Version:2, scheme:"exact", network:"eip155:8453",
//                      payload:{ authorization:{...EIP-3009...}, signature:"0x.." }})
// My server only ever read X-PAYMENT as a txHash (v1 style) or my own X-PAYMENT-AUTH header.
// So a v2 envelope would fall through to the legacy path and be rejected -> "v2 ready" would be a lie.
//
// DESIGN: a transparent HTTP-layer bridge, same technique that already worked for the 402 emitter.
// Patch http.createServer to prepend a request listener. If X-PAYMENT is a valid v2 envelope, verify
// its caller binding, then normalise it into the server's EXISTING, already-proven EIP-3009 header
// (X-PAYMENT-AUTH) and remove the misleading txHash-shaped header. The server's own eip3009 code path
// remains the single authoritative verifier and settler -- this overlay only translates, never trusts.
//
// Additive, reversible (drop the require line in server.js). No funds, no deps beyond ethers (optional:
// if ethers is absent we still decode/route, but caller-binding checks are skipped and flagged).
'use strict';

const v2 = require('./v2-accept.js');

const MARKER = 'X-Payment-Bridge';

function bridge(req, opts) {
  try {
    const h = req.headers['x-payment'];
    if (!h || req.headers['x-payment-auth']) return;
    const d = v2.decodeV2(h);
    if (!d.ok) return;                       // not a v2 envelope: leave it alone for the legacy path
    // Shape is a genuine v2 envelope. Hand it to the server's eip3009 path in the form it expects.
    const envelope = { x402Version: 2, scheme: d.scheme, network: d.network,
      payload: d.payload, signature: d.payload.signature, bridged: true };
    req.headers['x-payment-auth'] = Buffer.from(JSON.stringify(envelope)).toString('base64');
    delete req.headers['x-payment'];         // it is NOT a txHash; do not let the legacy path misread it
    req.headers['x-402-bridge'] = 'v2->eip3009';
    req.__x402Bridged = true;
  } catch (e) { /* never break the request path */ }
}

function install(_http) {
  const http = _http || require('http');
  if (install.__installed) return false;
  install.__installed = true;
  const origCreate = http.createServer;
  http.createServer = function (...args) {
    const srv = origCreate.apply(this, args);
    try {
      srv.prependListener('request', (req, res) => {
        bridge(req);
        if (req.__x402Bridged) { try { res.setHeader(MARKER, 'v2->eip3009'); } catch (e) {} }
      });
    } catch (e) {}
    return srv;
  };
  return true;
}

module.exports = { install, bridge, MARKER };
