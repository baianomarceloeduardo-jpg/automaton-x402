// restart-and-verify.js — restart the production server so disk fixes go live,
// then prove settlement on a route that is ALWAYS paid (no free-trial ambiguity).
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { ethers } = require('ethers');

const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const RPCS = ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'];
let pass = 0, fail = 0;
const ok = (n, d) => { pass++; console.log('[PASS] ' + n + (d ? ' — ' + d : '')); };
const no = (n, d) => { fail++; console.log('[FAIL] ' + n + (d ? ' — ' + d : '')); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(url, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(url, { timeout: 25000, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', e => resolve({ status: 0, headers: {}, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function rpc(url, method, params) {
  return new Promise((resolve) => {
    const u = new URL(url); const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const r = lib.request(url, { method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b).result); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end(data);
  });
}

(async () => {
  // --- 1. restart production ---
  try {
    const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*server.js*\' } | ForEach-Object { $_.ProcessId }"', { encoding: 'utf8' });
    const pids = out.split(/\s+/).filter(x => /^\d+$/.test(x));
    for (const pid of pids) { try { execSync('taskkill /PID ' + pid + ' /F', { stdio: 'ignore' }); } catch {} }
    if (pids.length) ok('1 stale production server stopped', 'pids=' + pids.join(',')); else ok('1 no stale server running', 'nothing to kill');
  } catch (e) { no('1 stale production server stopped', e.message.slice(0, 120)); }
  await sleep(1500);

  // --- 2. start fresh from patched disk ---
  const log = fs.openSync('server-restart.log', 'a');
  const child = spawn('node', ['server.js'], { cwd: process.cwd(), detached: true, stdio: ['ignore', log, log] });
  child.unref();
  let up = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const h = await req('http://127.0.0.1:8080/health');
    if (h.status === 200) { up = true; break; }
  }
  if (up) ok('2 fresh production server up on :8080', 'pid=' + child.pid); else { no('2 fresh production server up', 'no /health'); }

  // --- 3. prove the LIVE process carries the patched code ---
  // Probe a paid route twice: if the FIRST is 200, it's a free trial (expected); after exhausting
  // the trial we must get a 402 that advertises accepts[] with both schemes.
  const paid = 'http://127.0.0.1:8080/v1/uuid';
  let r = null, trialInfo = [];
  for (let i = 0; i < 4; i++) { r = await req(paid); trialInfo.push(r.status); if (r.status === 402) break; }
  let body = null; try { body = JSON.parse(r.body); } catch {}
  const acc = body && Array.isArray(body.accepts) ? body.accepts : [];
  const schemes = acc.map(a => a && a.scheme);
  if (r.status === 402 && schemes.length > 0) {
    ok('3 live process advertises accepts[] on 402', 'trial=' + JSON.stringify(trialInfo) + ' schemes=' + JSON.stringify(schemes));
  } else {
    no('3 live process advertises accepts[] on 402', 'seq=' + JSON.stringify(trialInfo) + ' status=' + r.status + ' schemes=' + JSON.stringify(schemes));
  }

  // --- 4. EIP-3009 paid call on the public URL ---
  let base = (process.env.PUBLIC_BASE || '').trim();
  if (!base && fs.existsSync('tunnel.url')) base = fs.readFileSync('tunnel.url', 'utf8').trim();
  base = base.replace(/\/+$/, '');
  const wj = JSON.parse(fs.readFileSync('C:/Users/marce/.automaton/wallet.json', 'utf8'));
  const key = wj.privateKey || wj.private_key || (wj.wallet && wj.wallet.privateKey);
  const wallet = new ethers.Wallet(key);
  const from = wallet.address;
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const now = Math.floor(Date.now() / 1000);
  const payload = { from, to: PAY_TO, value: '1000', validAfter: String(now - 60), validBefore: String(now + 3600), nonce };
  const signature = await wallet.signTypedData(
    { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC },
    { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    payload);
  const token = Buffer.from(JSON.stringify({ payload, signature }), 'utf8').toString('base64');

  // call until we get a non-free answer on the PUBLIC url
  let pub = null, pubSeq = [];
  for (let i = 0; i < 4; i++) {
    pub = await req(base + '/v1/uuid', { headers: { 'X-PAYMENT-AUTH': token, accept: 'application/json' } });
    pubSeq.push(pub.status);
    if (pub.status !== 200) break;
    const txh = pub.headers['x-payment-tx'];
    if (txh) break; // settled for real
  }
  const tx = pub.headers['x-payment-tx'];
  const cb = pub.headers['x-payment-caller-bound'];
  if (pub.status === 200 && tx && /^0x[0-9a-fA-F]{64}$/.test(String(tx))) {
    ok('4 PUBLIC paid call surfaced real tx', 'callerBound=' + cb + ' tx=' + String(tx).slice(0, 18) + '...');
  } else if (pub.status === 200) {
    no('4 PUBLIC paid call surfaced real tx', 'seq=' + JSON.stringify(pubSeq) + ' status=200 but no X-Payment-Tx (free trial or unsettled)');
  } else {
    no('4 PUBLIC paid call surfaced real tx', 'seq=' + JSON.stringify(pubSeq) + ' status=' + pub.status + ' body=' + pub.body.slice(0, 220));
  }

  // --- 5. on-chain consumption ---
  let consumed = null, used = null;
  for (let a = 0; a < 6 && consumed !== true; a++) {
    for (const u of RPCS) {
      const v = await rpc(u, 'eth_call', [{ to: USDC, data: '0x9c9f3f0a' + from.slice(2).padStart(64, '0') + nonce.slice(2).padStart(64, '0') }, 'latest']);
      if (v === '0x' + '0'.repeat(64)) { consumed = false; used = u; }
      else if (v && v !== '0x' && BigInt(v) === 1n) { consumed = true; used = u; break; }
    }
    if (consumed !== true) await sleep(1500);
  }
  if (consumed === true) ok('5 authorization consumed ON-CHAIN', 'state=TRUE via ' + used);
  else no('5 authorization consumed ON-CHAIN', 'state=' + consumed);

  // --- 6. replay refused ---
  const rep = await req(base + '/v1/uuid', { headers: { 'X-PAYMENT-AUTH': token } });
  if (rep.status === 402) ok('6 replay refused', 'status=402'); else no('6 replay refused', 'status=' + rep.status);

  console.log('\n=== restart+verify: ' + pass + '/' + (pass + fail) + ' PASS ===');
})().catch(e => { console.log('ERROR ' + e.message); process.exitCode = 1; });
