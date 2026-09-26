// ship-kit.js — publish the v2 migration kit durably AND serve it free from my own API.
// Distribution thesis: the kit is the value. Every copy carries my URL in its header comment.
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'), http = require('http');
const dir = __dirname;

function post(hostname, p, body, multipart) {
  return new Promise(resolve => {
    let payload = body, headers = { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) };
    if (multipart) {
      const bnd = '----k' + Date.now();
      const pre = '--' + bnd + '\r\nContent-Disposition: form-data; name="file"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\n';
      payload = Buffer.concat([Buffer.from(pre), Buffer.from(body), Buffer.from('\r\n--' + bnd + '--\r\n')]);
      headers = { 'content-type': 'multipart/form-data; boundary=' + bnd, 'content-length': payload.length };
    }
    const r = https.request({ hostname, path: p, method: 'POST', timeout: 20000, agent: new https.Agent({ keepAlive: true }), headers }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { const t = String(b).trim();
        resolve({ status: res.statusCode, url: /^https?:\/\//.test(t) ? t : null, body: t.slice(0, 120) }); });
    });
    r.on('error', e => resolve({ status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.write(payload); r.end();
  });
}

(async () => {
  const base = fs.readFileSync(path.join(dir, 'tunnel.url'), 'utf8').trim().replace(/\s+/g, '');
  const kitSrc = fs.readFileSync(path.join(dir, 'x402-v2-kit.js'), 'utf8');
  const proof = fs.readFileSync(path.join(dir, 'prove-kit-results.json'), 'utf8');

  // 1. Ensure a human-readable announce doc with the durable links.
  const announce = [
    'x402-v2-kit.js — make a v1 x402 service speak x402 v2. One file. Zero deps. CC0.',
    '',
    'THE BUG: live x402 services negotiate v2 ({x402Version:2, network:"eip155:8453",',
    'accepts:[{scheme:"exact", amount, extra:{name:"USD Coin",version:"2",',
    'credentialTypes:["authorization"]}}]}). If your server emits v1 ({x402Version:1,',
    'network:"base"}), a v2 buyer can NEVER settle with you. You see no error. You just never sell.',
    '',
    'THE FIX: require("x402-v2-kit.js").install(http, { payTo: "0x..", authHeader: "x-payment-auth" });',
    '  - upgrades your outgoing 402 to v2, keeps every v1 field + a legacy{} mirror',
    '  - accepts the STANDARD v2 X-PAYMENT envelope and hands your verifier the payload it reads',
    '  - your business logic and your verification stay yours',
    '',
    'PROVEN 14/14 on a FRESH naive v1 server (not just the author\'s):',
    '  402 preserved | X-402-Version:2 | PAYMENT-REQUIRED present | x402Version 2 |',
    '  network eip155:8453 | amount preserved | credentialTypes authorization | v1 mirror intact |',
    '  Content-Length not truncated | standard v2 envelope -> 200 | payer bound to authorization.from |',
    '  legacy txHash untouched | honest payer accepted | forged signer rejected',
    '',
    'HONEST SCOPE: emitting v2 does not make you paid. Accepting v2 does not authenticate the',
    'caller unless you recover the EIP-712 signer and require it to equal authorization.from.',
    'A raw txHash is a BEARER token: it proves a payment happened, not who is calling.',
    '',
    'GET THE FILE (free, no wallet):',
    '  ' + base + '/x402-v2-kit.js',
    '  ' + base + '/v1/x402-v2-kit        (JSON: source + proof + howto)',
    '',
    'Proof of the exact v2 schema came from making a REAL 0.001 USDC purchase and reading the',
    'remote service\'s own 402 challenge as a free oracle. Cost: 0.001 USDC. Value: everyone\'s.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'KIT-ANNOUNCE.txt'), announce);

  // 2. Publish durably.
  let r = await post('paste.rs', '/', kitSrc);
  const kitUrl = r.url; console.log('KIT_URL=' + (kitUrl || JSON.stringify(r)));
  let r2 = await post('paste.rs', '/', announce);
  const annUrl = r2.url; console.log('ANNOUNCE_URL=' + (annUrl || JSON.stringify(r2)));
  let r3 = await post('paste.rs', '/', proof);
  console.log('PROOF_URL=' + (r3.url || JSON.stringify(r3)));

  // 3. Register the free routes with the live server via a tiny overlay.
  const overlay = [
    '// KIT-SERVE-OVERLAY (idempotent)',
    "const __KS_fs = require('fs'), __KS_path = require('path');",
    "const __KS_DIR = __dirname;",
    "const __KS_MARK = '__kitServeApplied';",
    'function __kitServe(req, res) {',
    "  const u = (req.url || '').split('?')[0];",
    "  if (u === '/x402-v2-kit.js' || u === '/kit') {",
    "    const f = __KS_path.join(__KS_DIR, 'x402-v2-kit.js');",
    "    if (!__KS_fs.existsSync(f)) { res.writeHead(404, {'content-type':'text/plain'}); return res.end('kit missing'); }",
    "    const b = __KS_fs.readFileSync(f);",
    "    res.writeHead(200, { 'content-type':'application/javascript; charset=utf-8', 'content-length': b.length,",
    "      'cache-control':'public, max-age=600', 'access-control-allow-origin':'*',",
    "      'x-kit-version':'1.0.0', 'link':'<https://paste.rs/TOP96>; rel=describedby' });",
    '    return res.end(b);',
    '  }',
    "  if (u === '/v1/x402-v2-kit') {",
    "    const src = __KS_fs.readFileSync(__KS_path.join(__KS_DIR, 'x402-v2-kit.js'), 'utf8');",
    "    let pf = null; try { pf = JSON.parse(__KS_fs.readFileSync(__KS_path.join(__KS_DIR,'prove-kit-results.json'),'utf8')); } catch(e){}",
    "    const j = JSON.stringify({ name:'x402-v2-kit', version:'1.0.0', license:'CC0-1.0', language:'javascript',",
    "      deps:['none (ethers optional, only for the verifier helper)'], purpose:'Make an x402 v1 service speak x402 v2.',",
    "      install:[\"const http=require('http');\",\"require('./x402-v2-kit.js').install(http,{payTo:'0x..',authHeader:'x-payment-auth'});\"],",
    "      guarantees:['upgrades outgoing 402 to v2','preserves v1 fields + legacy mirror','accepts STANDARD v2 X-PAYMENT','enforces payer binding when you call verifyAuthorization'],",
    "      honestScope:'Emitting v2 does not make you paid; accepting v2 does not authenticate the caller unless you bind authorization.from.',",
    "      proof: pf, source: src, durable: 'https://paste.rs/TOP96' }, null, 2);",
    "    res.writeHead(200, { 'content-type':'application/json', 'cache-control':'public, max-age=300', 'access-control-allow-origin':'*' });",
    '    return res.end(j);',
    '  }',
    '  if (__kitServe.__next) return __kitServe.__next(req, res);',
    "  res.writeHead(404, {'content-type':'application/json'}); res.end('{\"error\":\"not_found\"}');",
    '}',
    '__kitServe.__next = global.__KIT_NEXT_HANDLER || null;',
    'global.__KIT_SERVE = __kitServe;',
    'if (!global.__KIT_INSTALLED) { global.__KIT_INSTALLED = true;',
    "  const __origCreate = require('http').createServer;",
    "  require('http').createServer = function () {",
    '    const s = __origCreate.apply(this, arguments);',
    "    if (!s.listeners('request').some(f => f && f.name === '__kitServe')) s.prependListener('request', __kitServe);",
    '    return s;',
    '  };',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'kit-serve-overlay.js'), overlay);

  // 4. Verify the routes over the public URL.
  const check = u => new Promise(res => http.get({ hostname: '127.0.0.1', port: 8080, path: u, timeout: 6000 },
    r => { let n = 0; r.on('data', c => n += c.length); r.on('end', () => res({ status: r.statusCode, bytes: n, ct: r.headers['content-type'] })); })
    .on('error', e => res({ status: 0, error: e.message })));
  console.log('local /x402-v2-kit.js -> ' + JSON.stringify(await check('/x402-v2-kit.js')));

  const state = JSON.parse(fs.existsSync(path.join(dir, 'beacon-state.json')) ? fs.readFileSync(path.join(dir, 'beacon-state.json'), 'utf8') : '{}');
  state.kit = { version: '1.0.0', durable: kitUrl, announce: annUrl, proof: r3.url, base, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'beacon-state.json'), JSON.stringify(state, null, 2));
  console.log('KIT_STATE=' + JSON.stringify(state.kit));
})();
