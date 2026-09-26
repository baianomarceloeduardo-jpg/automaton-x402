// repair-settler.js — rewrite settleAuthorization cleanly (the earlier patch stacked 5 bare `try {`).
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'local-settler.js');
let lines = fs.readFileSync(F, 'utf8').split(/\r?\n/);

// find the start of settleAuthorization and its closing "}" (the line after the catch block)
let start = lines.findIndex(l => l.startsWith('async function settleAuthorization'));
if (start < 0) { console.log('ANCHOR_MISSING'); process.exit(1); }
let end = lines.findIndex((l, i) => i > start && /^catch \(e\) \{/.test(l));
if (end < 0) { console.log('CATCH_MISSING'); process.exit(1); }
let close = -1;
for (let i = end + 1; i < lines.length; i++) { if (lines[i] === '}') { close = i; break; } }
if (close < 0) { console.log('CLOSE_MISSING'); process.exit(1); }

const FN = [
  '// Broadcast a signed authorization on-chain DIRECTLY (no facilitator). Returns { ok, tx, status, error }.',
  'async function settleAuthorization(auth, opts) {',
  "  const { ethers } = ethersLib();",
  '  opts = opts || {};',
  '  const w = loadWallet();',
  "  if (!w) return { ok: false, error: 'wallet_missing' };",
  '  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);',
  '  const signer = new ethers.Wallet(w.pk, provider);',
  '  const usdc = new ethers.Contract(USDC, ABI, signer);',
  '',
  '  const a = auth.payload && auth.payload.authorization ? auth.payload.authorization : auth;',
  '  const sig = auth.signature || auth.sig;',
  "  if (!a || !sig) return { ok: false, error: 'auth_or_signature_missing' };",
  '',
  '  const sp = ethers.Signature.from(sig);',
  '',
  ...([]),
  '  // Replay guard: never broadcast a nonce already consumed on-chain.',
  '  try {',
  '    const used = await usdc.authorizationState(a.from, a.nonce);',
  "    if (used) return { ok: false, error: 'nonce_already_used_onchain' };",
  '  } catch (e) { /* advisory: do not block on RPC hiccup */ }',
  '',
  '  const gas = opts.gasOverride || {};',
  '  try {',
  '    const tx = await usdc.transferWithAuthorization(',
  '      a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, sp.v, sp.r, sp.s, gas',
  '    );',
  "    console.log('broadcast tx=' + tx.hash);",
  '    const rc = await tx.wait(1);',
  '    const ok = rc && Number(rc.status) === 1;',
  '    return { ok, tx: tx.hash, status: rc && rc.status, block: rc && rc.blockNumber };',
  '  } catch (e) {',
  "    return { ok: false, error: 'broadcast_failed: ' + (e.shortMessage || e.message), code: e.code, tx: (e.transaction && e.transaction.hash) || null };",
  '  }',
  '}',
];

lines = lines.slice(0, start).concat(FN, lines.slice(close + 1));
fs.writeFileSync(F, lines.join('\n'));
console.log('settleAuthorization rewritten cleanly (lines ' + (start + 1) + '-' + (close + 1) + ')');
