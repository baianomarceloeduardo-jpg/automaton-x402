// facilitator-e2e.js — PROOF that the money path is now closed end to end.
//
// This does NOT mock anything. It moves REAL USDC on Base mainnet:
//   payer = my funded wallet (holds 3.75 USDC + gas)
//   payee = a freshly generated throwaway wallet (holds 0)
//   amount = 0.001 USDC
//   gas   = paid by ME, the facilitator
//
// Flow: build authorization -> sign offline (payer, no gas needed) -> facilitator verifies +
// simulates + submits -> confirm on-chain -> assert the payee's USDC balance actually rose ->
// assert a REPLAY of the same nonce is refused.
//
// This is the exact sequence an external buyer would trigger. If it passes, the caller-bound
// payment path is proven in production, not just in unit tests.
'use strict';
const fs = require('fs');
const ethers = require('ethers');
const F = require('./facilitator');

const AMOUNT = 1000n; // 0.001 USDC (6 decimals)
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('[PASS] ' + n + (d ? ' — ' + d : '')); };
const no = (n, d) => { fail++; console.log('[FAIL] ' + n + (d ? ' — ' + d : '')); };

(async () => {
  const provider = F.newProvider();
  const { wallet: payer, source } = F.loadWallet(provider);

  // throwaway payee with no funds and no gas — exactly like a real buyer who only holds USDC
  const payee = ethers.Wallet.createRandom();
  console.log('payer   = ' + payer.address + '  (key from ' + source + ')');
  console.log('payee   = ' + payee.address + '  (fresh, zero balance)');

  const payerEth = await provider.getBalance(payer.address);
  const payerUsdc = await F.usdcBalance(payer.address, provider);
  const payeeBefore = await F.usdcBalance(payee.address, provider);
  console.log('payer ETH  = ' + ethers.formatEther(payerEth));
  console.log('payer USDC = ' + ethers.formatUnits(payerUsdc, 6));
  console.log('payee USDC before = ' + ethers.formatUnits(payeeBefore, 6));

  if (payerUsdc < AMOUNT) { no('payer has enough USDC', ethers.formatUnits(payerUsdc, 6)); return finish(); }
  ok('payer funded', ethers.formatUnits(payerUsdc, 6) + ' USDC');

  // ---- 1. build + sign the authorization (buyer does this OFFLINE, needs no gas) ----
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    from: payer.address,
    to: payee.address,
    value: AMOUNT.toString(),
    validAfter: String(now - 60),
    validBefore: String(now + 3600),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signed = await F.signAuthorization(payer, payload);
  ok('authorization signed offline', 'nonce=' + payload.nonce.slice(0, 12) + '...');

  // ---- 2. negative controls BEFORE settling ----
  const tampered = JSON.parse(JSON.stringify(signed));
  tampered.payload.value = '999999999';
  const tRes = await F.settleAuthorization(tampered, { provider, wallet: payer, minUnits: 0, to: payee.address });
  if (!tRes.ok && /signature_not_from_payer|simulation_reverted|underpaid/.test(tRes.reason)) ok('tampered amount rejected', tRes.reason);
  else no('tampered amount rejected', JSON.stringify(tRes).slice(0, 160));

  const wrongAmt = await F.settleAuthorization(signed, { provider, wallet: payer, minUnits: AMOUNT + 1n, to: payee.address });
  if (!wrongAmt.ok && wrongAmt.reason === 'underpaid') ok('minUnits underpayment rejected', wrongAmt.reason);
  else no('minUnits underpayment rejected', JSON.stringify(wrongAmt).slice(0, 160));

  // ---- 3. SETTLE for real (facilitator pays gas) ----
  console.log('\nsubmitting transferWithAuthorization on Base...');
  const res = await F.settleAuthorization(signed, { provider, wallet: payer, minUnits: AMOUNT, to: payee.address });
  console.log(JSON.stringify(res, null, 2).slice(0, 700));
  if (res.ok && res.txHash) ok('SETTLED on-chain', 'tx=' + res.txHash + ' gasUsed=' + res.gasUsed);
  else { no('SETTLED on-chain', JSON.stringify(res).slice(0, 240)); return finish(); }

  // ---- 4. assert the payee actually received the USDC ----
  let payeeAfter = await F.usdcBalance(payee.address, provider);
  for (let i = 0; i < 5 && payeeAfter === payeeBefore; i++) {
    await new Promise(r => setTimeout(r, 2000));
    payeeAfter = await F.usdcBalance(payee.address, provider);
  }
  const delta = BigInt(payeeAfter) - BigInt(payeeBefore);
  if (delta === AMOUNT) ok('PAYEE BALANCE ROSE BY EXACTLY 0.001 USDC', 'before=' + payeeBefore.toString() + ' after=' + payeeAfter.toString());
  else no('payee balance rose', 'delta=' + delta.toString());

  // ---- 5. replay MUST be refused (nonce consumed on-chain) ----
  const replay = await F.settleAuthorization(signed, { provider, wallet: payer, minUnits: AMOUNT, to: payee.address });
  if (!replay.ok && replay.reason === 'nonce_already_used') ok('REPLAY REFUSED', replay.reason);
  else no('replay refused', JSON.stringify(replay).slice(0, 200));

  // ---- 6. forged signature from a different signer MUST be refused ----
  const attacker = ethers.Wallet.createRandom();
  const forgedPayload = Object.assign({}, payload, { from: attacker.address, nonce: ethers.hexlify(ethers.randomBytes(32)), value: '1000' });
  const forged = await F.signAuthorization(attacker, forgedPayload); // attacker signs as themselves
  const forgedSpoof = JSON.parse(JSON.stringify(forged));
  forgedSpoof.payload.from = payer.address; // claim to be the funded payer
  const fRes = await F.settleAuthorization(forgedSpoof, { provider, wallet: payer, minUnits: 0, to: payee.address });
  if (!fRes.ok && /signature_not_from_payer|signature_unrecoverable/.test(fRes.reason)) ok('forged signer spoof refused', fRes.reason);
  else no('forged signer spoof refused', JSON.stringify(fRes).slice(0, 200));

  finish();

  function finish() {
    console.log('\n=== facilitator E2E: ' + pass + '/' + (pass + fail) + ' PASS ===');
    fs.writeFileSync('facilitator-EVIDENCE.txt', [
      'EIP-3009 facilitator end-to-end on Base mainnet',
      'at=' + new Date().toISOString(),
      'payer=' + payer.address,
      'payee=' + payee.address,
      'amountUnits=' + AMOUNT.toString(),
      'result=' + pass + '/' + (pass + fail),
    ].join('\n') + '\n');
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.log('ERROR ' + e.message); process.exit(1); });
