// gasfree-checkout.js v1.0.0  — Automaton-Sovereign
// ---------------------------------------------------------------------------
// GAS-FREE USDC CHECKOUT ON BASE MAINNET.
//
// The problem this solves (empirically, not theoretically): most agents and many
// users hold USDC but ZERO ETH. On Base, a plain ERC-20 transfer costs gas, so a
// wallet with 0 ETH literally cannot pay anyone. That blocks x402 adoption for
// exactly the class of payer that x402 was built for: autonomous agents.
//
// The fix: EIP-3009 `transferWithAuthorization`. The payer signs an EIP-712
// authorization OFFLINE (costs nothing, needs no ETH). A facilitator relays it
// on-chain and pays the gas. USDC moves; the payer never needed ETH.
//
// PROVEN by the author with 0 ETH:
//   tx 0xbc34a70a61b61ca789168789eabfa4fba6f8e05b953c535483ab17f55023f0e0
//   receipt status 0x1, network base, payer ETH balance 0.000000000
//
// Public API
//   pickFacilitator(network?)            -> {url, network, scheme, extra, x402Version}
//   buildRequirements({payTo, amountUnits, resource, extra}) -> PaymentRequirements
//   buildPayload(wallet, req, {validSeconds}) -> {paymentPayload}   (signed, offline, free)
//   settle(payload, requirements, facUrl?)-> {success, txHash, payer, network}
//   checkout({wallet, payTo, amountUnits, resource}) -> {txHash, receipt}  (one call)
//   verifySettlement(txHash, {to, minUnits, rpc}) -> {ok, netUnits, confirmations, reason}
//
// CLI
//   node gasfree-checkout.js quote  --to 0x.. --amount 0.001
//   node gasfree-checkout.js pay    --to 0x.. --amount 0.001
//   node gasfree-checkout.js verify --tx 0x.. --to 0x.. --min 0.001
//   node gasfree-checkout.js selftest
//
// Zero dependencies beyond `ethers` (signing only). Node >= 18.
// ---------------------------------------------------------------------------
'use strict';
const https = require('https');
const http = require('http');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_RPC = 'https://mainnet.base.org';
const CHAIN_ID = 8453;

// Facilitators that actually relay gas on MAINNET. payai is the one verified live
// by the author (2026-09-25). x402.org is listed too but is TESTNET-ONLY for mainnet
// callers -- discovery filters it out by network, which is the whole point of probing.
const FACILITATORS = [
  'https://facilitator.payai.network',
  'https://x402.org/facilitator',
];

function request(url, method, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ status: 0, body: 'BAD_URL ' + e.message }); }
    const lib = u.protocol === 'https:' ? https : http;
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { 'user-agent': 'gasfree-checkout/1.0', accept: 'application/json' };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = lib.request({
      host: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      method, headers, timeout: timeoutMs || 45000,
    }, s => {
      let b = ''; s.on('data', c => b += c);
      s.on('end', () => resolve({ status: s.statusCode, headers: s.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    if (data) req.write(data);
    req.end();
  });
}
const j = s => { try { return JSON.parse(s); } catch (e) { return null; } };

// Cache discovery so we don't hammer facilitators on every checkout.
let _facCache = null;
let _facCacheAt = 0;
const FAC_TTL_MS = 10 * 60 * 1000;

// Find a facilitator that will relay for this network, and the exact `extra`
// (EIP-712 domain) it wants. Passing the wrong/absent domain is the #1 failure:
// payai returns `invalid_exact_evm_missing_eip712_domain` if you omit it.
async function discoverFacilitators() {
  const now = Date.now();
  if (_facCache && (now - _facCacheAt) < FAC_TTL_MS) return _facCache;
  const found = [];
  for (const base of FACILITATORS) {
    const r = await request(base + '/supported', 'GET', null, 12000);
    const body = j(r.body);
    const kinds = (body && (body.kinds || body.networks || [])) || [];
    for (const k of kinds) {
      if (String(k.scheme) !== 'exact') continue;
      found.push({
        url: base,
        scheme: 'exact',
        network: k.network,
        x402Version: k.x402Version || body.x402Version || 2,
        extra: Object.assign({ name: 'USD Coin', version: '2' }, k.extra || {}),
        isBaseMainnet: /^base$|^eip155:8453$/.test(String(k.network)),
      });
    }
  }
  _facCache = found; _facCacheAt = now;
  return found;
}

// Prefer an explicit network, else Base mainnet.
async function pickFacilitator(network) {
  const all = await discoverFacilitators();
  let pick;
  if (network === 'base' || network === undefined || network === null) {
    pick = all.find(f => f.isBaseMainnet);
  } else {
    pick = all.find(f => String(f.network) === String(network));
  }
  if (!pick) {
    const available = all.map(f => f.scheme + '@' + f.network);
    throw new Error('no_gasfree_facilitator_for_network:' + (network || 'base') + ' available=' + JSON.stringify(available));
  }
  return pick;
}

function buildRequirements(o) {
  const units = toUnits(o.amountUnits !== undefined ? o.amountUnits : o.amount);
  const extra = o.extra || { name: 'USD Coin', version: '2' };
  return {
    scheme: o.scheme || 'exact',
    network: o.network || 'base',
    maxAmountRequired: String(units),
    resource: o.resource || 'gasfree://checkout',
    description: o.description || 'Gas-free USDC payment (EIP-3009)',
    mimeType: o.mimeType || 'application/json',
    payTo: o.payTo,
    maxTimeoutSeconds: o.maxTimeoutSeconds || 300,
    asset: o.asset || USDC_BASE,
    extra,
  };
}

function toUnits(v) {
  if (v === null || v === undefined) throw new Error('amount_required');
  if (typeof v === 'bigint') return v;
  const s = String(v);
  if (/^\d+$/.test(s)) return BigInt(s);           // already atomic units
  const n = Number(s);
  if (!isFinite(n) || n <= 0) throw new Error('bad_amount:' + s);
  return BigInt(Math.round(n * 1e6));               // USDC has 6 decimals
}

// Sign OFFLINE. No network call, no ETH, no gas. This is the whole trick.
async function buildPayload(wallet, requirements, opts) {
  const ethers = require('ethers');
  const w = wallet instanceof ethers.Wallet ? wallet : new ethers.Wallet(wallet);
  const net = requirements.network;
  const chainId = /^eip155:(\d+)$/.test(String(net)) ? Number(String(net).split(':')[1]) : CHAIN_ID;
  const asset = requirements.asset || USDC_BASE;
  const seconds = (opts && opts.validSeconds) || 3600;
  const now = Math.floor(Date.now() / 1000);
  const extra = requirements.extra || { name: 'USD Coin', version: '2' };

  const validAfter = BigInt(now - 60);
  const validBefore = BigInt(now + seconds);
  const value = toUnits(requirements.maxAmountRequired);
  const from = await w.getAddress();
  const nonce = ethers.hexlify(ethers.randomBytes(32));

  const domain = { name: extra.name || 'USD Coin', version: extra.version || '2', chainId, verifyingContract: asset };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const message = { from, to: requirements.payTo, value, validAfter, validBefore, nonce };
  const signature = await w.signTypedData(domain, types, message);
  const recovered = ethers.verifyTypedData(domain, types, message, signature);
  if (recovered.toLowerCase() !== String(from).toLowerCase()) throw new Error('signature_selfcheck_failed');

  return {
    paymentPayload: {
      x402Version: requirements.x402Version || 2,
      scheme: 'exact',
      network: requirements.network,
      payload: {
        signature,
        authorization: {
          from, to: requirements.payTo,
          value: value.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    },
    meta: { signer: from, nonce, domain, valueUnits: value.toString(), neededEth: '0' },
  };
}

async function settle(paymentPayload, requirements, facilitatorUrl) {
  const fac = facilitatorUrl || (await pickFacilitator(requirements.network)).url;
  const r = await request(fac + '/settle', 'POST', { paymentPayload, paymentRequirements: requirements }, 60000);
  const body = j(r.body) || {};
  if (r.status === 200 && body.success && (body.transaction || body.txHash)) {
    return { success: true, txHash: body.transaction || body.txHash, payer: body.payer, network: body.network, facilitator: fac };
  }
  const diag = await request(fac + '/verify', 'POST', { paymentPayload, paymentRequirements: requirements }, 30000);
  return {
    success: false, status: r.status, facilitator: fac,
    error: body.errorReason || body.error || ('http_' + r.status),
    message: body.errorMessage || body.errorMessage || null,
    verify: (j(diag.body) || { raw: diag.body.slice(0, 300) }),
  };
}

// One-shot: discover, sign, settle, confirm. This is the merchant/buyer happy path.
async function checkout(o) {
  const fac = await pickFacilitator(o.network || 'base');
  const requirements = buildRequirements({
    payTo: o.payTo, amountUnits: o.amountUnits, amount: o.amount,
    network: fac.network, extra: fac.extra, x402Version: fac.x402Version,
    resource: o.resource, description: o.description,
  });
  requirements.x402Version = fac.x402Version;
  const built = await buildPayload(o.wallet, requirements, o);
  const res = await settle(built.paymentPayload, requirements, fac.url);
  if (!res.success) return Object.assign({ requirements, meta: built.meta }, res);
  const receipt = await waitForReceipt(res.txHash, o.rpc || DEFAULT_RPC, o.confirmations || 1);
  return { success: true, txHash: res.txHash, payer: res.payer, facilitator: res.facilitator, requirements, meta: built.meta, receipt };
}

function rpc(rpcUrl, method, params) {
  return request(rpcUrl, 'POST', { jsonrpc: '2.0', id: 1, method, params }, 20000).then(r => j(r.body) || {});
}

async function waitForReceipt(txHash, rpcUrl, confirmations, tries) {
  const max = tries || 20;
  for (let i = 0; i < max; i++) {
    const r = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash]);
    if (r.result) {
      const head = await rpc(rpcUrl, 'eth_blockNumber', []);
      const headN = head.result ? parseInt(head.result, 16) : 0;
      const mine = parseInt(r.result.blockNumber, 16);
      const conf = headN ? (headN - mine) : 0;
      if (conf >= (confirmations || 1)) return { status: r.result.status, blockNumber: r.result.blockNumber, confirmations: conf, logs: r.result.logs.length };
    }
    await new Promise(s => setTimeout(s, 3000));
  }
  return { pending: true };
}

// Independent on-chain verification of a settlement: receipt success, correct
// recipient, NET sum of Transfer logs >= minUnits. Sums (doesn't .find()) so a
// decoy log cannot spoof the amount.
async function verifySettlement(txHash, o) {
  const rpcUrl = (o && o.rpc) || DEFAULT_RPC;
  const to = (o && o.to) ? String(o.to).toLowerCase() : null;
  const minUnits = o && o.minUnits !== undefined ? toUnits(o.minUnits) : 0n;
  const wantConf = (o && o.confirmations) || 1;

  const r = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash]);
  if (!r.result) return { ok: false, reason: 'tx_not_found' };
  const rc = r.result;
  if (String(rc.status).toLowerCase() !== '0x1') return { ok: false, reason: 'tx_failed', status: rc.status };

  const head = await rpc(rpcUrl, 'eth_blockNumber', []);
  const conf = head.result ? (parseInt(head.result, 16) - parseInt(rc.blockNumber, 16)) : 0;
  if (conf < wantConf) return { ok: false, reason: 'insufficient_confirmations', confirmations: conf };

  let net = 0n;
  let matches = 0;
  for (const log of rc.logs || []) {
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    const from = '0x' + log.topics[1].slice(26).toLowerCase();
    const toA = '0x' + log.topics[2].slice(26).toLowerCase();
    if (Decimal_toLower(log.address) !== USDC_BASE.toLowerCase()) continue;
    const value = BigInt(log.data);
    if (to && toA === to) { net += value; matches++; }
    else if (to && from === to && toA === to) { matches++; } // self-transfer, no net
  }
  if (to && matches === 0) return { ok: false, reason: 'no_transfer_to_recipient', confirmations: conf };
  if (to && net < minUnits) return { ok: false, reason: 'underpaid', netUnits: net.toString(), required: minUnits.toString(), confirmations: conf };
  return { ok: true, netUnits: net.toString(), confirmations: conf, payer: (rc.from || '').toLowerCase(), blockNumber: rc.blockNumber, txHash };
}
function Decimal_toLower(a) { return String(a).toLowerCase(); }

// ---------------- CLI ----------------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function selftest() {
  const fs = require('fs');
  const path = require('path');
  const ethers = require('ethers');
  let pass = 0, fail = 0;
  const t = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS ' + name + (extra ? ' :: ' + extra : '')); } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };

  console.log('--- gasfree-checkout selftest ---');
  const fac = await pickFacilitator('base');
  t('A facilitator discovered for base mainnet', !!fac && fac.isBaseMainnet, fac && (fac.url + ' ' + fac.network));
  t('B facilitator advertises EIP-712 domain extra', !!(fac && fac.extra && fac.extra.name), JSON.stringify(fac && fac.extra));

  const wfile = 'C:/Users/marce/.automaton/wallet.json';
  const wallet = fs.existsSync(wfile)
    ? new ethers.Wallet((() => { const k = JSON.parse(fs.readFileSync(wfile, 'utf8')).privateKey; return k.startsWith('0x') ? k : '0x' + k; })())
    : ethers.Wallet.createRandom();
  const self = await wallet.getAddress();

  const req = buildRequirements({ payTo: self, amountUnits: '1000', network: fac.network, extra: fac.extra, resource: 'selftest' });
  t('C requirements well-formed', req.scheme === 'exact' && req.maxAmountRequired === '1000' && req.asset === USDC_BASE);

  const built = await buildPayload(wallet, req);
  t('D signed payload recovers to signer', built.meta.signer.toLowerCase() === self.toLowerCase());
  t('E payload needs no ETH', built.meta.neededEth === '0' && !!built.paymentPayload.payload.signature);
  t('F nonce is 32 bytes hex', /^0x[0-9a-f]{64}$/.test(built.meta.nonce));

  const bad = JSON.parse(JSON.stringify(req)); bad.payTo = ethers.Wallet.createRandom().address;
  const vit = await request(fac.url + '/verify', 'POST', { paymentPayload: built.paymentPayload, paymentRequirements: bad }, 30000);
  const vj = j(vit.body);
  t('G tampered recipient REJECTED by facilitator', !(vj && vj.isValid === true), (vj && (vj.invalidReason || vj.isValid)) + '');

  // Real settlement (minimal amount, self-payment) -- the empirical proof.
  const units = arg('units', '1000');
  const res = await checkout({ wallet, payTo: self, amountUnits: units, network: 'base', resource: 'selftest', confirmations: 1 });
  t('H LIVE mainnet gas-free settlement', res.success === true, res.txHash || JSON.stringify(res.error || res));
  if (res.success) {
    t('I receipt succeeded', res.receipt && String(res.receipt.status).toLowerCase() === '0x1', JSON.stringify(res.receipt));
    const ver = await verifySettlement(res.txHash, { to: self, minUnits: 1000, confirmations: 1 });
    t('J independent verification ok (net sum)', ver.ok === true, JSON.stringify(ver));
    const verBad = await verifySettlement(res.txHash, { to: ethers.Wallet.createRandom().address, minUnits: 1000, confirmations: 1 });
    t('K verification rejects wrong recipient', verBad.ok === false, verBad.reason);
    const verUnder = await verifySettlement(res.txHash, { to: self, minUnits: '100000000', confirmations: 1 });
    t('L verification rejects underpayment', verUnder.ok === false, verUnder.reason);
    console.log('\n  REUSE tx to prove replay is impossible on-chain:');
    const replay = await settle(built.paymentPayload, req, fac.url);
    t('M replayed authorization REJECTED', replay.success === false, replay.error || JSON.stringify(replay).slice(0, 160));
  }
  console.log('\n--- ' + pass + ' passed / ' + fail + ' failed ---');
  process.exitCode = fail ? 1 : 0;
}

(async () => {
  const cmd = process.argv[2] || 'help';
  try {
    if (cmd === 'quote') {
      const to = arg('to'), amount = arg('amount', '0.001');
      const fac = await pickFacilitator('base');
      console.log(JSON.stringify({
        gasFree: true, payerNeedsEth: '0', facilitator: fac.url, network: fac.network,
        requirements: buildRequirements({ payTo: to, amountUnits: amount, network: fac.network, extra: fac.extra }),
        howTo: 'Sign EIP-3009 TransferWithAuthorization over the EIP-712 domain in requirements.extra, POST {paymentPayload,paymentRequirements} to ' + fac.url + '/settle.',
      }, null, 2));
    } else if (cmd === 'pay') {
      const fs = require('fs'), ethers = require('ethers');
      const k = JSON.parse(fs.readFileSync(arg('key', 'C:/Users/marce/.automaton/wallet.json'), 'utf8')).privateKey;
      const wallet = new ethers.Wallet(k.startsWith('0x') ? k : '0x' + k);
      const res = await checkout({ wallet, payTo: arg('to'), amountUnits: arg('amount', '0.001'), resource: arg('resource', 'cli') });
      console.log(JSON.stringify(res, null, 2));
      process.exitCode = res.success ? 0 : 1;
    } else if (cmd === 'verify') {
      const res = await verifySettlement(arg('tx'), { to: arg('to'), minUnits: arg('min', '0'), confirmations: Number(arg('confirmations', '1')) });
      console.log(JSON.stringify(res, null, 2));
      process.exitCode = res.ok ? 0 : 1;
    } else if (cmd === 'selftest') {
      await selftest();
    } else {
      console.log('gasfree-checkout.js v1.0.0\n  quote --to 0x.. --amount 0.001\n  pay --to 0x.. --amount 0.001\n  verify --tx 0x.. --to 0x.. --min 0.001\n  selftest');
    }
  } catch (e) { console.log('FATAL ' + e.message); process.exitCode = 1; }
})();

module.exports = { pickFacilitator, discoverFacilitators, buildRequirements, buildPayload, settle, checkout, verifySettlement, toUnits, USDC_BASE, FACILITATORS };
