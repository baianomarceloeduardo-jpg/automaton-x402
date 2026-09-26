// anchor-base.js — permanently record my live base URL ON-CHAIN as tx calldata.
//
// WHY ON-CHAIN (the durable-ingress problem, finally solved honestly):
//   Quick tunnels rotate. Paste hosts are read-only or dead (paste.rs PUT=404).
//   kvdb=500, jsonblob=403. So there is NO keyless writable public store I can rely on.
//   But I DO have write access to Base: my own wallet. A self-tx with calldata is a
//   permanent, timestamped, publicly auditable record, and every wallet/explorer is a
//   reader. Anchoring 'AUTOMATON-BASE v1 <url>' on-chain means the CURRENT base is
//   discoverable forever by anyone reading my address's history — no third party.
//
//   Rotation now costs one cheap tx instead of breaking my identity: the newest anchor
//   for address 0x71DE...EE528 is, by definition, the live base.
//
// Reuses the proven key path: wallet.json (local then ~/.automaton) + ethers + base RPC.
'use strict';
const fs = require('fs');
const path = require('path');
const ethers = require('ethers');

const DIR = __dirname;
const RPCS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'];

function loadKey() {
  for (const p of [path.join(DIR, 'wallet.json'), 'C:\\Users\\marce\\.automaton\\wallet.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const k = j.privateKey || j.private_key || j.key ||
        (j.wallet && (j.wallet.privateKey || j.wallet.private_key));
      if (k) return k;
    } catch (_) {}
  }
  return null;
}

(async () => {
  let base = (process.argv[2] || '').trim();
  if (!/^https?:\/\//.test(base)) {
    try { base = (fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').split('=').pop() || '').trim(); } catch (_) {}
  }
  if (!/^https?:\/\//.test(base)) { console.log('ANCHOR=FAIL reason=no_base'); process.exit(2); }

  const key = loadKey();
  if (!key) { console.log('ANCHOR=FAIL reason=no_key'); process.exit(3); }

  let provider = null;
  for (const r of RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(r, 8453, { staticNetwork: true });
      const n = await p.getBlockNumber();
      if (n > 0) { provider = p; console.log('rpc: ' + r + ' block=' + n); break; }
    } catch (_) {}
  }
  if (!provider) { console.log('ANCHOR=FAIL reason=no_rpc'); process.exit(4); }

  const wallet = new ethers.Wallet(key, provider);
  const addr = await wallet.getAddress();
  const bal = await provider.getBalance(addr);
  console.log('address: ' + addr);
  console.log('balance: ' + ethers.formatEther(bal) + ' ETH');

  // calldata: compact, self-describing, utf8-decodable by anyone.
  const payload = 'AUTOMATON-BASE v1 base=' + base + ' agent=95791 ts=' + new Date().toISOString();
  const data = ethers.hexlify(ethers.toUtf8Bytes(payload));
  console.log('calldata(' + payload.length + 'B): ' + payload);

  const fee = await provider.getFeeData();
  const tx = {
    to: addr,                       // self-tx: moves no value, costs only gas
    value: 0n,
    data,
    gasLimit: 40000n,
    maxFeePerGas: fee.maxFeePerGas ? fee.maxFeePerGas * 2n : ethers.parseUnits('0.05', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ? fee.maxPriorityFeePerGas * 2n : ethers.parseUnits('0.01', 'gwei'),
  };

  let sent;
  try { sent = await wallet.sendTransaction(tx); }
  catch (e) { console.log('ANCHOR=FAIL reason=send (' + (e.shortMessage || e.message) + ')'); process.exit(5); }
  console.log('tx: ' + sent.hash);
  const rc = await sent.wait(1);
  console.log('status: ' + rc.status + ' block: ' + rc.blockNumber + ' gasUsed: ' + rc.gasUsed.toString());

  const rec = {
    anchoredAt: new Date().toISOString(), base, payload, tx: sent.hash,
    block: rc.blockNumber, status: rc.status, gasUsed: rc.gasUsed.toString(),
    address: addr, explorer: 'https://basescan.org/tx/' + sent.hash
  };
  fs.writeFileSync(path.join(DIR, 'ANCHOR-LATEST.json'), JSON.stringify(rec, null, 2) + '\n');
  try {
    fs.appendFileSync(path.join(DIR, 'ANCHOR-LOG.jsonl'), JSON.stringify(rec) + '\n');
    const hist = fs.existsSync(path.join(DIR, 'anchor-history.json'))
      ? JSON.parse(fs.readFileSync(path.join(DIR, 'anchor-history.json'), 'utf8')) : { anchors: [] };
    hist.anchors.push(rec);
    hist.currentBase = base;
    hist.note = 'The LAST anchor for this address is the live base. Read the newest tx calldata.';
    fs.writeFileSync(path.join(DIR, 'anchor-history.json'), JSON.stringify(hist, null, 2) + '\n');
  } catch (_) {}

  console.log('\nCURRENT_BASE_ANCHOR=' + base);
  console.log('ANCHOR=' + (rc.status === 1 ? 'PASS' : 'FAIL'));
  process.exit(rc.status === 1 ? 0 : 6);
})();
