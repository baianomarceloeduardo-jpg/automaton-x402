'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ethers } = require('ethers');
const { FeeClaimer, NPM, FEE_LOCKER, WETH, USDC, NPM_I, LOCKER_I, AERO_I } = require('../fee-claimer/claim-daemon.js');

const OTHER = '0x' + 'a'.repeat(40);
const POOL = '0x' + 'b'.repeat(40);
const stateFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claim-')), 'state.json');

// Answers eth_call by target + function selector, like the real contracts would.
function mockRpc({ positions = 1, collect = [400000000000000n, 5n], lockerFees = {} } = {}) {
  const calls = [];
  return {
    calls,
    async call(method, [tx]) {
      assert.equal(method, 'eth_call');
      calls.push(tx);
      const to = tx.to.toLowerCase();
      if (to === NPM.toLowerCase()) {
        const f = NPM_I.parseTransaction({ data: tx.data });
        if (f.name === 'balanceOf') return NPM_I.encodeFunctionResult('balanceOf', [positions]);
        if (f.name === 'tokenOfOwnerByIndex') return NPM_I.encodeFunctionResult('tokenOfOwnerByIndex', [777]);
        if (f.name === 'positions') return NPM_I.encodeFunctionResult('positions', [0, ethers.ZeroAddress, WETH, OTHER, 3000, -60, 60, 1, 0, 0, 0, 0]);
        if (f.name === 'collect') { assert.ok(tx.from, 'collect dry-run must be sent from the owner'); return NPM_I.encodeFunctionResult('collect', collect); }
      }
      if (to === FEE_LOCKER.toLowerCase()) {
        const f = LOCKER_I.parseTransaction({ data: tx.data });
        return LOCKER_I.encodeFunctionResult('availableFees', [lockerFees[f.args[1].toLowerCase()] || 0n]);
      }
      if (to === POOL) {
        const f = AERO_I.parseTransaction({ data: tx.data });
        if (f.name === 'token0') return AERO_I.encodeFunctionResult('token0', [USDC]);
        if (f.name === 'token1') return AERO_I.encodeFunctionResult('token1', [OTHER]);
        return AERO_I.encodeFunctionResult(f.name, [f.name === 'claimable0' ? 2000000n : 0n]);
      }
      throw new Error('unexpected call to ' + tx.to);
    }
  };
}

test('decide applies per-token thresholds and never auto-claims unpriced tokens', () => {
  assert.equal(FeeClaimer.decide({ amounts: [{ token: WETH, raw: 300000000000000n }] }), 'claim');
  assert.equal(FeeClaimer.decide({ amounts: [{ token: WETH, raw: 1n }] }), 'below_threshold_or_unpriced');
  assert.equal(FeeClaimer.decide({ amounts: [{ token: OTHER, raw: 10n ** 30n }] }), 'below_threshold_or_unpriced');
  assert.equal(FeeClaimer.decide({ amounts: [{ token: USDC, raw: 0n }] }), 'nothing_owed');
});

test('dry-run (default) reports claimables without sending anything', async () => {
  let sent = 0;
  const c = new FeeClaimer({ rpc: mockRpc(), owner: OTHER, signer: null, execute: false, aeroPools: [POOL], stateFile: stateFile(), sendTx: async () => { sent++; } });
  const s = await c.tick();
  assert.equal(sent, 0);
  const v3 = s.items.find(i => i.source === 'uniswap-v3');
  assert.equal(v3.decision, 'claim_dry_run');
  assert.equal(v3.amounts[0].raw, '400000000000000');
  assert.equal(s.items.filter(i => i.source === 'clanker-fee-locker').every(i => i.decision === 'nothing_owed'), true);
  assert.equal(s.items.find(i => i.source === 'aerodrome').decision, 'claim_dry_run');
  assert.equal(s.mode, 'dry-run');
  assert.deepEqual(s.errors, []);
});

test('execute mode refuses without the owner key', async () => {
  const w = ethers.Wallet.createRandom();
  const c = new FeeClaimer({ rpc: mockRpc(), owner: OTHER, signer: { address: w.address, wallet: w }, execute: true, stateFile: stateFile(), sendTx: async () => { throw new Error('must not send'); } });
  const s = await c.tick();
  assert.equal(s.items.find(i => i.source === 'uniswap-v3').decision, 'claim_blocked_no_owner_key');
});

test('execute mode with the owner key claims and records the tx', async () => {
  const w = ethers.Wallet.createRandom();
  const txs = [];
  const file = stateFile();
  const c = new FeeClaimer({ rpc: mockRpc({ lockerFees: { [WETH.toLowerCase()]: 10n ** 16n } }), owner: w.address, signer: { address: w.address, wallet: w }, execute: true, stateFile: file,
    sendTx: async tx => { txs.push(tx); return { hash: '0x' + String(txs.length).padStart(64, '0'), status: 1 }; } });
  const s = await c.tick();
  assert.equal(txs.length, 2, 'v3 collect + clanker WETH claim');
  assert.equal(txs[0].to, NPM);
  assert.equal(NPM_I.parseTransaction({ data: txs[0].data }).name, 'collect');
  assert.equal(LOCKER_I.parseTransaction({ data: txs[1].data }).args[1], WETH);
  assert.equal(s.executed.length, 2);
  const again = await c.tick();
  assert.equal(again.executed.length, 4, 'executed history accumulates across runs');
});

test('a failing source is reported without stopping the others', async () => {
  const rpc = mockRpc();
  const orig = rpc.call;
  rpc.call = async (m, p) => { if (p[0].to.toLowerCase() === NPM.toLowerCase()) throw new Error('rpc down'); return orig(m, p); };
  const s = await new FeeClaimer({ rpc, owner: OTHER, signer: null, stateFile: stateFile() }).tick();
  assert.deepEqual(s.errors, [{ source: 'uniswap-v3', error: 'rpc down' }]);
  assert.equal(s.items.filter(i => i.source === 'clanker-fee-locker').length, 2);
});
