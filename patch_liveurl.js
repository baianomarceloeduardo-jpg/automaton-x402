#!/usr/bin/env node
// patch_liveurl.js - make discovery routes always serve the CURRENT public base URL.
// Fixes the root cause of listing rot: bazaar.json on disk holds a stale URL.
// Idempotent. Backs up to server.js.bak6.
'use strict';
const fs = require('fs');
const P = 'server.js';
let s = fs.readFileSync(P, 'utf8');
const before = s;

// 1) Inject a helper that overlays the live base URL onto any listing object.
if (!s.includes('function liveListing(')) {
  const helper = `
// --- live listing overlay: listings must NEVER carry a stale public URL ---
function liveListing(obj) {
  try {
    const b = base();
    const out = Object.assign({}, obj);
    out.baseUrl = b;
    out.health = b + '/health';
    out.pricing = b + '/pricing';
    out.x402 = b + '/.well-known/x402';
    out.probe = b + '/v1/x402-probe?url=<target>';
    out.updatedAt = new Date().toISOString();
    if (Array.isArray(out.endpoints)) {
      out.endpoints = out.endpoints.map(e => Object.assign({}, e, e.path ? { url: b + e.path } : {}));
    }
    return out;
  } catch (e) { return obj; }
}
`;
  s = s.replace(/(function base\(\) \{[^\n]*\n)/, '$1' + helper);
  console.log(s.includes('function liveListing(') ? '+ liveListing() injected' : '! liveListing injection FAILED');
}

// 2) Wrap the bazaar file read with the live overlay.
const oldBazaar = `      const b = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'bazaar.json'), 'utf8'));`;
if (s.includes(oldBazaar)) {
  const newBazaar = `      const b = liveListing(JSON.parse(fs.readFileSync(require('path').join(__dirname, 'bazaar.json'), 'utf8')));`;
  s = s.replace(oldBazaar, newBazaar);
  console.log('+ bazaar route now serves live URL');
} else if (s.includes('liveListing(JSON.parse')) {
  console.log('= bazaar route already patched');
} else {
  console.log('! bazaar anchor not found');
}

// 3) Same for the bazaarManifest() builder.
if (s.includes('function bazaarManifest() {')) {
  s = s.replace(/return send\(res, 200, bazaarManifest\(\)\)/, 'return send(res, 200, liveListing(bazaarManifest()))');
  console.log('+ bazaarManifest route overlaid');
}

if (s !== before) { fs.writeFileSync(P + '.bak6', before); fs.writeFileSync(P, s); console.log('WROTE server.js'); }
else console.log('NO CHANGE');
