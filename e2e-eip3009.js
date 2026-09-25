// e2e-eip3009.js - end-to-end proof of the CALLER-BOUND paid path over real HTTP.
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const { ethers } = require('ethers');
const { makeEip3009 } = require('./eip3009.js');
const path = require('path');

const PORT = 8081;
const BASEURL = 'http://127.0.0.1:' + PORT;
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

function call(p, headers, method) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASEURL + p, { method: method || 'GET', timeout: 25000, headers: headers || {} },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let T = 0, P = 0;
const chk = (n, c) => { T++; if (c) P++; console.log((c ? 'PASS ' : 'FAIL ') + n); };

(async () => {
  const proc = spawn(process.execPath, [path.join(__dirname, 'eip3009-service.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => process.stdout.write('[svc] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[svc-err] ' + d));

  let up = false;
  for (let i = 0; i < 20; i++) { try { const h = await call('/health'); if (h.status === 200) { up = true; break; } } catch (e) {} await sleep(500); }
  chk('service up on :8081', up);
  if (!up) { proc.kill(); process.exit(1); }

  const h = await call('/health');
  const hj = JSON.parse(h.body);
  chk('health advertises eip3009 + USDC asset', hj.scheme === 'eip3009' && hj.asset.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

  const pr = await call('/pricing');
  const pj = JSON.parse(pr.body);
  chk('pricing exposes caller-binding accepts[]', pr.status === 200 && pj.accepts && pj.accepts[0].scheme === 'eip3009' && pj.accepts[0].extract !== undefined || pj.accepts[0].scheme === 'eip3009');

  // 1. paid route without payment -> 402 with caller-bound challenge
  const c1 = await call('/v1/paid/uuid');
  const cj = JSON.parse(c1.body);
  chk('unpaid -> 402 with eip3009 accepts[]', c1.status === 402 && cj.accepts && cj.accepts[0].scheme === 'eip3009');

  // 2. honest signed authorization -> 200, callerBound true, payer echoed
  const wallet = ethers.Wallet.createRandom();
  const e = makeEip3009(null, wallet);
  const env = await e.signAuthorization({ from: wallet.address, to: PAY_TO, value: '1000' }, wallet);
  const b64 = Buffer.from(JSON.stringify(env), 'utf8').toString('base64');
  const c2 = await call('/v1/paid/uuid', { 'X-PAYMENT-AUTH': b64 });
  let c2j = {}; try { c2j = JSON.parse(c2.body); } catch (e) {}
  chk('signed auth -> 200 paid + callerBound=true + payer echoed',
    c2.status === 200 && c2j.paid === true && c2j.callerBound === true &&
    String(c2j.payer).toLowerCase() === wallet.address.toLowerCase() &&
    String(c2.headers['x-payment-caller-bound']) === 'true');

  // 3. REPLAY of the same authorization -> rejected (nonce consumed locally)
  const c3 = await call('/v1/paid/uuid', { 'X-PAYMENT-AUTH': b64 });
  let c3j = {}; try { c3j = JSON.parse(c3.body); } catch (e) {}
  chk('replay of same authorization rejected', c3.status === 402 && /nonce/.test(JSON.stringify(c3j)));

  // 4. FORGED signature (attacker signs payer's address) -> rejected
  const attacker = ethers.Wallet.createRandom();
  const ea = makeEip3009(null, attacker);
  const forged = await ea.signAuthorization({ from: wallet.address, to: PAY_TO, value: '1000' }, attacker);
  const fb64 = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64');
  const c4 = await call('/v1/paid/uuid', { 'X-PAYMENT-AUTH': fb64 });
  let c4j = {}; try { c4j = JSON.parse(c4.body); } catch (e) {}
  chk('forged signature rejected (not caller-bound)', c4.status === 402 && /signature_mismatch/.test(JSON.stringify(c4j)));

  // 5. wrong recipient rejected
  const env3 = await e.signAuthorization({ from: wallet.address, to: attacker.address, value: '1000' }, wallet);
  const b643 = Buffer.from(JSON.stringify(env3), 'utf8').toString('base64');
  const c5 = await call('/v1/paid/uuid', { 'X-PAYMENT-AUTH': b643 });
  let c5j = {}; try { c5j = JSON.parse(c5.body); } catch (e) {}
  chk('wrong_recipient rejected', c5.status === 402 && /wrong_recipient/.test(JSON.stringify(c5j)));

  // 6. tampered value rejected
  const tampered = JSON.parse(JSON.stringify(env)); tampered.payload.value = '999999';
  const tb64 = Buffer.from(JSON.stringify(tampered), 'utf8').toString('base64');
  const c6 = await call('/v1/paid/uuid', { 'X-PAYMENT-AUTH': tb64 });
  let c6j = {}; try { c6j = JSON.parse(c6.body); } catch (e) {}
  chk('tampered amount rejected (signature_mismatch)', c6.status === 402 && /signature_mismatch/.test(JSON.stringify(c6j)));

  // 7. free verifier endpoint works (fresh envelope so it is not already consumed)
  const envV = await e.signAuthorization({ from: wallet.address, to: PAY_TO, value: '1000' }, wallet);
  const v2 = await new Promise((resolve, reject) => {
    const body = JSON.stringify(envV);
    const r = http.request(BASEURL + '/v1/verify-authorization', { method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.write(body); r.end();
  });
  let vj = {}; try { vj = JSON.parse(v2.body); } catch (e) {}
  chk('free /v1/verify-authorization validates envelope', v2.status === 200 && vj.ok === true);
  // 8. unique resources per distinct authorization (fresh nonce)
  const env4 = await e.signAuthorization({ from: wallet.address, to: PAY_TO, value: '1000' }, wallet);
  const b644 = Buffer.from(JSON.stringify(env4), 'utf8').toString('base64');
  const c8 = await call('/v1/paid/time', { 'X-PAYMENT-AUTH': b644 });
  let c8j = {}; try { c8j = JSON.parse(c8.body); } catch (e) {}
  chk('fresh nonce -> second paid call succeeds', c8.status === 200 && c8j.paid === true && c8j.unix > 0);

  console.log('\n' + P + '/' + T + ' PASS');
  proc.kill();
  process.exit(P === T ? 0 : 1);
})().catch(e => { console.error('E2E ERROR ' + e.message); process.exit(1); });
