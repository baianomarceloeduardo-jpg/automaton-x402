// paid-api-e2e.js — production proof for the CLEAN caller-bound paid API (:8081).
//
// Uses a genuinely SEPARATE buyer wallet (fresh, funded with real USDC, zero ETH) to exercise
// the exact flow an external customer would: 402 -> sign offline -> retry with X-PAYMENT-AUTH ->
// facilitator broadcasts on Base -> 200 + real tx hash -> replay refused.
'use strict';
const ethers = require('ethers');
const http = require('http');
const F = require('./facilitator.js');

const BASE = 'http://127.0.0.1:8081';
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PRICE = 1000n;
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('[PASS] ' + n + (d ? ' — ' + d : '')); };
const no = (n, d) => { fail++; console.log('[FAIL] ' + n + (d ? ' — ' + d : '')); };

function get(path, headers = {}) {
  return new Promise(resolve => {
    const req = http.request(BASE + path, { method: 'GET', timeout: 180000, headers }, res => {
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
  console.log('buyer (fresh external customer) = ' + buyer.address);
  console.log('buyer ETH = ' + ethers.formatEther(await provider.getBalance(buyer.address)) + ' (ZERO — must still be able to pay)');

  // fund buyer with USDC only
  const usdc = new ethers.Contract(F.USDC, ['function transfer(address,uint256) returns (bool)'], mine);
  const ftx = await usdc.transfer(buyer.address, 10000n);
  const frc = await ftx.wait();
  if (frc && (frc.status === 1 || frc.status === '0x1')) ok('buyer funded with 0.01 USDC only', 'tx=' + ftx.hash);
  else { no('buyer funded'); return finish(); }
  const buyerBefore = BigInt(await F.usdcBalance(buyer.address, provider));

  // free surfaces
  const health = await get('/health');
  if (health.status === 200) ok('free /health 200', 'body=' + health.body.slice(0, 80).replace(/\s+/g, ' '));
  else no('free /health 200', 'status=' + health.status);
  const pricing = await get('/pricing');
  if (pricing.status === 200 && pricing.body.includes('eip3009')) ok('free /pricing advertises eip3009');
  else no('free /pricing advertises eip3009', 'status=' + pricing.status);

  // unpaid -> 402 with a real challenge
  const unpaid = await get('/paid/uuid');
  if (unpaid.status === 402) ok('unpaid -> 402');
  else no('unpaid -> 402', 'status=' + unpaid.status);
  let ch = null; try { ch = JSON.parse(unpaid.body); } catch (e) {}
  if (ch && ch.accepts && ch.accepts[0] && ch.accepts[0].scheme === 'eip3009' && ch.accepts[0].payTo.toLowerCase() === PAY_TO.toLowerCase()) {
    ok('402 challenge well-formed', 'amount=' + ch.accepts[0].maxAmountRequired + ' chain=' + ch.accepts[0].chainId);
  } else no('402 challenge well-formed', unpaid.body.slice(0, 160));

  // buyer signs OFFLINE, needs no ETH
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    from: buyer.address, to: PAY_TO, value: PRICE.toString(),
    validAfter: String(now - 60), validBefore: String(now + 3600),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signed = await F.signAuthorization(buyer, payload);
  const envelope = Buffer.from(JSON.stringify({ payload: signed.payload, signature: signed.signature })).toString('base64');
  ok('buyer signed EIP-712 authorization offline', 'nonce=' + payload.nonce.slice(0, 12) + '...');

  // forged signature: attacker signs, then claims to be the buyer -> must be refused
  const attacker = ethers.Wallet.createRandom();
  const aSigned = await F.signAuthorization(attacker, Object.assign({}, payload, { from: attacker.address, nonce: ethers.hexlify(ethers.randomBytes(32)) }));
  const forgedEnv = Buffer.from(JSON.stringify({ payload: Object.assign({}, aSigned.payload, { from: buyer.address }), signature: aSigned.signature })).toString('base64');
  const forged = await get('/paid/uuid', { 'X-PAYMENT-AUTH': forgedEnv });
  if (forged.status === 402 && forged.body.includes('signature_not_from_payer')) ok('forged signer spoof refused');
  else no('forged signer spoof refused', 'status=' + forged.status + ' ' + forged.body.slice(0, 140));

  // TAMPERED amount: sign 0.001 then claim a larger value -> must be refused
  const tamperedEnv = Buffer.from(JSON.stringify({ payload: Object.assign({}, signed.payload, { value: '900000000' }), signature: signed.signature })).toString('base64');
  const tampered = await get('/paid/uuid', { 'X-PAYMENT-AUTH': tamperedEnv });
  if (tampered.status === 402) ok('tampered amount refused', 'reason=' + (JSON.parse(tampered.body).reason || 'n/a'));
  else no('tampered amount refused', 'status=' + tampered.status);

  // THE PAID CALL
  console.log('\nPAID CALL: buyer (0 ETH) -> live server -> facilitator broadcasts on Base...');
  const paid = await get('/paid/uuid', { 'X-PAYMENT-AUTH': envelope });
  console.log('  status=' + paid.status + ' settled=' + paid.headers['x-payment-settled'] + ' tx=' + paid.headers['x-payment-tx']);
  if (paid.status === 200) ok('PAID CALL SERVED (200)');
  else no('PAID CALL SERVED', 'status=' + paid.status + ' body=' + paid.body.slice(0, 200));
  if (String(paid.headers['x-payment-settled']).toLowerCase() === 'true') ok('settled=true (real broadcast, not queued)');
  else no('settled=true', 'got=' + paid.headers['x-payment-settled']);
  const tx = paid.headers['x-payment-tx'];
  if (/^0x[0-9a-fA-F]{64}$/.test(String(tx))) ok('on-chain tx hash', tx);
  else no('on-chain tx hash', 'got=' + tx);
  if (String(paid.headers['x-payment-caller-bound']).toLowerCase() === 'true') ok('caller-bound=true');
  else no('caller-bound=true');
  let body = null; try { body = JSON.parse(paid.body); } catch (e) {}
  if (body && body.uuid) ok('paid payload returned', 'uuid=' + body.uuid);
  else no('paid payload returned', paid.body.slice(0, 120));

  // money moved?
  const buyerAfter = BigInt(await F.usdcBalance(buyer.address, provider));
  const spent = buyerBefore - buyerAfter;
  if (spent === PRICE) ok('BUYER DEBITED EXACTLY 0.001 USDC', 'spent=' + spent.toString());
  else no('buyer debited exactly 0.001', 'spent=' + spent.toString());

  // replay refused
  const replay = await get('/paid/uuid', { 'X-PAYMENT-AUTH': envelope });
  if (replay.status === 402 && replay.body.includes('nonce_already_used')) ok('REPLAY REFUSED (nonce_already_used)');
  else no('replay refused', 'status=' + replay.status + ' ' + replay.body.slice(0, 140));

  // fresh nonce -> second distinct purchase succeeds
  const p2 = Object.assign({}, payload, { nonce: ethers.hexlify(ethers.randomBytes(32)) });
  const s2 = await F.signAuthorization(buyer, p2);
  const env2 = Buffer.from(JSON.stringify({ payload: s2.payload, signature: s2.signature })).toString('base64');
  const paid2 = await get('/paid/time', { 'X-PAYMENT-AUTH': env2 });
  if (paid2.status === 200) ok('SECOND DISTINCT PURCHASE SERVED', 'tx=' + paid2.headers['x-payment-tx']);
  else no('second purchase served', 'status=' + paid2.status + ' ' + paid2.body.slice(0, 160));

  const ledger = await get('/ledger');
  if (ledger.status === 200 && ledger.body.includes('settled')) ok('settlement ledger records real txs');
  else no('settlement ledger records real txs', 'status=' + ledger.status);

  finish();

  function finish() {
    console.log('\n=== paid-api E2E: ' + pass + '/' + (pass + fail) + ' PASS ===');
    require('fs').writeFileSync('PAID-API-EVIDENCE.txt', [
      'Clean caller-bound paid API (paid-api.js v1.0.0) end-to-end on Base mainnet',
      'at=' + new Date().toISOString(),
      'buyer=' + buyer.address, 'buyerEth=0', 'payTo=' + PAY_TO,
      'tx=' + tx, 'result=' + pass + '/' + (pass + fail),
    ].join('\n') + '\n');
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.log('ERROR ' + e.message); process.exit(1); });
