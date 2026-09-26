'use strict';
/**
 * Automaton Pool Sentinel — watches new liquidity pools on Base and scans every new token's bytecode.
 *
 * Sources (verified on-chain 2026-09-26; ~1h sample: Uniswap v4 291 pools, v3 2, Aerodrome 0):
 *   Uniswap v4 PoolManager  Initialize   — Clanker / Zora launches land here
 *   Uniswap v3 Factory      PoolCreated
 *   Aerodrome PoolFactory   PoolCreated  (v2-style)
 *   Aerodrome Slipstream    PoolCreated  (CL)
 *
 * Output: services/pool-sentinel/scanned-pools.json (read by /v2/sentinel/* in server.js).
 * Usage:  node pool-watcher.js [--once]
 */
const path = require('path');
const { ethers } = require('ethers');
const { createRpc, hexToNumber, toHex } = require('../lib/rpc');
const { readJson, writeJsonAtomic, logger } = require('../lib/store');
const { scanTokenContract } = require('../../token-security.js');
const { createTelegramAlerter, loadAlertConfig } = require('./telegram-alerts');

const OUT_FILE = process.env.SENTINEL_FILE || path.join(__dirname, 'scanned-pools.json');
const POLL_MS = +(process.env.SENTINEL_POLL_MS || 4000);
const MAX_POOLS_KEPT = +(process.env.SENTINEL_MAX_POOLS || 2000);
const CHUNK = 200;          // blocks per eth_getLogs call
const MAX_LAG = 1500;       // public RPCs are not archive nodes; beyond this we skip ahead and record a gap
const SCAN_CONCURRENCY = 4;
const log = logger('pool-sentinel');

const ZERO = '0x0000000000000000000000000000000000000000';
// Well-known quote assets: the *other* side of the pair is the "new" token.
const QUOTES = new Set([
  ZERO,                                            // native ETH (Uniswap v4)
  '0x4200000000000000000000000000000000000006',    // WETH
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',    // USDC
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca',    // USDbC
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',    // DAI
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',    // cbBTC
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b',    // VIRTUAL
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631',    // AERO
  '0x1bc0c42215582d5a085795f4badbac3ff36d1bcb',    // CLANKER
  '0x1111111111166b7fe7bd91427724b487980afc69'     // ZORA
]);

const SOURCES = [
  {
    dex: 'uniswap-v4', address: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    iface: new ethers.Interface(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']),
    map: a => ({ pool: a.id, token0: a.currency0, token1: a.currency1, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks: a.hooks })
  },
  {
    dex: 'uniswap-v3', address: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    iface: new ethers.Interface(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)']),
    map: a => ({ pool: a.pool, token0: a.token0, token1: a.token1, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing) })
  },
  {
    dex: 'aerodrome', address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    iface: new ethers.Interface(['event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256 index)']),
    map: a => ({ pool: a.pool, token0: a.token0, token1: a.token1, stable: a.stable })
  },
  {
    dex: 'aerodrome-slipstream', address: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
    iface: new ethers.Interface(['event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool)']),
    map: a => ({ pool: a.pool, token0: a.token0, token1: a.token1, tickSpacing: Number(a.tickSpacing) })
  }
];
for (const s of SOURCES) s.topic = s.iface.fragments[0].topicHash;
const BY_ADDRESS = new Map(SOURCES.map(s => [s.address.toLowerCase(), s]));

function decodeLog(lg) {
  const src = BY_ADDRESS.get(String(lg.address).toLowerCase());
  if (!src || lg.topics[0] !== src.topic) return null;
  const parsed = src.iface.parseLog({ topics: lg.topics, data: lg.data });
  const base = src.map(parsed.args);
  return {
    dex: src.dex,
    ...base,
    pool: base.pool.toLowerCase(),
    token0: base.token0.toLowerCase(),
    token1: base.token1.toLowerCase(),
    ...(base.hooks ? { hooks: base.hooks.toLowerCase() } : {}),
    block: hexToNumber(lg.blockNumber),
    tx: lg.transactionHash,
    logIndex: hexToNumber(lg.logIndex)
  };
}

// Tokens that deserve a scan: non-quote sides; if both sides are quotes, nothing is new.
function newTokensOf(p) {
  return [p.token0, p.token1].filter(t => !QUOTES.has(t));
}

function summarizeScan(s) {
  if (!s || s.error) return { error: (s && (s.error || s.message)) || 'scan_failed' };
  return { riskScore: s.riskScore, verdict: s.verdict, flags: s.flags || [], isContract: s.isContract !== false };
}

class PoolSentinel {
  constructor({ rpc = createRpc(), file = OUT_FILE, scan = scanTokenContract, now = () => Date.now(), maxPools = MAX_POOLS_KEPT, onRecords = null } = {}) {
    this.rpc = rpc; this.file = file; this.scan = scan; this.now = now; this.maxPools = maxPools; this.onRecords = onRecords;
    const prev = readJson(file, null);
    this.state = prev && prev.version === 1 ? prev : {
      version: 1, lastBlock: null, updatedAt: null,
      stats: { pools: 0, tokensScanned: 0, scanErrors: 0, byVerdict: {}, byDex: {}, avgScanMs: 0, gaps: [] },
      pools: []
    };
    this.tokenCache = new Map();
    this.dirty = false;
    this.lastWrite = 0;
  }

  // Concurrent workers share one in-flight scan per token; failed scans are evicted so they retry later.
  scanToken(token) {
    if (this.tokenCache.has(token)) return this.tokenCache.get(token);
    const p = this._scan(token).then(out => { if (out.error) this.tokenCache.delete(token); return out; });
    this.tokenCache.set(token, p);
    if (this.tokenCache.size > 20000) this.tokenCache.delete(this.tokenCache.keys().next().value);
    return p;
  }

  async _scan(token) {
    const t0 = Date.now();
    let res;
    try { res = await this.scan(token, (m, p) => this.rpc.call(m, p)); } catch (e) { res = { error: 'scan_exception', message: e.message }; }
    const out = { ...summarizeScan(res), scanMs: Date.now() - t0 };
    const st = this.state.stats;
    if (out.error) st.scanErrors++;
    else {
      st.tokensScanned++;
      st.avgScanMs = Math.round(st.avgScanMs + (out.scanMs - st.avgScanMs) / st.tokensScanned);
      st.byVerdict[out.verdict] = (st.byVerdict[out.verdict] || 0) + 1;
    }
    return out;
  }

  async processPools(pools) {
    const records = [];
    let i = 0;
    const worker = async () => {
      while (i < pools.length) {
        const p = pools[i++];
        const tokens = newTokensOf(p);
        const scans = {};
        for (const t of tokens) scans[t] = await this.scanToken(t);
        const worst = Object.values(scans).filter(s => !s.error).reduce((m, s) => Math.max(m, s.riskScore), -1);
        records.push({ detectedAt: new Date(this.now()).toISOString(), ...p, newTokens: tokens, scans, maxRisk: worst < 0 ? null : worst });
      }
    };
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, pools.length) }, worker));
    records.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
    return records;
  }

  async tick() {
    const latest = hexToNumber(await this.rpc.call('eth_blockNumber'));
    let from = this.state.lastBlock == null ? latest - 30 : this.state.lastBlock + 1;
    if (latest - from > MAX_LAG) {
      this.state.stats.gaps.push({ from, to: latest - MAX_LAG - 1, at: new Date(this.now()).toISOString() });
      this.state.stats.gaps = this.state.stats.gaps.slice(-50);
      from = latest - MAX_LAG;
    }
    if (from > latest) return { newPools: 0, latest };

    let newPools = 0;
    for (let start = from; start <= latest; start += CHUNK) {
      const end = Math.min(latest, start + CHUNK - 1);
      const logs = await this.rpc.call('eth_getLogs', [{
        fromBlock: toHex(start), toBlock: toHex(end),
        address: SOURCES.map(s => s.address),
        topics: [SOURCES.map(s => s.topic)]
      }]);
      const pools = [];
      for (const lg of logs || []) { const d = decodeLog(lg); if (d) pools.push(d); }
      if (pools.length) {
        const recs = await this.processPools(pools);
        for (const r of recs) this.state.stats.byDex[r.dex] = (this.state.stats.byDex[r.dex] || 0) + 1;
        this.state.stats.pools += recs.length;
        this.state.pools = recs.concat(this.state.pools).slice(0, this.maxPools);
        newPools += recs.length;
        // Fire-and-forget: alert delivery must never slow down or break the scan loop.
        if (this.onRecords) Promise.resolve().then(() => this.onRecords(recs)).catch(e => log('onRecords error', e.message));
      }
      this.state.lastBlock = end;
      this.dirty = true;
    }
    this.flush(newPools > 0);
    return { newPools, latest };
  }

  flush(force) {
    if (!this.dirty) return;
    if (!force && this.now() - this.lastWrite < 30000) return;
    this.state.updatedAt = new Date(this.now()).toISOString();
    writeJsonAtomic(this.file, this.state);
    this.dirty = false;
    this.lastWrite = this.now();
  }
}

async function main() {
  const once = process.argv.includes('--once');
  const alertCfg = loadAlertConfig();
  const alerter = alertCfg ? createTelegramAlerter({ ...alertCfg, log: m => log('[alerts]', m) }) : null;
  const s = new PoolSentinel({ onRecords: alerter ? async recs => { const n = await alerter.notify(recs); if (n) log(`[alerts] sent ${n} alert(s) to ${alerter.recipients().length} recipient(s)`); } : null });
  log('start', { file: s.file, lastBlock: s.state.lastBlock, rpcs: s.rpc.urls,
    alerts: alerter ? `on (recipients now: ${alerter.recipients().length}, max ${alertCfg.maxPerHour}/h)` : 'off' });
  let stopping = false;
  const stop = () => { stopping = true; s.flush(true); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  let failures = 0;
  do {
    try {
      const r = await s.tick();
      failures = 0;
      if (r.newPools) log(`+${r.newPools} pools @${r.latest} | total ${s.state.stats.pools} | tokens ${s.state.stats.tokensScanned} | avgScan ${s.state.stats.avgScanMs}ms`);
    } catch (e) {
      failures++;
      log('tick error', e.message);
      if (failures >= 20) { log('20 consecutive failures, exiting for supervisor restart'); process.exit(2); }
    }
    if (once) break;
    await new Promise(r => setTimeout(r, POLL_MS * Math.min(8, 1 + failures)));
  } while (!stopping);
}

if (require.main === module) main();

module.exports = { PoolSentinel, decodeLog, newTokensOf, summarizeScan, SOURCES, QUOTES };
