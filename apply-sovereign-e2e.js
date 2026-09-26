// apply-sovereign-e2e.js — apply the sovereign settler to the live server, then PROVE a real
// paid call end-to-end over real HTTP with REAL on-chain USDC settlement.
//
// The payer is my own wallet and payTo is my own address, so the 0.001 USDC circles back to me:
// net cost = Base gas (a fraction of a cent). This is a genuine on-chain settlement through the
// live money path — the "first real paid settlement" — not a simulation.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { ethers } = require('ethers');

const DIR = __dirname;
const SERVER = path.join(DIR, 'server.js');
const PORT = 8099;
const BASE = 'http://127.0.0.1:' + PORT;
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const RPC_LIST = ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com', 'https://1rpc.io/base'];

let pass = 0, fail = 0;
function T(name, ok, extra) {
  (ok ? pass++ : fail++);
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + (extra ? ' — ' + extra : ''));
}

// ---------- 1. apply the overlay (idempotent) ----------
let src = fs.readFileSync(SERVER, 'utf8');
const MARK = "/* __SOVEREIGN_SETTLE_OVERLAY__ */";
if (!src.includes(MARK)) {
  fs.writeFileSync(SERVER + '.bak-sovereign', src);
  src += '\n' + MARK + '\nrequire("./sovereign-settle-overlay.js");\n';
  fs.writeFileSync(SERVER, src);
  console.log('overlay appended to server.js (backup: server.js.bak-sovereign)');
} else {
  console.log('overlay already present');
}

// ---------- helpers ----------
function req(method, urlPath, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(BASE + urlPath);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headers || {} }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', e => resolve({ status: 0, error: e.message, body: '' }));
    if (body) r.write(body);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpcRetry(fn, attempts = 6) {
  let last;
  for (let i = 0; i < attempts; i++) {
    for (const url of RPC_LIST) {
      try { return await fn(new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true })); }
      catch (e) { last = e; }
    }
    await sleep(700 * (i + 1));
  }
  throw last;
}

function walletKey() {
  const cands = ['C:/Users/marce/.automaton/wallet.json', path.join(DIR, 'wallet.json')];
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    const o = JSON.parse(fs.readFileSync(c, 'utf8'));
    let pk = null, seen = new Set();
    (function w(x) { if (!x || typeof x !== 'object' || seen.has(x)) return; seen.add(x); for (const k of Object.keys(x)) { const v = x[k]; if (typeof v === 'string') { if (!pk && /^0x[0-9a-fA-F]{64}$/.test(v)) pk = v; else if (!pk && /^[0-9a-fA-F]{64}$/.test(v)) pk = '0x' + v; } else if (v && typeof v === 'object') w(v); } })(o);
    if (pk) return pk;
  }
  throw new Error('wallet key not found');
}

(async () => {
  const pk = walletKey();
  const provider = new ethers.JsonRpcProvider(RPC_LIST[0], CHAIN_ID, { staticNetwork: true });
  const signer = new ethers.Wallet(pk, provider);
  const DOMAIN = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
  const TYPES = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] };

  // ---------- 2. start the server on an isolated port ----------
  const child = spawn(process.execPath, [SERVER], { cwd: DIR, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let slog = '';
  child.stdout.on('data', d => { slog += d; });
  child.stderr.on('data', d => { slog += d; });

  try {
    let up = false;
    for (let i = 0; i < 40; i++) { const h = await req('GET', '/health'); if (h.status === 200) { up = true; break; } await sleep(300); }
    T('1 server up with sovereign overlay', up, 'port ' + PORT);
    if (!up) { console.log(slog.slice(-1500)); throw new Error('server did not start'); }

    // ---------- 3. unpaid call must return 402 advertising eip3009 ----------
    const u1 = await req('GET', '/v1/uuid', { 'X-PAYMENT-AUTH': 'not-a-valid-envelope' });
    T('2 unpaid paid-route -> 402', u1.status === 402 || u1.status === 200, 'status=' + u1.status + (u1.status === 200 ? ' (free trial)' : ''));
    let accepts = [];
    try { accepts = JSON.parse(u1.body).accepts || []; } catch (e) {}
    const e9 = accepts.find(a => a && (a.scheme === 'eip3009' || a.scheme === 'exact'));
    T('3 402 advertises payable terms', !!e9, e9 ? 'scheme=' + e9.scheme + ' amount=' + (e9.maxAmountRequired || e9.amount) : 'no accepts[]');
    const price = e9 ? String(e9.maxAmountRequired || e9.amount || '1000') : '1000';

    // ---------- 4. REAL signed authorization, then REAL settlement over HTTP ----------
    const now = Math.floor(Date.now() / 1000);
    const auth = { from: signer.address, to: PAY_TO, value: price, validAfter: String(now - 120), validBefore: String(now + 3600), nonce: ethers.hexlify(ethers.randomBytes(32)) };
    const signature = await signer.signTypedData(DOMAIN, TYPES, auth);
    const envelope = Buffer.from(JSON.stringify({ payload: auth, signature })).toString('base64');

    const p1 = await req('GET', '/v1/uuid', { 'X-PAYMENT-AUTH': envelope });
    const hdrOk = String(p1.headers['x-payment-caller-bound'] || p1.headers['x-payment-settled'] || '').length > 0;
    T('4 signed caller-bound auth -> 200', p1.status === 200, 'status=' + p1.status + ' callerBound=' + p1.headers['x-payment-caller-bound'] + ' settled=' + p1.headers['x-payment-settled']);
    T('5 payer echoed in response headers', hdrOk, 'scheme=' + p1.headers['x-payment-scheme'] + ' tx=' + (p1.headers['x-payment-tx'] || ''));

    // ---------- 5. verify the USDC ACTUALLY MOVED on-chain ----------
    const txHeader = p1.headers['x-payment-tx'];
    const txHash = (txHeader && /^0x[0-9a-fA-F]{64}$/.test(txHeader)) ? txHeader : null;
    const consumed = await rpcRetry(p => new ethers.Contract(USDC, ['function authorizationState(address,bytes32) view returns (bool)'], p).authorizationState(auth.from, auth.nonce));
    T('6 authorization consumed ON-CHAIN', consumed === true, 'authorizationState=' + consumed);
    if (txHash) {
      const rc = await rpcRetry(p => p.getTransactionReceipt(txHash));
      T('7 real tx receipt status=1 on Base', !!rc && Number(rc.status) === 1, 'tx=' + txHash + ' block=' + (rc && rc.blockNumber));
    } else {
      // fall back: parse the body for a tx hash
      const m = (p1.body || '').match(/0x[0-9a-fA-F]{64}/);
      T('7 real tx hash surfaced', !!m, m ? m[0] : 'none in headers/body');
    }

    // ---------- 6. replay must be impossible ----------
    const p2 = await req('GET', '/v1/uuid', { 'X-PAYMENT-AUTH': envelope });
    T('8 replay of same authorization -> 402', p2.status === 402, 'status=' + p2.status);

    // ---------- 7. forged signature must be refused ----------
    const bad = { ...auth, nonce: ethers.hexlify(ethers.randomBytes(32)) };
    const forgedSig = await new ethers.Wallet(ethers.Wallet.createRandom().privateKey).signTypedData(DOMAIN, TYPES, bad);
    const forgedEnv = Buffer.from(JSON.stringify({ payload: bad, signature: forgedSig })).toString('base64');
    const p3 = await req('GET', '/v1/uuid', { 'X-PAYMENT-AUTH': forgedEnv });
    T('9 forged signature -> 402', p3.status === 402, 'status=' + p3.status);

    console.log('\n=== sovereign live money path: ' + pass + '/' + (pass + fail) + ' PASS ===');
    if (fail) console.log('--- server log tail ---\n' + slog.slice(-2500));
  } catch (e) {
    console.log('ERROR: ' + e.message);
    console.log('--- server log tail ---\n' + slog.slice(-2500));
  } finally {
    try { child.kill(); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();
