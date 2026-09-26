'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PoolSentinel, decodeLog, newTokensOf, SOURCES } = require('../pool-sentinel/pool-watcher.js');
const routes = require('../pool-sentinel/sentinel-routes.js');

const WETH = '0x4200000000000000000000000000000000000006';
const TOK_A = '0x' + 'a'.repeat(40);
const TOK_B = '0x' + 'b'.repeat(40);
const tmp = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-')), name);
const hex = n => '0x' + n.toString(16);

function mkLog(dex, args, block, logIndex = 0) {
  const src = SOURCES.find(s => s.dex === dex);
  const frag = src.iface.fragments[0];
  const enc = src.iface.encodeEventLog(frag, args);
  return { address: src.address, topics: enc.topics, data: enc.data, blockNumber: hex(block), logIndex: hex(logIndex), transactionHash: '0x' + String(block).padStart(64, '0') };
}
const v4Log = (t0, t1, block, i) => mkLog('uniswap-v4', ['0x' + '1'.repeat(64), t0, t1, 10000, 200, '0x' + 'c'.repeat(40), 1n << 96n, 0], block, i);
const v3Log = (t0, t1, block, i) => mkLog('uniswap-v3', [t0, t1, 3000, 60, '0x' + 'd'.repeat(40)], block, i);

function mockRpc({ latest, logsByCall = [] }) {
  const calls = [];
  return {
    urls: ['mock'], calls,
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'eth_blockNumber') return hex(latest.value);
      if (method === 'eth_getLogs') return logsByCall.shift() || [];
      throw new Error('unexpected ' + method);
    }
  };
}

test('decodeLog handles every configured source', () => {
  const a = decodeLog(v4Log(WETH, TOK_A, 10));
  assert.equal(a.dex, 'uniswap-v4'); assert.equal(a.token1, TOK_A); assert.equal(a.fee, 10000); assert.equal(a.block, 10);
  const b = decodeLog(v3Log(TOK_B, WETH, 11));
  assert.equal(b.dex, 'uniswap-v3'); assert.equal(b.pool, '0x' + 'd'.repeat(40));
  const c = decodeLog(mkLog('aerodrome', [TOK_A, WETH, false, '0x' + 'e'.repeat(40), 5n], 12));
  assert.equal(c.dex, 'aerodrome'); assert.equal(c.stable, false);
  const d = decodeLog(mkLog('aerodrome-slipstream', [TOK_A, WETH, 100, '0x' + 'f'.repeat(40)], 13));
  assert.equal(d.tickSpacing, 100);
  assert.equal(decodeLog({ ...v3Log(TOK_A, WETH, 1), address: '0x' + '9'.repeat(40) }), null);
});

test('newTokensOf skips quote assets', () => {
  assert.deepEqual(newTokensOf({ token0: WETH, token1: TOK_A }), [TOK_A]);
  assert.deepEqual(newTokensOf({ token0: TOK_A, token1: TOK_B }), [TOK_A, TOK_B]);
  assert.deepEqual(newTokensOf({ token0: '0x0000000000000000000000000000000000000000', token1: WETH }), []);
});

test('tick scans new tokens once, persists, and resumes from the cursor', async () => {
  const file = tmp('scanned.json');
  const latest = { value: 1000 };
  const rpc = mockRpc({ latest, logsByCall: [[v4Log(WETH, TOK_A, 990, 1), v3Log(TOK_A, WETH, 995, 0), v4Log(TOK_B, WETH, 999, 3)]] });
  const scanned = [];
  const scan = async addr => { scanned.push(addr); return { riskScore: addr === TOK_A ? 80 : 10, verdict: addr === TOK_A ? 'HIGH_RISK_CAUTION' : 'SAFE', flags: [] }; };
  const s = new PoolSentinel({ rpc, file, scan });
  const r = await s.tick();
  assert.equal(r.newPools, 3);
  assert.deepEqual(scanned.sort(), [TOK_A, TOK_B].sort(), 'each token scanned once');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.lastBlock, 1000);
  assert.equal(saved.pools[0].block, 999, 'newest first');
  assert.equal(saved.pools.find(p => p.newTokens[0] === TOK_A).maxRisk, 80);
  assert.equal(saved.stats.byDex['uniswap-v4'], 2);

  latest.value = 1005;
  await s.tick();
  const gl = rpc.calls.filter(c => c.method === 'eth_getLogs').at(-1).params[0];
  assert.equal(gl.fromBlock, hex(1001));
  assert.equal(gl.toBlock, hex(1005));

  // Empty ranges are flushed at most every 30s (pool-bearing ranges are flushed immediately),
  // so a restart can only re-read empty blocks and never duplicates pools.
  assert.equal(new PoolSentinel({ rpc, file, scan }).state.lastBlock, 1000, 'empty range not yet flushed');
  s.flush(true);
  assert.equal(new PoolSentinel({ rpc, file, scan }).state.lastBlock, 1005, 'state reloads from disk');
});

test('a lag beyond the RPC window records a gap instead of scanning history', async () => {
  const file = tmp('scanned.json');
  const latest = { value: 100000 };
  const rpc = mockRpc({ latest });
  const s = new PoolSentinel({ rpc, file, scan: async () => ({ riskScore: 0, verdict: 'SAFE' }) });
  s.state.lastBlock = 10;
  await s.tick();
  assert.equal(s.state.stats.gaps.length, 1);
  assert.equal(rpc.calls.find(c => c.method === 'eth_getLogs').params[0].fromBlock, hex(100000 - 1500));
});

test('scan errors are counted and not cached', async () => {
  const file = tmp('scanned.json');
  let n = 0;
  const rpc = mockRpc({ latest: { value: 50 }, logsByCall: [[v4Log(WETH, TOK_A, 45)], [v4Log(WETH, TOK_A, 50)]] });
  const s = new PoolSentinel({ rpc, file, scan: async () => { n++; throw new Error('boom'); } });
  await s.tick();
  assert.equal(s.state.stats.scanErrors, 1);
  assert.equal(s.state.pools[0].maxRisk, null);
});

test('routes: query validation, filtering and status', () => {
  const sp = q => new URLSearchParams(q);
  assert.equal(routes.parseLatestQuery(sp('limit=0')).error, 'invalid_params');
  assert.equal(routes.parseLatestQuery(sp('maxRisk=abc')).error, 'invalid_params');
  assert.equal(routes.parseLatestQuery(sp('since=notadate')).error, 'invalid_params');
  assert.equal(routes.parseLatestQuery(sp('dex=../../x')).error, 'invalid_params');
  const q = routes.parseLatestQuery(sp('limit=5&maxRisk=30&dex=uniswap-v4'));
  assert.deepEqual([q.limit, q.maxRisk, q.dex], [5, 30, 'uniswap-v4']);

  const file = tmp('scanned.json');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), lastBlock: 7, stats: { pools: 3 }, pools: [
    { dex: 'uniswap-v4', maxRisk: 10, detectedAt: new Date(now).toISOString() },
    { dex: 'uniswap-v4', maxRisk: 90, detectedAt: new Date(now).toISOString() },
    { dex: 'uniswap-v3', maxRisk: null, detectedAt: new Date(now).toISOString() }] }));
  const out = routes.latest(q, file);
  assert.equal(out.count, 1);
  assert.equal(out.pools[0].maxRisk, 10);
  const st = routes.status(file, now + 1000);
  assert.equal(st.live, true); assert.equal(st.poolsAvailable, 3);
  assert.equal(routes.status(tmp('missing.json')).ok, false);
});

test('routes: SSE stream emits only new pools and expires', async () => {
  const file = tmp('scanned.json');
  const pool = (i) => ({ dex: 'uniswap-v4', tx: '0x' + i, logIndex: 0, detectedAt: new Date(1700000000000 + i).toISOString(), maxRisk: i });
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), lastBlock: 1, pools: [pool(1)] }));
  const req = new EventEmitter();
  let body = ''; let headers; let ended = false;
  const res = { writeHead: (c, h) => { headers = h; }, write: s => { body += s; }, end: () => { ended = true; } };
  routes.stream(req, res, { windowMs: 400, pollMs: 25, file, extraHeaders: { 'X-PAYMENT-RESPONSE': 'ok' } });
  await new Promise(r => setTimeout(r, 60));
  const t = Date.now() + 5; while (Date.now() < t) {} // ensure a distinct mtime
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), lastBlock: 2, pools: [pool(3), pool(2), pool(1)] }));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(headers['X-PAYMENT-RESPONSE'], 'ok');
  const events = body.split('\n\n').filter(Boolean).map(b => b.split('\n')[0]);
  assert.deepEqual(events.filter(e => e === 'event: pool').length, 2, 'only the two new pools');
  assert.ok(body.indexOf('"maxRisk":2') < body.indexOf('"maxRisk":3'), 'oldest first');
  assert.ok(events.includes('event: expired'));
  assert.ok(ended);
  assert.ok(routes.streamCapacity());
});
