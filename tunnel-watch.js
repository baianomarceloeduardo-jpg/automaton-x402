// tunnel-watch.js — public-reachability watchdog for the Value API.
//
// DEFECT THIS FIXES (observed 2026-09-26): keepalive.ps1 printed "OK <url>" while the
// public URL was actually HTTP 530. It verified the LOCAL port only, then trusted the
// tunnel process was alive. A dead quick-tunnel holding a stale URL is indistinguishable
// from a healthy one without a PUBLIC request. This watchdog only reports success after
// a real request to the public URL returns 200.
//
// Behaviour:
//   1. local /health must be 200 (otherwise the server, not the tunnel, is the problem)
//   2. if the current tunnel.url answers 200 publicly -> reuse it (no churn)
//   3. otherwise kill cloudflared, start a fresh quick tunnel, parse the new URL,
//      and poll it until 200 or attempts are exhausted
//   4. write tunnel.url only with a PUBLICLY-VERIFIED url
//   5. exit non-zero if no public reachability was achieved
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');

const DIR = __dirname;
const PORT = 8080;
const URL_FILE = path.join(DIR, 'tunnel.url');
const LOG = path.join(DIR, 'tunnel-watch.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(m) {
  const line = new Date().toISOString() + ' ' + m;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

function req(url, ms = 12000) {
  return new Promise((resolve) => {
    let lib, u;
    try { u = new URL(url); lib = u.protocol === 'https:' ? https : http; }
    catch (e) { return resolve({ status: 0, error: 'bad_url' }); }
    const r = lib.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      timeout: ms, headers: { 'user-agent': 'automaton-tunnel-watch/1.0' } }, (res) => {
      let n = 0; res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    });
    r.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

function killCloudflared() {
  try {
    const out = execSync('tasklist /fi "imagename eq cloudflared.exe" /fo csv /nh', { encoding: 'utf8' });
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/"[^"]+","(\d+)"/);
      if (m) pids.push(m[1]);
    }
    for (const pid of pids) { try { execSync('taskkill /f /pid ' + pid, { stdio: 'ignore' }); log('killed cloudflared PID ' + pid); } catch (_) {} }
    return pids.length;
  } catch (_) { return 0; }
}

function whichCloudflared() {
  const candidates = [
    path.join(DIR, 'cloudflared.exe'),
    'C:\\root\\value-api\\cloudflared.exe',
    'C:\\root\\cloudflared.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const p = execSync('where cloudflared', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (p) return p;
  } catch (_) {}
  return null;
}

async function startTunnel(bin) {
  const logFd = fs.openSync(path.join(DIR, 'cloudflared.log'), 'a');
  const child = spawn(bin, ['tunnel', '--url', 'http://localhost:' + PORT, '--no-autoupdate'],
    { cwd: DIR, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  log('spawned cloudflared PID ' + child.pid);

  // Parse the assigned trycloudflare URL out of the log.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(1500);
    let txt = '';
    try { txt = fs.readFileSync(path.join(DIR, 'cloudflared.log'), 'utf8'); } catch (_) {}
    const hits = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (hits && hits.length) return hits[hits.length - 1];
  }
  return null;
}

(async () => {
  // 1. local must be healthy — the tunnel cannot fix a dead server.
  const local = await req('http://127.0.0.1:' + PORT + '/health');
  log('local /health -> ' + JSON.stringify(local));
  if (local.status !== 200) {
    log('FATAL: local server not healthy; start server.js first');
    process.exit(2);
  }

  // 2. reuse an existing tunnel only if it answers publicly.
  let existing = '';
  try { existing = (fs.readFileSync(URL_FILE, 'utf8').split('=').pop() || '').trim(); } catch (_) {}
  if (/^https:\/\//.test(existing)) {
    const pub = await req(existing + '/health');
    log('existing tunnel ' + existing + ' -> ' + JSON.stringify(pub));
    if (pub.status === 200) {
      fs.writeFileSync(URL_FILE, 'BASE=' + existing + '\n');
      log('REACHABLE=' + existing + ' (reused)');
      process.exit(0);
    }
  }

  const bin = whichCloudflared();
  if (!bin) { log('FATAL: cloudflared.exe not found'); process.exit(3); }
  log('cloudflared: ' + bin);

  // 3. rotate until public health is genuinely 200.
  for (let attempt = 1; attempt <= 3; attempt++) {
    killCloudflared();
    await sleep(2000);
    const url = await startTunnel(bin);
    if (!url) { log('attempt ' + attempt + ': no URL parsed'); continue; }
    log('attempt ' + attempt + ': candidate ' + url);

    for (let i = 0; i < 10; i++) {
      await sleep(2500);
      const pub = await req(url + '/health');
      if (pub.status === 200) {
        const kit = await req(url + '/x402-v2-kit.js');
        log('VERIFIED public /health=200 kit=' + kit.status);
        fs.writeFileSync(URL_FILE, 'BASE=' + url + '\n');
        log('REACHABLE=' + url);
        process.exit(0);
      }
    }
    log('attempt ' + attempt + ': public never returned 200');
  }

  log('UNREACHABLE: exhausted attempts');
  process.exit(1);
})();
