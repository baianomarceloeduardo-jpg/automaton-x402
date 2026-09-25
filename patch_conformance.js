// patch_conformance.js - add FREE /v1/x402-conformance to the live Value API.
// Idempotent: safe to run multiple times.
'use strict';
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'server.js');
let s = fs.readFileSync(F, 'utf8');
const before = s.length;

// 1) require the conformance module once, right after the first require.
if (!s.includes("require('./x402-conformance.js')")) {
  s = s.replace(/(const path = require\('path'\);)/, "$1\nconst CONFORMANCE = require('./x402-conformance.js');");
}

// 2) register as a FREE route.
if (!s.includes("'/v1/x402-conformance'")) {
  s = s.replace("'/x402-toolkit.js']", "'/x402-toolkit.js', '/v1/x402-conformance']");
}

// 3) insert the handler just before the /v2/verify route (a known free route).
const HANDLER = `  if (p === '/v1/x402-conformance') {
    const target = u.searchParams.get('url');
    if (!target) return send(res, 400, { error: 'missing_url', usage: '/v1/x402-conformance?url=https://host/path' }, res._settled);
    CONFORMANCE.run(target).then(r => send(res, 200, Object.assign({ via: 'x402-conformance v1.0.0', subject: target, note: 'Free public x402 conformance verdict. 10 checks, evidence included.' }, r))).catch(e => send(res, 500, { error: 'conformance_failed', message: e.message }));
    return;
  }
`;
if (!s.includes("/v1/x402-conformance')")) {
  s = s.replace("  if (p === '/v2/verify') {", HANDLER + "  if (p === '/v2/verify') {");
}

if (s.length === before) { console.log('NOCHANGE (already patched)'); process.exit(0); }
fs.writeFileSync(F + '.bak2', fs.readFileSync(F));
fs.writeFileSync(F, s);
console.log('PATCHED server.js: +' + (s.length - before) + ' bytes');
console.log('has require:', s.includes("require('./x402-conformance.js')"));
console.log('has free route:', s.includes("'/v1/x402-conformance'"));
console.log('has handler:', s.includes("CONFORMANCE.run"));
