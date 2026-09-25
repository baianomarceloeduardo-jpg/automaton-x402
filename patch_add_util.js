#!/usr/bin/env node
// patch_add_util.js - add the FREE /v1/verify-payment utility route to server.js (idempotent).
'use strict';
const fs = require('fs');
const P = 'server.js';
let s = fs.readFileSync(P, 'utf8');
const before = s;

// 1) require the module once
if (!s.includes("require('./payment-verify.js')")) {
  s = s.replace(/(const http = require\('http'\);?)/, "$1\nconst { verifyTransfer } = require('./payment-verify.js');");
  if (!s.includes("require('./payment-verify.js')")) {
    s = s.replace(/(const https = require\('https'\);?)/, "$1\nconst http = require('http');\nconst { verifyTransfer } = require('./payment-verify.js');");
  }
  console.log(s.includes("require('./payment-verify.js')") ? '+ required payment-verify.js' : '! could not inject require');
} else { console.log('= require already present'); }

// 2) inject the route just before /v2/verify (which is a proven free route)
const anchor = "  if (p === '/v2/verify') {";
const route = `  if (p === '/v1/verify-payment') {
    const q = new URL(req.url, 'http://x');
    const txHash = q.searchParams.get('tx') || q.searchParams.get('txHash') || '';
    const asset = q.searchParams.get('asset') || undefined;
    const to = q.searchParams.get('to') || undefined;
    let minAmount = 0n; try { minAmount = BigInt(q.searchParams.get('minAmount') || q.searchParams.get('amount') || '0'); } catch (e) {}
    let minConf; const mc = q.searchParams.get('confirmations'); if (mc !== null) { const n = parseInt(mc, 10); if (!isNaN(n)) minConf = n; }
    const vr = await verifyTransfer({ txHash, asset, to, minAmount, minConfirmations: minConf });
    return send(res, 200, vr, res._settled);
  }
`;
if (!s.includes("p === '/v1/verify-payment'")) {
  if (s.includes(anchor)) { s = s.replace(anchor, route + anchor); console.log('+ /v1/verify-payment route injected'); }
  else {
    // fallback anchor: first 'if (p === '
    const m = s.match(/^\s*if \(p === '[^']+'\) \{/m);
    if (m) { s = s.replace(m[0], route + m[0]); console.log('+ route injected at first handler'); }
    else console.log('! no anchor found for route');
  }
} else { console.log('= route already present'); }

// 3) document it as free
if (s.includes("'/v2/merkle/verify', '/'") && !s.includes("'/v1/verify-payment'")) {
  s = s.replace("'/v2/merkle/verify', '/'", "'/v2/merkle/verify', '/v1/verify-payment', '/'");
  console.log('+ added to free route metadata');
}

if (s !== before) { fs.writeFileSync(P + '.bak2', before); fs.writeFileSync(P, s); console.log('WROTE ' + P); }
else console.log('NO CHANGE');
