// capture-live-proof.js — one-shot evidence capture for the sovereign live money path.
// Records: raw 402 challenge body, full success headers, on-chain confirmation with RPC lag tolerance.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { ethers } = require('ethers');

const DIR = __dirname;
const PORT = 8100;
const BASE = 'http://127.0.0.1:' + PORT;
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const RPCS = ['https://base.llamarpc.com', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://1rpc.io/base'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = [];
const log = (s) => { out.push(s); console.log(s); };

function req(method, p, headers) {
  return new Promise((resolve) => {
    const u = new URL(BASE + p);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headers || {} }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', e => resolve({ status: 0, error: e.message, body: '' }));
    r.end();
  });
}

function key() {
  const c = 'C:/Users/marce/.automaton/wallet.json';
  const o = JSON.parse(fs.readFileSync(c, 'utf8'));
  let pk = null, seen = new Set();
  (function w(x) { if (!x || typeof x !== 'object' || seen.has(x)) return; seen.add(x); for (const k of Object.keys(x)) { const v = x[k]; if (typeof v === 'string') { if (!pk && /^0x[0-9a-fA-F]{64}$/.test(v)) pk = v; } else if (v && typeof v === 'object') w(v); } })(o);
  return pk;
}

(async () => {
  const signer = new ethers.Wallet(key());
  const DOMAIN = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
  const TYPES = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] };

  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srv = ''; child.stdout.on('data', d => srv += d); child.stderr.on('data', d => srv += d);

  try {
    for (let i = 0; i < 40; i++) { const h = await req('GET', '/health'); if (h.status === 200) break; await sleep(300); }

    // --- A. raw 402 challenge ---
    const c1 = await req('GET', '/v1/uuid', { 'X-PAYMENT-AUTH': 'x' });
    log('=== A. RAW 402 CHALLENGE (status ' + c1.status + ') ===');
    log('www-authenticate: ' + c1.headers['www-authenticate']);
    let cj = null; try { cj = JSON.parse(c1.body); } catch (e) {}
    log('body keys: ' + (cj ? Object.keys(cj).join(',') : 'unparseable'));
    log('accepts: ' + JSON.stringify(cj && cj.accepts, null, 1));

    const amt = (cj && cj.accepts && cj.accepts[0] && (cj.accepts[0].maxAmountRequired || cj.accepts[0].amount)) || '1000';

    // --- B. real signed payment ---
    const now = Math.floor(Date.now() / 1000);
    const auth = { from: signer.address, to: PAY_TO, value: String(amt), validAfter: String(now - 120), validBefore: String(now + 3600), nonce: ethers.hexlify(ethers.randomBytes(32)) };
    const signature = await signer.signTypedData(DOMAIN, TYPES, auth);
    const env = Buffer.from(JSON.stringify({ payload: auth, signature })).toString('base64');
    const p1 = await req('GET', '/v1/uuid', { 'X-PAYMENT-AUTH': env });
    log('\n=== B. PAID CALL RESULT (status ' + p1.status + ') ===');
    log('ALL response headers relevant:');
    for (const k of Object.keys(p1.headers)) if (/payment|x-|ledger/i.test(k)) log('  ' + k + ': ' + p1.headers[k]);
    const env2 = { status: p1.status, headers: p1.headers, body: p1.body.slice(0, 600), auth: { from: auth.from, to: auth.to, value: auth.value, nonce: auth.nonce } };
    fs.writeFileSync(path.join(DIR, 'live-paid-response.json'), JSON.stringify(env2, null, 2));

    // --- C. on-chain confirmation with lag tolerance ---
    log('\n=== C. ON-CHAIN CONFIRMATION ===');
    let confirmed = false;
    for (let i = 0; i < 10 && !confirmed; i++) {
      for (const url of RPCS) {
        try {
          const p = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
          const used = await new ethers.Contract(USDC, ['function authorizationState(address,bytes32) view returns (bool)'], p).authorizationState(auth.from, auth.nonce);
          if (used === true) { confirmed = true; log('authorizationState=TRUE via ' + url + ' (attempt ' + (i + 1) + ')'); break; }
        } catch (e) {}
      }
      if (!confirmed) await sleep(1500);
    }
    log('nonce consumed on-chain: ' + confirmed);
    log('nonce: ' + auth.nonce);
    log('payer: ' + auth.from + '  valueUnits: ' + auth.value);

    log('\n=== D. SERVER LOG (settlement lines) ===');
    srv.split('\n').filter(l => /sovereign|settle|SETTLED|broadcast/i.test(l)).forEach(l => log('  ' + l.trim()));

    fs.writeFileSync(path.join(DIR, 'LIVE-MONEY-PATH-EVIDENCE.txt'), out.join('\n'));
    log('\nEvidence written: LIVE-MONEY-PATH-EVIDENCE.txt');
  } catch (e) {
    log('ERROR: ' + e.message);
  } finally { try { child.kill(); } catch (e) {} }
  process.exit(0);
})();
