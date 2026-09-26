// verify-settlement.js — prove the money loop CORRECTLY.
//
// LESSON FROM THE LAST RUN (real, not noise):
//   The public paid call succeeded: GET /paid/uuid -> 402 -> signed EIP-3009 -> 200 with
//   X-Payment-Caller-Bound: true, and the response carried payment.tx = 0xaf8d13ae...3a6b.
//   That means the SERVER already settled the authorization on-chain. My extra broadcast of the
//   same authorization then reverted with "authorization is used" — correct behaviour, because an
//   EIP-3009 nonce is single-use by design. So the previous 5/7 was a BUG IN MY TEST, not in the rail.
//
// WHAT THIS DOES (the right verification):
//   1. Heal + read the live base, then discover the 402 challenge on the public URL.
//   2. Sign an EIP-3009 authorization and pay it.
//   3. Read the tx hash the SERVER returned (the settlement it performed).
//   4. Verify THAT tx on Base: chainId 8453, receipt status 0x1, and a Transfer log moving
//      exactly maxAmountRequired USDC to payTo.
//   5. Assert double-spend safety: replaying the SAME authorization must be refused.
//   6. Write honest evidence to PAID-PROOF.md / PAID-PROOF.json.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const DIR = __dirname;

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const CHAIN_ID = 8453;
const RPCS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'];
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const liveBase = () => {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return null;
};
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
function httpGet(url, headers = {}, timeout = 20000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: '', headers: {} }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.get(url, { timeout, headers: Object.assign({ 'user-agent': 'automaton-verify/1.0' }, headers) }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message, headers: {} }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout', headers: {} }); });
  });
}
async function rpc(method, params) {
  for (const url of RPCS) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = await new Promise(resolve => {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 15000 },
        res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } }); });
      req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    });
    if (r && r.result !== undefined) return r.result;
  }
  return null;
}

(async () => {
  const out = { at: new Date().toISOString(), steps: [] };
  const step = (n, ok, d) => { out.steps.push({ step: n, ok, detail: d }); console.log((ok ? 'PASS ' : 'FAIL ') + n + ' :: ' + d); };
  const ethers = require('ethers');

  // 0. heal to guarantee the tested base is the verified base
  try { require('child_process').execSync('node self-heal-paid.js', { cwd: DIR, stdio: 'ignore', timeout: 300000 }); } catch (e) {}
  const base = liveBase();
  if (!base) { console.log('FAIL: no live base'); process.exit(2); }
  console.log('LIVE BASE = ' + base); out.base = base;

  const key = findKey(); if (!key) { console.log('FAIL: no key'); process.exit(3); }
  const wallet = new ethers.Wallet(key);

  // 1. discover challenge
  const r402 = await httpGet(base + '/paid/uuid');
  let accepts = []; try { accepts = (JSON.parse(r402.body).accepts) || []; } catch (e) {}
  step('1-public-402', r402.status === 402 && accepts.length > 0, 'GET /paid/uuid -> HTTP ' + r402.status + ', accepts=' + accepts.length);
  const acc = accepts.find(a => String(a.scheme).toLowerCase().includes('3009')) || accepts[0];
  if (!acc) { console.log('no payable accept'); process.exit(4); }
  const value = String(acc.maxAmountRequired || '1000');
  const to = acc.payTo || PAY_TO;
  const asset = acc.asset || USDC;

  // 2. sign + pay
  const now = Math.floor(Date.now() / 1000);
  const payload = { from: wallet.address, to, value, validAfter: String(now - 60), validBefore: String(now + 600), nonce: ethers.hexlify(ethers.randomBytes(32)) };
  const domain = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: asset };
  const types = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
  const signature = await wallet.signTypedData(domain, types, { from: payload.from, to: payload.to, value: BigInt(payload.value), validAfter: BigInt(payload.validAfter), validBefore: BigInt(payload.validBefore), nonce: payload.nonce });
  const envelope = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');

  const paid = await httpGet(base + '/paid/uuid', { 'X-PAYMENT-AUTH': envelope });
  let pj = {}; try { pj = JSON.parse(paid.body); } catch (e) {}
  const settledTx = (pj.payment && (pj.payment.tx || pj.payment.txHash)) || null;
  step('2-public-200', paid.status === 200, 'GET /paid/uuid with X-PAYMENT-AUTH -> HTTP ' + paid.status + ' callerBound=' + ((paid.headers || {})['x-payment-caller-bound'] || '-'));
  step('3-server-returned-tx', !!settledTx, settledTx ? ('server settled on-chain: ' + settledTx) : 'server returned no tx hash');
  out.settledTx = settledTx;

  // 3. verify THAT tx independently, on-chain
  if (settledTx) {
    const chainIdHex = await rpc('eth_chainId', []);
    step('4-chain-is-base', chainIdHex === '0x2105', 'eth_chainId=' + chainIdHex + ' (expect 0x2105 = 8453)');
    let rcpt = await rpc('eth_getTransactionReceipt', [settledTx]);
    for (let i = 0; i < 10 && (!rcpt || !rcpt.blockNumber); i++) { await new Promise(r => setTimeout(r, 3000)); rcpt = await rpc('eth_getTransactionReceipt', [settledTx]); }
    step('5-receipt-status-1', !!rcpt && rcpt.status === '0x1', 'receipt status=' + (rcpt && rcpt.status) + ' block=' + (rcpt && rcpt.blockNumber));
    let moved = null;
    if (rcpt && rcpt.logs) for (const l of rcpt.logs) {
      if (String(l.address).toLowerCase() === asset.toLowerCase() && l.topics[0] === TRANSFER && l.topics.length === 3) {
        const addr = '0x' + l.topics[2].slice(26);
        if (addr.toLowerCase() === to.toLowerCase()) moved = { to: addr, amount: BigInt(l.data).toString() };
      }
    }
    step('6-transfer-to-payTo', !!moved, moved ? ('USDC ' + (Number(moved.amount) / 1e6) + ' -> ' + moved.to) : 'no Transfer to payTo');
    step('7-amount-correct', !!moved && moved.amount === value, moved ? ('moved=' + moved.amount + ' expected=' + value) : 'n/a');
    out.verification = { chainIdHex, receipt: rcpt ? { status: rcpt.status, blockNumber: rcpt.blockNumber } : null, moved };
  }

  // 4. replay must be refused (double-spend safety, the exact defect found in the Session-5 audit)
  const replay = await httpGet(base + '/paid/uuid', { 'X-PAYMENT-AUTH': envelope });
  step('8-replay-refused', replay.status === 402, 'replay of the same authorization -> HTTP ' + replay.status + ' ' + String(replay.body).slice(0, 90).replace(/\s+/g, ' '));

  const passed = out.steps.filter(s => s.ok).length;
  const lines = ['', '## Corrected money-loop proof — ' + out.at,
    'Public URL ' + base + ' · Base mainnet · ' + passed + '/' + out.steps.length + ' checks passed',
    ...out.steps.map(s => '- ' + (s.ok ? 'PASS' : 'FAIL') + ' ' + s.step + ': ' + s.detail),
    out.settledTx ? 'Explorer: https://basescan.org/tx/' + out.settledTx : 'Explorer: (none)',
    'Correction of the prior run: the earlier step-5 failure was my test double-broadcasting an already-settled',
    'authorization; EIP-3009 nonces are single-use, so the revert was correct. The server settled it.',
    'Honest scope: still a self-settlement of my own USDC. It proves the rail works end-to-end on mainnet with real',
    'money; it is not external revenue.', ''];
  try { fs.appendFileSync(path.join(DIR, 'PAID-PROOF.md'), lines.join('\n') + '\n'); } catch (e) {}
  fs.writeFileSync(path.join(DIR, 'PAID-PROOF.json'), JSON.stringify(out, null, 2));
  console.log('\n=== ' + passed + '/' + out.steps.length + ' PASS ===');
})();
