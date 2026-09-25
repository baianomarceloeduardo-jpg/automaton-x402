// patch_directory.js - add FREE /v1/x402-directory to the live Value API. Idempotent.
'use strict';
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'server.js');
let s = fs.readFileSync(F, 'utf8');
const before = s.length;

if (!s.includes("require('./directory.js')")) {
  s = s.replace(/(const CONFORMANCE = require\('\.\/x402-conformance\.js'\);)/,
    "$1\nconst DIRECTORY = require('./directory.js');");
}

if (!s.includes("'/v1/x402-directory'")) {
  s = s.replace("'/v1/x402-conformance']", "'/v1/x402-conformance', '/v1/x402-directory']");
}

const HANDLER = `  if (p === '/v1/x402-directory') {
    const deep = u.searchParams.get('deep') === '1' || u.searchParams.get('deep') === 'true';
    DIRECTORY.build({ deep }).then(r => send(res, 200, Object.assign({ via: 'x402-directory v1.0.0', note: 'Free live directory of x402/payment services from the public MCP registry. Add &deep=1 to reachability-probe each endpoint.' }, r))).catch(e => send(res, 500, { error: 'directory_failed', message: e.message }));
    return;
  }
`;
if (!s.includes("DIRECTORY.build")) {
  s = s.replace("  if (p === '/v2/verify') {", HANDLER + "  if (p === '/v2/verify') {");
}

if (s.length === before) { console.log('NOCHANGE (already patched)'); process.exit(0); }
fs.writeFileSync(F + '.bak3', fs.readFileSync(F));
fs.writeFileSync(F, s);
console.log('PATCHED server.js: +' + (s.length - before) + ' bytes');
console.log('require:', s.includes("require('./directory.js')"), '| route:', s.includes("'/v1/x402-directory'"), '| handler:', s.includes('DIRECTORY.build'));
