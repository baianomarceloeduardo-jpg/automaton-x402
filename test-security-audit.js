#!/usr/bin/env node
'use strict';
/**
 * test-security-audit.js - defensive regression suite for the Automaton-Sovereign value API.
 *
 * Boots server.js from an ISOLATED code-only copy (no keys, no state files, stubbed broadcast
 * dispatcher, throwaway attestation key) on a spare port, then attacks it. Production files in
 * this directory are never written.
 *
 *   node test-security-audit.js            full suite (needs network for Base RPC checks)
 *   OFFLINE=1 node test-security-audit.js  skip the checks that hit mainnet.base.org
 *
 * Each check is written as "the attack must FAIL"; a PASS means the defense holds.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRC = __dirname;
const PORT = parseInt(process.env.AUDIT_PORT || '18199', 10);
const OFFLINE = process.env.OFFLINE === '1';
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  -- ' + detail : '')); };

// ---------- isolated sandbox ----------
function buildSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-audit-'));
  for (const f of fs.readdirSync(SRC)) {
    if (/\.js$/.test(f) || f === 'package.json') fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  const pk = path.join(SRC, 'packages', 'x402-conformance');
  const dpk = path.join(dir, 'packages', 'x402-conformance');
  fs.mkdirSync(path.join(dpk, 'bin'), { recursive: true });
  for (const f of fs.readdirSync(pk)) if (/\.(js|json)$/.test(f)) fs.copyFileSync(path.join(pk, f), path.join(dpk, f));
  for (const f of fs.readdirSync(path.join(pk, 'bin'))) fs.copyFileSync(path.join(pk, 'bin', f), path.join(dpk, 'bin', f));
  // No outbound broadcast / diary writes from the test instance.
  fs.writeFileSync(path.join(dir, 'broadcast-dispatcher.js'),
    "module.exports={startDispatcher(){return null},HISTORY_FILE:__dirname+'/pulse-history.jsonl',dispatchOnce:async()=>null};\n");
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return dir;
}

function req(method, p, headers, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (payload) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (res) => {
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, text: d, json: j }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.setTimeout(60000, () => r.destroy(new Error('timeout')));
    if (payload) r.write(payload);
    r.end();
  });
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    const r = await req('GET', '/health');
    if (r.status === 200) return true;
    await new Promise((s) => setTimeout(s, 500));
  }
  return false;
}

// ---------- EIP-3009 helpers ----------
async function signedAuth(value) {
  const { ethers } = require('ethers');
  const w = ethers.Wallet.createRandom(); // fresh wallet: zero USDC, zero ETH
  const now = Math.floor(Date.now() / 1000);
  const msg = { from: w.address, to: '0x71DEAc098914A009E3720524642A6bE6F65EE528', value: String(value), validAfter: 0, validBefore: now + 600, nonce: ethers.hexlify(ethers.randomBytes(32)) };
  const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' };
  const types = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] };
  const signature = await w.signTypedData(domain, types, msg);
  return Buffer.from(JSON.stringify({ payload: msg, signature })).toString('base64');
}

async function main() {
  const dir = buildSandbox();
  console.log('sandbox: ' + dir);
  const env = Object.assign({}, process.env, {
    PORT: String(PORT), FREE_TRIAL: '3', NODE_ENV: 'production', TRUST_PROXY: '0',
    ATTESTATION_KEY_PATH: path.join(dir, 'audit_key.pem'), SIM_RATE_PER_MIN: '20', SIM_MAX_CONCURRENT: '4',
    SIM_RPC_URL: 'http://127.0.0.1:9' // server-side simulations hit a dead RPC: no load on mainnet from the burst test
  });
  const srv = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (c) => log += c); srv.stderr.on('data', (c) => log += c);
  let exited = null; srv.on('exit', (c) => { exited = c; });
  try {
    if (!(await waitUp())) { console.log(log.slice(-2000)); throw new Error('server did not start'); }

    // --- 1. Crash / DoS: malformed percent-encoding must not kill the process ---
    if (process.env.SKIP_CRASH !== '1') for (const p of ['/v1/domain/check?domain=%E0%A4%A', '/domain?domain=%ZZ', '/v1/x402-remediate?url=%E0%A4%A', '/v1/index/submit?url=%E0%A4%A', '/%E0%A4%A']) {
      await req('GET', p);
    }
    await new Promise((s) => setTimeout(s, 300));
    const alive = await req('GET', '/health');
    check('malformed %-encoding does not crash the server', exited === null && alive.status === 200, 'exit=' + exited + ' health=' + alive.status);

    // --- 2. EIP-3009 (X-PAYMENT-AUTH): unfunded signed authorization must not buy a paid call ---
    const auth = await signedAuth(1000);
    const r2 = await req('GET', '/v1/uuid', { 'X-PAYMENT-AUTH': auth, 'x-no-trial': '1' });
    check('EIP-3009 auth from an unfunded wallet is rejected (no free paid call)', r2.status === 402, 'status=' + r2.status + ' reason=' + (r2.json && r2.json.reason));

    // --- 3. EIP-3009 replay race: same authorization fired concurrently must succeed at most once ---
    const auth3 = await signedAuth(1000);
    const burst = await Promise.all(Array.from({ length: 6 }, () => req('GET', '/v1/uuid', { 'X-PAYMENT-AUTH': auth3, 'x-no-trial': '1' })));
    const wins = burst.filter((r) => r.status === 200).length;
    check('EIP-3009 concurrent replay of one authorization: at most 1 success', wins <= 1, 'successes=' + wins + ' statuses=' + burst.map((r) => r.status).join(','));

    // --- 4. EIP-3009 underpaid for route price (attest = 0.05 USDC) ---
    const r4 = await req('POST', '/v2/attest', { 'X-PAYMENT-AUTH': await signedAuth(1000), 'x-no-trial': '1' }, { data: 'x' });
    check('EIP-3009 auth below the route price is rejected', r4.status === 402, 'status=' + r4.status + ' reason=' + (r4.json && r4.json.reason));

    // --- 5. Free-trial bypass via spoofed client-IP headers ---
    let trialWins = 0;
    for (let i = 0; i < 8; i++) {
      const ip = '203.0.113.' + (10 + i);
      const r = await req('GET', '/v1/uuid', { 'X-Forwarded-For': ip, 'CF-Connecting-IP': ip });
      if (r.status === 200) trialWins++;
    }
    check('spoofed X-Forwarded-For / CF-Connecting-IP cannot mint extra free-trial calls', trialWins <= 3, 'free calls obtained=' + trialWins + ' (quota 3)');

    // --- 6. Legacy txHash: malformed / forged hashes rejected, no crash ---
    const r6 = await req('GET', '/v1/uuid', { 'X-PAYMENT': '0x' + 'ab'.repeat(32), 'x-no-trial': '1' });
    check('forged legacy txHash is rejected', r6.status === 402, 'status=' + r6.status + ' reason=' + (r6.json && r6.json.reason));

    // --- 7. /v2/simulate input sanitization: rejected BEFORE charging, never 5xx ---
    const bad = [
      '/v2/simulate?to=abc',
      '/v2/simulate?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&data=zz',
      '/v2/simulate?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&value=-5',
      '/v2/simulate?to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&from=0x123'
    ];
    const badRes = [];
    for (const p of bad) badRes.push((await req('GET', p, { 'x-no-trial': '1' })).status);
    const badPost = await req('POST', '/v2/simulate', { 'x-no-trial': '1' }, '{"to":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","value":{"x":1}}');
    badRes.push(badPost.status);
    check('/v2/simulate rejects malformed input with 400 before payment', badRes.every((s) => s === 400), 'statuses=' + badRes.join(','));
    const big = await req('POST', '/v2/simulate', { 'x-no-trial': '1' }, { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x' + 'aa'.repeat(200000) });
    check('/v2/simulate rejects oversized calldata/body', big.status === 400 || big.status === 413 || big.status === 0, 'status=' + big.status + (big.status === 0 ? ' (socket closed at body limit)' : ''));

    // --- 8. MCP simulate tool: free local tool must be rate-limited (no open RPC proxy) ---
    const S = require(path.join(dir, 'packages', 'x402-conformance', 'tx-simulator.js'));
    const badSim = await S.simulate({ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x' + 'aa'.repeat(200000) });
    check('simulator rejects oversized calldata without an RPC call', badSim.ok === false && /too large/.test(badSim.error || ''), badSim.error);
    const mcpBurst = await Promise.all(Array.from({ length: 30 }, (_, i) => req('POST', '/mcp', {}, { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'simulate_base_transaction', arguments: { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x18160ddd' } } })));
    const limited = mcpBurst.filter((r) => r.json && r.json.result && /rate_limited/.test(r.json.result.content[0].text)).length;
    check('MCP simulate_base_transaction is rate-limited under burst', limited > 0, limited + '/30 throttled (limit 20/min)');

    // --- 9. Error/stack-trace leakage ---
    const probes = await Promise.all([
      req('POST', '/v2/attest', { 'X-PAYMENT': 'not-base64-{{{', 'x-no-trial': '1' }, 'garbage'),
      req('POST', '/mcp', {}, '{bad json'),
      req('GET', '/v2/verify?index=-1'),
      req('POST', '/v2/merkle/prove', { 'x-no-trial': '1' }, '{"items":"notarray"}')
    ]);
    const leaks = probes.filter((r) => /at \S+ \(|node:internal|[A-Z]:\\\\|\/home\/|\.js:\d+:\d+/.test(r.text || ''));
    check('no stack traces / filesystem paths in error responses', leaks.length === 0, leaks.length ? leaks[0].text.slice(0, 160) : 'statuses=' + probes.map((r) => r.status).join(','));

    // --- 10. History record endpoint: unauthenticated live scans must be throttled ---
    const rec = [];
    for (let i = 0; i < 3; i++) rec.push((await req('GET', '/v1/x402/history/record', { 'X-Forwarded-For': '198.51.100.7' })).status);
    check('public /v1/x402/history/record is not an unauthenticated write endpoint', rec.every((s) => s === 403 || s === 429), 'statuses=' + rec.join(','));
    const localRec = await req('GET', '/v1/x402/history/record');
    check('local operator (publish-history.ps1 on 127.0.0.1) can still record', localRec.status === 200 && localRec.json && localRec.json.recorded === true, 'status=' + localRec.status);

    // --- 11. RPC resilience: simulator degrades cleanly when RPC is down ---
    const down = await S.simulate({ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x18160ddd' }, { rpcUrl: 'http://127.0.0.1:9' });
    check('simulator returns ok:false (no throw) when RPC is unreachable', down.ok === false && /rpc_unreachable/.test(down.error || ''), down.error);

    // Mock RPC: rate-limit errors must NOT be reported as reverts; real reverts must be decoded.
    let mode = 'ratelimit';
    const mock = http.createServer((q, s) => {
      let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
        const m = JSON.parse(b);
        const out = { jsonrpc: '2.0', id: m.id };
        if (m.method === 'eth_chainId') out.result = '0x2105';
        else if (m.method === 'eth_blockNumber') out.result = '0x10';
        else if (mode === 'ratelimit') out.error = { code: -32016, message: 'over rate limit' };
        else out.error = { code: 3, message: 'execution reverted: nope', data: '0x08c379a0' + '20'.padStart(64, '0') + '4'.padStart(64, '0') + Buffer.from('nope').toString('hex').padEnd(64, '0') };
        s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(out));
      });
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    const mockUrl = 'http://127.0.0.1:' + mock.address().port;
    const rl = await S.simulate({ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x18160ddd' }, { rpcUrl: mockUrl });
    check('RPC rate-limit is reported as rpc_error, not as a revert', rl.ok === false && rl.willRevert === null && /rpc_error/.test(rl.error || ''), 'ok=' + rl.ok + ' willRevert=' + rl.willRevert + ' error=' + rl.error);
    mode = 'revert';
    const rv = await S.simulate({ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x18160ddd' }, { rpcUrl: mockUrl });
    check('real revert is decoded (Error(string))', rv.ok && rv.willRevert === true && rv.revertReason === 'nope', 'reason=' + rv.revertReason);
    mock.close();

    if (!OFFLINE) {
      const live = await S.simulate({ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x18160ddd' });
      if (!live.ok && /rate limit/i.test(live.error || '')) console.log('SKIP simulator live read on Base Mainnet  -- public RPC is throttling this host (' + live.error + ')');
      else check('simulator live read on Base Mainnet (USDC.totalSupply)', live.ok && live.willRevert === false && live.estimatedGas > 0, 'ok=' + live.ok + ' willRevert=' + live.willRevert + ' gas=' + live.estimatedGas + ' block=' + live.blockNumber + (live.error ? ' error=' + live.error : ''));
    }

    // --- 12. Process still alive after the whole barrage ---
    const fin = await req('GET', '/health');
    check('server survived the full barrage', exited === null && fin.status === 200, 'exit=' + exited);
  } finally {
    srv.kill();
    // Drop the node_modules junction FIRST (link only, never its target), then the sandbox.
    const nm = path.join(dir, 'node_modules');
    let linkGone = false;
    try { fs.unlinkSync(nm); linkGone = true; } catch (e) { try { fs.rmdirSync(nm); linkGone = true; } catch (e2) {} }
    if (linkGone && !fs.existsSync(nm)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
    else console.log('sandbox left in place (junction not removed): ' + dir);
  }
  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('audit suite error: ' + e.message); process.exit(2); });
