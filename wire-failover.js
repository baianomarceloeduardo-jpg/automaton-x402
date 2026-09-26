// wire-failover.js — route local-settler.js reads through rpc-failover.js
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'local-settler.js');
let s = fs.readFileSync(F, 'utf8');

// add the require once
if (!s.includes("require('./rpc-failover')")) {
  s = s.replace(
    "const RPC = process.env.BASE_RPC || 'https://mainnet.base.org';",
    "const RPC = process.env.BASE_RPC || 'https://mainnet.base.org';\nconst { withRetry, RPC_LIST } = require('./rpc-failover');"
  );
}

// --- check(): reads via failover ---
const oldCheck = `  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const net = await provider.getNetwork();
  const bal = await provider.getBalance(w.addr);
  const usdc = new ethers.Contract(USDC, ABI, provider);
  const u = await usdc.balanceOf(w.addr);`;
const newCheck = `  const net = await withRetry(p => p.getNetwork(), { label: 'getNetwork' });
  const bal = await withRetry(p => p.getBalance(w.addr), { label: 'getBalance' });
  const u = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).balanceOf(w.addr),
    { label: 'balanceOf' }
  );`;
if (s.includes(oldCheck)) s = s.replace(oldCheck, newCheck);

// --- check(): drop the now-unused local provider/contract vars? keep 'usdc' out of scope is fine.

// --- settleAuthorization(): replay guard read via failover ---
s = s.replace(
  `  try {
    const used = await usdc.authorizationState(a.from, a.nonce);
    if (used) return { ok: false, error: 'nonce_already_used_onchain' };
  } catch (e) { /* advisory: do not block on RPC hiccup */ }`,
  `  try {
    const used = await withRetry(
      p => new ethers.Contract(USDC, ABI, p).authorizationState(a.from, a.nonce),
      { label: 'authorizationState', attempts: 6 }
    );
    if (used) return { ok: false, error: 'nonce_already_used_onchain' };
  } catch (e) {
    // FAIL CLOSED on the money path: if we cannot verify the nonce is unused, do not broadcast.
    return { ok: false, error: 'replay_check_unavailable: ' + (e.shortMessage || e.message) };
  }`
);

// --- selftest(): reads via failover, write via dedicated provider ---
s = s.replace(
  `  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const signer = new ethers.Wallet(w.pk, provider);
  const usdc = new ethers.Contract(USDC, ABI, provider);

  const before = await usdc.balanceOf(w.addr);`,
  `  const before = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).balanceOf(w.addr),
    { label: 'balanceOf' }
  );`
);

s = s.replace(
  `  const used0 = await usdc.authorizationState(w.addr, nonce);`,
  `  const used0 = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).authorizationState(w.addr, nonce),
    { label: 'authorizationState' }
  );`
);

s = s.replace(
  `  const used1 = await usdc.authorizationState(w.addr, nonce);`,
  `  await new Promise(r => setTimeout(r, 1500));
  const used1 = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).authorizationState(w.addr, nonce),
    { label: 'authorizationState' }
  );`
);

s = s.replace(
  `  const after = await usdc.balanceOf(w.addr);`,
  `  const after = await withRetry(
    p => new ethers.Contract(USDC, ABI, p).balanceOf(w.addr),
    { label: 'balanceOf' }
  );`
);

fs.writeFileSync(F, s);
console.log('failover wired');
