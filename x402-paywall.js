// x402-paywall.js v1.0.0 — ZERO-DEP (except ethers) drop-in x402 paywall for any Node HTTP service.
//
// WHY THIS EXISTS
// Every agent/service that wants to charge for compute hits the same three walls, and each one
// fails SILENTLY:
//   1. EIP-712 domain for USDC on Base must be exactly {name:"USD Coin",version:"2",chainId:8453,
//      verifyingContract:0x833589...} or settle returns invalid_exact_evm_missing_eip712_domain.
//   2. x402.org/facilitator is TESTNET-ONLY for mainnet callers — the default everyone picks.
//   3. A raw txHash is a BEARER credential: anyone who sees it on-chain can redeem it.
// This module ships the correct behaviour for all three, so you don't rediscover them in prod.
//
// USAGE (Express):
//   const { paywall } = require('./x402-paywall.js');
//   app.use(paywall({ priceUnits: '1000', payTo: '0x...' }));   // 0.001 USDC per call
//   // -> unpaid requests get a correct 402; paid ones proceed and get req.x402 = { payer, scheme }
//
// USAGE (raw node:http):
//   const guard = paywall({ priceUnits: '1000', payTo: '0x...' });
//   http.createServer(async (req,res) => { if (await guard(req,res)) return; /* paid: serve */ });
//
// USAGE (CLI):  node x402-paywall.js selftest   |   node x402-paywall.js demo

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHAIN_ID = 8453;
const NETWORK = 'base';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EIP712_DOMAIN = { name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC_BASE };
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Mainnet-capable facilitator. x402.org/facilitator is TESTNET-ONLY — do not use it here.
const DEFAULT_FACILITATOR = 'https://facilitator.payai.network';
const DEFAULT_RPC = 'https://mainnet.base.org';

let ethers = null;
function requireEthers() {
  if (ethers) return ethers;
  try { ethers = require('ethers'); } catch (e) {
    throw new Error('x402-paywall needs `npm i ethers` for signature recovery (0.001 USDC path).');
  }
  return ethers;
}

// ---------- rpc: protocol-aware (an http:// RPC URL must not go through https.request) ----------
function rpcCall(url, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length }, timeout: timeoutMs || 15000,
    }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { const j = JSON.parse(b); j.error ? reject(new Error(j.error.message)) : resolve(j.result); } catch (e) { reject(new Error('bad rpc json')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('rpc timeout')); });
    req.write(payload); req.end();
  });
}

async function rpcMulti(urls, method, params) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr = null;
  for (const u of list) { try { return await rpcCall(u, method, params); } catch (e) { lastErr = e; } }
  throw lastErr || new Error('no rpc');
}

function hexToBig(h) { return BigInt(h); }
function pad64(a) { return a.toLowerCase().replace(/^0x/, '').padStart(64, '0'); }
function topicToAddress(t) { return '0x' + t.slice(-40); }

// ---------- EIP-3009 verification (CALLER-BOUND: the only scheme that authenticates a payer) ----------
const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

async function verifyAuthorization({ payload, signature }, opts) {
  const { payTo, priceUnits, rpcUrls, requireOnChainNonceCheck } = opts;
  if (!payload || !signature) return { ok: false, reason: 'missing_payload_or_signature' };
  const p = payload;
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, reason: 'malformed_signature' };
  for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']) {
    if (p[k] === undefined || p[k] === null) return { ok: false, reason: 'missing_' + k };
  }
  if (String(p.to).toLowerCase() !== String(payTo).toLowerCase()) return { ok: false, reason: 'wrong_recipient' };
  let val, va, vb;
  try { val = BigInt(p.value); va = BigInt(p.validAfter); vb = BigInt(p.validBefore); }
  catch (e) { return { ok: false, reason: 'bad_numeric' }; }
  if (val < BigInt(priceUnits)) return { ok: false, reason: 'underpaid', got: val.toString(), need: String(priceUnits) };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (va > now + 60n) return { ok: false, reason: 'not_yet_valid' };
  if (vb < now - 60n) return { ok: false, reason: 'expired' };

  const { verifyTypedData } = requireEthers();
  let recovered;
  try {
    recovered = verifyTypedData(EIP712_DOMAIN, AUTH_TYPES, {
      from: p.from, to: p.to, value: p.value, validAfter: p.validAfter, validBefore: p.validBefore, nonce: p.nonce,
    }, signature);
  } catch (e) { return { ok: false, reason: 'signature_recovery_failed' }; }
  // THE caller binding: the recovered signer MUST be the claimed payer.
  if (String(recovered).toLowerCase() !== String(p.from).toLowerCase()) return { ok: false, reason: 'signer_mismatch' };

  // Replay: prefer ON-CHAIN authorizationState (no local state to lose on restart).
  if (requireOnChainNonceCheck !== false) {
    try {
      const data = '0xe94a0102' + pad64(p.from) + String(p.nonce).replace(/^0x/, '').replace(/^/, '').padStart(64, '0');
      const res = await rpcMulti(rpcUrls || [DEFAULT_RPC], 'eth_call', [{ to: USDC_BASE, data }, 'latest']);
      if (res && res !== '0x' && BigInt(res) !== 0n) return { ok: false, reason: 'nonce_already_used_onchain' };
    } catch (e) {
      // RPC unavailable: fall back to the local store below rather than silently allowing replay.
    }
  }
  return { ok: true, payer: recovered, scheme: 'eip3009', amountUnits: val.toString() };
}

// ---------- legacy `exact` (txHash) verification — kept for compat, explicitly bearer ----------
async function verifyLegacy(txHash, opts) {
  const { payTo, priceUnits, rpcUrls, confirmations } = opts;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash))) return { ok: false, reason: 'malformed_tx_hash' };
  const rpc = rpcUrls || [DEFAULT_RPC];
  let receipt, chainId;
  try {
    [receipt, chainId] = await Promise.all([
      rpcMulti(rpc, 'eth_getTransactionReceipt', [txHash]),
      rpcMulti(rpc, 'eth_chainId', []),
    ]);
  } catch (e) { return { ok: false, reason: 'rpc_unavailable' }; }
  if (!receipt) return { ok: false, reason: 'tx_not_found' };
  if (BigInt(chainId) !== BigInt(CHAIN_ID)) return { ok: false, reason: 'wrong_chain' };
  if (String(receipt.status) !== '0x1') return { ok: false, reason: 'tx_failed' };  // hex, not numeric 1
  let net = 0n, sawSelf = false, sawPayment = false;
  for (const log of (receipt.logs || [])) {
    if (String(log.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (String(log.address).toLowerCase() !== USDC_BASE.toLowerCase()) continue;
    const from = topicToAddress(log.topics[1]), to = topicToAddress(log.topics[2]);
    const value = hexToBig(log.data);
    if (from.toLowerCase() === to.toLowerCase()) { sawSelf = true; continue; }   // self-transfer moves nothing
    if (to.toLowerCase() === String(payTo).toLowerCase()) { net += value; sawPayment = true; }
  }
  if (!sawPayment) return { ok: false, reason: 'no_transfer_to_payTo' };
  if (net < BigInt(priceUnits)) return { ok: false, reason: 'underpaid_net', net: net.toString() };
  if (confirmations) {
    const head = BigInt(await rpcMulti(rpc, 'eth_blockNumber', []));
    const depth = head - BigInt(receipt.blockNumber) + 1n;
    if (depth < BigInt(confirmations)) return { ok: false, reason: 'insufficient_confirmations', depth: depth.toString() };
  }
  return { ok: true, payer: (receipt.from || ''), scheme: 'exact', bearer: true, amountUnits: net.toString() };
}

// ---------- persistent, race-safe claim store ----------
function makeClaimStore(file) {
  const done = new Set();
  const inFlight = new Set();
  try {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const j = JSON.parse(line); if (j.state === 'settled') done.add(j.key); } catch (e) {}
      }
    }
  } catch (e) {}
  return {
    // SYNCHRONOUS reservation — the race window is closed before any await happens.
    claim(key) {
      if (!key) return false;
      if (done.has(key) || inFlight.has(key)) return false;
      inFlight.add(key);
      try { fs.appendFileSync(file, JSON.stringify({ key, state: 'in_flight', at: new Date().toISOString() }) + '\n'); } catch (e) {}
      return true;
    },
    release(key) {
      inFlight.delete(key);
      try { fs.appendFileSync(file, JSON.stringify({ key, state: 'released', at: new Date().toISOString() }) + '\n'); } catch (e) {}
    },
    settle(key) {
      inFlight.delete(key); done.add(key);
      try { fs.appendFileSync(file, JSON.stringify({ key, state: 'settled', at: new Date().toISOString() }) + '\n'); } catch (e) {}
    },
    has(key) { return done.has(key); },
  };
}

// ---------- the 402 challenge ----------
function challenge(opts, req) {
  const resource = (req && (req.url || '/')) || '/';
  const common = {
    maxAmountRequired: String(opts.priceUnits), resource,
    description: opts.description || 'x402-paid compute',
    mimeType: opts.mimeType || 'application/json',
    payTo: opts.payTo, maxTimeoutSeconds: 60, asset: USDC_BASE,
  };
  return {
    x402Version: 1,
    accepts: [
      Object.assign({}, common, { scheme: 'eip3009', network: NETWORK, extra: { name: 'USD Coin', version: '2' } }),
      Object.assign({}, common, { scheme: 'exact', network: NETWORK, extra: { name: 'USDC', version: '2' } }),
    ],
    error: 'X-PAYMENT required',
    preferredScheme: 'eip3009',
    whyEip3009: 'Caller-bound by EIP-712 signature and the buyer needs 0 ETH — a facilitator pays gas. A raw txHash (scheme "exact") is a bearer credential and does not authenticate the caller.',
    facilitator: opts.facilitator || DEFAULT_FACILITATOR,
    hint: 'Sign the eip3009 payload, base64 the {payload,signature} JSON, send it as X-PAYMENT-AUTH.',
  };
}

// ---------- the paywall itself ----------
function paywall(options) {
  const opts = Object.assign({
    priceUnits: '1000', payTo: null, description: 'x402-paid compute',
    rpcUrls: [process.env.X402_RPC || DEFAULT_RPC], facilitator: DEFAULT_FACILITATOR,
    stateFile: path.join(__dirname, 'x402-paywall-claims.jsonl'),
    freeTrialPerDay: 0, confirmations: 0, requireOnChainNonceCheck: true, maxHeaderBytes: 8192,
  }, options || {});
  if (!opts.payTo || !/^0x[0-9a-fA-F]{40}$/.test(opts.payTo)) throw new Error('paywall: a valid payTo address is required');
  const store = makeClaimStore(opts.stateFile);
  const trials = new Map();

  return async function guard(req, res) {
    opts._lastChallenge = null;
    // free trial (optional)
    if (opts.freeTrialPerDay > 0) {
      const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
      const day = new Date().toISOString().slice(0, 10);
      const k = ip + '|' + day;
      const used = trials.get(k) || 0;
      if (used < opts.freeTrialPerDay) { trials.set(k, used + 1); req.x402 = { scheme: 'free_trial' }; return false; }
    }
    const authHeader = req.headers['x-payment-auth'];
    const legacyHeader = req.headers['x-payment'];

    if (authHeader) {
      if (String(authHeader).length > opts.maxHeaderBytes) return deny(res, opts, req, 'header_too_large');
      let env;
      try { env = JSON.parse(Buffer.from(String(authHeader), 'base64').toString('utf8')); }
      catch (e) { return deny(res, opts, req, 'malformed_payment_auth'); }
      if (!env || !env.payload || !env.signature) return deny(res, opts, req, 'missing_payload_or_signature');
      const claimKey = 'eip3009:' + String(env.payload.from).toLowerCase() + ':' + env.payload.nonce;
      if (!store.claim(claimKey)) return deny(res, opts, req, 'authorization_already_used');   // race closed here
      try {
        const v = await verifyAuthorization(env, opts);
        if (!v.ok) { store.release(claimKey); return deny(res, opts, req, v.reason, v); }
        store.settle(claimKey);
        req.x402 = { scheme: 'eip3009', payer: v.payer, amountUnits: v.amountUnits, callerBound: true };
        if (res.setHeader) res.setHeader('X-Payment-Caller-Bound', 'true');
        return false; // allowed
      } catch (e) { store.release(claimKey); return deny(res, opts, req, 'verify_error'); }
    }

    if (legacyHeader) {
      const tx = String(legacyHeader).trim();
      const claimKey = 'exact:' + tx.toLowerCase();
      if (!store.claim(claimKey)) return deny(res, opts, req, 'tx_already_used');
      try {
        const v = await verifyLegacy(tx, opts);
        if (!v.ok) { store.release(claimKey); return deny(res, opts, req, v.reason, v); }
        store.settle(claimKey);
        req.x402 = { scheme: 'exact', payer: v.payer, amountUnits: v.amountUnits, bearer: true };
        return false;
      } catch (e) { store.release(claimKey); return deny(res, opts, req, 'verify_error'); }
    }

    return deny(res, opts, req, 'payment_required');
  };
}

function deny(res, opts, req, reason, extra) {
  const body = Object.assign(challenge(opts, req), { reason });
  if (extra) body.detail = extra;
  const buf = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(402, {
    'content-type': 'application/json; charset=utf-8', 'content-length': buf.length,
    'www-authenticate': 'x402', 'access-control-allow-origin': '*',
  });
  res.end(buf);
  return true; // handled (denied)
}

module.exports = {
  paywall, verifyAuthorization, verifyLegacy, challenge, makeClaimStore,
  CHAIN_ID, NETWORK, USDC_BASE, EIP712_DOMAIN, DEFAULT_FACILITATOR, DEFAULT_RPC,
};

// ---------- selftest: proves the money path without touching real funds ----------
async function selftest() {
  const { Wallet } = requireEthers();
  const results = [];
  const t = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

  const payTo = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
  const payer = Wallet.createRandom();
  const attacker = Wallet.createRandom();
  const stateFile = path.join(require('os').tmpdir(), 'x402-paywall-selftest-' + Date.now() + '.jsonl');
  const guard = paywall({ priceUnits: '1000', payTo, stateFile, requireOnChainNonceCheck: false, rpcUrls: [DEFAULT_RPC] });

  function mockReq(headers) {
    return { headers: headers || {}, url: '/v1/compute', socket: { remoteAddress: '127.0.0.1' } };
  }
  function mockRes() {
    const r = { status: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { this.status = s; Object.assign(this.headers, h || {}); }, end(b) { this.body = b ? b.toString() : ''; } };
    return r;
  }
  async function envelope(wallet, overrides) {
    const now = Math.floor(Date.now() / 1000);
    const payload = Object.assign({
      from: wallet.address, to: payTo, value: '1000',
      validAfter: String(now - 10), validBefore: String(now + 600),
      nonce: '0x' + require('crypto').randomBytes(32).toString('hex'),
    }, overrides || {});
    const sig = await wallet.signTypedData(EIP712_DOMAIN, AUTH_TYPES, {
      from: payload.from, to: payload.to, value: payload.value,
      validAfter: payload.validAfter, validBefore: payload.validBefore, nonce: payload.nonce,
    });
    return { payload, signature: sig };
  }
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');

  // A. unpaid -> 402 advertising BOTH schemes
  let res = mockRes();
  let denied = await guard(mockReq({}), res);
  let body = JSON.parse(res.body);
  t('A unpaid -> 402 with both schemes', denied && res.status === 402 && body.accepts.length === 2 &&
    body.accepts.some(a => a.scheme === 'eip3009') && body.accepts.some(a => a.scheme === 'exact'), 'reason=' + body.reason);

  // B. eip3009 domain advertised correctly
  const eip = body.accepts.find(a => a.scheme === 'eip3009');
  t('B eip3009 advertises correct EIP-712 extra', eip.extra.name === 'USD Coin' && eip.extra.version === '2' && eip.asset === USDC_BASE);

  // C. valid caller-bound authorization -> allowed
  const env = await envelope(payer);
  res = mockRes();
  denied = await guard(mockReq({ 'x-payment-auth': b64(env) }), res);
  t('C valid eip3009 -> allowed, payer bound', denied === false && res.headers['X-Payment-Caller-Bound'] === 'true');

  // D. replay of the SAME authorization -> 402
  res = mockRes();
  denied = await guard(mockReq({ 'x-payment-auth': b64(env) }), res);
  t('D replay -> 402', denied === true && JSON.parse(res.body).reason === 'authorization_already_used');

  // E. forged signature (attacker signs payer's payload) -> 402
  const forged = await envelope(payer);
  forged.signature = await attacker.signTypedData(EIP712_DOMAIN, AUTH_TYPES, {
    from: forged.payload.from, to: forged.payload.to, value: forged.payload.value,
    validAfter: forged.payload.validAfter, validBefore: forged.payload.validBefore, nonce: forged.payload.nonce,
  });
  res = mockRes();
  denied = await guard(mockReq({ 'x-payment-auth': b64(forged) }), res);
  t('E forged signature -> 402 signer_mismatch', denied === true && JSON.parse(res.body).reason === 'signer_mismatch');

  // F. wrong recipient -> 402
  const wrongTo = await envelope(payer, { to: attacker.address });
  res = mockRes();
  denied = await guard(mockReq({ 'x-payment-auth': b64(wrongTo) }), res);
  t('F wrong recipient -> 402', denied === true && JSON.parse(res.body).reason === 'wrong_recipient');

  // G. tampered amount (underpaid) -> 402
  const cheap = await envelope(payer, { value: '500' });
  res = mockRes();
  denied = await guard(mockReq({ 'x-payment-auth': b64(cheap) }), res);
  t('G underpaid -> 402', denied === true && JSON.parse(res.body).reason === 'underpaid');

  // H. expired -> 402
  const old = await envelope(payer, { validAfter: String(Math.floor(Date.now() / 1000) - 7200), validBefore: String(Math.floor(Date.now() / 1000) - 3600) });
  res = mockRes();
  denied = await guard(mockReq({ 'x-payment-auth': b64(old) }), res);
  t('H expired -> 402', denied === true && JSON.parse(res.body).reason === 'expired');

  // I. RACE: two synchronous claims, only the first wins
  const store = makeClaimStore(path.join(require('os').tmpdir(), 'race-' + Date.now() + '.jsonl'));
  const first = store.claim('k1'), second = store.claim('k1');
  t('I race closed (claim is synchronous)', first === true && second === false);

  // J. RESTART-SAFE: a fresh store reloads settled claims from disk
  const persistFile = path.join(require('os').tmpdir(), 'persist-' + Date.now() + '.jsonl');
  const s1 = makeClaimStore(persistFile); s1.claim('k2'); s1.settle('k2');
  const s2 = makeClaimStore(persistFile);
  t('J restart-safe claim store', s2.has('k2') === true);

  // K. malformed header rejected before any store mutation
  res = mockRes();
  denied = await guard(mockReq({ 'x-payment-auth': 'not-base64!!!' }), res);
  t('K malformed header -> 402', denied === true && JSON.parse(res.body).reason === 'malformed_payment_auth');

  // L. legacy malformed txHash -> 402
  res = mockRes();
  denied = await guard(mockReq({ 'x-payment': '0xdeadbeef' }), res);
  t('L malformed legacy tx -> 402', denied === true && JSON.parse(res.body).reason === 'malformed_tx_hash');

  // M. challenge tells the buyer the facilitator (mainnet-capable, not x402.org)
  res = mockRes();
  await guard(mockReq({}), res);
  const ch = JSON.parse(res.body);
  t('M challenge names a mainnet facilitator', ch.facilitator === DEFAULT_FACILITATOR && !/x402\.org/.test(ch.facilitator));

  const pass = results.filter(r => r.ok).length;
  console.log('\n=== x402-paywall selftest: ' + pass + '/' + results.length + ' ===');
  try { fs.unlinkSync(stateFile); } catch (e) {}
  return pass === results.length;
}

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'selftest') selftest().then(ok => process.exit(ok ? 0 : 1));
  else if (cmd === 'demo') {
    const guard = paywall({ priceUnits: '1000', payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528' });
    const srv = http.createServer(async (req, res) => {
      if (req.url === '/free') { res.writeHead(200); return res.end('free\n'); }
      if (await guard(req, res)) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ paid: true, charged: '0.001 USDC', x402: req.x402 }));
    });
    srv.listen(8099, () => console.log('paywalled demo on http://127.0.0.1:8099 (try /free and /v1/compute)'));
  } else console.log('usage: node x402-paywall.js selftest|demo');
}
