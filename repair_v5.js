'use strict';
// repair_v5.js — remove duplicated v0.5.0 insertions caused by a double patch run.
// Deterministic, idempotent: safe to run repeatedly.
const fs = require('fs');
const P = 'C:/root/value-api/server.js';
let s = fs.readFileSync(P, 'utf8');
const log = [];
function count(needle) { let n = 0, i = 0; while ((i = s.indexOf(needle, i)) !== -1) { n++; i += needle.length; } return n; }
function nth(needle, n) { let i = -1; for (let k = 0; k <= n; k++) { i = s.indexOf(needle, i + 1); if (i === -1) return -1; } return i; }

const MARK = '// ---------- Merkle batch attestations (v0.5.0) ----------';
const ANCH = '// ---------- x402 on-chain verification ----------';
const ROUTE = "  if (p === '/v2/batch') {";
const UTIL  = '  if (PAID_UTIL.includes(p)) {';
const ATTESTPRICE = "{ path: '/v2/attest', method: 'GET|POST', priceUsdc: PRICE_USDC, params: { data: 'string (or {\"data\":\"...\"})' }, returns: 'signed, hash-chained attestation entry' },";
const BATCHPRICE  = "{ path: '/v2/batch', method: 'POST', priceUsdc: PRICE_USDC, params: { items: 'string[] (max 1000)' }, returns: 'ONE signed merkle root committing all items; free inclusion proofs via /v2/proof' }";

log.push('before: MARK=' + count(MARK) + ' ANCH=' + count(ANCH) + ' ROUTE=' + count(ROUTE) + ' UTIL=' + count(UTIL) + ' BATCHPRICE=' + count(BATCHPRICE));

// 1) helper block duplication: keep first MARK..ANCH region, drop the second
if (count(MARK) > 1) {
  const m2 = nth(MARK, 1);            // start of 2nd marker
  const aLast = s.lastIndexOf(ANCH);  // the single trailing anchor
  if (m2 > 0 && aLast > m2) { s = s.slice(0, m2) + s.slice(aLast); log.push('dedup: removed duplicate helper block [' + m2 + ',' + aLast + ')'); }
}

// 2) routes duplication: keep first ROUTE..UTIL region, drop the second
if (count(ROUTE) > 1) {
  const r2 = nth(ROUTE, 1);
  const uLast = s.lastIndexOf(UTIL);
  if (r2 > 0 && uLast > r2) { s = s.slice(0, r2) + s.slice(uLast); log.push('dedup: removed duplicate route block [' + r2 + ',' + uLast + ')'); }
}

// 3) pricing entry duplication
while (true) {
  const needle = BATCHPRICE + ',\n    ' + BATCHPRICE;
  if (s.indexOf(needle) === -1) break;
  s = s.replace(needle, BATCHPRICE);
  log.push('dedup: merged duplicated pricing entry');
}
// also tolerate ',\n    ' vs ',\n\t'
while (s.indexOf(BATCHPRICE + ',\n\t' + BATCHPRICE) !== -1) { s = s.replace(BATCHPRICE + ',\n\t' + BATCHPRICE, BATCHPRICE); log.push('dedup: merged duplicated pricing entry (tab)'); }

fs.writeFileSync(P, s);
log.push('after: MARK=' + count(MARK) + ' ANCH=' + count(ANCH) + ' ROUTE=' + count(ROUTE) + ' UTIL=' + count(UTIL) + ' BATCHPRICE=' + count(BATCHPRICE) + ' BATCH_DIR=' + count('const BATCH_DIR') + ' VERSION_050=' + count("const VERSION = '0.5.0';"));
console.log(log.join('\n'));
