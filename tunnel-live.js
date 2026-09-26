// tunnel-live.js — establish a public route to the PROVEN paid API (:8081). Decisive build.
//
// ROOT CAUSE OF PRIOR FAILURES (found, not guessed):
//   1. cloudflared QUIC registers but Cloudflare edge returns 530/1033 (transport intercepted).
//   2. My PowerShell capture passed RedirectStandardOutput AND RedirectStandardError to the SAME
//      file. Start-Process REJECTS that, so ssh never actually ran and the log stayed empty.
//      => every "no url in ssh banner" result was a BROKEN CAPTURE, not a broken tunnel.
// FIX: separate out/err files, then parse the ssh banner (localhost.run announces the URL).
// FALLBACK: cloudflared over HTTP/2 with explicit edge ipv4.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const PORT = 8081;
const CF = fs.existsSync(path.join(DIR, 'cloudflared.exe')) ? path.join(DIR, 'cloudflared.exe') : 'cloudflared';
const URL_FILE = path.join(DIR, 'paid-tunnel.url');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ps(cmd, timeout = 150000) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout });
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
  ps(`Get-Process cloudflared,ssh -ErrorAction SilentlyContinue | Stop-Process -Force`);
}
/** Start detached with SEPARATE stdout/stderr files (the bug fix). */
function startDetached(exe, args, outFile, errFile) {
  const argList = args.map(a => `'${String(a).replace(/'/g, "''")}'`).join(',');
  return ps(`try { Start-Process -FilePath '${exe}' -ArgumentList @(${argList}) -WorkingDirectory '${DIR}' -RedirectStandardOutput '${outFile}' -RedirectStandardError '${errFile}' -WindowStyle Hidden; 'STARTED' } catch { 'ERR ' + $_.Exception.Message }`);
}
async function waitForUrl(outs, errs, patterns, maxIter = 30) {
  for (let i = 0; i < maxIter; i++) {
    await sleep(1500);
    let txt = '';
    for (const f of [...outs, ...errs]) { try { txt += fs.readFileSync(f, 'utf8') + '\n'; } catch (e) {} }
    for (const p of patterns) { const m = txt.match(p); if (m) return { url: m[0], raw: txt }; }
    if (/Permission denied|Connection refused|Could not resolve|Host key verification failed|Operation timed out/i.test(txt) && i > 4) {
      return { url: null, raw: txt };
    }
  }
  let txt = '';
  for (const f of [...outs, ...errs]) { try { txt += fs.readFileSync(f, 'utf8') + '\n'; } catch (e) {} }
  return { url: null, raw: txt };
}
async function verifyPublic(url) {
  for (let i = 0; i < 8; i++) { const r = await get(url + '/health'); if (r.status === 200) return true; await sleep(3000); }
  return false;
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
  console.log('[live] local health = ' + local.status);

  // ---- Strategy 1: ssh -R via localhost.run (proven in prior sessions) ----
  const s1out = path.join(DIR, 's1.out'), s1err = path.join(DIR, 's1.err');
  console.log('[S1] localhost.run');
  console.log('[S1] start -> ' + startDetached('ssh',
    ['-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'ServerAliveInterval=30',
     '-o', 'ExitOnForwardFailure=yes', '-R', `80:localhost:${PORT}`, 'nokey@localhost.run'], s1out, s1err));
  let r = await waitForUrl([s1out], [s1err], [/https:\/\/[a-z0-9-]+\.lhr\.life/, /https:\/\/[a-z0-9-]+\.localhost\.run/]);
  if (r.url) {
    console.log('[S1] url = ' + r.url);
    if (await verifyPublic(r.url)) return finish(r.url, 'localhost.run', local.status);
    console.log('[S1] public verify failed');
  } else {
    console.log('[S1] no url. raw=' + JSON.stringify(r.raw.slice(-400)));
  }
  killAll(); await sleep(2000);

  // ---- Strategy 2: cloudflared HTTP/2 + explicit ipv4 edge ----
  const s2out = path.join(DIR, 's2.out'), s2err = path.join(DIR, 's2.err');
  console.log('[S2] cloudflared http2');
  startDetached(CF, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4'], s2out, s2err);
  r = await waitForUrl([s2out], [s2err], [/https:\/\/[a-z0-9-]+\.trycloudflare\.com/], 34);
  if (r.url) {
    console.log('[S2] url = ' + r.url);
    if (await verifyPublic(r.url)) return finish(r.url, 'cloudflared-http2', local.status);
    console.log('[S2] public verify failed (530/1033 = edge cannot route)');
  } else {
    console.log('[S2] no url. raw=' + JSON.stringify(r.raw.slice(-400)));
  }

  console.log('[live] NO public route this pass.');
  fs.writeFileSync(path.join(DIR, 'PAID-API-PUBLIC.json'), JSON.stringify({
    at: new Date().toISOString(), publicBase: null, localHealth: local.status, verified: false,
    note: 'no tunnel route; local service persisted + self-healing on :8081',
  }, null, 2));
  process.exit(2);
})();

async function finish(url, via, localStatus) {
  fs.writeFileSync(URL_FILE, url + '\n');
  const ch = await get(url + '/paid/uuid');
  const pr = await get(url + '/pricing');
  const ev = { at: new Date().toISOString(), publicBase: url, via, localHealth: localStatus, publicHealth: 200,
    publicPaidChallengeStatus: ch.status, publicPricingStatus: pr.status, verified: ch.status === 402 };
  fs.writeFileSync(path.join(DIR, 'PAID-API-PUBLIC.json'), JSON.stringify(ev, null, 2));
  console.log('[live] *** PUBLIC PAID API LIVE *** ' + url + ' via ' + via);
  console.log('[live] /health=200 /paid/uuid=' + ch.status + ' (expect 402) /pricing=' + pr.status + ' VERIFIED=' + ev.verified);
  process.exit(0);
}
