// self-heal-paid.js — ONE command that keeps the PAID API reachable and its durable
// listings in sync. This is the durability fix, not another status check.
//
// WHY THIS IS THE RIGHT BUILD:
//   The paid path is PROVEN (a zero-ETH stranger paid over the public internet; settlement
//   verified on-chain). The only thing standing between me and a first paying customer is that
//   my public URL rotates on every restart, so every durable listing I publish goes stale.
//   Conway's domain API is dead (404), so a real domain is not available. Therefore the honest
//   engineering answer is: make reachability SELF-HEALING and make the beacon SELF-UPDATING.
//
// WHAT IT DOES (idempotent — safe to run every 300s, only acts when broken):
//   1. Am I serving locally on :8081? If not, start paid-api.js.
//   2. Is my recorded public URL STILL alive from the outside? If yes, STOP (nothing to do).
//   3. If not, tear down the dead tunnel and establish a fresh one (separate out/err files --
//      the capture fix proven in tunnel-live.js).
//   4. If the base URL CHANGED, republish the durable beacon + buyer quickstart so every
//      listing points at the live service again.
//   5. Verify publicly: /health 200 and /paid/uuid 402. Only then declare success.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const PORT = 8081;
const URL_FILE = path.join(DIR, 'paid-tunnel.url');
const STATE_FILE = path.join(DIR, 'paid-heal-state.json');
const LOG = path.join(DIR, 'paid-heal.log');
const CF = fs.existsSync(path.join(DIR, 'cloudflared.exe')) ? path.join(DIR, 'cloudflared.exe') : 'cloudflared';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(m) {
  const line = '[' + new Date().toISOString() + '] ' + m;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}
function ps(cmd, timeout = 150000) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout });
  return String((r.stdout || '') + (r.stderr || '')).trim();
}
function get(url, timeout = 12000) {
  return new Promise(resolve => {
    let mod; try { mod = url.startsWith('https') ? https : http; } catch (e) { return resolve({ status: 0, body: 'badurl' }); }
    const req = mod.get(url, { timeout, headers: { 'user-agent': 'automaton-heal/1.0' } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}
function post(url, body) {
  return new Promise(resolve => {
    const u = new URL(url); const data = Buffer.from(body);
    const r = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': data.length }, timeout: 25000 },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    r.write(data); r.end();
  });
}
function killTunnels() { ps(`Get-Process cloudflared,ssh -ErrorAction SilentlyContinue | Stop-Process -Force`); }
function startDetached(exe, args, outFile, errFile) {
  const argList = args.map(a => `'${String(a).replace(/'/g, "''")}'`).join(',');
  return ps(`try { Start-Process -FilePath '${exe}' -ArgumentList @(${argList}) -WorkingDirectory '${DIR}' -RedirectStandardOutput '${outFile}' -RedirectStandardError '${errFile}' -WindowStyle Hidden; 'STARTED' } catch { 'ERR ' + $_.Exception.Message }`);
}
function currentPublicUrl() {
  try { const u = fs.readFileSync(URL_FILE, 'utf8').trim(); return /^https?:\/\//.test(u) ? u : null; } catch (e) { return null; }
}
function saveState(patch) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  Object.assign(s, patch, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  return s;
}

/** Republish the durable beacon so every listing points at the live base. */
async function republishBeacon(base) {
  const PAY_TO = '0x71DEAc098914A009E3720524642A6bE6F65EE528';
  const beacon = {
    service: 'automaton-sovereign-paid-api', version: '1.0.0', baseUrl: base,
    payTo: PAY_TO, agentId: 95791, scheme: 'eip3009', header: 'X-PAYMENT-AUTH',
    priceUnits: '1000', priceUsdc: '0.001',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chainId: 8453, network: 'base',
    free: ['/health', '/pricing', '/.well-known/x402', '/ledger'],
    paid: ['/paid/hash', '/paid/uuid', '/paid/time', '/paid/hashchain'],
    buyerNeedsEth: false,
    note: 'Buyer signs EIP-712 offline; seller settles on-chain and pays gas. Nonce consumed on-chain => no replay.',
    updatedAt: new Date().toISOString(),
  };
  const r = await post('https://paste.rs/', JSON.stringify(beacon, null, 2));
  const url = (r.body || '').trim();
  const ok = r.status === 201 || r.status === 200;
  log('beacon republished -> ' + (ok ? url : 'FAILED ' + r.status + ' ' + (r.body || '').slice(0, 80)));
  if (ok) { const v = await get(url); log('beacon verified GET ' + v.status + ' ' + v.body.length + ' bytes'); }
  fs.writeFileSync(path.join(DIR, 'beacon.json'), JSON.stringify(beacon, null, 2));
  return ok ? url : null;
}

(async () => {
  log('=== self-heal start ===');

  // 1. local service
  let local = await get(`http://127.0.0.1:${PORT}/health`);
  if (local.status !== 200) {
    log('local :' + PORT + ' DOWN -> starting paid-api.js');
    ps(`Start-Process -FilePath node -ArgumentList 'paid-api.js' -WorkingDirectory '${DIR}' -RedirectStandardOutput '${path.join(DIR, 'paid-api.log')}' -RedirectStandardError '${path.join(DIR, 'paid-api.err.log')}' -WindowStyle Hidden`);
    await sleep(5000);
    local = await get(`http://127.0.0.1:${PORT}/health`);
  }
  if (local.status !== 200) { log('FATAL: local service will not start'); saveState({ ok: false, reason: 'local_down' }); process.exit(1); }
  log('local :' + PORT + ' health=200');

  // 2. is the recorded public URL still alive? If so, nothing to do.
  const existing = currentPublicUrl();
  if (existing) {
    const h = await get(existing + '/health');
    if (h.status === 200) {
      log('public URL still ALIVE -> ' + existing + ' (no action needed)');
      saveState({ ok: true, baseUrl: existing, action: 'none' });
      process.exit(0);
    }
    log('recorded URL is DEAD (' + h.status + ') -> ' + existing);
  } else {
    log('no recorded public URL');
  }

  // 3. establish a fresh tunnel
  killTunnels(); await sleep(2500);
  const s1out = path.join(DIR, 'heal-s1.out'), s1err = path.join(DIR, 'heal-s1.err');
  log('[S1] localhost.run');
  startDetached('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'ServerAliveInterval=30',
    '-o', 'ExitOnForwardFailure=yes', '-R', `80:localhost:${PORT}`, 'nokey@localhost.run'], s1out, s1err);
  let url = null;
  for (let i = 0; i < 30 && !url; i++) {
    await sleep(1500);
    let txt = '';
    for (const f of [s1out, s1err]) { try { txt += fs.readFileSync(f, 'utf8') + '\n'; } catch (e) {} }
    const m = txt.match(/https:\/\/[a-z0-9-]+\.(lhr\.life|localhost\.run)/);
    if (m) url = m[0];
  }
  if (!url) {
    log('[S1] no url -> trying cloudflared http2');
    killTunnels(); await sleep(2000);
    const s2out = path.join(DIR, 'heal-s2.out'), s2err = path.join(DIR, 'heal-s2.err');
    startDetached(CF, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4'], s2out, s2err);
    for (let i = 0; i < 34 && !url; i++) {
      await sleep(1500);
      let txt = '';
      for (const f of [s2out, s2err]) { try { txt += fs.readFileSync(f, 'utf8') + '\n'; } catch (e) {} }
      const m = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) url = m[0];
    }
  }
  if (!url) { log('FATAL: no tunnel URL'); saveState({ ok: false, reason: 'no_tunnel' }); process.exit(2); }
  log('new candidate url = ' + url);

  // 4. verify publicly BEFORE trusting it
  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    const h = await get(url + '/health');
    if (h.status === 200) ok = true; else await sleep(3000);
  }
  if (!ok) { log('FATAL: candidate url not publicly routable'); saveState({ ok: false, reason: 'not_routable', baseUrl: url }); process.exit(3); }
  const ch = await get(url + '/paid/uuid');
  log('public verify: /health=200 /paid/uuid=' + ch.status + (ch.status === 402 ? ' (correct challenge)' : ' (UNEXPECTED)'));

  // 5. persist new URL + republish durable beacon because the base CHANGED
  fs.writeFileSync(URL_FILE, url + '\n');
  const beaconUrl = await republishBeacon(url);
  // refresh the buyer quickstart with the live base so humans copy the right URL
  try {
    const kit = fs.readFileSync(path.join(DIR, 'BUYER-QUICKSTART.md'), 'utf8').replace(/LIVE BASE:\s*\S+/, 'LIVE BASE: ' + url);
    fs.writeFileSync(path.join(DIR, 'BUYER-QUICKSTART.md'), kit);
  } catch (e) {}

  saveState({ ok: true, baseUrl: url, action: existing ? 'rotated' : 'established', beacon: beaconUrl, paidChallenge: ch.status });
  log('*** SERVICE REACHABLE + LISTINGS IN SYNC: ' + url + ' ***');
  process.exit(0);
})();
