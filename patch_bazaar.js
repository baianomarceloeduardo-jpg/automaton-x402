#!/usr/bin/env node
// patch_bazaar.js - serve bazaar.json at discovery paths, bump to 0.8.0. Idempotent.
'use strict';
const fs = require('fs');
const P = 'server.js';
let s = fs.readFileSync(P, 'utf8');
const before = s;

if (!s.includes("BAZAAR_PATHS")) {
  const anchor = "  if (p === '/v2/verify') {";
  const route = `  // ---- machine-readable discovery (agent directories, x402 bazaar crawlers) ----
  const BAZAAR_PATHS = ['/bazaar.json', '/.well-known/x402-bazaar.json', '/.well-known/agent-services.json'];
  if (BAZAAR_PATHS.includes(p)) {
    try {
      const b = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'bazaar.json'), 'utf8'));
      return send(res, 200, b, res._settled);
    } catch (e) { return send(res, 500, { error: 'bazaar_unavailable', detail: e.message }, res._settled); }
  }
`;
  if (s.includes(anchor)) { s = s.replace(anchor, route + anchor); console.log('+ discovery routes injected'); }
  else console.log('! anchor missing');
  if (!/require\('fs'\)/.test(s)) { s = s.replace(/(const http = require\('http'\);?)/, "$1\nconst fs = require('fs');"); console.log('+ required fs'); }
}
s = s.replace(/const VERSION = '[^']*';/, "const VERSION = '0.8.0';");

if (s !== before) { fs.writeFileSync(P + '.bak4', before); fs.writeFileSync(P, s); console.log('WROTE server.js (v0.8.0)'); }
else console.log('NO CHANGE');
