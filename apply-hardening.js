// apply-hardening.js - wire the hardened verifier into the live server, safely & reversibly.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const DIR = __dirname;

function must(cond, msg) { if (!cond) { console.error('PATCH_ABORT: ' + msg); process.exit(1); } }

// ---- 1. add payer tracking to the hardened verifier (for the X-Payment-From header) ----
const H = path.join(DIR, 'pay-verify-hardened.js');
let h = fs.readFileSync(H, 'utf8');
if (!h.includes('payerAmt')) {
  const before = h;
  h = h.replace('        let net = 0n, sawTo = false;',
                '        let net = 0n, sawTo = false, payer = null, payerAmt = 0n;');
  h = h.replace('          if (to === PAY_TO) { net += v; sawTo = true; }',
                '          if (to === PAY_TO) { net += v; sawTo = true; if (v > payerAmt) { payerAmt = v; payer = from; } }');
  h = h.replace('          ok: true, tx, amount: net.toString(), confirmations: conf,',
                '          ok: true, tx, from: payer, amount: net.toString(), confirmations: conf,');
  must(h !== before && h.includes('payerAmt') && h.includes('payer = from'), 'payer tracking replace failed');
  fs.writeFileSync(H, h);
  console.log('hardened: payer tracking added');
} else { console.log('hardened: payer tracking already present'); }

// ---- 2. overlay onto server.js (append is safe: routes resolve verifyPayment at request time) ----
const S = path.join(DIR, 'server.js');
let s = fs.readFileSync(S, 'utf8');
const MARK = '/* __HARDENING_OVERLAY__ */';
if (!s.includes(MARK)) {
  fs.writeFileSync(S + '.bak8', s); // reversible
  const overlay = [
    '',
    MARK,
    "// Sentinela audit remediations (P0 replay/bearer, P1 hex-status/chain/log-sum, P2 rpc-consensus).",
    "const __hv = require('./pay-verify-hardened.js');",
    "const __verifier = __hv.createVerifier({",
    "  payTo: PAY_TO,",
    "  rpcUrls: [ (typeof BASE_RPC_URL !== 'undefined' && BASE_RPC_URL) ? BASE_RPC_URL : 'https://mainnet.base.org' ],",
    "  confirmations: (typeof MIN_CONFIRMATIONS !== 'undefined' ? Number(MIN_CONFIRMATIONS) : 3),",
    "  minUnits: BigInt(PRICE_BASE_UNITS),",
    "  storeFile: __dirname + '/used-txs.jsonl'",
    "});",
    "verifyPayment = async function (txHash) {",
    "  const r = await __verifier.verify(txHash);",
    "  if (r && r.ok && !r.from) r.from = 'verified';",
    "  return r;",
    "};",
    MARK,
    ''
  ].join('\n');
  fs.writeFileSync(S, s + overlay);
  console.log('server.js: overlay appended (backup server.js.bak8)');
} else { console.log('server.js: overlay already present'); }

// ---- 3. syntax check ----
try { execSync('node --check "' + S + '"', { stdio: 'inherit' }); console.log('syntax OK: server.js'); }
catch (e) { console.error('SYNTAX FAIL server.js'); process.exit(1); }

// ---- 4. re-run the attack suite against the (now payer-aware) module ----
try {
  const out = execSync('node "' + H + '"', { encoding: 'utf8' });
  const line = out.trim().split('\n').filter(l => /PASS$|FAIL$/.test(l.trim())).pop() || '';
  console.log('attack-suite: ' + out.trim().split('\n').pop());
} catch (e) { console.error('ATTACK SUITE FAILED'); process.exit(1); }
console.log('HARDENING_APPLIED');
