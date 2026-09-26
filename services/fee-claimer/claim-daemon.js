'use strict';
/**
 * Automaton Fee Claimer — finds LP / launch fees owed to the treasury on Base and claims them.
 *
 *   Uniswap v3 NonfungiblePositionManager   collect() dry-run per position NFT held by the owner
 *   Clanker v4 ClankerFeeLocker             availableFees(owner, token)
 *   Aerodrome v2 pools (CLAIM_AERO_POOLS)   claimable0/1(owner)
 *
 * State on 2026-09-26: the treasury holds 0 v3 positions, 0 Clanker fees, no LP tokens.
 * Default is DRY-RUN (report only). On-chain claims need CLAIM_EXECUTE=1 plus an operator key
 * (see ../lib/signer.js) whose address equals the owner, and must clear the gas-vs-value check.
 *
 * Usage: node claim-daemon.js [--once]
 */
const path = require('path');
const { ethers } = require('ethers');
const { createRpc, DEFAULT_RPCS } = require('../lib/rpc');
const { readJson, writeJsonAtomic, logger } = require('../lib/store');
const { loadSigner } = require('../lib/signer');

const OWNER = (process.env.CLAIM_OWNER || '0x71DEAc098914A009E3720524642A6bE6F65EE528');
const STATE_FILE = process.env.CLAIM_STATE || path.join(__dirname, 'claim-state.json');
const POLL_MS = +(process.env.CLAIM_POLL_MS || 30 * 60 * 1000);
const NPM = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const FEE_LOCKER = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MAX128 = (1n << 128n) - 1n;
const log = logger('fee-claimer');

// Minimum claimable amount (raw units) worth a transaction. Tokens not listed are reported, never auto-claimed.
const THRESHOLDS = { [WETH.toLowerCase()]: 300000000000000n /* 0.0003 WETH */, [USDC.toLowerCase()]: 1000000n /* 1 USDC */ };

const NPM_I = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)'
]);
const LOCKER_I = new ethers.Interface([
  'function availableFees(address feeOwner,address token) view returns (uint256)',
  'function claim(address feeOwner,address token)'
]);
const AERO_I = new ethers.Interface([
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function claimable0(address) view returns (uint256)', 'function claimable1(address) view returns (uint256)',
  'function claimFees() returns (uint256,uint256)'
]);

function envList(v) { return String(v || '').split(',').map(s => s.trim()).filter(s => /^0x[0-9a-fA-F]{40}$/.test(s)); }

class FeeClaimer {
  constructor({ rpc = createRpc(), owner = OWNER, signer = loadSigner(), execute = process.env.CLAIM_EXECUTE === '1',
    extraTokens = envList(process.env.CLAIM_EXTRA_TOKENS), aeroPools = envList(process.env.CLAIM_AERO_POOLS),
    stateFile = STATE_FILE, sendTx = null, now = () => Date.now() } = {}) {
    Object.assign(this, { rpc, owner, signer, execute, extraTokens, aeroPools, stateFile, now });
    this.sendTx = sendTx || defaultSendTx(signer);
  }

  async ethCall(to, iface, fn, args, from) {
    const data = iface.encodeFunctionData(fn, args);
    const res = await this.rpc.call('eth_call', [Object.assign({ to, data }, from ? { from } : {}), 'latest']);
    return iface.decodeFunctionResult(fn, res);
  }

  async uniswapV3() {
    const out = [];
    const n = Number((await this.ethCall(NPM, NPM_I, 'balanceOf', [this.owner]))[0]);
    for (let i = 0; i < Math.min(n, 50); i++) {
      const id = (await this.ethCall(NPM, NPM_I, 'tokenOfOwnerByIndex', [this.owner, i]))[0];
      const pos = await this.ethCall(NPM, NPM_I, 'positions', [id]);
      const params = { tokenId: id, recipient: this.owner, amount0Max: MAX128, amount1Max: MAX128 };
      // collect() is non-view; an eth_call from the owner returns what a real call would transfer.
      const [a0, a1] = await this.ethCall(NPM, NPM_I, 'collect', [params], this.owner);
      out.push({ source: 'uniswap-v3', id: id.toString(), target: NPM,
        amounts: [{ token: pos[2], raw: a0 }, { token: pos[3], raw: a1 }],
        calldata: NPM_I.encodeFunctionData('collect', [params]) });
    }
    return out;
  }

  async clanker() {
    const out = [];
    for (const token of [WETH, USDC, ...this.extraTokens]) {
      const [raw] = await this.ethCall(FEE_LOCKER, LOCKER_I, 'availableFees', [this.owner, token]);
      out.push({ source: 'clanker-fee-locker', id: token, target: FEE_LOCKER, amounts: [{ token, raw }],
        calldata: LOCKER_I.encodeFunctionData('claim', [this.owner, token]) });
    }
    return out;
  }

  async aerodrome() {
    const out = [];
    for (const pool of this.aeroPools) {
      const [t0] = await this.ethCall(pool, AERO_I, 'token0', []);
      const [t1] = await this.ethCall(pool, AERO_I, 'token1', []);
      const [c0] = await this.ethCall(pool, AERO_I, 'claimable0', [this.owner]);
      const [c1] = await this.ethCall(pool, AERO_I, 'claimable1', [this.owner]);
      out.push({ source: 'aerodrome', id: pool, target: pool, amounts: [{ token: t0, raw: c0 }, { token: t1, raw: c1 }],
        calldata: AERO_I.encodeFunctionData('claimFees', []) });
    }
    return out;
  }

  // Worth claiming = some amount in a thresholded token clears its minimum.
  static decide(item) {
    const worth = item.amounts.some(a => { const t = THRESHOLDS[String(a.token).toLowerCase()]; return t !== undefined && a.raw >= t; });
    const nonzero = item.amounts.some(a => a.raw > 0n);
    return worth ? 'claim' : nonzero ? 'below_threshold_or_unpriced' : 'nothing_owed';
  }

  async tick() {
    const items = [];
    const errors = [];
    for (const [name, fn] of [['uniswap-v3', () => this.uniswapV3()], ['clanker', () => this.clanker()], ['aerodrome', () => this.aerodrome()]]) {
      try { items.push(...await fn()); } catch (e) { errors.push({ source: name, error: e.message }); }
    }
    const executed = [];
    for (const it of items) {
      it.decision = FeeClaimer.decide(it);
      if (it.decision !== 'claim') continue;
      if (!this.execute) { it.decision = 'claim_dry_run'; continue; }
      if (!this.signer || this.signer.address.toLowerCase() !== this.owner.toLowerCase()) { it.decision = 'claim_blocked_no_owner_key'; continue; }
      try {
        const r = await this.sendTx({ to: it.target, data: it.calldata });
        executed.push({ source: it.source, id: it.id, tx: r.hash, status: r.status, at: new Date(this.now()).toISOString() });
        it.decision = 'claimed';
      } catch (e) {
        it.decision = 'claim_failed'; it.error = e.message;
      }
    }
    const prev = readJson(this.stateFile, {});
    const state = {
      version: 1, owner: this.owner, mode: this.execute ? 'execute' : 'dry-run', lastRunAt: new Date(this.now()).toISOString(),
      items: items.map(i => ({ source: i.source, id: i.id, decision: i.decision, error: i.error,
        amounts: i.amounts.map(a => ({ token: a.token, raw: a.raw.toString() })) })),
      errors,
      executed: (prev.executed || []).concat(executed).slice(-200)
    };
    writeJsonAtomic(this.stateFile, state);
    return state;
  }
}

function defaultSendTx(signer) {
  if (!signer) return null;
  return async ({ to, data }) => {
    const provider = new ethers.JsonRpcProvider(DEFAULT_RPCS[0], 8453, { staticNetwork: true });
    const w = signer.wallet.connect(provider);
    const gas = await provider.estimateGas({ from: w.address, to, data });
    const fee = await provider.getFeeData();
    const maxFee = (fee.maxFeePerGas || fee.gasPrice) * 2n;
    const bal = await provider.getBalance(w.address);
    if (bal < gas * maxFee * 2n) throw new Error('insufficient_gas_balance');
    const tx = await w.sendTransaction({ to, data, gasLimit: gas * 12n / 10n, maxFeePerGas: maxFee, type: 2 });
    const rcpt = await tx.wait(1);
    return { hash: tx.hash, status: rcpt.status };
  };
}

async function main() {
  const once = process.argv.includes('--once');
  const c = new FeeClaimer();
  log('start', { owner: c.owner, mode: c.execute ? 'execute' : 'dry-run', signer: c.signer ? c.signer.address : 'none' });
  const stop = () => process.exit(0);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  for (;;) {
    try {
      const s = await c.tick();
      const summary = s.items.reduce((t, i) => (t[i.decision] = (t[i.decision] || 0) + 1, t), {});
      log('checked', s.items.length, 'claim targets', JSON.stringify(summary), s.errors.length ? 'errors ' + JSON.stringify(s.errors) : '');
    } catch (e) { log('tick error', e.message); }
    if (once) break;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) main();

module.exports = { FeeClaimer, THRESHOLDS, NPM, FEE_LOCKER, WETH, USDC, NPM_I, LOCKER_I, AERO_I };
