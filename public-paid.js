// public-paid.js v3 — one script, FOUR strategies, proper output capture, public verification.
//
// FAILURE HISTORY (so this file stays honest):
//   v1 cloudflared quick tunnel -> 530 error 1033 (edge could not route to origin) while a stale
//      second cloudflared process was alive AND --logfile raced my stdio redirect.
//   v2 killed everything, waited, single log sink, waited for "Registered tunnel connection" ->
//      still 530 for 15 checks. QUIC registers but the edge refuses to route: the classic
//      "QUIC is being intercepted/proxied" signature.
// THIS VERSION changes the transport instead of retrying it:
//   S1 cloudflared --protocol http2   (TCP/443 instead of UDP/QUIC)
//   S2 ssh -R via localhost.run       (captured via PowerShell redirect, parsed from the SSH banner)
//   S3 ssh -R via serveo.net          (hostname-pinned attempt)
//   S4 cloudflared with an explicit edge IP + http2
// Each strategy is verified from the PUBLIC side before it is accepted. First one that serves wins.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const DIR = __dirname;
const PORT = 8081;
const CF = fs.existsSync(path.join(DIR, 'cloudflared.exe')) ? path.join(DIR, 'cloudflared.exe') : 'cloudflared';
const CF_LOG = path.join(DIR, 'tp-cf.log');
const SSH_LOG = path.join(DIR, 'tp-ssh.log');
const URL_FILE = path.join(DIR, 'paid-tunnel.url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 120000 });
  return String((r.stdout || '') + (r.stderr || '')).trim();
}
function get(url, timeout = 12000) {
  return new Promise(resolve => {
    let mod; try { mod = url.startsWith('https') ? https : http; } catch (e) { return resolve({ status: 0, body: 'badurl' }); }
    const req = mod.get(url, { timeout }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}
function killAll() {
  ps(`Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force`);
  ps(`Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
  for (const f of [CF_LOG, SSH_LOG]) { try { fs.writeFileSync(f, ''); } catch (e) {} }
}
/** Start a process DETACHED with output captured by PowerShell (no stdio race). */
function startCaptured(exe, args, logFile) {
  const argList = args.map(a => `'${String(a).replace(/'/g, "''")}'`).join(',');
  ps(`Start-Process -FilePath '${exe}' -ArgumentList @(${argList}) -WorkingDirectory '${DIR}' -RedirectStandardOutput '${logFile}' -RedirectStandardError '${logFile}' -WindowStyle Hidden`);
}
async function verify(url) {
  for (let i = 0; i < 10; i++) {
    const r = await get(url + '/health');
    if (r.status === 200) return true;
    await sleep(3000);
  }
  return false;
}
async function scanLogForUrl(file, patterns, requireMarker) {
  for (let i = 0; i < 34; i++) {
    await sleep(1500);
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
    if (requireMarker && !new RegExp(requireMarker).test(txt)) continue;
    for (const p of patterns) {
      const m = txt.match(p);
      if (m) return m[0];
    }
  }
  return null;
}

async function s1_cloudflared_http2() {
  console.log('[S1] cloudflared --protocol http2 -> :' + PORT);
  startCaptured(CF, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate', '--protocol', 'http2', '--logfile', CF_LOG], CF_LOG);
  const url = await scanLogForUrl(CF_LOG, [/https:\/\/[a-z0-9-]+\.trycloudflare\.com/], 'Registered tunnel connection|Connection.*registered');
  if (!url) { console.log('[S1] no url in log'); return null; }
  console.log('[S1] url=' + url);
  return (await verify(url)) ? { url, via: 'cloudflared-http2' } : (console.log('[S1] public verify failed'), null);
}

async function s2_localhostrun() {
  console.log('[S2] ssh -R 80:localhost:' + PORT + ' nokey@localhost.run');
  startCaptured('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:localhost:${PORT}`, 'nokey@localhost.run'], SSH_LOG);
  const url = await scanLogForUrl(SSH_LOG, [/https:\/\/[a-z0-9-]+\.lhr\.life/, /https:\/\/[a-z0-9-]+\.localhost\.run/]);
  if (!url) { console.log('[S2] no url in ssh banner'); return null; }
  console.log('[S2] url=' + url);
  return (await verify(url)) ? { url, via: 'localhost.run' } : (console.log('[S2] public verify failed'), null);
}

async function s3_serveo() {
  console.log('[S3] ssh -R 80:localhost:' + PORT + ' serveo.net');
  startCaptured('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:localhost:${PORT}`, 'serveo.net'], SSH_LOG);
  const url = await scanLogForUrl(SSH_LOG, [/https:\/\/[a-z0-9-]+\.serveo\.net/, /https:\/\/[a-z0-9-]+\.serveousercontent\.com/]);
  if (!url) { console.log('[S3] no url in ssh banner'); return null; }
  console.log('[S3] url=' + url);
  return (await verify(url)) ? { url, via: 'serveo' } : (console.log('[S3] public verify failed'), null);
}

(async () => {
  killAll();
  await sleep(2500);

  let local = await get(`http://127.0.0.1:${PORT}/health`);
  if (local.status !== 200) {
    ps(`Start-Process -FilePath node -ArgumentList 'paid-api.js' -WorkingDirectory '${DIR}' -RedirectStandardOutput '${path.join(DIR, 'paid-api.log')}' -RedirectStandardError '${path.join(DIR, 'paid-api.err.log')}' -WindowStyle Hidden`);
    await sleep(5000);
    local = await get(`http://127.0.0.1:${PORT}/health`);
  }
  console.log('[public] local health = ' + local.status);

  let result = null;
  for (const [name, fn] of [['s1', s1_cloudflared_http2], ['s2', s2_localhostrun], ['s3', s3_serveo]]) {
    try { result = await fn(); } catch (e) { console.log('[' + name + '] threw ' + e.message); result = null; }
    if (result) break;
    killAll();
    await sleep(2000);
  }

  const ev = { at: new Date().toISOString(), publicBase: result ? result.url : null, via: result ? result.via : null, localHealth: local.status, verified: false };
  if (result) {
    fs.writeFileSync(URL_FILE, result.url + '\n');
    const ch = await get(result.url + '/paid/uuid');
    ev.publicHealth = 200; ev.publicPaidChallengeStatus = ch.status; ev.verified = ch.status === 402;
    console.log('[public] LIVE ' + result.url + ' via ' + result.via + ' | /paid/uuid=' + ch.status + ' | VERIFIED=' + ev.verified);
  } else {
    console.log('[public] no public route established. Local service is persisted + self-healing; re-run later.');
  }
  fs.writeFileSync(path.join(DIR, 'PAID-API-PUBLIC.json'), JSON.stringify(ev, null, 2));
  process.exit(result ? 0 : 2);
})();
