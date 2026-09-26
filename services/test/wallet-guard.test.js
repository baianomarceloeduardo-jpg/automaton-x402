'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isSpendLocked,
  assertSpendAllowed,
  createGuardedWallet
} = require('../lib/wallet-guard');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));

test('isSpendLocked defaults to true unless ALLOW_OUTBOUND_SPEND is 1 or true', () => {
  assert.equal(isSpendLocked({}), true);
  assert.equal(isSpendLocked({ ALLOW_OUTBOUND_SPEND: '0' }), true);
  assert.equal(isSpendLocked({ ALLOW_OUTBOUND_SPEND: 'false' }), true);
  assert.equal(isSpendLocked({ ALLOW_OUTBOUND_SPEND: '1' }), false);
  assert.equal(isSpendLocked({ ALLOW_OUTBOUND_SPEND: 'true' }), false);
  assert.equal(isSpendLocked({ ALLOW_OUTBOUND_SPEND: 'TRUE ' }), false);
});

test('assertSpendAllowed throws and records blocked attempt when locked', () => {
  const d = tmp();
  const ledgerFile = path.join(d, 'spend-ledger.json');

  assert.throws(
    () => assertSpendAllowed({
      to: '0x1234567890123456789012345678901234567890',
      amount: '1000',
      token: 'USDC',
      reason: 'test spend',
      env: {},
      ledgerFile
    }),
    /\[WALLET_SPEND_GUARD_BLOCKED\] Outbound spend of 1000 USDC to 0x1234567890123456789012345678901234567890 rejected/
  );

  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'BLOCKED');
  assert.equal(ledger.records[0].amount, '1000');
});

test('assertSpendAllowed permits and records allowed attempt when unlocked', () => {
  const d = tmp();
  const ledgerFile = path.join(d, 'spend-ledger.json');

  const ok = assertSpendAllowed({
    to: '0x1234567890123456789012345678901234567890',
    amount: '1000',
    token: 'USDC',
    reason: 'authorized spend',
    env: { ALLOW_OUTBOUND_SPEND: '1' },
    ledgerFile
  });

  assert.equal(ok, true);
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'ALLOWED');
});

test('assertSpendAllowed enforces MAX_DAILY_SPEND_USDC', () => {
  const d = tmp();
  const ledgerFile = path.join(d, 'spend-ledger.json');
  const env = { ALLOW_OUTBOUND_SPEND: '1', MAX_DAILY_SPEND_USDC: '0.005' };

  // First spend: 0.003 USDC (3000 units) -> OK
  assert.equal(assertSpendAllowed({
    to: '0x1234567890123456789012345678901234567890',
    amount: '3000',
    token: 'USDC',
    env,
    ledgerFile
  }), true);

  // Second spend: 0.003 USDC (3000 units) -> Exceeds 0.005 cap!
  assert.throws(
    () => assertSpendAllowed({
      to: '0x1234567890123456789012345678901234567890',
      amount: '3000',
      token: 'USDC',
      env,
      ledgerFile
    }),
    /Daily spend cap exceeded/
  );
});

test('createGuardedWallet intercepts signTypedData for EIP-3009 and blocks it when locked', async () => {
  const d = tmp();
  const ledgerFile = path.join(d, 'spend-ledger.json');

  let signedTyped = false;
  let signedMessage = false;
  const mockWallet = {
    address: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
    signTypedData: async () => { signedTyped = true; return '0xsig'; },
    signMessage: async () => { signedMessage = true; return '0xmsgsig'; }
  };

  const guarded = createGuardedWallet(mockWallet, { env: {}, ledgerFile });

  // Regular signMessage (authentication, reports) must pass freely:
  const sig = await guarded.signMessage('Bounty Report: SAFE');
  assert.equal(sig, '0xmsgsig');
  assert.equal(signedMessage, true);

  // signTypedData with TransferWithAuthorization must be intercepted and BLOCKED:
  await assert.rejects(
    async () => {
      await guarded.signTypedData(
        { name: 'USD Coin' },
        { TransferWithAuthorization: [{ name: 'to', type: 'address' }] },
        { to: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea', value: '1000' }
      );
    },
    /\[WALLET_SPEND_GUARD_BLOCKED\]/
  );
  assert.equal(signedTyped, false, 'original signTypedData must never be called when locked');

  // Now unlock:
  const unlockedGuarded = createGuardedWallet(mockWallet, { env: { ALLOW_OUTBOUND_SPEND: '1' }, ledgerFile });
  const typedSig = await unlockedGuarded.signTypedData(
    { name: 'USD Coin' },
    { TransferWithAuthorization: [{ name: 'to', type: 'address' }] },
    { to: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea', value: '1000' }
  );
  assert.equal(typedSig, '0xsig');
  assert.equal(signedTyped, true);
});

test('createGuardedWallet blocks sendTransaction with value > 0 when locked', async () => {
  const d = tmp();
  const ledgerFile = path.join(d, 'spend-ledger.json');

  let sentTx = false;
  const mockWallet = {
    address: '0x71DEAc098914A009E3720524642A6bE6F65EE528',
    sendTransaction: async () => { sentTx = true; return { hash: '0xtx' }; }
  };

  const guarded = createGuardedWallet(mockWallet, { env: {}, ledgerFile });

  // Native ETH transfer attempt must be blocked:
  await assert.rejects(
    async () => {
      await guarded.sendTransaction({
        to: '0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea',
        value: 1000000000000000n
      });
    },
    /\[WALLET_SPEND_GUARD_BLOCKED\]/
  );
  assert.equal(sentTx, false);
});
