// facilitator.js v3 — EIP-3009 settlement with DETERMINISTIC, IDEMPOTENT broadcast.
//
// THE ROLE: a signature is not money. Somebody must submit transferWithAuthorization() on-chain
// and pay the gas. That is the facilitator. I hold ETH on Base, so I am the facilitator.
//
// DEFECTS FIXED (observed in production, 2026-09-26):
//   (a) ethers' FallbackProvider(quorum:1) gave inconsistent reads and `invalid numeric value`
//       on broadcast. Replaced with an EXPLICIT provider pool under my own control.
//   (b) A broadcast that reported an error had ACTUALLY LANDED on-chain: the next attempt was
//       refused with "FiatTokenV2: authorization is used or canceled". A paying customer was
//       turned away because I misread a network hiccup as a failure. Fixed by signing the
//       transaction LOCALLY and precomputing its hash, so the result is knowable regardless of
//       what any RPC says. If the nonce is consumed on-chain, the payment IS settled.
//
// Guarantees enforced here:
//   1. Signature MUST recover to `from` (caller binding; a txHash cannot do this).
//   2. Recipient + amount MUST match the advertised challenge; underpayment is refused.
//   3. Validity window enforced with clock skew.
//   4. On-chain nonce state => native replay defense.
//   5. The exact call is SIMULATED before any gas is spent.
//   6. Gas price bounded; transaction signed locally; the private key is never logged.
//   7. Idempotent settlement: a lost broadcast response can never lose a real payment.

'use strict';
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');

const USDC = process.env.USDC_BASE || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const MAX_GAS_PRICE_GWEI = parseFloat(process.env.FACILITATOR_MAX_GWEI || '5');
const RECEIPT_TIMEOUT_MS = parseInt(process.env.FACILITATOR_RECEIPT_TIMEOUT_MS || '90000', 10);

const RPC_LIST = (process.env.BASE_RPCS || [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://1rpc.io/base',
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];
const IFACE = new ethers.Interface(ABI);

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

function domain() {
  return { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
}

// ---------------- provider pool (explicit, mine) ----------------

const _pool = [];
function pool() {
  if (_pool.length) return _pool;
  for (const url of RPC_LIST) {
    try {
      _pool.push(new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 }));
    } catch (e) { /* skip */ }
  }
  if (!_pool.length) throw new Error('no_rpc_endpoints');
  return _pool;
}
function newProvider() { return pool()[0]; }

const TRANSIENT = /missing revert data|CALL_EXCEPTION|timeout|TIMEDOUT|ECONNRESET|ECONNREFUSED|rate|429|503|502|504|network|fetch failed|no backend|coalesce|invalid numeric value|cannot estimate|server error|bad gateway/i;

/** Try the same read on every endpoint until one answers. Logic reverts (with data) are rethrown. */
async function readWithFailover(fn) {
  let lastErr;
  const providers = pool();
  for (let round = 0; round < 2; round++) {
    for (const p of providers) {
      try { return await fn(p); }
      catch (e) {
        lastErr = e;
        const msg = String((e && (e.shortMessage || e.message)) || e);
        if (e && e.data && !/missing revert data/i.test(msg) && !/CALL_EXCEPTION/i.test(msg)) throw e;
        if (!TRANSIENT.test(msg)) throw e;
      }
    }
    await new Promise(r => setTimeout(r, 600));
  }
  throw lastErr;
}

// ---------------- signing ----------------

async function signAuthorization(wallet, payload) {
  const msg = {
    from: payload.from, to: payload.to, value: String(payload.value),
    validAfter: String(payload.validAfter), validBefore: String(payload.validBefore),
    nonce: payload.nonce,
  };
  const sig = typeof wallet.signTypedData === 'function'
    ? await wallet.signTypedData(domain(), TYPES, msg)
    : await wallet._signTypedData(domain(), TYPES, msg);
  return Object.assign({ payload: msg, signature: sig }, splitSig(sig));
}

function splitSig(sig) {
  if (ethers.Signature && typeof ethers.Signature.from === 'function') {
    const s = ethers.Signature.from(sig);
    return { v: s.v, r: s.r, s: s.s };
  }
  const s = ethers.utils.splitSignature(sig);
  return { v: s.v, r: s.r, s: s.s };
}

async function recoverSigner(payload, signature) {
  const msg = {
    from: payload.from, to: payload.to, value: String(payload.value),
    validAfter: String(payload.validAfter), validBefore: String(payload.validBefore),
    nonce: payload.nonce,
  };
  return typeof ethers.verifyTypedData === 'function'
    ? ethers.verifyTypedData(domain(), TYPES, msg, signature)
    : ethers.utils.verifyTypedData(domain(), TYPES, msg, signature);
}

// ---------------- wallet ----------------

function loadWallet(provider) {
  const candidates = [
    path.join(process.cwd(), '..', '.automaton', 'wallet.json'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.automaton', 'wallet.json'),
    path.join(process.cwd(), 'wallet.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const pk = raw.privateKey || raw.private_key || raw.key || (raw.wallet && raw.wallet.privateKey);
      if (pk && /^0x[0-9a-fA-F]{64}$/.test(pk)) return { wallet: new ethers.Wallet(pk, provider), source: p };
    } catch (e) { /* next */ }
  }
  throw new Error('wallet_not_found');
}

// ---------------- settlement ----------------

async function nonceIsUsed(from, nonce) {
  try {
    const res = await readWithFailover(async (p) => {
      const c = new ethers.Contract(USDC, ABI, p);
      return await c.authorizationState(from, nonce);
    });
    return !!res;
  } catch (e) { return null; } // unknown
}

async function waitForReceipt(txHash, timeoutMs = RECEIPT_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const p of pool()) {
      try {
        const r = await p.getTransactionReceipt(txHash);
        if (r) return r;
      } catch (e) { /* try next */ }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

async function settleAuthorization(input, opts = {}) {
  const { wallet, source } = opts.wallet
    ? { wallet: opts.wallet, source: 'injected' }
    : loadWallet(newProvider());
  const payload = input.payload || input;
  const signature = input.signature;
  const minUnits = opts.minUnits != null ? BigInt(opts.minUnits) : 0n;
  const expectedTo = (opts.to || payload.to || '').toLowerCase();

  for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
    if (payload[k] === undefined || payload[k] === null) return { ok: false, reason: 'missing_' + k };
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(String(signature || ''))) return { ok: false, reason: 'bad_signature_shape' };

  // 1. caller binding
  let signer;
  try { signer = await recoverSigner(payload, signature); }
  catch (e) { return { ok: false, reason: 'signature_unrecoverable' }; }
  if (String(signer).toLowerCase() !== String(payload.from).toLowerCase()) {
    return { ok: false, reason: 'signature_not_from_payer', recovered: signer };
  }

  // 2. recipient binding
  if (expectedTo && String(payload.to).toLowerCase() !== expectedTo) return { ok: false, reason: 'wrong_recipient' };

  // 3. amount
  const value = BigInt(payload.value);
  if (value < minUnits) return { ok: false, reason: 'underpaid', value: value.toString(), minUnits: minUnits.toString() };

  // 4. validity window
  const now = Math.floor(Date.now() / 1000);
  const va = Number(payload.validAfter), vb = Number(payload.validBefore);
  if (Number.isFinite(va) && now < va - 5) return { ok: false, reason: 'not_yet_valid', now, validAfter: va };
  if (Number.isFinite(vb) && now > vb + 5) return { ok: false, reason: 'expired', now, validBefore: vb };

  // 5. on-chain replay defense
  const used = await nonceIsUsed(payload.from, payload.nonce);
  if (used === true) return { ok: false, reason: 'nonce_already_used' };
  if (used === null) {
    // RPC blind. We can still proceed safely: a consumed nonce cannot be re-used on-chain, and
    // the contract itself will revert if it is. Never deny a paying customer for our own blindness.
  }

  const { v, r, s } = splitSig(signature);

  // 6. simulate the exact call before spending gas
  try {
    await readWithFailover(async (p) => {
      const c = new ethers.Contract(USDC, ABI, p);
      return await c.transferWithAuthorization.staticCall(
        payload.from, payload.to, value, va, vb, payload.nonce, v, r, s);
    });
  } catch (e) {
    const m = String(e.shortMessage || e.message);
    if (/authorization is used or canceled/i.test(m)) return { ok: false, reason: 'nonce_already_used' };
    return { ok: false, reason: 'simulation_reverted:' + m.slice(0, 160) };
  }

  // 7. gas
  const fee = await readWithFailover((p) => p.getFeeData());
  const maxFee = fee.maxFeePerGas || fee.gasPrice;
  if (maxFee && Number(ethers.formatUnits(maxFee, 'gwei')) > MAX_GAS_PRICE_GWEI) {
    return { ok: false, reason: 'gas_price_too_high', gwei: Number(ethers.formatUnits(maxFee, 'gwei')) };
  }
  const usdcC = new ethers.Contract(USDC, ABI, newProvider());
  let gasLimit;
  try {
    const est = await readWithFailover((p) => new ethers.Contract(USDC, ABI, p).transferWithAuthorization.estimateGas(
      payload.from, payload.to, value, va, vb, payload.nonce, v, r, s));
    gasLimit = (est * 130n) / 100n;
  } catch (e) {
    const m = String(e.message);
    if (/authorization is used or canceled/i.test(m)) return { ok: false, reason: 'nonce_already_used' };
    return { ok: false, reason: 'gas_estimate_failed:' + m.slice(0, 130) };
  }

  const payerEth = await readWithFailover((p) => p.getBalance(wallet.address));
  const worstCase = gasLimit * (maxFee || 1000000000n);
  if (payerEth < worstCase) {
    return { ok: false, reason: 'facilitator_out_of_gas', have: payerEth.toString(), need: worstCase.toString() };
  }

  // 8. build + SIGN LOCALLY (so the tx hash is known regardless of any RPC)
  const data = IFACE.encodeFunctionData('transferWithAuthorization',
    [payload.from, payload.to, value, va, vb, payload.nonce, v, r, s]);
  const nonce = await readWithFailover((p) => p.getTransactionCount(wallet.address, 'pending'));
  const txReq = { to: USDC, data, chainId: CHAIN_ID, nonce, value: 0n, gasLimit };
  if (fee.maxFeePerGas) {
    txReq.type = 2;
    txReq.maxFeePerGas = fee.maxFeePerGas;
    txReq.maxPriorityFeePerGas = fee.maxPriorityFeePerGas || ethers.parseUnits('0.001', 'gwei');
  } else {
    txReq.type = 0;
    txReq.gasPrice = fee.gasPrice || ethers.parseUnits('1', 'gwei');
  }
  const signedTx = await wallet.signTransaction(txReq);
  const txHash = ethers.keccak256(signedTx);

  // 9. broadcast to every endpoint until one accepts (same signed tx => idempotent)
  let broadcastErr = null;
  let accepted = false;
  for (let round = 0; round < 3 && !accepted; round++) {
    for (const p of pool()) {
      try { await p.broadcastTransaction(signedTx); accepted = true; break; }
      catch (e) {
        const m = String(e.shortMessage || e.message);
        if (/already known|already imported|nonce too low|replacement transaction|known transaction/i.test(m)) { accepted = true; break; }
        broadcastErr = m;
      }
    }
    if (!accepted) await new Promise(r => setTimeout(r, 800));
  }

  // 10. resolve the outcome from CHAIN state, not from the RPC's opinion
  let receipt = await waitForReceipt(txHash);
  if (!receipt) {
    const nowUsed = await nonceIsUsed(payload.from, payload.nonce);
    if (nowUsed === true) {
      // The authorization is consumed: the money MOVED. Report settlement honestly.
      return {
        ok: true, txHash, blockNumber: null, gasUsed: null, facilitator: wallet.address,
        facilitatorKeySource: source, receiptPending: true,
        note: 'nonce consumed on-chain; receipt not yet observed',
        settled: { from: payload.from, to: payload.to, value: value.toString(), nonce: payload.nonce },
      };
    }
    return { ok: false, reason: 'receipt_timeout', txHash, broadcastError: broadcastErr };
  }

  const confirmed = receipt.status === 1 || receipt.status === '0x1' || receipt.status === true;
  if (!confirmed) return { ok: false, reason: 'tx_reverted', txHash, status: receipt.status };

  return {
    ok: true, txHash, blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : null,
    facilitator: wallet.address, facilitatorKeySource: source,
    settled: { from: payload.from, to: payload.to, value: value.toString(), nonce: payload.nonce },
  };
}

async function usdcBalance(addr) {
  return await readWithFailover(async (p) => {
    const c = new ethers.Contract(USDC, ABI, p);
    return await c.balanceOf(addr);
  });
}

module.exports = {
  settleAuthorization, signAuthorization, recoverSigner, splitSig, usdcBalance,
  loadWallet, newProvider, readWithFailover, nonceIsUsed, domain, TYPES, USDC, CHAIN_ID, RPC_LIST,
};
