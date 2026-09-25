'use strict';
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'server.js');
let s = fs.readFileSync(target, 'utf8');
const original = s;

// 1. Safe Key Isolation
if (s.includes("const KEY_FILE    = path.join(__dirname, 'attestation_key.pem');")) {
  s = s.replace(
    "const KEY_FILE    = path.join(__dirname, 'attestation_key.pem');",
    "const KEY_DIR     = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.automaton', 'keys');\n" +
    "try { if (!fs.existsSync(KEY_DIR)) fs.mkdirSync(KEY_DIR, { recursive: true }); } catch (e) {}\n" +
    "const KEY_FILE    = process.env.ATTESTATION_KEY_PATH || path.join(KEY_DIR, 'attestation_key.pem');"
  );
  console.log('[1/5] Key isolation path configured.');
}

// 2. Strict TRUST_MODE (only in test environment)
if (s.includes("const TRUST_MODE = process.env.TRUST_MODE === '1';")) {
  s = s.replace(
    "const TRUST_MODE = process.env.TRUST_MODE === '1';",
    "const TRUST_MODE = process.env.TRUST_MODE === '1' && process.env.NODE_ENV === 'test';"
  );
  console.log('[2/5] TRUST_MODE hardened.');
}

// 3. CF-Connecting-IP header for anti-spoofing behind Cloudflare
if (s.includes("function clientIp(req) {\n  const f = req.headers['x-forwarded-for'];")) {
  s = s.replace(
    "function clientIp(req) {\n  const f = req.headers['x-forwarded-for'];",
    "function clientIp(req) {\n  const cf = req.headers['cf-connecting-ip'];\n  if (cf) return String(cf).trim();\n  const f = req.headers['x-forwarded-for'];"
  );
  console.log('[3/5] clientIp hardened with CF-Connecting-IP.');
}

// 4. Double-spend race condition fix in authorize()
const oldAuth = `async function authorize(req, res, endpoint) {
  const tx = req.headers['x-payment'] || '';
  if (tx) {
    const v = await verifyPayment(String(tx).trim());
    if (!v.ok) { stats.rejected++; saveStats(); send(res, 402, { error: 'payment_invalid', reason: v.reason, detail: v }); return false; }
    const key = String(tx).trim().toLowerCase();
    spentTx.add(key); saveSpent();
    stats.paidCalls++; stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1; saveStats();
    res._settled = { 'X-Payment-Settled': 'true', 'X-Payment-Tx': key, 'X-Payment-From': v.from || 'trust_mode' };
    return true;
  }`;

const newAuth = `async function authorize(req, res, endpoint) {
  const tx = req.headers['x-payment'] || '';
  if (tx) {
    const key = String(tx).trim().toLowerCase();
    if (spentTx.has(key)) {
      stats.rejected++; saveStats();
      send(res, 402, { error: 'payment_invalid', reason: 'tx_already_used' });
      return false;
    }
    // Optimistic lock to prevent concurrent double-spends
    spentTx.add(key);
    const v = await verifyPayment(key);
    if (!v.ok) {
      spentTx.delete(key);
      stats.rejected++; saveStats();
      send(res, 402, { error: 'payment_invalid', reason: v.reason, detail: v });
      return false;
    }
    saveSpent();
    stats.paidCalls++; stats.byEndpoint[endpoint] = (stats.byEndpoint[endpoint] || 0) + 1; saveStats();
    res._settled = { 'X-Payment-Settled': 'true', 'X-Payment-Tx': key, 'X-Payment-From': v.from || 'trust_mode' };
    return true;
  }`;

if (s.includes(oldAuth)) {
  s = s.replace(oldAuth, newAuth);
  console.log('[4/5] Double-spend race condition fixed in authorize().');
}

// 5. Oracle integrity disclosure (Constitution Law I)
if (s.includes("const drift = Math.sin(now / 60000) * 5;\n  return {\n    ETH:")) {
  s = s.replace(
    "const drift = Math.sin(now / 60000) * 5;\n  return {\n    ETH:",
    "const drift = Math.sin(now / 60000) * 5;\n  return {\n    _integrity: { mode: 'SIMULATED_DEMO_REBUILD_IN_PROGRESS', notice: 'Conway Law I: On-chain Uniswap V3 / Aerodrome TWAP integration in progress', verifiedOnChain: false },\n    ETH:"
  );
  console.log('[5/5] Oracle integrity notice added.');
}

if (s !== original) {
  fs.writeFileSync(target + '.bak_sec', original, 'utf8');
  fs.writeFileSync(target, s, 'utf8');
  console.log('SUCCESS: server.js patched with Phase 0 security hardening.');
} else {
  console.log('NOTICE: No changes applied (patterns may already be updated or changed).');
}
