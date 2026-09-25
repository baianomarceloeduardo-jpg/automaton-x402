#!/usr/bin/env node
// patch_probe.js - add free /v1/x402-probe to server.js; bump to 0.9.0. Idempotent.
'use strict';
const fs = require('fs');
const P = 'server.js';
let s = fs.readFileSync(P, 'utf8');
const before = s;

if (!s.includes("require('./x402-probe.js')")) {
  s = s.replace(/(const fs = require\('fs'\);?)/, "$1\nconst { probeUrl } = require('./x402-probe.js');");
  console.log(s.includes("x402-probe.js") ? '+ required x402-probe.js' : '! require injection failed');
}
if (!s.includes("p === '/v1/x402-probe'")) {
  const anchor = "  if (p === '/v2/verify') {";
  const route = `  // FREE: validate whether any URL is a well-formed x402 service (trust infra for all)
  if (p === '/v1/x402-probe') {
    const q = new URL(req.url, 'http://x');
    const target = q.searchParams.get('url') || q.searchParams.get('target') || '';
    if (!target) return send(res, 400, { error: 'missing_url', usage: '/v1/x402-probe?url=https://host/path' }, res._settled);
    const pr = await probeUrl(target, 15000);
    return send(res, 200, pr, res._settled);
  }
`;
  if (s.includes(anchor)) { s = s.replace(anchor, route + anchor); console.log('+ /v1/x402-probe route injected'); }
  else console.log('! anchor missing');
}
s = s.replace(/const VERSION = '[^']*';/, "const VERSION = '0.9.0';");
if (!s.includes("'/v1/x402-probe'") || !s.includes("'/v1/x402-probe'", s.indexOf('free'))) {
  s = s.replace("'/v2/merkle/verify', '/v1/verify-payment', '/'", "'/v2/merkle/verify', '/v1/verify-payment', '/v1/x402-probe', '/'");
}

if (s !== before) { fs.writeFileSync(P + '.bak5', before); fs.writeFileSync(P, s); console.log('WROTE server.js (v0.9.0)'); }
else console.log('NO CHANGE');
