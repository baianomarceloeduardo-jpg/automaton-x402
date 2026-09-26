// revenue-watch.js — does anyone actually pay me? Poll Base for inbound USDC and record it.
//
// THE BLIND SPOT: I have shipped services for many sessions and reported "zero paid calls" from
// assumption, not from measurement. This is the instrument. It scans Base for ERC-20 Transfer
// logs whose recipient is my payTo address, classifies each sender as SELF (my own wallet, i.e. a
// self-test) or EXTERNAL (genuine revenue), advances a durable block cursor, and records the first
// external payment as a permanent proof event.
//
// Why logs and not a balance diff: a balance diff cannot tell you WHO paid or WHEN. A log gives
// sender, amount, tx hash and block -- the evidence needed to claim revenue honestly.
//
// Public Base RPCs cap eth_getLogs ranges, so this scans in bounded windows.
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const DIR = __dirname;

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const CHAIN_ID = 8453;
const RPCS = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'];
const LOOKBACK = 40000;   // blocks to scan on a cold start (~22h on Base)
const CHUNK = 2000n;      // per-request block window
const MAX_WINDOWS = 40;   // bound the work per pass
const STATE = path.join(DIR, 'revenue-state.json');
const LOG = path.join(DIR, 'REVENUE-LOG.jsonl');

function rpc(url, method, params, timeout = 20000) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { return resolve({ ok: false }); }
    const mod = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { const j = JSON.parse(b); resolve({ ok: j.result !== undefined, result: j.result, error: j.error && j.error.message }); }
        catch (e) { resolve({ ok: false, error: 'bad_json' }); } });
    });
    r.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    r.write(body); r.end();
  });
}
const hex = n => '0x' + n.toString(16);
const pad = a => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const unpad = t => '0x' + String(t).slice(-40);
const num = h => Number(BigInt(h));

async function call(method, params) {
  for (const url of RPCS) { const r = await rpc(url, method, params); if (r.ok) return r.result; }
  return null;
}

async function run() {
  const out = { at: new Date().toISOString(), chainId: CHAIN_ID, payTo: PAY_TO };
  const latest = await call('eth_blockNumber', []);
  if (!latest) { out.error = 'rpc_unavailable'; console.log(JSON.stringify(out, null, 2)); return out; }
  const latestN = num(latest);

  let state = { lastBlock: 0, externalCount: 0, externalTotalUnits: '0', selfCount: 0, firstExternalAt: null };
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch (e) {}

  let lo = BigInt(state.lastBlock ? state.lastBlock + 1 : Math.max(0, latestN - LOOKBACK));
  const hi = BigInt(latestN);
  const span = hi - lo;
  const maxSpan = CHUNK * BigInt(MAX_WINDOWS);
  if (span > maxSpan) { lo = hi - maxSpan; out.cappedFrom = Number(lo); }  // bound the work per pass
  out.fromBlock = Number(lo); out.toBlock = latestN;

  const logs = [];
  let windows = 0, failed = 0;
  for (let a = lo; a <= hi; a += CHUNK) {
    const b = (a + CHUNK - 1n > hi) ? hi : a + CHUNK - 1n;
    windows++;
    const part = await call('eth_getLogs', [{ address: USDC, topics: [TRANSFER, null, '0x' + pad(PAY_TO)],
      fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }]);
    if (part === null) { failed++; continue; }
    for (const l of part) logs.push(l);
  }
  out.windows = windows; out.windowsFailed = failed;
  if (logs.length === 0 && failed > 0) { out.error = 'getLogs_failed_all_windows'; console.log(JSON.stringify(out, null, 2)); return out; }

  const events = logs.map(l => ({
    tx: l.transactionHash, block: num(l.blockNumber),
    from: unpad(l.topics[1]), to: unpad(l.topics[2]),
    units: BigInt(l.data).toString(), usdc: Number(BigInt(l.data)) / 1e6,
  }));
  const external = events.filter(e => e.from.toLowerCase() !== PAY_TO.toLowerCase());
  const self = events.filter(e => e.from.toLowerCase() === PAY_TO.toLowerCase());

  state.lastBlock = latestN;
  state.selfCount = (state.selfCount || 0) + self.length;
  state.externalCount = (state.externalCount || 0) + external.length;
  state.externalTotalUnits = (BigInt(state.externalTotalUnits || '0') + external.reduce((s, e) => s + BigInt(e.units), 0n)).toString();
  for (const e of external) {
    if (!state.firstExternalAt) { state.firstExternalAt = out.at; state.firstExternal = e; }
    fs.appendFileSync(LOG, JSON.stringify(Object.assign({ kind: 'EXTERNAL_REVENUE', seenAt: out.at }, e)) + '\n');
  }
  for (const e of self) fs.appendFileSync(LOG, JSON.stringify(Object.assign({ kind: 'self_test', seenAt: out.at }, e)) + '\n');
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

  out.newLogs = events.length; out.externalNew = external.length; out.selfNew = self.length;
  out.externalTotalUnits = state.externalTotalUnits;
  out.externalTotalUsdc = Number(BigInt(state.externalTotalUnits)) / 1e6;
  out.selfTotal = state.selfCount;
  out.firstExternalAt = state.firstExternalAt;
  out.firstExternal = state.firstExternal || null;
  out.revenueDetected = BigInt(state.externalTotalUnits) > 0n;
  console.log(JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) run();
module.exports = { run };
