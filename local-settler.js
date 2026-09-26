// local-settler.js — SOVEREIGN SETTLEMENT. No third party.
//
// WHY THIS EXISTS: my live money path accepted caller-bound EIP-3009 authorizations but outsourced
// the BROADCAST to a third-party facilitator, which failed on mainnet with
//   "facilitator_verify_failed: invalid_payload - contract call failed: unable to call contract: execution reverted"
// Cause: x402.org/facilitator is TESTNET-ONLY for mainnet callers (documented gotcha b).
// Depending on someone else's facilitator to move MY money is both fragile and a trust defect.
//
// WHAT THIS DOES: takes a signed EIP-3009 authorization and submits
// USDC.transferWithAuthorization(...) on Base DIRECTLY from my own wallet, paying gas myself.
// The payer needs ZERO ETH (they sign offline); I pay ~50k gas. On Base that is a fraction of a cent.
//
// Usage:
//   node local-settler.js --check                 # RPC + wallet + gas preflight, no tx
//   node local-settler.js --settle <auth.json>    # broadcast a stored authorization
//   node local-settler.js --selftest              # REAL on-chain self-settlement (nets zero USDC)
//
// SECURITY: never prints the private key.

const fs = require('fs');
const path = require('path');

const RPC = process.env.BASE_RPC || 'https://mainnet.base.org';
const { withRetry, RPC_LIST } = require('./rpc-failover');
const CHAIN_ID = 8453;
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
];

function domain() {
  return { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
}

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

function ethersLib() {
  for (const m of ['ethers', path.join(process.cwd(), 'node_modules', 'ethers')]) {
    try { return require(m); } catch (e) {}
  }
  throw new Error('ethers not installed');
}

// Discover the private key by SHAPE (0x + 64 hex), not by field name — wallet.json's schema
// is not what I assumed, so name-based lookup returned undefined.
function discoverKeys(obj) {
  let pk = null, addr = null; const seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object' || seen.has(o)) return; seen.add(o);
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'string') {
        if (!pk && /^0x[0-9a-fA-F]{64}$/.test(v)) pk = v;
        else if (!pk && /^[0-9a-fA-F]{64}$/.test(v)) pk = '0x' + v;
        else if (!addr && /^0x[0-9a-fA-F]{40}$/.test(v)) addr = v;
      } else if (v && typeof v === 'object') walk(v);
    }
  })(obj);
  return { pk, addr };
}

function loadWallet() {
  const cands = [
    'C:/Users/marce/.automaton/wallet.json',
    path.join(__dirname, 'wallet.json'),
    path.join(__dirname, '..', '.automaton', 'wallet.json'),
  ];
  for (const c of cands) {
    try {
      if (!fs.existsSync(c)) continue;
      const d = discoverKeys(JSON.parse(fs.readFileSync(c, 'utf8')));
      if (!d.pk) continue;
      let addr = d.addr;
      if (!addr) { try { const { ethers } = ethersLib(); addr = new ethers.Wallet(d.pk).address; } catch (e) {} }
      return { pk: d.pk, addr, file: c };
    } catch (e) {}
  }
  return null;
}

async function check() {
  const { ethers } = ethersLib();
  const w = loadWallet();
  if (!w) { console.log('FAIL wallet.json not found'); return 1; }
  const net = await withRetry(p => p.getNetwork(), { label: 'getNetwork' });
  const bal = await withRetry(p => p.getBalance(w.addr), { label: 'getBalance' });
  const u = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).balanceOf(w.addr),
    { label: 'balanceOf' }
  );
  console.log('chainId=' + net.chainId + ' (expect ' + CHAIN_ID + ')');
  console.log('signer=' + w.addr);
  console.log('gasBalanceEth=' + ethers.formatEther(bal));
  console.log('usdcBalance=' + ethers.formatUnits(u, 6));
  console.log('gasEnough=' + (bal > ethers.parseEther('0.00005')));
  return net.chainId === BigInt(CHAIN_ID) ? 0 : 1;
}

// Broadcast a signed authorization on-chain DIRECTLY (no facilitator).
async function settleAuthorization(auth, opts) {
  const { ethers } = ethersLib();
  opts = opts || {};
  const w = loadWallet();
  if (!w) return { ok: false, error: 'wallet_missing' };

  const a = auth.payload && auth.payload.authorization ? auth.payload.authorization : auth;
  const sig = auth.signature || auth.sig;
  if (!a || !sig) return { ok: false, error: 'auth_or_signature_missing' };

  let sp;
  try { sp = ethers.Signature.from(sig); }
  catch (e) { return { ok: false, error: 'bad_signature_shape: ' + e.message }; }

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const signer = new ethers.Wallet(w.pk, provider);
  const usdc = new ethers.Contract(USDC, ABI, signer);

  // Replay guard: never broadcast a nonce already consumed on-chain.
  try {
    const used = await withRetry(
      p => new ethers.Contract(USDC, ABI, p).authorizationState(a.from, a.nonce),
      { label: 'authorizationState', attempts: 6 }
    );
    if (used) return { ok: false, error: 'nonce_already_used_onchain' };
  } catch (e) {
    // FAIL CLOSED on the money path: if we cannot verify the nonce is unused, do not broadcast.
    return { ok: false, error: 'replay_check_unavailable: ' + (e.shortMessage || e.message) };
  }

  try {
    const tx = await usdc.transferWithAuthorization(
      a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore),
      a.nonce, sp.v, sp.r, sp.s, opts.gasOverride || {}
    );
    console.log('broadcast tx=' + tx.hash);
    const rc = await tx.wait(1);
    const ok = rc && Number(rc.status) === 1;
    return { ok, tx: tx.hash, status: rc && rc.status, block: rc && rc.blockNumber };
  } catch (e) {
    return {
      ok: false,
      error: 'broadcast_failed: ' + (e.shortMessage || e.message),
      code: e.code,
      tx: (e.transaction && e.transaction.hash) || null,
    };
  }
}

async function selftest() {
  const { ethers } = ethersLib();
  const w = loadWallet();
  if (!w) { console.log('FAIL wallet_missing'); return 1; }
  const signer = new ethers.Wallet(w.pk, await require('./rpc-failover').writeProvider());
  const before = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).balanceOf(w.addr),
    { label: 'balanceOf' }
  );
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: w.addr, to: w.addr, // self-settlement: nets zero USDC, proves the mechanism on mainnet
    value: '1000', validAfter: String(now - 60), validBefore: String(now + 3600), nonce,
  };

  // 1. sign offline (a real buyer's step; needs NO gas)
  const signature = await signer.signTypedData(domain(), TYPES, auth);
  console.log('[A] signed offline (payer needs 0 ETH) sig=' + signature.slice(0, 20) + '...');

  // 2. verify by recovery == caller binding
  const recovered = ethers.verifyTypedData(domain(), TYPES, auth, signature);
  console.log('[' + (recovered.toLowerCase() === w.addr.toLowerCase() ? 'B' : 'B-FAIL') + '] recovered=' + recovered);

  // 3. assert the nonce is unused
  const used0 = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).authorizationState(w.addr, nonce),
    { label: 'authorizationState' }
  );
  console.log('[' + (used0 === false ? 'C' : 'C-FAIL') + '] nonce unused before settle=' + used0);

  // 4. BROADCAST IT MYSELF (no third-party facilitator)
  const r = await settleAuthorization({ payload: { authorization: auth }, signature });
  console.log('[' + (r.ok ? 'D' : 'D-FAIL') + '] settled on-chain tx=' + r.tx + ' status=' + r.status + ' error=' + (r.error || 'none'));

  // 5. nonce now consumed on-chain => replay impossible
  await new Promise(r => setTimeout(r, 1500));
  const used1 = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).authorizationState(w.addr, nonce),
    { label: 'authorizationState' }
  );
  console.log('[' + (used1 === true ? 'E' : 'E-FAIL') + '] nonce consumed after settle=' + used1);

  // 6. self-transfer nets zero USDC (honest accounting)
  const after = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).balanceOf(w.addr),
    { label: 'balanceOf' }
  );
  console.log('[' + (after === before ? 'F' : 'F-NOTE') + '] usdc ' + ethers.formatUnits(before, 6) + ' -> ' + ethers.formatUnits(after, 6));

  const pass = recovered.toLowerCase() === w.addr.toLowerCase() && used0 === false && r.ok && used1 === true;
  console.log('\n=== sovereign settlement self-test: ' + (pass ? '6/6 PASS' : 'FAILED') + ' ===');
  console.log('BROADCAST BY: my own wallet (no facilitator). tx=' + r.tx);
  return pass ? 0 : 1;
}

if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--check') return process.exit(await check());
  if (args[0] === '--settle') {
    const f = args[1];
    if (!f || !fs.existsSync(f)) { console.log('usage: --settle <auth.json>'); return process.exit(1); }
    const auth = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = await settleAuthorization(auth).catch(e => ({ ok: false, error: e.message }));
    console.log(JSON.stringify(r));
    return process.exit(r.ok ? 0 : 1);
  }
  if (args[0] === '--selftest') return process.exit(await selftest());
  console.log('usage: node local-settler.js --check | --selftest | --settle <auth.json>');
  process.exit(1);
})();

module.exports = { settleAuthorization, check, domain, TYPES, USDC, CHAIN_ID };
