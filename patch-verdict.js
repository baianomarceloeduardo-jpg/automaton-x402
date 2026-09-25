// patch-verdict.js - fix the PARTIAL misfire in x402-conformance-v2.js
'use strict';
const fs = require('fs');
const P = 'x402-conformance-v2.js';
let s = fs.readFileSync(P, 'utf8');
const anchor = "  const verdict = failed === 0 ? 'CONFORMANT' : (passed >= checks.length - 2 ? 'PARTIAL' : 'NON_CONFORMANT');";
if (s.indexOf(anchor) < 0) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
const replacement = [
  "  // MONEY-CRITICAL checks: if a challenge cannot name a valid payer target or a real",
  "  // price, it is NOT 'partially conformant' -- it is unusable. An 8/9 must not read as near-pass.",
  "  const CRITICAL = ['accepts_array_nonempty', 'scheme_present', 'network_settlement_valid',",
  "    'asset_valid_erc20_address', 'payto_valid_address', 'amount_positive_integer'];",
  "  const criticalFailed = checks.some(c => CRITICAL.indexOf(c.name) >= 0 && !c.ok);",
  "  const verdict = failed === 0 ? 'CONFORMANT' : (criticalFailed ? 'NON_CONFORMANT' : 'PARTIAL');"
].join('\n');
s = s.replace(anchor, replacement);
fs.writeFileSync(P, s);
console.log('verdict logic patched');
