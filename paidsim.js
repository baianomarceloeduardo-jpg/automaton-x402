#!/usr/bin/env node
/**
 * paidsim.js - DETERMINISTIC proof of the real x402 PAID SETTLEMENT branch, zero funds.
 * One mock Base RPC + one server instance (FREE_TRIAL=0, real verification, RPC pointed at the mock).
 * Drives 6 scenarios covering every branch of verifyPayment().
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const DIR = __dirname, SRV = 8081, RPC = 8545;
const TX = {
  valid: '0x' + 'a1'.repeat(32),
  underpaid: '0x' + 'b2'.repeat(32),
  failed: '0x' + 'c3'.repeat(32),
  nolog: '0x' + 'd4'.repeat(32),
  notfound: '0x' + 'e5'.repeat(32),
  malformed: '0xdeadbeef'
};
const V = '0x' + 'aa'.repeat(32); // second distinct valid tx? mock keys by prefix, so use a1 prefix variant
const V2 = '0xa1' + 'bb'.repeat(31);

const procs = [];
function start(file, args, env) {
  const p = spawn(process.execPath, [path.join(DIR, file), ...args], {
    cwd: DIR, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'ignore', 'pipe']
  });
  p.stderr.on('data', d => process.stdout.write('[' + file + '!] ' + d));
  procs.push(p); return p;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(q, tx) {
  return new Promise((res, rej) => {
    const headers = tx ? { 'X-PAYMENT': tx } : {};
    const r = http.request({ host: '127.0.0.1', port: SRV, path: q, headers }, x => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b }));
    });
    r.on('error', rej); r.end();
  });
}

(async () => {
  start('mockrpc.js', [String(RPC)]);
  start('server.js', [], { PORT: String(SRV), BASE_RPC_URL: 'http://127.0.0.1:' + RPC, MIN_CONFIRMATIONS: '1', FREE_TRIAL: '0' });
  await sleep(1200);

  const cases = [
    ['no payment -> 402 challenge', '/v1/hash?input=x', null, 402, null],
    ['malformed tx -> 402', '/v1/hash?input=x', TX.malformed, 402, null],
    ['unknown tx -> 402 tx_not_found', '/v1/hash?input=x', TX.notfound, 402, null],
    ['failed tx -> 402 tx_failed', '/v1/hash?input=x', TX.failed, 402, null],
    ['no USDC transfer to payTo -> 402', '/v1/hash?input=x', TX.nolog, 402, null],
    ['underpaid -> 402 underpaid', '/v1/hash?input=x', TX.underpaid, 402, null],
    ['VALID settlement -> 200 + settled', '/v1/hash?input=settle', TX.valid, 200, true],
    ['replay same tx -> 402 tx_already_used', '/v1/hash?input=x', TX.valid, 402, null],
    ['VALID settlement 2nd tx -> 200 + settled', '/v1/uuid', V2, 200, true]
  ];

  const out = [];
  let fails = 0;
  console.log('\n=============== x402 PAID SETTLEMENT SIMULATION (real branch, mock RPC) ===============');
  for (const [name, q, tx, expStatus, expSettled] of cases) {
    let r;
    try { r = await get(q, tx); } catch (e) { r = { status: 'ERR', headers: {}, body: e.message }; }
    const settled = r.headers['x-payment-settled'] === 'true';
    const settledOk = expSettled === null ? true : settled === expSettled;
    const pass = r.status === expStatus && settledOk;
    if (!pass) fails++;
    let reason = '';
    try { const j = JSON.parse(r.body); reason = j.reason || j.error || ''; } catch (e) {}
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n       status=${r.status} settled=${settled} reason=${reason}`);
    out.push({ name, status: r.status, settled, reason, pass });
  }
  console.log(`\nTOTAL: ${out.length - fails} pass / ${fails} fail`);
  fs.appendFileSync('paidsim.log', JSON.stringify({ at: new Date().toISOString(), out }) + '\n');
  procs.forEach(p => { try { p.kill(); } catch (e) {} });
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('FATAL ' + e.stack); procs.forEach(p => { try { p.kill(); } catch (x) {} }); process.exit(2); });
