'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClaimVerifier, UsedTxStore, USDC_BASE, TRANSFER_TOPIC, pad32 } = require('../telegram-bot/claim-verifier.js');

const TREASURY = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const PAYER = '0x' + '1'.repeat(40);
const OTHER = '0x' + '2'.repeat(40);
const FAKE_TOKEN = '0x' + '3'.repeat(40);
const NOW = Date.UTC(2026, 8, 26, 18, 0, 0);
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const units = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
const tmpStore = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claims-')), 'used.json');

const transferLog = ({ token = USDC_BASE, to = TREASURY, amount = 2000000n }) =>
  ({ address: token, topics: [TRANSFER_TOPIC, pad32(PAYER), pad32(to)], data: units(amount) });

function mockRpc(receipts, { latest = 1000, blockTs = NOW / 1000 - 60 } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    if (method === 'eth_getTransactionReceipt') {
      const r = receipts[params[0]];
      if (r instanceof Error) throw r;
      return r || null;
    }
    if (method === 'eth_blockNumber') return '0x' + latest.toString(16);
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x' + Math.floor(blockTs).toString(16) };
    throw new Error('unexpected ' + method);
  };
  rpc.calls = calls;
  return rpc;
}
const receipt = (logs, status = '0x1', block = 990) => ({ status, blockNumber: '0x' + block.toString(16), logs });
const verifier = (rpc, file = tmpStore(), opts = {}) =>
  createClaimVerifier({ rpc, treasury: TREASURY, store: new UsedTxStore(file), now: () => NOW, ...opts });

test('success: USDC >= 2.00 to the treasury activates once', async () => {
  const v = verifier(mockRpc({ [hash(1)]: receipt([transferLog({ amount: 2500000n })]) }));
  const r = await v.verify(hash(1));
  assert.equal(r.ok, true);
  assert.equal(r.amountUnits, '2500000');
});

test('insufficient amount is rejected with the received amount', async () => {
  const v = verifier(mockRpc({ [hash(2)]: receipt([transferLog({ amount: 1999999n })]) }));
  const r = await v.verify(hash(2));
  assert.deepEqual([r.ok, r.reason, r.amountUnits], [false, 'insufficient_amount', '1999999']);
});

test('wrong contract (fake USDC with the same Transfer event) is rejected', async () => {
  const v = verifier(mockRpc({ [hash(3)]: receipt([transferLog({ token: FAKE_TOKEN, amount: 10n ** 12n })]) }));
  assert.equal((await v.verify(hash(3))).reason, 'no_usdc_transfer');
});

test('wrong recipient is rejected', async () => {
  const v = verifier(mockRpc({ [hash(4)]: receipt([transferLog({ to: OTHER, amount: 5000000n })]) }));
  assert.equal((await v.verify(hash(4))).reason, 'wrong_recipient');
});

test('replay: the same tx cannot activate twice, even across restarts', async () => {
  const file = tmpStore();
  const rpc = mockRpc({ [hash(5)]: receipt([transferLog({})]) });
  assert.equal((await verifier(rpc, file).verify(hash(5))).ok, true);
  const again = verifier(rpc, file);
  assert.equal((await again.verify(hash(5))).reason, 'already_used');
  assert.equal((await again.verify(hash(5).toUpperCase().replace('0X', '0x'))).reason, 'already_used', 'case-insensitive');
});

test('replay: concurrent claims of one tx -> exactly one success', async () => {
  const v = verifier(mockRpc({ [hash(6)]: receipt([transferLog({})]) }));
  const rs = await Promise.all(Array.from({ length: 5 }, () => v.verify(hash(6))));
  assert.equal(rs.filter(r => r.ok).length, 1);
  assert.equal(rs.filter(r => r.reason === 'already_used').length, 4);
});

test('failed tx, missing receipt, malformed hash', async () => {
  const v = verifier(mockRpc({ [hash(7)]: receipt([transferLog({})], '0x0') }));
  assert.equal((await v.verify(hash(7))).reason, 'tx_failed');
  assert.equal((await v.verify(hash(8))).reason, 'tx_not_found_or_pending');
  assert.equal((await v.verify('0x1234')).reason, 'invalid_hash');
});

test('a rejected tx is not burned: it can succeed later (e.g. after confirmations)', async () => {
  const receipts = { [hash(9)]: receipt([transferLog({})], '0x1', 1000) };
  const file = tmpStore();
  const early = verifier(mockRpc(receipts, { latest: 1000 }), file);
  assert.equal((await early.verify(hash(9))).reason, 'not_enough_confirmations');
  const later = verifier(mockRpc(receipts, { latest: 1005 }), file);
  assert.equal((await later.verify(hash(9))).ok, true);
});

test('old treasury inflows cannot be harvested', async () => {
  const v = verifier(mockRpc({ [hash(10)]: receipt([transferLog({})]) }, { blockTs: NOW / 1000 - 49 * 3600 }));
  assert.equal((await v.verify(hash(10))).reason, 'tx_too_old');
});

test('multiple USDC transfers to the treasury are summed; other logs ignored', async () => {
  const logs = [
    transferLog({ amount: 1000000n }), transferLog({ amount: 1000000n }),
    transferLog({ to: OTHER, amount: 9000000n }), transferLog({ token: FAKE_TOKEN, amount: 9000000n }),
    { address: USDC_BASE, topics: ['0x' + 'f'.repeat(64)], data: '0x' }
  ];
  const r = await verifier(mockRpc({ [hash(11)]: receipt(logs) })).verify(hash(11));
  assert.deepEqual([r.ok, r.amountUnits], [true, '2000000']);
});

test('RPC errors release the reservation', async () => {
  const receipts = { [hash(12)]: new Error('timeout') };
  const file = tmpStore();
  assert.equal((await verifier(mockRpc(receipts), file).verify(hash(12))).reason, 'rpc_error');
  receipts[hash(12)] = receipt([transferLog({})]);
  assert.equal((await verifier(mockRpc(receipts), file).verify(hash(12))).ok, true);
});
