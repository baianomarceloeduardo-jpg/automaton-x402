// stable-url.js v1.1.0 - attempt a STABLE public URL (free, no account).
// v1.1.0 FIXES: (a) waitPublic() was referenced but never defined -> crash; (b) the URL regex
// matched serveo's console banner (https://console.serveo.net) instead of my tunnel. Now the
// regex excludes console.* and REQUIRES the requested subdomain, so success means MY url.
// serveo.net and localhost.run accept a requested subdomain over plain SSH, giving a URL that
// survives restarts. Falls back to a cloudflared quick tunnel (rotating) if neither works.
'use strict';
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DIR = __dirname;
const PORT = 8080;
const SUB = 'automaton-sovereign';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + a.join(' '));

function sh(c, shell) { try { return execSync(c, { stdio: 'pipe', shell: shell || 'cmd.exe', timeout: 60000 }).toString(); } catch (e) { return ((e.stdout || '') + (e.stderr || '')).toString(); } }

function probe(url) {
  return new Promise(resolve => {
    const mod = url.indexOf('https') === 0 ? https : http;
    const req = mod.get(url, { timeout: 9000 }, res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
  });
}

async function waitPublic(base, tries) {
  for (let i = 0; i < (tries || 40); i++) {
    const r = await probe(base + '/health');
    if (r.status === 200) return true;
    await sleep(2000);
  }
  return false;
}

function killTunnels() {
  sh('powershell -NoProfile -Command "Get-Process cloudflared,ssh -ErrorAction SilentlyContinue | Stop-Process -Force"');
  sh('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*server.js*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"');
  sh('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ' + PORT + ' -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"');
}

function startServer() {
  const out = fs.openSync(path.join(DIR, 'server.log'), 'a');
  const p = spawn(process.execPath, [path.join(DIR, 'server.js')], { cwd: DIR, env: Object.assign({}, process.env, { PORT: String(PORT) }), detached: true, stdio: ['ignore', out, out] });
  p.unref();
}

async function waitLocal(n) { for (let i = 0; i < (n || 40); i++) { if ((await probe('http://127.0.0.1:' + PORT + '/health')).status === 200) return true; await sleep(500); } return false; }

async function trySshTunnel(provider, args) {
  const logf = path.join(DIR, 'tunnel-' + provider.replace(/[^a-z0-9]/gi, '') + '.log');
  try { if (fs.existsSync(logf)) fs.unlinkSync(logf); } catch (e) {}
  const out = fs.openSync(logf, 'a');
  const p = spawn('ssh', args, { cwd: DIR, detached: true, stdio: ['ignore', out, out] });
  p.unref();
  log(provider + ': ssh started pid=' + p.pid);
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    let txt = '';
    try { txt = fs.readFileSync(logf, 'utf8'); } catch (e) {}
    // Require MY requested subdomain; never accept the provider's console/banner URL.
    const re = new RegExp('https:\\/\\/' + SUB + '\\.[a-z0-9.-]*(serveo\\.net|lhr\\.life|localhost\\.run)', 'i');
    const m = re.exec(txt);
    if (m) return { url: 'https://' + SUB + '.' + m[1], pid: p.pid };
    if (/permission denied|connection refused|could not resolve|no such file|closed by remote host/i.test(txt)) {
      log(provider + ': ' + txt.replace(/\s+/g, ' ').slice(0, 200));
      break;
    }
  }
  try { p.kill(); } catch (e) {}
  return null;
}

(async () => {
  killTunnels();
  await sleep(1500);
  startServer();
  if (!(await waitLocal(40))) { log('ABORT: server down'); process.exit(1); }
  log('local /health 200 = true');

  const attempts = [
    { name: 'serveo', args: ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-R', SUB + ':80:localhost:' + PORT, 'serveo.net'] },
    { name: 'localhost.run', args: ['-o', 'StrictHostKeyChecking=no', '-o', 'ServerAliveInterval=30', '-R', SUB + ':80:localhost:' + PORT, 'nokey@localhost.run'] }
  ];

  for (const a of attempts) {
    const r = await trySshTunnel(a.name, a.args);
    if (!r) { log(a.name + ': no requested-subdomain URL'); continue; }
    log(a.name + ': url ' + r.url + ' -- waiting for public readiness');
    if (await waitPublic(r.url, 20)) {
      fs.writeFileSync(path.join(DIR, 'tunnel.url'), r.url + '\n');
      fs.writeFileSync(path.join(DIR, 'stable-url.json'), JSON.stringify({ provider: a.name, url: r.url, subdomain: SUB, at: new Date().toISOString(), stable: true }, null, 2));
      log('SUCCESS STABLE ' + a.name + ' -> ' + r.url);
      process.exit(0);
    }
    log(a.name + ': not routable through the public edge');
  }

  log('falling back to cloudflared quick tunnel (rotating)');
  const cfLog = path.join(DIR, 'cloudflared.log');
  try { if (fs.existsSync(cfLog)) fs.unlinkSync(cfLog); } catch (e) {}
  const out = fs.openSync(cfLog, 'a');
  const p = spawn(path.join(DIR, 'cloudflared.exe'), ['tunnel', '--url', 'http://127.0.0.1:' + PORT, '--no-autoupdate'], { cwd: DIR, detached: true, stdio: ['ignore', out, out] });
  p.unref();
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    let txt = '';
    try { txt = fs.readFileSync(cfLog, 'utf8'); } catch (e) {}
    const m = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/.exec(txt);
    if (m) {
      fs.writeFileSync(path.join(DIR, 'tunnel.url'), m[0] + '\n');
      fs.writeFileSync(path.join(DIR, 'stable-url.json'), JSON.stringify({ provider: 'cloudflared-quick', url: m[0], at: new Date().toISOString(), stable: false }, null, 2));
      if (await waitPublic(m[0], 40)) { log('SUCCESS (ROTATING) ' + m[0]); process.exit(0); }
      log('cloudflared URL parsed but not routable'); process.exit(1);
    }
  }
  log('ABORT: no tunnel URL'); process.exit(1);
})();
