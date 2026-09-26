// apply-pricing-live.js — fix: /pricing and /.well-known/x402 served a STATIC PRICING object whose
// baseUrl freezes at boot, so after tunnel rotation those two surfaces advertised a DEAD base URL.
// Fix: serve a per-request copy with baseUrl derived from the live request Host (requestBase(req)).
//
// Idempotent (marker-based, strips and re-appends) and reversible (server.js.bak-pricing backup).
const fs = require('fs');
const { execSync } = require('child_process');

const FILE = 'server.js';
const MARK = '__PRICING_LIVE_OVERLAY__';
const BACKUP = 'server.js.bak-pricing';

let src = fs.readFileSync(FILE, 'utf8');

if (!fs.existsSync(BACKUP)) { fs.copyFileSync(FILE, BACKUP); console.log('backup -> ' + BACKUP); }

// 1. strip any previous overlay (idempotency)
if (src.includes(MARK)) {
  src = src.replace(new RegExp('\\n?// ' + MARK + '[\\s\\S]*?// END ' + MARK + '\\n?', 'g'), '');
  console.log('stripped previous overlay');
}

// 2. the exact static-serving line
const ORIG = "if (p === '/pricing' || p === '/.well-known/x402') return send(res, 200, PRICING);";
const PATCHED = "if (p === '/pricing' || p === '/.well-known/x402') return send(res, 200, __livePricing(req));";

if (!src.includes(ORIG) && !src.includes(PATCHED)) {
  console.log('TARGET LINE NOT FOUND — aborting (file may have changed shape)');
  process.exitCode = 2;
  return;
}
if (src.includes(PATCHED)) { src = src.replace(PATCHED, ORIG); console.log('reverted route line for clean re-apply'); }

const overlay = [
  '',
  '// ' + MARK,
  '// Per-request pricing surface so baseUrl always matches the LIVE host (fixes stale-URL drift',
  '// across tunnel rotation). Falls back to the static object on any error.',
  'function __livePricing(req) {',
  '  try {',
  '    const b = (typeof requestBase === "function") ? requestBase(req) : (PRICING && PRICING.baseUrl) || "";',
  '    if (!b) return PRICING;',
  '    const out = JSON.parse(JSON.stringify(PRICING));',
  '    out.baseUrl = b;',
  '    out.pricingUrl = b + "/pricing";',
  '    out.x402 = b + "/.well-known/x402";',
  '    if (out.pricing && typeof out.pricing === "object") out.pricing.baseUrl = b;',
  '    if (out.service && typeof out.service === "object") out.service.baseUrl = b;',
  '    const fix = (arr) => Array.isArray(arr) ? arr.map(e => (e && typeof e === "object") ? Object.assign({}, e, { url: b + (e.path || e.url || "") }) : e) : arr;',
  '    out.endpoints = fix(out.endpoints);',
  '    out.freeEndpoints = fix(out.freeEndpoints);',
  '    return out;',
  '  } catch (e) { return PRICING; }',
  '}',
  '// END ' + MARK,
  '',
].join('\n');

src = src.replace(ORIG, PATCHED);
src = src.replace(/\n?$/, '\n' + overlay);

fs.writeFileSync(FILE, src);
console.log('overlay applied: /pricing + /.well-known/x402 now derive baseUrl from the live request');

// 3. syntax check
try { execSync('node --check ' + FILE, { stdio: 'pipe' }); console.log('syntax OK'); }
catch (e) { console.log('SYNTAX FAIL — restoring backup'); fs.copyFileSync(BACKUP, FILE); process.exitCode = 3; }
