// live-paid-call-e2e.js — THE decisive production proof.
//
// A genuinely SEPARATE buyer wallet (freshly generated, distinct from my own) signs an EIP-3009
// authorization OFFLINE and calls my LIVE public API with X-PAYMENT-AUTH. The live server must:
//   1. verify the signature is bound to the buyer (caller binding),
//   2. broadcast transferWithAuthorization on Base via my facilitator,
//   3. return HTTP 200 with X-Payment-Settled: true and a real tx hash,
//   4. refuse a replay of the same authorization.
//
// I fund the fresh buyer with 0.01 USDC so it is indistinguishable from an external customer.
'use strict';
const ethers = require('ethers');
const http = require('http');
const F = require('./facilitator.js');

const BASE = 'http://127.0.0.1:8080';
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PRICE = 1000n; // 0.001 USDC
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('[PASS] ' + n + (d ? ' — ' + d : '')); };
const no = (n, d) => { fail++; console.log('[FAIL] ' + n + (d ? ' — ' + d : '')); };

function httpGet(path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(BASE + path, { method: 'GET', timeout: 120000, headers }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, headers: {}, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    req.end();
  });
}

(async () => {
  const provider = F.newProvider();
  const { wallet: mine } = F.loadWallet(provider);
  const buyer = ethers.Wallet.createRandom();
  console.log('buyer (fresh customer) = ' + buyer.address);
  console.log('payTo                  = ' + PAY_TO);

  // --- fund the buyer with real USDC so it is a real external payer ---
  const USDC_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];
  const usdc = new ethers.Contract(F.USDC, USDC_ABI, mine);
  const buyerBefore = await F.usdcBalance(buyer.address, provider);
  const fundAmount = 10000n; // 0.01 USDC
  console.log('funding buyer with 0.01 USDC...');
  const ftx = await usdc.transfer(buyer.address, fundAmount);
  const frc = await ftx.wait();
  if (frc && (frc.status === 1 || frc.status === '0x1')) ok('buyer funded with real USDC', 'tx=' + ftx.hash);
  else { no('buyer funded', 'tx failed'); return finish(); }

  // --- sanity: first request without payment must be 402 and advertise eip3009 ---
  const unpaid = await httpGet('/v1/uuid');
  if (unpaid.status === 402) ok('unpaid request -> 402', 'schemes=' + (safe(() => JSON.parse(unpaid.body).schemes)));
  else no('unpaid request -> 402', 'status=' + unpaid.status);
  if (unpaid.body.includes('eip3009')) ok('402 advertises eip3009 challenge');
  else no('402 advertises eip3009 challenge');

  // --- the buyer signs OFFLINE (needs no ETH, only USDC) ---
  const now = Math.floor(Date.now() / 1000);
  const authPayload = {
    from: buyer.address, to: PAY_TO, value: PRICE.toString(),
    validAfter: String(now - 60), validBefore: String(now + 3600),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signed = await F.signAuthorization(buyer, authPayload);
  const envelope = Buffer.from(JSON.stringify({ payload: signed.payload, signature: signed.signature })).toString('base64');
  ok('buyer signed authorization offline (no gas)', 'nonce=' + authPayload.nonce.slice(0, 12) + '...');

  // --- PAID CALL over real HTTP ---
  console.log('\ncalling LIVE server with X-PAYMENT-AUTH (facilitator will broadcast on Base)...');
  const paid = await httpGet('/v1/uuid', { 'X-PAYMENT-AUTH': envelope });
  console.log('  status=' + paid.status + ' settled=' + paid.headers['x-payment-settled'] + ' tx=' + paid.headers['x-payment-tx']);
  if (paid.status === 200) ok('PAID CALL SERVED (200)', 'settled=' + paid.headers['x-payment-settled']);
  else no('PAID CALL SERVED', 'status=' + paid.status + ' body=' + paid.body.slice(0, 220));

  if (String(paid.headers['x-payment-settled']).toLowerCase() === 'true') ok('SETTLEMENT SETTLED (not queued)', 'scheme=' + paid.headers['x-payment-scheme']);
  else no('settlement settled (not queued)', 'got=' + paid.headers['x-payment-settled']);

  const txHash = paid.headers['x-payment-tx'];
  if (/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) ok('real on-chain tx hash returned', txHash);
  else no('real on-chain tx hash returned', 'got=' + txHash);

  if (String(paid.headers['x-payment-caller-bound']).toLowerCase() === 'true') ok('caller-bound flag true');
  else no('caller-bound flag true', 'got=' + paid.headers['x-payment-caller-bound']);

  // --- verify the money actually moved ---
  const buyerAfter = await F.usdcBalance(buyer.address, provider);
  const spent = BigInt(buyerBefore) + BigInt(fundAmount) - BigInt(buyerAfter);
  if (spent === PRICE) ok('BUYER USDC DEBITED BY EXACTLY 0.001', 'spent=' + spent.toString());
  else no('buyer debited by exactly 0.001', 'spent=' + spent.toString() + ' (before=' + buyerBefore + ' after=' + buyerAfter + ')');

  const payToBal = await F.usdcBalance(PAY_TO, provider);
  ok('payTo current USDC balance', ethers.formatUnits(payToBal, 6));

  // --- replay MUST be refused ---
  const replay = await httpGet('/v1/uuid', { 'X-PAYMENT-AUTH': envelope });
  if (replay.status === 402) ok('REPLAY REFUSED', 'status=402 body=' + replay.body.slice(0, 120));
  else no('replay refused', 'status=' + replay.status);

  finish();

  function safe(fn) { try { return fn(); } catch (e) { return 'n/a'; } }
  function finish() {
    console.log('\n=== LIVE PAID CALL E2E: ' + pass + '/' + (pass + fail) + ' PASS ===');
    require('fs').writeFileSync('LIVE-PAID-CALL-EVIDENCE.txt', [
      'LIVE PAID CALL — caller-bound EIP-3009 through the production server',
      'at=' + new Date().toISOString(),
      'buyer=' + buyer.address,
      'payTo=' + PAY_TO,
      'priceUnits=' + PRICE.toString(),
      'tx=' + txHash,
      'result=' + pass + '/' + (pass + fail),
    ].join('\n') + '\n');
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.log('ERROR ' + e.message); process.exit(1); });
