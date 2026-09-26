// public-money-proof.js — verify the PUBLIC tunnel serves the corrected money path.
// Steps: resolve base URL -> find local port -> public 402 must advertise accepts[] (both schemes)
//        -> signed EIP-3009 paid call over PUBLIC url -> 200 + X-Payment-Tx
//        -> confirm authorization consumed on-chain.
// Zero third-party deps beyond ethers (used for EIP-712 signing only).

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

function get(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: 20000, headers: { accept: 'application/json' } }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
  });
}

function getAuth(url, token) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: 20000, headers: { accept: 'application/json', 'X-PAYMENT-AUTH': token } }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
  });
}

function rpc(url, method, params) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = lib.request(url, { method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b).result); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(data);
  });
}

(async () => {
  // 1. base url
  let base = (process.env.PUBLIC_BASE || '').trim();
  if (!base && fs.existsSync('tunnel.url')) base = fs.readFileSync('tunnel.url', 'utf8').trim();
  if (!base && fs.existsSync('up-url.txt')) base = fs.readFileSync('up-url.txt', 'utf8').trim();
  if (!base) { no('1 public base URL resolved', 'no tunnel.url / PUBLIC_BASE'); print(); return; }
  base = base.replace(/\/+$/, '');
  ok('1 public base URL resolved', base);

  // 2. find local port serving /health
  let port = 0;
  for (const p of [8080, 8100, 8099, 8081, 3000]) {
    const r = await get('http://127.0.0.1:' + p + '/health');
    if (r.status === 200) { port = p; break; }
  }
  if (!port) { no('2 local server port found', 'no /health on 8080/8100/8099/8081/3000'); print(); return; }
  ok('2 local server port found', ':' + port);

  // 3. public 402 must advertise accepts[]
  const paid = base + '/v1/uuid';
  const r402 = await get(paid);
  let body = null; try { body = JSON.parse(r402.body); } catch {}
  const accepts = body && Array.isArray(body.accepts) ? body.accepts : [];
  const schemes = accepts.map(a => a && a.scheme);
  if (r402.status === 402 && accepts.length > 0 && (schemes.includes('exact') || schemes.includes('eip3009'))) {
    ok('3 public 402 advertises payable terms', 'schemes=' + JSON.stringify(schemes) + ' amount=' + (accepts[0] && accepts[0].maxAmountRequired));
  } else if (r402.status === 200) {
    ok('3 public paid route reachable', 'fresh free-trial 200 (402 will come after trial)');
  } else {
    no('3 public 402 advertises payable terms', 'status=' + r402.status + ' schemes=' + JSON.stringify(schemes));
  }

  // 4. signed EIP-3009 paid call over the PUBLIC url
  const wj = JSON.parse(fs.readFileSync('C:/Users/marce/.automaton/wallet.json', 'utf8'));
  const key = wj.privateKey || wj.private_key || (wj.wallet && wj.wallet.privateKey);
  if (!key) { no('4 wallet loaded', 'no privateKey field'); print(); return; }
  const wallet = new ethers.Wallet(key);
  const from = wallet.address;

  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const value = 1000n; // 0.001 USDC
  const now = Math.floor(Date.now() / 1000);
  const payload = { from, to: PAY_TO, value: value.toString(), validAfter: String(now - 60), validBefore: String(now + 3600), nonce };
  const domain = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  };
  const signature = await wallet.signTypedData(domain, types, payload);
  const token = Buffer.from(JSON.stringify({ payload, signature }), 'utf8').toString('base64');

  const paidRes = await getAuth(paid, token);
  const tx = paidRes.headers['x-payment-tx'];
  const callerBound = paidRes.headers['x-payment-caller-bound'];
  if (paidRes.status === 200 && tx && /^0x[0-9a-fA-F]{64}$/.test(String(tx))) {
    ok('4 PUBLIC paid call settled', 'status=200 callerBound=' + callerBound + ' tx=' + String(tx).slice(0, 18) + '...');
  } else if (paidRes.status === 200) {
    no('4 PUBLIC paid call settled', 'status=200 but X-Payment-Tx missing');
  } else {
    no('4 PUBLIC paid call settled', 'status=' + paidRes.status + ' body=' + paidRes.body.slice(0, 200));
  }

  // 5. on-chain confirmation (with RPC lag tolerance)
  let consumed = null, usedRpc = null;
  for (let attempt = 1; attempt <= 5 && consumed !== true; attempt++) {
    for (const r of RPCS) {
      const v = await rpc(r, 'eth_call', [{ to: USDC, data: '0x9c9f3f0a' + from.slice(2).padStart(64, '0') + nonce.slice(2).padStart(64, '0') }, 'latest']);
      if (v && v !== '0x' && BigInt(v) === 1n) { consumed = true; usedRpc = r; break; }
      if (v === '0x' + '0'.repeat(64)) { consumed = false; usedRpc = r; }
    }
    if (consumed !== true) await new Promise(r => setTimeout(r, 1500));
  }
  if (consumed === true) ok('5 authorization consumed ON-CHAIN', 'authorizationState=TRUE via ' + usedRpc);
  else no('5 authorization consumed ON-CHAIN', 'state=' + consumed + ' (rpc lag or not settled)');

  // 6. replay must be refused
  const replay = await getAuth(paid, token);
  if (replay.status === 402) ok('6 replay over PUBLIC url refused', 'status=402');
  else no('6 replay over PUBLIC url refused', 'status=' + replay.status);

  print();
})().catch(e => { console.log('ERROR ' + e.message); process.exitCode = 1; });

function print() {
  console.log('\n=== PUBLIC money path: ' + pass + '/' + (pass + fail) + ' PASS ===');
}
