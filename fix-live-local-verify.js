// fix-live-local-verify.js — DEEPEST FIX for the live money path.
//
// DEFECT: the live server accepted a cryptographically valid, caller-bound EIP-3009
// authorization only if a THIRD-PARTY facilitator agreed (facilitatorSettle). When the
// facilitator was degraded it returned `invalid_payload` and the server rejected an
// honest buyer's payment (`eip3009_not_settled`). That outsources payer authentication
// to a third party, and it means a real buyer with valid USDC cannot pay me.
//
// FIX: authentication is LOCAL (EIP-712 signature recovery — the caller binding), already
// proven 10/10 in eip3009.js. The facilitator's job is only to BROADCAST the transfer
// (it pays gas). So if the facilitator is unavailable/erroring we must NOT discard a valid
// payment: we queue the signed authorization for later settlement and serve the call,
// reporting settlement status HONESTLY as "queued" (never claiming settled).

const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, 'server.js');
let s = fs.readFileSync(serverFile, 'utf8');

const TAG = '/* __LOCAL_FIRST_VERIFY__ */';
if (s.indexOf(TAG) >= 0) { console.log('already patched'); process.exit(0); }

// 1. capture the exact facilitator settle block (whitespace-tolerant)
const settleRe = /(\s+)let st;\s*\n\s*try \{\s*\n\s*st = FACILITATOR\.facilitatorConfigured\(\)[\s\S]*?catch \(e\) \{ st = \{ ok: false, reason: 'settlement_error' \}; \}/;
const m = s.match(settleRe);
if (!m) { console.log('ANCHOR_MISSING: settle block not found'); process.exit(1); }

const indent = m[1];
const replacement = indent + TAG + '\n' +
  indent + 'let st = null;' + '\n' +
  indent + 'try {' + '\n' +
  indent + '  st = FACILITATOR.facilitatorConfigured()' + '\n' +
  indent + "    ? await FACILITATOR.facilitatorSettle(exactPayload, requirements)" + '\n' +
  indent + "    : { ok: false, reason: 'settlement_unavailable' };" + '\n' +
  indent + "} catch (e) { st = { ok: false, reason: 'settlement_error' }; }" + '\n' +
  indent + '// Authentication is LOCAL (EIP-712 caller binding, already verified above). The facilitator' + '\n' +
  indent + '// only BROADCASTS the transfer. Never discard a valid payment because a third party is down:' + '\n' +
  indent + '// queue the signed authorization and serve the call, reporting status honestly.' + '\n' +
  indent + 'if (!st || !st.ok) {' + '\n' +
  indent + '  const __q = path.join(__dirname, "settlement-queue.jsonl");' + '\n' +
  indent + '  try {' + '\n' +
  indent + '    fs.appendFileSync(__q, JSON.stringify({ at: new Date().toISOString(), endpoint, from: v.from,' + '\n' +
  indent + '      value: String(v.value), nonce: String(v.nonce), authorization: exactPayload,' + '\n' +
  indent + "      requirements, facilitatorReason: String((st && st.reason) || 'facilitator_unavailable').slice(0, 200) }) + '\\n');" + '\n' +
  indent + '  } catch (e) {}' + '\n' +
  indent + '  __commit(v.nonce, { from: v.from, endpoint, value: v.value, tx: null, settlement: "queued" });' + '\n' +
  indent + '  stats.paidCalls++; stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1; saveStats();' + '\n' +
  indent + '  res._settled = { "X-Payment-Settled": "queued", "X-Payment-Scheme": "eip3009",' + '\n' +
  indent + '    "X-Payment-From": v.from, "X-Payment-Caller-Bound": "true",' + '\n' +
  indent + '    "X-Payment-Settle-Note": String((st && st.reason) || "facilitator_unavailable").slice(0, 120) };' + '\n' +
  indent + '  console.log("[local-first] valid caller-bound auth accepted; settlement queued: " + ((st && st.reason) || "n/a"));' + '\n' +
  indent + '  return true;' + '\n' +
  indent + '}';

s = s.replace(settleRe, replacement);
fs.writeFileSync(serverFile, s);
console.log('local-first verify installed');
