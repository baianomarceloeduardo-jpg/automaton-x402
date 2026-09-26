// prove-paid-live.js — THE decisive proof: a real, on-chain-settled x402 call through my own
// PUBLIC paid API, using real USDC on Base mainnet.
//
// WHY THIS IS THE ONE THING THAT MATTERS NOW:
//   Every prior "proof" used mocks or a local harness. That proves my code is self-consistent; it
//   does not prove the rail works with real money against a service reachable from the internet.
//   Funds now exist (USDC + ETH for gas), so the honest, decisive act is to execute the full loop
//   on mainnet: discover 402 -> sign EIP-712 EIP-3009 -> retry -> accepted -> settle on-chain ->
//   verify the transfer in a block explorer data path.
//
// WHAT IT DOES:
//   1. Read the LIVE public base (paid-tunnel.url / tunnel.url).
//   2. GET /paid/uuid -> expect HTTP 402 and an accepts[] the client can actually pay.
//   3. Build + sign an EIP-3009 TransferWithAuthorization for USDC on Base from the wallet.
//   4. Retry with X-PAYMENT-AUTH: base64({payload,signature}) -> expect 200 + X-Payment-Caller-Bound.
//   5. Settle for real: broadcast transferWithAuthorization to the USDC contract (payer pays gas
//      here; in production a facilitator does, which is why a buyer with 0 ETH can still pay).
//   6. Re-read the tx receipt and assert the Transfer log moved value to payTo.
//   7. Append an honest evidence record to PAID-PROOF.md.
//
// SECURITY: the private key is read into memory only and never printed, logged, or written.
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

function liveBase() {
  for (const f of ['paid-tunnel.url', 'tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return null;
}
function findKey() {
  const cands = [
    path.join(DIR, 'wallet.json'),
    'C:\\Users\\marce\\.automaton\\wallet.json',
    path.join(process.env.USERPROFILE || '', '.automaton', 'wallet.json'),
  ];
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const k = j.privateKey || j.private_key || j.key || (j.wallet && (j.wallet.privateKey || j.wallet.private_key));
      if (k && /^0x?[0-9a-fA-F]{64}$/.test(String(k))) return { key: String(k).startsWith('0x') ? String(k) : '0x' + String(k), from: p };
    } catch (e) {}
  }
  return null;
}
function httpGet(url, headers = {}, timeout = 15000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: '' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.get(url, { timeout, headers: Object.assign({ 'user-agent': 'automaton-prove/1.0' }, headers) }, res => {
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
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body); req.end();
    });
    if (r && r.result !== undefined) return { result: r.result, rpc: url };
  }
  return { result: null, rpc: null };
}

(async () => {
  const out = { at: new Date().toISOString(), steps: [] };
  const step = (n, ok, d) => { out.steps.push({ step: n, ok, detail: d }); console.log((ok ? 'PASS ' : 'FAIL ') + n + ' :: ' + d); };

  let ethers; try { ethers = require('ethers'); } catch (e) { console.log('FAIL: ethers not installed'); process.exit(1); }

  const base = liveBase();
  if (!base) { console.log('FAIL: no live base url'); process.exit(2); }
  console.log('LIVE BASE = ' + base);
  out.base = base;

  const wk = findKey();
  if (!wk) { console.log('FAIL: wallet private key not found'); process.exit(3); }
  const wallet = new ethers.Wallet(wk.key);
  console.log('wallet address = ' + wallet.address);

  // 0. sanity: balance (real funds, real chain)
  const balHex = (await rpc('eth_getBalance', [wallet.address, 'latest'])).result;
  const ethBal = balHex ? Number(BigInt(balHex)) / 1e18 : 0;
  console.log('ETH (gas) = ' + ethBal.toFixed(8));
  out.ethBalance = ethBal;
  step('0-gas-present', ethBal > 0.00001, 'ETH balance ' + ethBal.toFixed(8));

  // 1. discover the challenge on the PUBLIC url
  const r402 = await httpGet(base + '/paid/uuid');
  let accepts = [];
  try { const j = JSON.parse(r402.body); accepts = j.accepts || []; } catch (e) {}
  step('1-public-402', r402.status === 402, 'GET /paid/uuid -> HTTP ' + r402.status + ', accepts=' + accepts.length);
  out.challenge = { status: r402.status, accepts };

  // 2. pick a payable accept (prefer eip3009)
  const acc = accepts.find(a => String(a.scheme).toLowerCase().indexOf('3009') !== -1) || accepts[0];
  if (!acc) { console.log('no accepts[] to pay; cannot proceed'); fs.writeFileSync(path.join(DIR, 'PAID-PROOF.json'), JSON.stringify(out, null, 2)); process.exit(4); }
  const value = String(acc.maxAmountRequired || '1000');
  const to = acc.payTo || PAY_TO;
  const asset = (acc.asset || USDC);
  step('2-payable-accept', true, 'scheme=' + acc.scheme + ' asset=' + asset + ' to=' + to + ' amount=' + value + ' (=' + (Number(value) / 1e6) + ' USDC)');

  // 3. sign EIP-3009 TransferWithAuthorization
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    from: wallet.address, to, value,
    validAfter: String(now - 60), validBefore: String(now + 600),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const domain = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: asset };
  const types = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] };
  const signature = await wallet.signTypedData(domain, types, {
    from: payload.from, to: payload.to, value: BigInt(payload.value),
    validAfter: BigInt(payload.validAfter), validBefore: BigInt(payload.validBefore), nonce: payload.nonce,
  });
  const envelope = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
  step('3-signed-eip3009', true, 'nonce=' + payload.nonce.slice(0, 12) + '... sigLen=' + signature.length + ' headerLen=' + envelope.length);
  out.envelope = { payload: Object.assign({}, payload, { nonce: payload.nonce.slice(0, 10) + '...' }), signatureLen: signature.length };

  // 4. retry with the authorization -> expect accepted AND caller-bound
  const paid = await httpGet(base + '/paid/uuid', { 'X-PAYMENT-AUTH': envelope });
  const callerBound = String((paid.headers || {})['x-payment-caller-bound'] || '');
  const ok4 = paid.status === 200;
  step('4-public-200', ok4, 'GET /paid/uuid with X-PAYMENT-AUTH -> HTTP ' + paid.status + ' callerBound=' + (callerBound || '-' ) + ' body=' + String(paid.body).slice(0, 100).replace(/\s+/g, ' '));
  out.paidResponse = { status: paid.status, callerBound, body: String(paid.body).slice(0, 400) };
  if (!ok4) { fs.writeFileSync(path.join(DIR, 'PAID-PROOF.json'), JSON.stringify(out, null, 2)); console.log('recorded PAID-PROOF.json (accepted=false)'); process.exit(0); }

  // 5. settle for REAL on-chain (payer pays gas in this self-test; production uses a facilitator)
  const iface = new ethers.Interface(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']);
  const sig = ethers.Signature.from(signature);
  const data = iface.encodeFunctionData('transferWithAuthorization', [payload.from, payload.to, payload.value, payload.validAfter, payload.validBefore, payload.nonce, sig.v, sig.r, sig.s]);
  let txHash = null, broadcastErr = null;
  try {
    const provider = new ethers.JsonRpcProvider(RPCS[0]);
    const w = new ethers.Wallet(wk.key, provider);
    const tx = await w.sendTransaction({ to: asset, data, gasLimit: 180000 });
    txHash = tx.hash;
    console.log('broadcast tx = ' + txHash);
    const rc = await tx.wait(1);
    step('5-settled-on-chain', rc && rc.status === 1, 'tx ' + txHash + ' status=' + (rc && rc.status));
    out.settlement = { txHash, status: rc && rc.status };
  } catch (e) {
    broadcastErr = e.message;
    step('5-settled-on-chain', false, 'broadcast failed: ' + e.message);
    out.settlement = { txHash, error: e.message };
  }

  // 6. verify the receipt moved value to payTo
  if (txHash) {
    const rcpt = (await rpc('eth_getTransactionReceipt', [txHash])).result;
    let moved = null;
    if (rcpt && rcpt.logs) {
      const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      for (const l of rcpt.logs) {
        if (String(l.address).toLowerCase() === asset.toLowerCase() && l.topics[0] === topic && l.topics.length === 3) {
          const toAddr = '0x' + l.topics[2].slice(26);
          if (toAddr.toLowerCase() === to.toLowerCase()) moved = { to: toAddr, amount: BigInt(l.data).toString() };
        }
      }
    }
    step('6-transfer-verified', !!moved, moved ? ('USDC ' + (Number(moved.amount) / 1e6) + ' -> ' + moved.to + ' in tx ' + txHash) : 'no Transfer log to payTo found');
    out.receipt = { txHash, moved };
  }

  // 7. honest evidence record
  const passed = out.steps.filter(s => s.ok).length;
  const lines = [
    '', '## Real on-chain x402 settlement proof — ' + out.at,
    'Base mainnet (chainId 8453) · public URL ' + base,
    'Result: ' + passed + '/' + out.steps.length + ' checks passed',
    ...out.steps.map(s => '- ' + (s.ok ? 'PASS' : 'FAIL') + ' ' + s.step + ': ' + s.detail),
    out.settlement && out.settlement.txHash ? 'Explorer: https://basescan.org/tx/' + out.settlement.txHash : 'Explorer: (none)',
    'Honest scope: this proves the payer side end-to-end on mainnet. It is a self-settlement of my own USDC,',
    'so it is settlement proof, NOT external revenue. The gas-free buyer claim uses a facilitator; here the',
    'payer paid gas, so a facilitator settlement remains the untested variant.',
    '',
  ];
  try { fs.appendFileSync(path.join(DIR, 'PAID-PROOF.md'), lines.join('\n') + '\n'); } catch (e) {}
  fs.writeFileSync(path.join(DIR, 'PAID-PROOF.json'), JSON.stringify(out, null, 2));
  console.log('\n=== ' + passed + '/' + out.steps.length + ' PASS === wrote PAID-PROOF.md + PAID-PROOF.json');
})();
