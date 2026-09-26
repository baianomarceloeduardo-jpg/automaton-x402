// KIT-SERVE-OVERLAY (idempotent)
const __KS_fs = require('fs'), __KS_path = require('path');
const __KS_DIR = __dirname;
const __KS_MARK = '__kitServeApplied';
function __kitServe(req, res) {
  const u = (req.url || '').split('?')[0];
  if (u === '/x402-v2-kit.js' || u === '/kit') {
    const f = __KS_path.join(__KS_DIR, 'x402-v2-kit.js');
    if (!__KS_fs.existsSync(f)) { res.writeHead(404, {'content-type':'text/plain'}); return res.end('kit missing'); }
    const b = __KS_fs.readFileSync(f);
    res.writeHead(200, { 'content-type':'application/javascript; charset=utf-8', 'content-length': b.length,
      'cache-control':'public, max-age=600', 'access-control-allow-origin':'*',
      'x-kit-version':'1.0.0', 'link':'<https://paste.rs/TOP96>; rel=describedby' });
    return res.end(b);
  }
  if (u === '/v1/x402-v2-kit') {
    const src = __KS_fs.readFileSync(__KS_path.join(__KS_DIR, 'x402-v2-kit.js'), 'utf8');
    let pf = null; try { pf = JSON.parse(__KS_fs.readFileSync(__KS_path.join(__KS_DIR,'prove-kit-results.json'),'utf8')); } catch(e){}
    const j = JSON.stringify({ name:'x402-v2-kit', version:'1.0.0', license:'CC0-1.0', language:'javascript',
      deps:['none (ethers optional, only for the verifier helper)'], purpose:'Make an x402 v1 service speak x402 v2.',
      install:["const http=require('http');","require('./x402-v2-kit.js').install(http,{payTo:'0x..',authHeader:'x-payment-auth'});"],
      guarantees:['upgrades outgoing 402 to v2','preserves v1 fields + legacy mirror','accepts STANDARD v2 X-PAYMENT','enforces payer binding when you call verifyAuthorization'],
      honestScope:'Emitting v2 does not make you paid; accepting v2 does not authenticate the caller unless you bind authorization.from.',
      proof: pf, source: src, durable: 'https://paste.rs/TOP96' }, null, 2);
    res.writeHead(200, { 'content-type':'application/json', 'cache-control':'public, max-age=300', 'access-control-allow-origin':'*' });
    return res.end(j);
  }
  if (__kitServe.__next) return __kitServe.__next(req, res);
  res.writeHead(404, {'content-type':'application/json'}); res.end('{"error":"not_found"}');
}
__kitServe.__next = global.__KIT_NEXT_HANDLER || null;
global.__KIT_SERVE = __kitServe;
if (!global.__KIT_INSTALLED) { global.__KIT_INSTALLED = true;
  const __origCreate = require('http').createServer;
  require('http').createServer = function () {
    const s = __origCreate.apply(this, arguments);
    if (!s.listeners('request').some(f => f && f.name === '__kitServe')) s.prependListener('request', __kitServe);
    return s;
  };
}
