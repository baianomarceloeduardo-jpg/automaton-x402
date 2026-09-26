// prove-live-eip3009.js — verify the LIVE public paid route enforces caller-bound EIP-3009.
// Last unproven link: a real buyer hitting the public URL with X-PAYMENT-AUTH must be
// accepted when honest and rejected when forged. No funds move (verification only).
const fs = require('fs');
const path = require('path');
const https = require('https');

let ethers;
try { ethers = require('ethers'); } catch (e) { console.log('SKIP: ethers missing'); process.exit(0); }

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DOMAIN = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_BASE };
const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

function get(base, p) {
  return new Promise(resolve => {
    const u = new URL(base + p);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 40000,
      headers: { 'accept': 'application/json' } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    req.end();
  });
}

(async () => {
  const base = fs.readFileSync(path.join(__dirname, 'tunnel.url'), 'utf8').trim();
  const results = [];
  const t = (n, ok, d) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };

  // EXHAUST_TRIAL: burn the free evaluation calls for this IP so the next probe
  // hits the real paywall. Without this the probe gets a 200 and proves nothing.
  for (let i = 0; i < 4; i++) { await get(base, "/v1/uuid"); }

  // 1. What does the LIVE 402 advertise for a paid route?
  const probe = await get(base, '/v1/hash?input=live-probe');
  let ch = null; try { ch = JSON.parse(probe.body); } catch (e) {}
  t('1 live paid route returns 402', probe.status === 402, 'status=' + probe.status);
  const schemes = ch && ch.accepts ? ch.accepts.map(a => a.scheme) : [];
  t('2 live 402 advertises eip3009', schemes.indexOf('eip3009') >= 0, 'schemes=[' + schemes.join(',') + ']');
  t('3 live 402 still advertises legacy exact', schemes.indexOf('exact') >= 0);

  if (schemes.indexOf('eip3009') < 0) {
    console.log('\nRESULT: live server does NOT yet enforce caller-bound payments. Need to wire paywall into server.js paid routes.');
    process.exit(2);
  }

  // 4. Honest authorization against the live route
  const payer = ethers.Wallet.createRandom();
  const now = Math.floor(Date.now() / 1000);
  const payload = { from: payer.address, to: PAY_TO, value: '1000',
    validAfter: String(now - 10), validBefore: String(now + 600),
    nonce: '0x' + require('crypto').randomBytes(32).toString('hex') };
  const sig = await payer.signTypedData(DOMAIN, TYPES, {
    from: payload.from, to: payload.to, value: payload.value,
    validAfter: payload.validAfter, validBefore: payload.validBefore, nonce: payload.nonce,
  });
  const envB64 = Buffer.from(JSON.stringify({ payload, signature: sig })).toString('base64');

  const paid = await new Promise(resolve => {
    const u = new URL(base + '/v1/hash?input=live-probe');
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 40000,
      headers: { 'accept': 'application/json', 'x-payment-auth': envB64 } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.setTimeout(40000, () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    req.end();
  });
  t('4 honest eip3009 accepted live (200)', paid.status === 200, 'status=' + paid.status + ' body=' + paid.body.slice(0, 160));
  t('5 live response sets caller-bound header', String(paid.headers['x-payment-caller-bound'] || '') === 'true',
    'header=' + paid.headers['x-payment-caller-bound']);

  // 6. Replay the SAME authorization -> must be rejected
  const replay = await new Promise(resolve => {
    const u = new URL(base + '/v1/hash?input=live-probe');
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 40000,
      headers: { 'accept': 'application/json', 'x-payment-auth': envB64 } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR' }));
    req.end();
  });
  t('6 live replay rejected (402)', replay.status === 402, 'status=' + replay.status);

  // 7. Forged signature -> must be rejected
  const attacker = ethers.Wallet.createRandom();
  const fPayload = { from: payer.address, to: PAY_TO, value: '1000',
    validAfter: String(now - 10), validBefore: String(now + 600),
    nonce: '0x' + require('crypto').randomBytes(32).toString('hex') };
  const fSig = await attacker.signTypedData(DOMAIN, TYPES, {
    from: fPayload.from, to: fPayload.to, value: fPayload.value,
    validAfter: fPayload.validAfter, validBefore: fPayload.validBefore, nonce: fPayload.nonce,
  });
  const forgedB64 = Buffer.from(JSON.stringify({ payload: fPayload, signature: fSig })).toString('base64');
  const forged = await new Promise(resolve => {
    const u = new URL(base + '/v1/hash?input=live-probe');
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 40000,
      headers: { 'accept': 'application/json', 'x-payment-auth': forgedB64 } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR' }));
    req.end();
  });
  t('7 live forged signature rejected (402)', forged.status === 402, 'status=' + forged.status);

  const pass = results.filter(Boolean).length;
  console.log('\n=== live caller-bound money path: ' + pass + '/' + results.length + ' ===');
  console.log('LIVE BASE: ' + base);
  process.exit(pass === results.length ? 0 : 1);
})();
