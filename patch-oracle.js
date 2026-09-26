// patch-oracle.js — wire the multi-RPC consensus oracle into the live paid API.
//
// Source transform, not a monkey-patch: the paid routes are gated inside paid-api.js by
// authorizeAndSettle(), which is module-private. So the honest way to add paid endpoints is to
// extend that file's own PAID_ROUTES list and its dispatch line. Reversible (backup kept),
// idempotent (marker-guarded).
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const TARGET = path.join(DIR, 'paid-api.js');
const MARKER = '/* __ORACLE_WIRED__ */';

let src = fs.readFileSync(TARGET, 'utf8');
if (src.indexOf(MARKER) !== -1) { console.log('[oracle] already wired (no-op)'); process.exit(0); }

const before = src;

// 1. require the oracle module at the top of the file
src = "const __ORACLE = require('./paid-oracle.js'); " + MARKER + "\n" + src;

// 2. extend PAID_ROUTES (tolerate either quote style / spacing)
const routesRe = /const PAID_ROUTES = \[([^\]]*)\];/;
if (!routesRe.test(src)) { console.log('[oracle] FATAL: PAID_ROUTES not found'); process.exit(1); }
src = src.replace(routesRe, (m, inner) => {
  const existing = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const want = ['clock', 'block', 'gas', 'balance', 'nonce'];
  const merged = existing.concat(want.filter(w => !existing.includes(w)));
  console.log('[oracle] PAID_ROUTES: ' + existing.join(',') + ' -> ' + merged.join(','));
  return 'const PAID_ROUTES = ' + JSON.stringify(merged).replace(/"/g, "'") + ';';
});

// 3. dispatch oracle names to paid-oracle.js before falling back to the built-in handler
const dispatchRe = /const out = endpointHandler\(name, q\) \|\| \{ error: 'handler_missing' \};/;
if (!dispatchRe.test(src)) { console.log('[oracle] FATAL: dispatch line not found'); process.exit(1); }
src = src.replace(dispatchRe,
  "const __qs = new URLSearchParams(String(req.url).split('?')[1] || '');\n" +
  "    const out = (__ORACLE.handlers[name] ? await __ORACLE.handlers[name](__qs) : endpointHandler(name, q)) || { error: 'handler_missing' };");

// 4. keep /pricing honest: describe the new endpoints too
src = src.replace("endpoints: PAID_ROUTES.map(r => ({ path: '/paid/' + r, priceUsdc: priceUsdc() })),",
  "endpoints: PAID_ROUTES.map(r => ({ path: '/paid/' + r, priceUsdc: priceUsdc(), description: (__ORACLE.INFO[r] && __ORACLE.INFO[r].description) || undefined, params: (__ORACLE.INFO[r] && __ORACLE.INFO[r].params) || undefined })),");

fs.writeFileSync(path.join(DIR, 'paid-api.js.bak-oracle'), before);
fs.writeFileSync(TARGET, src);
console.log('[oracle] wired: backup paid-api.js.bak-oracle (' + before.length + ' -> ' + src.length + ' bytes)');
