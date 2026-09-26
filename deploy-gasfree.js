// deploy-gasfree.js — restart the local server onto the patched code, ensure the
// public tunnel, then prove the gas-free routes are reachable PUBLICLY.
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const sleep = ms => new Promise(s => setTimeout(s, ms));
function log(s) { console.log(s); }

function get(url, tmo) {
  return new Promise(resolve => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: tmo || 30000 }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', e => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
  });
}

(async () => {
  // 1) find and kill ONLY the node process serving :8080 (by port owner)
  let pids = [];
  try {
    const out = execSync('netstat -ano | findstr ":8080" | findstr LISTENING', { encoding: 'utf8' });
    pids = [...new Set(out.split(/\r?\n/).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))];
  } catch (e) {}
  log('port 8080 listeners: ' + (pids.join(',') || 'none'));
  for (const pid of pids) { try { execSync('taskkill /PID ' + pid + ' /F', { stdio: 'pipe' }); log('killed ' + pid); } catch (e) { log('kill ' + pid + ' failed: ' + e.message.slice(0, 60)); } }
  await sleep(1500);

  // 2) start the patched server detached
  const outFd = fs.openSync(path.join(__dirname, 'server.log'), 'a');
  const errFd = fs.openSync(path.join(__dirname, 'server.err.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, detached: true, stdio: ['ignore', outFd, errFd],
    env: Object.assign({}, process.env, { PORT: '8080' }),
  });
  child.unref();
  log('spawned patched server pid ' + child.pid);

  // 3) wait for local readiness and confirm the overlay attached
  let local = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const h = await get('http://127.0.0.1:8080/health', 5000);
    if (h.status === 200) { local = h; break; }
  }
  log('local health: ' + (local ? '200 v' + (JSON.parse(local.body).version) : 'NOT UP'));
  const gfLocal = await get('http://127.0.0.1:8080/v1/gasfree-quote?amount=0.001', 30000);
  log('local /v1/gasfree-quote: ' + gfLocal.status);
  if (gfLocal.status !== 200) { log('ABORT: overlay not loaded locally, not touching tunnel'); process.exit(1); }

  // 4) ensure tunnel: reuse tunnel.url if public health is fresh, else rely on up.ps1
  let base = '';
  try { base = fs.readFileSync(path.join(__dirname, 'tunnel.url'), 'utf8').trim(); } catch (e) {}
  let pub = base ? await get(base + '/health', 20000) : { status: 0 };
  if (pub.status !== 200) {
    log('tunnel stale (' + base + ') -> re-running up.ps1');
    try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File up.ps1', { cwd: __dirname, stdio: 'pipe', timeout: 180000 }); } catch (e) { log('up.ps1: ' + (e.stdout ? e.stdout.toString().slice(-300) : e.message)); }
    try { base = fs.readFileSync(path.join(__dirname, 'tunnel.url'), 'utf8').trim(); } catch (e) {}
    for (let i = 0; i < 12; i++) { await sleep(2500); pub = await get(base + '/health', 15000); if (pub.status === 200) break; }
  }
  log('public base: ' + base + ' -> health ' + pub.status);

  // 5) prove the new routes PUBLICLY
  const checks = [
    ['/v1/gasfree-quote?amount=0.001', 200],
    ['/v1/gasfree-verify?tx=0x485003cb2a6b4b539d13be19c5465e313d85e3cb222c23b873a7ed76db48a53d&to=0x71DEAc098914A009E3720524642A6bE6F65EE528&min=1000', 200],
    ['/v1/gasfree-module', 200],
    ['/gasfree', 200],
    ['/pricing', 200],
  ];
  let pass = 0;
  for (const [r, want] of checks) {
    const res = await get(base + r, 40000);
    const ok = res.status === want;
    if (ok) pass++;
    log((ok ? 'PUBLIC PASS ' : 'PUBLIC FAIL ') + r + ' -> ' + res.status + ' (' + (res.body || '').length + ' bytes)');
  }
  // refresh the durable URL beacon
  if (base) {
    try {
      const bk = { base, updatedAt: new Date().toISOString(), routes: ['/v1/gasfree-quote', '/v1/gasfree-verify', '/v1/gasfree-module', '/gasfree'] };
      fs.writeFileSync(path.join(__dirname, 'beacon-state.json'), JSON.stringify(bk, null, 2));
      const data = Buffer.from(base);
      await new Promise(res => {
        const rq = https.request({ hostname: 'paste.rs', path: '/', method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': data.length } }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => { log('URL beacon -> ' + b.trim()); res(); }); });
        rq.on('error', () => res()); rq.write(data); rq.end();
      });
    } catch (e) {}
  }
  log('\n=== public gas-free proof: ' + pass + '/' + checks.length + ' ===');
})();
