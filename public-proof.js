// public-proof.js — PROVE the full paid loop over the PUBLIC INTERNET with a DISTINCT buyer.
//
// WHAT THIS PROVES (and why localhost tests are not enough):
//   The money path was proven locally. Revenue requires that a STRANGER, over the public internet,
//   holding ZERO ETH, can pay me and receive the payload. This script is that stranger:
//     - fresh buyer wallet, 0 ETH (cannot pay gas itself)
//     - funded with only 0.002 USDC by me
//     - reaches the service through the PUBLIC tunnel URL (not 127.0.0.1)
//     - gets 402, signs an EIP-712 authorization OFFLINE, retries, and receives 200
//   Every step is asserted, and the settlement is then confirmed INDEPENDENTLY on-chain from
//   the receipt logs (not from my own server's word).
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const ethers = require('ethers');
const F = require('./facilitator.js');

const DIR = __dirname;
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const BUYER_KEY_FILE = path.join(DIR, 'buyer-key.txt');
const PRICE_UNITS = 1000n; // 0.001 USDC

const pass = [], fail = [];
function check(name, cond, extra) {
  (cond ? pass : fail).push(name);
  console.log('[' + (cond ? 'PASS' : 'FAIL') + '] ' + name + (extra ? ' -- ' + extra : ''));
}
function readPublicBase() {
  for (const f of ['paid-tunnel.url']) {
    try { const u = fs.readFileSync(path.join(DIR, f), 'utf8').trim(); if (/^https?:\/\//.test(u)) return u; } catch (e) {}
  }
  return null;
}
function req(url, opts = {}) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const r = mod.request(url, { method: opts.method || 'GET', timeout: 15000, headers: opts.headers || {} }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', e => resolve({ status: 0, headers: {}, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

(async () => {
  const base = readPublicBase();
  if (!base) { console.log('no public base url found'); process.exit(1); }
  console.log('PUBLIC BASE = ' + base);

  const provider = F.newProvider();
  const me = F.loadWallet(provider).wallet;

  // ---- 1. buyer identity (persisted so repeated runs reuse it) ----
  let buyer;
  if (fs.existsSync(BUYER_KEY_FILE)) buyer = new ethers.Wallet(fs.readFileSync(BUYER_KEY_FILE, 'utf8').trim(), provider);
  else {
    buyer = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync(BUYER_KEY_FILE, buyer.privateKey, { mode: 0o600 });
  }
  const buyerEth = await F.readWithFailover(p => p.getBalance(buyer.address));
  console.log('buyer = ' + buyer.address + '  ETH = ' + ethers.formatEther(buyerEth));
  check('buyer holds ZERO ETH (cannot pay gas itself)', buyerEth === 0n, 'eth=' + ethers.formatEther(buyerEth));

  // ---- 2. fund buyer with USDC only ----
  let bal = await F.usdcBalance(buyer.address);
  if (bal < PRICE_UNITS * 2n) {
    console.log('funding buyer with 0.002 USDC from my wallet (USDC only, no ETH)...');
    const c = new ethers.Contract(F.USDC, ['function transfer(address,uint256) returns (bool)'], me);
    const tx = await c.transfer(buyer.address, 2000n);
    const rc = await tx.wait();
    check('buyer funded with USDC only', rc.status === 1 || rc.status === '0x1', 'tx=' + tx.hash);
    bal = await F.usdcBalance(buyer.address);
  } else {
    check('buyer funded with USDC only', bal >= PRICE_UNITS, 'balance=' + ethers.formatUnits(bal, 6));
  }

  // ---- 3. free surfaces over the PUBLIC internet ----
  const health = await req(base + '/health');
  check('PUBLIC /health 200', health.status === 200, 'bytes=' + health.body.length);
  const pricing = await req(base + '/pricing');
  check('PUBLIC /pricing advertises eip3009', pricing.status === 200 && /eip3009/.test(pricing.body));

  // ---- 4. unpaid request must challenge ----
  const target = base + '/paid/uuid';
  const un = await req(target);
  check('unpaid -> 402', un.status === 402, 'status=' + un.status);
  let ch = {};
  try { ch = JSON.parse(un.body); } catch (e) {}
  const acc = (ch.accepts && ch.accepts[0]) || {};
  check('402 challenge well-formed', String(acc.amount || acc.maxAmountRequired || '') === '1000' && String(acc.chainId) === '8453',
    'scheme=' + acc.scheme + ' amount=' + (acc.amount || acc.maxAmountRequired) + ' chain=' + acc.chainId);

  // ---- 5. sign EIP-712 authorization OFFLINE (buyer needs no gas) ----
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    from: buyer.address, to: acc.payTo || PAY_TO, value: '1000',
    validAfter: String(now - 5), validBefore: String(now + 3600),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await buyer.signTypedData(F.domain(), F.TYPES, payload);
  const recovered = ethers.verifyTypedData(F.domain(), F.TYPES, payload, signature);
  check('buyer signed caller-bound authorization offline', recovered.toLowerCase() === buyer.address.toLowerCase(), 'nonce=' + payload.nonce.slice(0, 10) + '...');

  // ---- 6. PAY over the public internet ----
  const envelope = Buffer.from(JSON.stringify({ payload, signature })).toString('base64');
  console.log('PAID CALL: buyer (0 ETH) -> PUBLIC internet -> facilitator settles on Base...');
  const paid = await req(target, { headers: { 'X-PAYMENT-AUTH': envelope } });
  check('PAID CALL SERVED over PUBLIC internet (200)', paid.status === 200, 'status=' + paid.status + ' ' + paid.body.slice(0, 80));
  check('settled=true header', String(paid.headers['x-payment-settled']) === 'true');
  check('caller-bound=true header', String(paid.headers['x-payment-caller-bound']) === 'true');
  const txHash = paid.headers['x-payment-tx'];
  check('on-chain tx hash returned', /^0x[0-9a-f]{64}$/i.test(String(txHash)), String(txHash));

  // ---- 7. replay must be refused ----
  const replay = await req(target, { headers: { 'X-PAYMENT-AUTH': envelope } });
  check('REPLAY REFUSED', replay.status === 402 && /nonce_already_used/.test(replay.body), 'status=' + replay.status);

  // ---- 8. INDEPENDENT on-chain verification of the settlement ----
  if (txHash) {
    const rc = await F.readWithFailover(p => p.getTransactionReceipt(txHash));
    if (rc) {
      const ok = rc.status === 1 || rc.status === '0x1';
      let moved = 0n;
      for (const L of rc.logs || []) {
        if (L.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
            L.address.toLowerCase() === F.USDC.toLowerCase()) {
          const to = '0x' + L.topics[2].slice(26);
          if (to.toLowerCase() === PAY_TO.toLowerCase()) moved += BigInt(L.data);
        }
      }
      check('INDEPENDENT on-chain verification: 0.001 USDC reached payTo', ok && moved === 1000n,
        'block=' + rc.blockNumber + ' moved=' + moved.toString());
    } else {
      check('INDEPENDENT on-chain verification: receipt found', false, 'receipt not yet visible');
    }
  }

  // ---- 9. the payload is real ----
  let pr = {};
  try { pr = JSON.parse(paid.body); } catch (e) {}
  check('paid payload returned', !!(pr.uuid || pr.result || pr.data), 'keys=' + Object.keys(pr).join(','));

  console.log('\n=== PUBLIC PROOF: ' + pass.length + '/' + (pass.length + fail.length) + ' PASS ===');
  if (fail.length) console.log('FAILED: ' + fail.join(' | '));
  const ev = { at: new Date().toISOString(), publicBase: base, buyer: buyer.address, buyerEth: '0',
    txHash, passes: pass.length, fails: fail.length, failed: fail };
  fs.writeFileSync(path.join(DIR, 'PUBLIC-PROOF.json'), JSON.stringify(ev, null, 2));
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.log('ERR ' + (e && e.message)); process.exit(1); });
