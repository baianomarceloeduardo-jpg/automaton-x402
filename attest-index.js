// attest-index.js — publish a tamper-evident, timestamped record of my x402 service index ON-CHAIN.
//
// WHY THIS IS NOT A GIMME: everything else I publish (paste.rs, HTTP, a tunnel URL) can vanish,
// rotate, or be edited by whoever controls the host. A hash anchored in a Base transaction cannot
// be. Any agent or human can, years from now, take my published index, hash it, and check it
// against this tx -- proving that this exact index existed at this exact block. That is real,
// verifiable infrastructure, and it is something only an agent with write access and its own wallet
// can do. Cost: one zero-value self-transaction carrying ~120 bytes of calldata (fractions of a cent).
//
// OUTPUT: a tx hash + block. The index snapshot, its sha256, and the anchoring tx are written to
// ATTEST-LOG.jsonl and printed as a public claim that anyone can independently verify.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DIR = __dirname;

const CHAIN_ID = 8453;
const RPCS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'];

function findKey() {
  for (const p of [path.join(DIR, 'wallet.json'), 'C:\\Users\\marce\\.automaton\\wallet.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const k = j.privateKey || j.private_key || j.key || (j.wallet && (j.wallet.privateKey || j.wallet.private_key));
      if (k && /^0x?[0-9a-fA-F]{64}$/.test(String(k))) return String(k).startsWith('0x') ? String(k) : '0x' + String(k);
    } catch (e) {}
  }
  return null;
}
const liveBase = () => {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return 'http://127.0.0.1:8081';
};

(async () => {
  const ethers = require('ethers');

  // 1. canonicalize the index. Deterministic ordering/hashing so ANYONE can recompute it.
  const cache = JSON.parse(fs.readFileSync(path.join(DIR, 'x402-live-cache.json'), 'utf8'));
  const canonical = {
    v: 1, kind: 'x402-verified-buyable-index', generatedAt: cache.generatedAt,
    checked: cache.checked, buyableCount: cache.buyableCount, deadCount: cache.deadCount,
    buyable: (cache.buyable || []).map(b => ({
      url: b.url, host: b.host, priceUnits: b.maxAmountRequired,
      scheme: b.scheme, network: b.network, chainId: b.chainId, payTo: b.payTo,
    })).sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
  };
  const json = JSON.stringify(canonical);
  const sha256 = crypto.createHash('sha256').update(json).digest('hex');
  fs.writeFileSync(path.join(DIR, 'index-snapshot.json'), JSON.stringify(canonical, null, 2));

  const base = liveBase();
  const payload = 'AUTOMATON-X402-IDX v1 sha256=' + sha256 + ' n=' + canonical.buyableCount + ' ' + base;
  console.log('[attest] snapshot sha256 = ' + sha256);
  console.log('[attest] buyable entries = ' + canonical.buyableCount + ' (of ' + canonical.checked + ' checked)');
  console.log('[attest] calldata = ' + payload);

  const key = findKey();
  if (!key) { console.log('[attest] FATAL: no wallet key'); process.exit(3); }

  // 2. connect with a working RPC (try each in turn)
  let provider = null, wallet = null;
  for (const rpc of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
      const net = await p.getNetwork();
      if (Number(net.chainId) === CHAIN_ID) { provider = p; break; }
    } catch (e) {}
  }
  if (!provider) { console.log('[attest] FATAL: no Base RPC reachable'); process.exit(4); }
  wallet = new ethers.Wallet(key, provider);
  const bal = await provider.getBalance(wallet.address);
  const feeData = await provider.getFeeData();
  console.log('[attest] wallet ' + wallet.address + '  balance ' + ethers.formatEther(bal) + ' ETH');

  const data = ethers.hexlify(ethers.toUtf8Bytes(payload));
  const gasLimit = 21000n + BigInt(Math.ceil(data.length / 2 - 1) * 16) + 4000n;
  const maxFeePerGas = (feeData.maxFeePerGas || feeData.gasPrice || 1000000n) * 2n;
  const est = gasLimit * maxFeePerGas;
  console.log('[attest] estimated fee ' + ethers.formatEther(est) + ' ETH (gasLimit=' + gasLimit.toString() + ')');
  if (bal < est * 3n) { console.log('[attest] ABORT: gas balance too low for a safe anchor'); process.exit(5); }

  // 3. send the anchor tx (zero value, self-addressed, data = the commitment)
  const tx = await wallet.sendTransaction({ to: wallet.address, value: 0n, data, gasLimit, maxFeePerGas, type: 2 });
  console.log('[attest] ANCHOR TX SENT: ' + tx.hash);
  const rcpt = await tx.wait(1);
  console.log('[attest] mined in block ' + rcpt.blockNumber + ' status=' + rcpt.status + ' gasUsed=' + rcpt.gasUsed.toString());

  const record = {
    at: new Date().toISOString(), chainId: CHAIN_ID, sha256, payload,
    buyableCount: canonical.buyableCount, checked: canonical.checked,
    txHash: tx.hash, blockNumber: rcpt.blockNumber, status: rcpt.status,
    explorer: 'https://basescan.org/tx/' + tx.hash,
    verify: 'sha256(index-snapshot.json canonicalized) must equal ' + sha256 + '; the tx calldata must utf8-decode to the payload.',
  };
  fs.appendFileSync(path.join(DIR, 'ATTEST-LOG.jsonl'), JSON.stringify(record) + '\n');
  fs.writeFileSync(path.join(DIR, 'ATTEST-LATEST.json'), JSON.stringify(record, null, 2));
  console.log('[attest] PUBLIC CLAIM: this exact index existed at Base block ' + rcpt.blockNumber);
  console.log('[attest] explorer ' + record.explorer);
})();
