// sovereign-settle-overlay.js — replace the third-party facilitator with MY OWN on-chain settler.
//
// PROBLEM (proven on mainnet):
//   facilitator_verify_failed: invalid_payload - contract call failed: unable to call contract: execution reverted
//   x402.org/facilitator is TESTNET-ONLY for mainnet callers. Every money path in server.js
//   (legacy 'exact' txHash, and caller-bound 'eip3009') routes through FACILITATOR.facilitatorSettle.
//   When it fails the eip3009 path degrades to settlement:"queued" and never moves USDC.
//
// FIX: monkey-patch FACILITATOR.facilitatorSettle to broadcast transferWithAuthorization MYSELF
//   via local-settler.js (proven 6/6 on Base mainnet). One patch point fixes all schemes.
//
// The normalizer below is deliberately SHAPE-TOLERANT: I do not control which envelope shape each
// caller builds, and a strict matcher silently degraded to "auth_or_signature_missing" in proof #1.
// It now RECURSIVELY locates the authorization object and its signature anywhere in the payload.

const FACILITATOR = require('./x402-facilitator.js');
const { settleAuthorization } = require('./local-settler.js');

const isAuth = (o) => o && typeof o === 'object'
  && typeof o.from === 'string' && typeof o.to === 'string'
  && o.value !== undefined && o.nonce !== undefined && o.validBefore !== undefined;

// Recursively harvest { any authorization object, any 0x-hex signature string } from an envelope.
function extract(node, acc) {
  acc = acc || { auth: null, sig: null };
  if (!node || typeof node !== 'object') return acc;
  if (typeof node === 'string') { if (!acc.sig && /^0x[0-9a-fA-F]{130}$/.test(node)) acc.sig = node; return acc; }
  if (isAuth(node) && !acc.auth) {
    acc.auth = {
      from: node.from, to: node.to, value: String(node.value),
      validAfter: String(node.validAfter !== undefined ? node.validAfter : 0),
      validBefore: String(node.validBefore), nonce: node.nonce,
    };
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') {
      if (!acc.sig && /^0x[0-9a-fA-F]{130}$/.test(v)) acc.sig = v;
      // x402 sometimes nests the signature as a JSON string
      if (!acc.sig && /^[0-9a-fA-F]{130}$/.test(v)) acc.sig = '0x' + v;
      if ((k === 'signature' || k === 'sig') && !acc.sig && /^0x?[0-9a-fA-F]{130}$/.test(v)) acc.sig = v.startsWith('0x') ? v : '0x' + v;
    } else if (v && typeof v === 'object') extract(v, acc);
  }
  return acc;
}

if (FACILITATOR.__sovereignSettlePatched) {
  console.log('[sovereign-settle] already patched');
} else {
  FACILITATOR.facilitatorConfigured = function () { return true; }; // we ARE the settler

  FACILITATOR.facilitatorSettle = async function (paymentData /*, requirements */) {
    try {
      const got = extract(paymentData);
      if (!got.auth) {
        return { ok: false, reason: 'no_settleable_authorization', shape: Object.keys(paymentData || {}).join(',') };
      }
      if (!got.sig) {
        return { ok: false, reason: 'no_signature_in_envelope' };
      }
      const r = await settleAuthorization({ payload: { authorization: got.auth }, signature: got.sig });
      if (!r || !r.ok) {
        console.log('[sovereign-settle] FAILED reason=' + ((r && r.error) || 'unknown'));
        return { ok: false, reason: 'sovereign_' + ((r && r.error) || 'settle_failed'), tx: (r && r.tx) || null };
      }
      console.log('[sovereign-settle] SETTLED BY MY OWN WALLET tx=' + r.tx + ' block=' + r.block);
      return { ok: true, tx: r.tx, status: r.status, block: r.block, settlement: 'sovereign', facilitator: 'self' };
    } catch (e) {
      console.log('[sovereign-settle] ERROR ' + (e && e.message));
      return { ok: false, reason: 'sovereign_error: ' + ((e && e.shortMessage) || (e && e.message)) };
    }
  };

  FACILITATOR.__sovereignSettlePatched = true;
  FACILITATOR.__extractAuth = extract; // exported for the proof harness
  console.log('[sovereign-settle] overlay active: settlement broadcast by my own wallet (no third-party facilitator)');
}

module.exports = FACILITATOR;
