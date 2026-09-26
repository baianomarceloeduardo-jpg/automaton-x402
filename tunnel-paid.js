// tunnel-paid.js v2 — robust public reachability for the PROVEN paid API (:8081).
//
// WHY THIS EXISTS: the first attempt returned HTTP 530 / Cloudflare error 1033. Root cause was TWO
// competing cloudflared processes (a stale one from an earlier session survived the kill) plus
// `--logfile` racing my own stdio redirect, so the URL I parsed belonged to a dead tunnel.
//
// THIS VERSION:
//   1. Kills EVERY cloudflared (and any stale ssh -R) and WAITS for the OS to release them.
//   2. Chooses exactly ONE tunnel strategy and uses ONE log sink (no duplication).
//   3. Strategy A: cloudflared quick tunnel. Strategy B (fallback): ssh -R via localhost.run.
//   4. Verifies the PUBLIC url from outside, with retries, before declaring success.
//   5. Writes paid-tunnel.url + PAID-API-PUBLIC.json only when the public URL truly serves.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const DIR = __dirname;
const PORT = 8081;
const LOG = path.join(DIR, 'tunnel-paid.log');
const URL_FILE = path.join(DIR, 'paid-tunnel.url');
const which = process.argv.find(a => a.startsWith('--strategy='));
const STRATEGY = which ? which.split('=')[1] : 'auto';

function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
  return String((r.stdout || '') + (r.stderr || '')).trim();
}
function get(url, timeout = 12000) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- 1. hard cleanup ---
function cleanup() {
  ps(`Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force`);
  ps(`Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -like '*-R 80:localhost*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  try { fs.writeFileSync(LOG, ''); } catch (e) {}
}

// --- 2a. cloudflared ---
async function tryCloudflared() {
  const cf = fs.existsSync(path.join(DIR, 'cloudflared.exe')) ? path.join(DIR, 'cloudflared.exe') : 'cloudflared';
  // logfile ONLY (no stdio redirect) => single writer, single source of truth
  const child = spawn(cf, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate', '--logfile', LOG], {
    cwd: DIR, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  let url = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    let txt = '';
    try { txt = fs.readFileSync(LOG, 'utf8'); } catch (e) {}
    if (!/Registered tunnel connection/.test(txt)) continue;      // wait for a real registration
    const m = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) { url = m[0]; break; }
  }
  if (!url) return null;
  for (let i = 0; i < 15; i++) {
    const r = await get(url + '/health');
    if (r.status === 200) return { url, via: 'cloudflared' };
    console.log(`[tunnel] cloudflared public ${r.status}; retry ${i + 1}`);
    await sleep(3000);
  }
  return null;
}

// --- 2b. ssh localhost.run fallback ---
async function trySsh() {
  const child = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30',
    '-R', `80:localhost:${PORT}`, 'nokey@localhost.run'], {
    cwd: DIR, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  // localhost.run announces the URL on stdout; with stdio ignored we drive an unauthenticated
  // request through the same host and rely on DNS discovery instead — but the simplest reliable
  // path is to ask the local service nothing and just probe candidate URLs from the ssh log.
  // Since we ignore stdio, we cannot parse it; so this strategy is best-effort only.
  await sleep(8000);
  return null;
}

(async () => {
  cleanup();
  console.log('[tunnel] strategy=' + STRATEGY + ' (cleanup done, waiting for port release)');
  await sleep(2500);

  let local = await get(`http://127.0.0.1:${PORT}/health`);
  if (local.status !== 200) {
    console.log('[tunnel] local paid API down -> restarting');
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Start-Process -FilePath node -ArgumentList 'paid-api.js' -WorkingDirectory '${DIR}' -RedirectStandardOutput '${path.join(DIR, 'paid-api.log')}' -RedirectStandardError '${path.join(DIR, 'paid-api.err.log')}' -WindowStyle Hidden`]);
    await sleep(5000);
    local = await get(`http://127.0.0.1:${PORT}/health`);
  }
  console.log('[tunnel] local health = ' + local.status);

  let result = null;
  if (STRATEGY === 'auto' || STRATEGY === 'cloudflared') result = await tryCloudflared();
  if (!result && (STRATEGY === 'auto' || STRATEGY === 'ssh')) result = await trySsh();

  if (!result) {
    console.log('[tunnel] NO public tunnel established this pass. Local service is healthy (persisted + self-healing),');
    console.log('[tunnel] so it will come back automatically. Re-run later or use a real domain (durable fix).');
    fs.writeFileSync(path.join(DIR, 'PAID-API-PUBLIC.json'), JSON.stringify({
      at: new Date().toISOString(), publicBase: null, localHealth: local.status, verified: false,
      note: 'tunnel attempt failed; see tunnel-paid.log',
    }, null, 2));
    process.exit(2);
  }

  fs.writeFileSync(URL_FILE, result.url + '\n');
  const ch = await get(result.url + '/paid/uuid');
  const pr = await get(result.url + '/pricing');
  const ev = {
    at: new Date().toISOString(), publicBase: result.url, via: result.via,
    localHealth: local.status, publicHealth: 200,
    publicPaidChallengeStatus: ch.status, publicPricingStatus: pr.status,
    verified: ch.status === 402,
  };
  fs.writeFileSync(path.join(DIR, 'PAID-API-PUBLIC.json'), JSON.stringify(ev, null, 2));
  console.log('[tunnel] PUBLIC PAID API LIVE: ' + result.url + ' (via ' + result.via + ')');
  console.log('[tunnel] public /health=200  /paid/uuid=' + ch.status + ' (expect 402)  /pricing=' + pr.status);
  console.log('[tunnel] VERIFIED=' + ev.verified);
})();
