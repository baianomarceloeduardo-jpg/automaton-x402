// kit-serve.js v2 — serve x402-v2-kit.js from my own API, ROBUSTLY and SAFELY.
//
// WHY v2: v1 patched http.createServer. That failed in production -- the live server's own 404
// answered for /x402-v2-kit.js, meaning the patch never bound to the running server object
// (module-instance / construction-order fragility). Patching a factory is the wrong layer.
//
// v2 intercepts http.Server.prototype.emit('request', req, res). That fires for EVERY request on
// EVERY http server regardless of how it was built (http.createServer, new http.Server,
// https.createServer) or which require() instance it captured. One reliable choke point.
//
// SAFETY: only the two kit URLs are handled here. Everything else returns to Node's normal emit,
// so the real router is untouched. Idempotent.
'use strict';
const fs = require('fs');
const path = require('path');
const httpMod = require('http');

const DIR = __dirname;
const KIT = path.join(DIR, 'x402-v2-kit.js');
const PROOF = path.join(DIR, 'prove-kit-results.json');
const readOr = (f, d) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return d; } };

function serveKit(res) {
  if (!fs.existsSync(KIT)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('kit missing'); }
  const b = Buffer.from(readOr(KIT, ''));
  res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-length': b.length,
    'cache-control': 'public, max-age=600', 'access-control-allow-origin': '*', 'x-kit-version': '1.0.0',
    'link': '<https://paste.rs/Gfnqj>; rel=describedby' });
  res.end(b);
}

function serveKitJson(res, req) {
  let proof = null; try { proof = JSON.parse(readOr(PROOF, 'null')); } catch (e) {}
  const h = String(req.headers.host || 'localhost:8080');
  const host = h.split(':')[0];
  const proto = /(trycloudflare\.com|lhr\.life|localhost\.run|ngrok)/.test(host) ? 'https' : 'http';
  const base = proto + '://' + h;
  const j = JSON.stringify({
    name: 'x402-v2-kit', version: '1.0.0', license: 'CC0-1.0', language: 'javascript', deps: ['none'],
    purpose: 'Make an x402 v1 service speak x402 v2. One file, zero dependencies.',
    install: ["const http = require('http');",
      "require('./x402-v2-kit.js').install(http, { payTo: '0x..', authHeader: 'x-payment-auth' });",
      '// then http.createServer(handler) as normal'],
    why: 'Live x402 services negotiate v2 ({x402Version:2, network:"eip155:8453" (CAIP-2), accepts:[{scheme:"exact", amount, extra:{name:"USD Coin",version:"2",credentialTypes:["authorization"]}}]}). A server emitting v1 ({x402Version:1, network:"base"}) can never be settled by a v2 buyer -- and sees no error, just no sales.',
    whatItDoes: ['upgrades any outgoing 402 to a valid v2 challenge',
      'preserves every v1 field plus an explicit legacy{} mirror, so v1 buyers keep working',
      'accepts the STANDARD v2 X-PAYMENT envelope (base64 {x402Version:2,scheme,network,payload:{authorization,signature}})',
      'hands your existing verifier the payload in the shape it already reads',
      'verifyAuthorization(): EIP-712 recovery REQUIRED to equal authorization.from (caller binding)'],
    honestScope: 'Emitting v2 does not make you paid. Accepting v2 does not authenticate the caller unless you bind authorization.from. A raw on-chain txHash is a BEARER token: it proves a payment happened, not who is calling you.',
    proof: proof, sourceUrl: base + '/x402-v2-kit.js', durable: 'https://paste.rs/Gfnqj',
    announce: 'https://paste.rs/LKMoH', proofUrl: 'https://paste.rs/Xlx78'
  }, null, 2);
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
  res.end(j);
}

function install() {
  if (global.__KIT_SERVE_V2) return false;
  global.__KIT_SERVE_V2 = true;
  const origEmit = httpMod.Server.prototype.emit;
  httpMod.Server.prototype.emit = function (type) {
    if (type === 'request') {
      const req = arguments[1], res = arguments[2];
      try {
        const u = String(req && req.url || '').split('?')[0];
        if (u === '/x402-v2-kit.js' || u === '/kit' || u === '/v1/x402-v2-kit') {
          global.__KIT_SERVE_HITS = (global.__KIT_SERVE_HITS || 0) + 1;
          if (u === '/v1/x402-v2-kit') serveKitJson(res, req); else serveKit(res);
          return true;                       // fully handled: real router never sees it
        }
      } catch (e) { /* fall through to normal handling */ }
    }
    return origEmit.apply(this, arguments);
  };
  return true;
}

module.exports = { install };
if (require.main === module) { install(); console.log('kit-serve v2 installed'); }
