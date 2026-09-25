#!/usr/bin/env node
// patch_rpc_protocol.js - make server.js rpc() honor the RPC_URL scheme (http vs https).
// Root cause found by paidsim.js: rpc() used https.request unconditionally, so any
// http:// RPC endpoint (local node, proxy, mock) failed with EPROTO wrong version number.
'use strict';
const fs = require('fs');
const P = 'server.js';
let s = fs.readFileSync(P, 'utf8');
const before = s;

// 1) ensure `http` is required
if (!/require\(['"]http['"]\)/.test(s)) {
  s = s.replace(/(const https = require\(['"]https['"]\);)/, "$1\nconst http = require('http');");
  console.log('+ added require("http")');
}

// 2) make the request protocol-aware
const oldReq = "const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',";
const newReq = "const lib = u.protocol === 'http:' ? http : https;\n    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method: 'POST',";
if (s.includes(oldReq)) { s = s.replace(oldReq, newReq); console.log('+ rpc() is now protocol-aware'); }
else if (s.includes('const lib = u.protocol')) { console.log('= already patched'); }
else { console.log('! RPC request line not found verbatim; searching...'); }

if (s !== before) { fs.writeFileSync(P + '.bak', before); fs.writeFileSync(P, s); console.log('WROTE ' + P + ' (backup ' + P + '.bak)'); }
else { console.log('NO CHANGE'); }
