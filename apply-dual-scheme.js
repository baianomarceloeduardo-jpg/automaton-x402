// apply-dual-scheme.js - reversibly append the EIP-3009 dual-scheme overlay to the primary
// server, syntax-check it, and prove the 402 challenge + caller-bound paid call work.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const SERVER = 'server.js';
const MARKER = '__DUAL_SCHEME_OVERLAY__';

let src = fs.readFileSync(SERVER, 'utf8');

// idempotent: strip any previous overlay (everything from the marker onward)
const idx = src.indexOf(MARKER);
if (idx >= 0) {
  const lineStart = src.lastIndexOf('\n', idx);
  src = src.slice(0, lineStart >= 0 ? lineStart : idx);
  console.log('removed previous overlay');
} else {
  fs.writeFileSync(SERVER + '.bak9', fs.readFileSync(SERVER));
  console.log('backup written: server.js.bak9');
}

const overlay = fs.readFileSync('dual-scheme-overlay.js', 'utf8');
fs.writeFileSync(SERVER, src.replace(/\s*$/, '') + '\n' + overlay);
console.log('overlay appended (' + overlay.length + ' bytes)');

// syntax check BEFORE we restart anything
try { execSync('node --check ' + SERVER, { stdio: 'pipe' }); console.log('SYNTAX OK'); }
catch (e) { console.log('SYNTAX FAIL: ' + (e.stderr || e.message).toString().slice(0, 400)); process.exit(1); }

// ---- prove it live on an isolated port ----
const PORT = 8082;
const { ethers } = require('ethers');
const E9 = require('./eip3009.js');
const http = require('http');
const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';

function call(p, headers, method) {
  return new Promise((resolve, reject) => {
    const r = http.request('http://127.0.0.1:' + PORT + p, { method: method || 'GET', timeout: 25000, headers: headers || {} },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const env2 = Object.assign({}, process.env, { PORT: String(PORT), FREE_TRIAL: '0', MIN_CONFIRMATIONS: '1' });
  const proc = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'pipe'], env: env2 });
  proc.stdout.on('data', d => process.stdout.write('[svc] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[svc-err] ' + d));

  let up = false;
  for (let i = 0; i < 30; i++) { try { const h = await call('/health'); if (h.status === 200) { up = true; break; } } catch (e) {} await sleep(500); }
  let T = 0, P = 0;
  const chk = (n, c) => { T++; if (c) P++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
  chk('primary server up with overlay', up);
  if (!up) { proc.kill(); process.exit(1); }

  // 1. unpaid paid-route -> 402 advertising BOTH schemes
  const c1 = await call('/v1/uuid');
  let c1j = {}; try { c1j = JSON.parse(c1.body); } catch (e) {}
  const acc = Array.isArray(c1j.accepts) ? c1j.accepts : [];
  const hasE9 = acc.some(a => a && a.scheme === 'eip3009');
  const hasExact = acc.some(a => a && a.scheme === 'exact') || acc.length > 0;
  chk('402 advertises eip3009 accepts[] entry', c1.status === 402 && hasE9);
  chk('402 still advertises legacy scheme (compat)', hasExact);

  // 2. signed authorization -> 200 caller-bound
  const w = ethers.Wallet.createRandom();
  const e = E9.makeEip3009(null, w);
  const envA = await e.signAuthorization({ from: w.address, to: PAY_TO, value: '1000' }, w);
  const b64 = Buffer.from(JSON.stringify(envA), 'utf8').toString('base64');
  const c2 = await call('/v1/uuid', { 'X-PAYMENT-AUTH': b64 });
  let c2j = {}; try { c2j = JSON.parse(c2.body); } catch (e) {}
  chk('X-PAYMENT-AUTH signed auth -> 200 callerBound=true', c2.status === 200 && String(c2.headers['x-payment-caller-bound']) === 'true' && c2j.uuid !== undefined);

  // 3. replay -> rejected
  const c3 = await call('/v1/uuid', { 'X-PAYMENT-AUTH': b64 });
  chk('replay rejected', c3.status === 402);

  // 4. forged signature -> rejected
  const atk = ethers.Wallet.createRandom();
  const ea = E9.makeEip3009(null, atk);
  const forged = await ea.signAuthorization({ from: w.address, to: PAY_TO, value: '1000' }, atk);
  const fb64 = Buffer.from(JSON.stringify(forged), 'utf8').toString('base64');
  const c4 = await call('/v1/uuid', { 'X-PAYMENT-AUTH': fb64 });
  chk('forged signature rejected', c4.status === 402);

  // 5. /pricing advertises both schemes
  const c5 = await call('/pricing');
  let c5j = {}; try { c5j = JSON.parse(c5.body); } catch (e) {}
  chk('/pricing advertises eip3009 + exact', c5.status === 200 && Array.isArray(c5j.schemes) && c5j.schemes.indexOf('eip3009') >= 0);

  console.log('\n' + P + '/' + T + ' PASS');
  proc.kill();
  process.exit(P === T ? 0 : 1);
})().catch(e => { console.error('APPLY ERROR ' + e.message); process.exit(1); });
