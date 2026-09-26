// external-buy.js v1.0.0 — BUY from a REAL third-party x402 service with my own wallet.
//
// Why this is the decisive experiment: for ~10 sessions the loop has only ever been
// seller-side. I proved a paid call through MY OWN rail (self-funded payer). What has never
// been proven is the OTHER side: that my EIP-3009 client can pay an INDEPENDENT service on the
// open market and receive its data. If that works, I am a real participant in the x402 economy,
// not just a lonely endpoint. It also stress-tests my client against a real, unknown server.
//
// Method (honest, no guessing): read the target's own 402, harvest its error oracle by sending
// deliberate malformed payments, then attempt the correct EIP-3009 envelope. Every response is
// printed verbatim. Nothing is fabricated; if it fails, the failure is the finding.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN = 8453;
const TARGET = process.argv[2] || 'https://api.onesource.io/api/chain/block-number';
const OUT = 'EXTERNAL-BUY.json';
const rec = { target: TARGET, startedAt: new Date().toISOString(), steps: [] };
const log = (...a) => { const s = a.join(' '); rec.steps.push(s); console.log(s); };

function findEthers() {
  const cands = ['ethers', 'C:/Users/marce/automaton/node_modules/ethers', path.join(__dirname, 'node_modules/ethers'), 'C:/root/value-api/node_modules/ethers'];
  for (const c of cands) { try { return require(c); } catch (_) {} }
  return null;
}
function loadWallet() {
  const cands = ['C:/Users/marce/.automaton/wallet.json', path.join(process.env.USERPROFILE || '', '.automaton', 'wallet.json'), path.join(__dirname, 'wallet.json')];
  for (const c of cands) {
    try { const j = JSON.parse(fs.readFileSync(c, 'utf8')); if (j.privateKey || j.private_key) return { pk: j.privateKey || j.private_key, address: j.address }; } catch (_) {}
  }
  return null;
}
async function get(url, headers) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctl.signal, redirect: 'follow' });
    const body = await r.text();
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    return { status: r.status, headers: h, body };
  } catch (e) { return { status: 0, headers: {}, body: 'ERR ' + String((e && e.message) || e) }; }
  finally { clearTimeout(t); }
}

(async () => {
  const ethers = findEthers();
  const w = loadWallet();
  log('ethers=' + (ethers ? 'ok' : 'MISSING') + ' wallet=' + (w ? (w.address || 'no-address-field') : 'MISSING'));
  if (!ethers || !w || !w.pk) { log('ABORT: need ethers + wallet private key'); fs.writeFileSync(OUT, JSON.stringify(rec, null, 2)); return; }

  // STEP 1 — read the real 402 challenge.
  const r1 = await get(TARGET);
  log('STEP1 GET -> ' + r1.status + ' ct=' + (r1.headers['content-type'] || ''));
  const payHeaders = Object.keys(r1.headers).filter((k) => /pay|x402|www-auth/i.test(k));
  log('STEP1 payHeaders=' + JSON.stringify(payHeaders));
  log('STEP1 body=' + r1.body.replace(/\s+/g, ' ').slice(0, 700));
  rec.step1 = { status: r1.status, payHeaders: payHeaders, body: r1.body.slice(0, 2000) };

  let accepts = null, chosen = null;
  try {
    const j = JSON.parse(r1.body);
    accepts = j.accepts || (j.error && j.error.accepts) || null;
    if (!accepts && r1.headers['www-authenticate'] && /base64/i.test(r1.headers['www-authenticate'])) {
      try { const dec = Buffer.from(String(r1.headers['www-authenticate']).split(' ').pop(), 'base64').toString('utf8'); const jj = JSON.parse(dec); accepts = jj.accepts; } catch (_) {}
    }
  } catch (_) {}
  if (Array.isArray(accepts)) {
    log('accepts n=' + accepts.length);
    chosen = accepts.find((a) => String(a.asset || '').toLowerCase() === USDC.toLowerCase() && /8453/.test(String(a.network || ''))) || accepts[0];
    log('chosen=' + JSON.stringify(chosen).slice(0, 400));
  } else { log('no parseable accepts[] in body; will still attempt envelope'); }
  rec.accepts = accepts; rec.chosen = chosen;

  const payTo = (chosen && chosen.payTo) || null;
  const value = String((chosen && (chosen.maxAmountRequired || chosen.amount)) || '1000');
  if (!payTo) { log('ABORT: no payTo'); fs.writeFileSync(OUT, JSON.stringify(rec, null, 2)); return; }

  // STEP 2 — error oracle: send a deliberately malformed payment to learn the exact expected shape.
  for (const hdr of ['x-payment', 'payment-signature']) {
    const r = await get(TARGET, { [hdr]: 'not-base64!!' });
    log('STEP2 ' + hdr + '=garbage -> ' + r.status + ' :: ' + r.body.replace(/\s+/g, ' ').slice(0, 300));
    rec['step2_' + hdr] = { status: r.status, body: r.body.slice(0, 800) };
  }

  // STEP 3 — sign the real EIP-3009 authorization.
  const wallet = new ethers.Wallet(w.pk);
  const from = wallet.address;
  const nonce = '0x' + crypto.randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const { assertSpendAllowed } = require('./services/lib/wallet-guard');
  assertSpendAllowed({ to: payTo, amount: value, token: 'USDC', reason: 'external-buy outbound purchase' });

  const auth = { from, to: payTo, value, validAfter: '0', validBefore: String(now + 3600), nonce };
  const domain = { name: 'USD Coin', version: '2', chainId: CHAIN, verifyingContract: USDC };
  const types = { TransferWithAuthorization: [ { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] };
  const signature = await wallet.signTypedData(domain, types, auth);
  log('STEP3 signed authorization from=' + from + ' to=' + payTo + ' value=' + value + ' sig=' + signature.slice(0, 18) + '...');
  rec.authorization = { from, to: payTo, value, validBefore: auth.validBefore, nonce };

  // STEP 4 — try the standard v2 envelope, then a couple of tolerated variants.
  const variants = [
    { name: 'v2-X-PAYMENT', hdr: 'x-payment', obj: { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature, authorization: auth } } },
    { name: 'v2-PAYMENT-SIGNATURE', hdr: 'payment-signature', obj: { x402Version: 2, scheme: 'exact', network: 'eip155:8453', payload: { signature, authorization: auth } } },
    { name: 'v1ish-payload-only', hdr: 'x-payment', obj: { scheme: 'exact', network: 'eip155:8453', payload: { signature, authorization: auth } } },
  ];
  for (const v of variants) {
    const b64 = Buffer.from(JSON.stringify(v.obj)).toString('base64');
    const r = await get(TARGET, { [v.hdr]: b64 });
    log('STEP4 ' + v.name + ' -> ' + r.status + ' ' + (r.status === 200 ? '*** PAID ***' : '') + ' :: ' + r.body.replace(/\s+/g, ' ').slice(0, 420));
    rec['step4_' + v.name] = { status: r.status, body: r.body.slice(0, 1500) };
    if (r.status === 200) { rec.SUCCESS = { via: v.name, body: r.body.slice(0, 2000) }; break; }
    if (r.status === 0) break; // network dead, stop hammering
  }

  rec.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2));
  log('WROTE ' + OUT);
})();
