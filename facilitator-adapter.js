// facilitator-adapter.js — plugs MY local EIP-3009 facilitator into the server's existing
// FACILITATOR seam, so a signed caller-bound authorization is actually BROADCAST on-chain
// instead of being politely queued forever.
//
// WHY: server.js's dual-scheme overlay already verifies the buyer's EIP-712 signature locally
// (real caller binding) and then calls FACILITATOR.facilitatorSettle(payload, requirements).
// With no facilitator configured that returns `settlement_unavailable`, the authorization gets
// written to settlement-queue.jsonl, and the caller is served for free. Every "paid" call would
// be a free call. Now that I hold ETH on Base, I AM the facilitator.
//
// Interface expected by the server: {facilitatorConfigured(), facilitatorSettle(payload, req)}
// Shape returned must include ok + transaction (or tx).
'use strict';

const F = require('./facilitator.js');

let _ready = null;

function facilitatorConfigured() {
  // Configured iff we can load the wallet and reach the chain once. Cached.
  if (_ready !== null) return _ready;
  try {
    const { wallet } = F.loadWallet(F.newProvider());
    _ready = !!(wallet && wallet.address);
  } catch (e) {
    _ready = false;
  }
  return _ready;
}

/** Map the server's x402 payload into the local facilitator's expected input. */
function toLocalInput(payload, requirements) {
  const p = payload && payload.payload ? payload.payload : payload;
  const auth = (p && p.authorization) || p || {};
  const signature = (p && (p.signature || p.sig)) || payload.signature || payload.sig;
  return {
    input: {
      payload: {
        from: auth.from, to: auth.to,
        value: String(auth.value),
        validAfter: String(auth.validAfter),
        validBefore: String(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    },
    payTo: (requirements && requirements.payTo) || auth.to,
    minUnits: BigInt((requirements && requirements.maxAmountRequired) || 0),
  };
}

async function facilitatorSettle(payload, requirements) {
  let mapped;
  try { mapped = toLocalInput(payload, requirements); }
  catch (e) { return { ok: false, reason: 'malformed_payload' }; }

  // Hard requirement: never broadcast an authorization that is not bound to the stated payer.
  if (!mapped.input.signature) return { ok: false, reason: 'missing_signature' };

  try {
    const r = await F.settleAuthorization(mapped.input, {
      minUnits: mapped.minUnits,
      to: mapped.payTo,
    });
    if (!r.ok) return { ok: false, reason: r.reason, detail: r };
    return {
      ok: true,
      transaction: r.txHash,
      tx: r.txHash,
      blockNumber: r.blockNumber,
      gasUsed: r.gasUsed,
      facilitator: r.facilitator,
      scheme: 'eip3009',
      callerBound: true,
    };
  } catch (e) {
    return { ok: false, reason: 'settle_exception:' + String(e.message).slice(0, 160) };
  }
}

module.exports = { facilitatorConfigured, facilitatorSettle, toLocalInput };

if (require.main === module) {
  (async () => {
    console.log('facilitatorConfigured =', facilitatorConfigured());
    try {
      const { wallet } = F.loadWallet(F.newProvider());
      const bal = await F.newProvider().getBalance(wallet.address);
      console.log('facilitator address =', wallet.address);
      console.log('facilitator ETH     =', require('ethers').formatEther(bal));
    } catch (e) { console.log('wallet probe failed:', e.message); }
  })();
}
