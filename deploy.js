// deploy.js v1.1.0 - ATOMIC public bring-up. Exactly one server, exactly one tunnel.
// v1.1.0 FIX: parseUrl() was a synchronous busy-loop (shelling `ping` for delay) that
// grepped cloudflared.log 40x within milliseconds, long before cloudflared emits its URL.
// Result: "no tunnel URL parsed" every time. Now it is truly async with real sleeps, and
// it also tolerates the transient 530/502 the edge returns while the tunnel handshakes.
'use strict';
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR = __dirname;
const PORT = 8080;
const LOG = path.join(DIR, 'cloudflared.log');
const URL_FILE = path.join(DIR, 'tunnel.url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sh(cmd) { try { return execSync(cmd, { stdio: 'pipe', shell: 'cmd.exe' }).toString(); } catch (e) { return (e.stdout || '').toString() + (e.stderr || '').toString(); } }
function ps(cmd) { return sh('powershell -NoProfile -Command "' + cmd.replace(/"/g, '\\"') + '"'); }
function log(...a) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + a.join(' ')); }

function killAll() {
  ps("Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force");
  ps("Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");
  ps("Get-NetTCPConnection -LocalPort " + PORT + " -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }");
  log('killed prior server + tunnel processes');
}

function startServer() {
  const out = fs.openSync(path.join(DIR, 'server.log'), 'a');
  const p = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: DIR, env: Object.assign({}, process.env, { PORT: String(PORT) }), detached: true, stdio: ['ignore', out, out]
  });
  p.unref();
  log('server started pid=' + p.pid);
}

function probe(url) {
  return new Promise(resolve => {
    const mod = url.indexOf('https') === 0 ? https : http;
    const req = mod.get(url, { timeout: 8000 }, res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
  });
}

async function waitLocal(tries) {
  for (let i = 0; i < (tries || 40); i++) {
    const r = await probe('http://127.0.0.1:' + PORT + '/health');
    if (r.status === 200) return true;
    await sleep(500);
  }
  return false;
}

function startTunnel() {
  if (fs.existsSync(LOG)) fs.unlinkSync(LOG);
  const cf = path.join(DIR, 'cloudflared.exe');
  if (!fs.existsSync(cf)) { log('cloudflared.exe MISSING'); return false; }
  const out = fs.openSync(LOG, 'a');
  const p = spawn(cf, ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], { cwd: DIR, detached: true, stdio: ['ignore', out, out] });
  p.unref();
  log('tunnel started pid=' + p.pid);
  return true;
}

// TRUE async wait for the quick-tunnel URL to appear in the log.
async function parseUrl(tries) {
  for (let i = 0; i < (tries || 30); i++) {
    try {
      const txt = fs.readFileSync(LOG, 'utf8');
      const m = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/.exec(txt);
      if (m) { fs.writeFileSync(URL_FILE, m[0] + '\n'); return m[0]; }
    } catch (e) {}
    await sleep(1000);
  }
  return null;
}

async function waitPublic(base, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    const r = await probe(base + '/health');
    if (r.status === 200) return true;
    await sleep(2000);
  }
  return false;
}

(async () => {
  killAll();
  await sleep(2000);
  startServer();
  if (!(await waitLocal(40))) { log('ABORT: server did not come up'); process.exit(1); }
  log('local /health 200 = true');
  if (!startTunnel()) process.exit(1);
  const base = await parseUrl(45);
  if (!base) { log('ABORT: no tunnel URL after 45s'); process.exit(1); }
  log('url ' + base);
  const pubOk = await waitPublic(base, 45);
  log('public /health 200 = ' + pubOk);
  if (!pubOk) { log('ABORT: tunnel not routable'); process.exit(1); }
  log('SUCCESS ' + base);
  process.exit(0);
})();
