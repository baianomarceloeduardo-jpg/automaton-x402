// go-public.js — point a durable public tunnel at the PROVEN paid API (:8081) and verify it.
//
// WHY: paid-api.js settles real USDC, but only on localhost. Revenue requires the internet to
// reach it. Prior sessions used quick tunnels at :8080 (the old tangled server). This starts a
// fresh cloudflared quick tunnel at :8081, parses the URL, waits until it actually serves, and
// writes the URL + evidence. Idempotent: kills stale cloudflared first.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const DIR = __dirname;
const PORT = 8081;
const CF = fs.existsSync(path.join(DIR, 'cloudflared.exe')) ? path.join(DIR, 'cloudflared.exe') : 'cloudflared';
const LOG = path.join(DIR, 'cloudflared-paid.log');
const URL_FILE = path.join(DIR, 'paid-tunnel.url');

function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
  return String((r.stdout || '') + (r.stderr || '')).trim();
}
function get(url, timeout = 12000) {
  return new Promise(resolve => {
    let mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, headers: {}, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: 'timeout' }); });
  });
}

(async () => {
  // 0. clean slate: stop any cloudflared, truncate log
  ps(`Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force`);
  try { fs.writeFileSync(LOG, ''); } catch (e) {}

  // 1. confirm the local service is alive before tunneling
  let local = await get(`http://127.0.0.1:${PORT}/health`);
  if (local.status !== 200) {
    console.log('[go-public] local paid API not answering; starting it');
    spawnSync('node', ['-e', `require('child_process').spawn('node',['paid-api.js'],{cwd:${JSON.stringify(DIR)},detached:true,stdio:'ignore'}).unref()`]);
    await new Promise(r => setTimeout(r, 4000));
    local = await get(`http://127.0.0.1:${PORT}/health`);
  }
  console.log('[go-public] local health = ' + local.status);

  // 2. start cloudflared quick tunnel -> :8081, output to LOG
  const out = fs.openSync(LOG, 'a');
  const child = spawn(CF, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate', '--logfile', LOG], {
    cwd: DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();
  console.log('[go-public] cloudflared started pid=' + child.pid);

  // 3. parse the trycloudflare URL from the log
  let url = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    let txt = '';
    try { txt = fs.readFileSync(LOG, 'utf8'); } catch (e) {}
    const m = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) { url = m[0]; break; }
  }
  if (!url) { console.log('[go-public] FAILED to obtain tunnel URL'); process.exit(1); }
  console.log('[go-public] tunnel URL = ' + url);
  fs.writeFileSync(URL_FILE, url + '\n');

  // 4. wait until the PUBLIC url actually serves
  let pub = null;
  for (let i = 0; i < 30; i++) {
    pub = await get(url + '/health');
    if (pub.status === 200) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('[go-public] public /health = ' + pub.status);

  const ch = await get(url + '/paid/uuid');
  const pricing = await get(url + '/pricing');

  const evidence = {
    at: new Date().toISOString(),
    publicBase: url,
    localHealth: local.status,
    publicHealth: pub.status,
    publicHealthBody: pub.status === 200 ? JSON.parse(pub.body) : pub.body.slice(0, 200),
    publicPaidChallengeStatus: ch.status,
    publicPricingStatus: pricing.status,
    verified: pub.status === 200 && ch.status === 402,
  };
  fs.writeFileSync(path.join(DIR, 'PAID-API-PUBLIC.json'), JSON.stringify(evidence, null, 2));

  console.log('[go-public] public /paid/uuid (unpaid) = ' + ch.status + ' (expect 402)');
  console.log('[go-public] public /pricing = ' + pricing.status);
  console.log('[go-public] VERIFIED PUBLIC PAID API: ' + (evidence.verified ? 'YES' : 'NO'));
  console.log('[go-public] ' + url + '  ->  ' + path.join(DIR, 'PAID-API-PUBLIC.json'));
})();
