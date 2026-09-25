'use strict';
// patch_pubkey.js — add the advertised-but-missing GET /v2/pubkey route (idempotent).
const fs = require('fs');
const P = 'C:/root/value-api/server.js';
let s = fs.readFileSync(P, 'utf8');
const log = [];
function count(n) { let c = 0, i = 0; while ((i = s.indexOf(n, i)) !== -1) { c++; i += n.length; } return c; }

const ANCH = '  if (PAID_UTIL.includes(p)) {';
const ROUTE = `  if (p === '/v2/pubkey') {
    try {
      const pem = crypto.createPublicKey(signingKey).export({ type: 'spki', format: 'pem' });
      return send(res, 200, { keyId, algorithm: 'ECDSA-P256-SHA256', encoding: 'spki-pem', publicKey: pem, verifyUrl: base() + '/v2/verify', ledgerUrl: base() + '/v2/ledger', note: 'Signatures over each ledger entry hash use this key. Verify offline with verify.js.' });
    } catch (e) { return send(res, 500, { error: 'pubkey_unavailable', detail: String(e && e.message) }); }
  }
`;

if (count("if (p === '/v2/pubkey')") > 0) {
  log.push('SKIP: /v2/pubkey handler already present');
} else {
  if (count(ANCH) !== 1) throw new Error('anchor not unique: ' + count(ANCH));
  s = s.replace(ANCH, ROUTE + ANCH);
  log.push('ADDED: /v2/pubkey handler before paid block');
}
// ensure the free-route advertisement list includes it (dedup-safe)
fs.writeFileSync(P, s);
log.push('version=' + (s.match(/const VERSION = '([^']+)'/) || [])[1] + ' bytes=' + s.length);
console.log(log.join('\n'));
