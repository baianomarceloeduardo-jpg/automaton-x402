// apply-osir.js - one-shot: apply overlay, syntax-check, restart server, verify endpoints live.
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

function sh(c) { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } }

function stopOn8080() {
  const out = sh('netstat -ano');
  const pids = new Set();
  out.split(/\r?\n/).forEach(l => {
    if (/:8080\b/.test(l) && /LISTENING/.test(l)) {
      const t = l.trim().split(/\s+/);
      const pid = t[t.length - 1];
      if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
  });
  for (const pid of pids) {
    sh('taskkill /F /PID ' + pid);
    console.log('stopped pid ' + pid);
  }
  return [...pids];
}

function get(p) {
  return new Promise(r => {
    http.get('http://127.0.0.1:8080' + p, s => { let b = ''; s.on('data', c => b += c); s.on('end', () => r({ c: s.statusCode, n: b.length, t: s.headers['content-type'] || '', b })); }).on('error', e => r({ c: 0, b: e.message }));
  });
}

(async () => {
  console.log('=== 1) apply overlay ===');
  console.log(sh('node osir-overlay.js').trim());
  console.log('=== 2) syntax check ===');
  const syn = sh('node -c server.js');
  if (syn.trim()) { console.log('SYNTAX FAIL:\n' + syn); process.exit(1); }
  console.log('SYNTAX_OK');
  console.log('=== 3) restart 8080 ===');
  stopOn8080();
  await new Promise(r => setTimeout(r, 1500));
  const log = fs.openSync('osir-server.log', 'a');
  spawn('node', ['server.js'], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  await new Promise(r => setTimeout(r, 5000));
  console.log('=== 4) verify local ===');
  const routes = ['/health', '/v1/domain/tlds', '/v1/domain/check?domain=automatonsovereign.xyz', '/v1/domain/check?domain=bad%20domain', '/domain'];
  let pass = 0;
  for (const p of routes) {
    const r = await get(p);
    const ok = r.c === 200 || (p.includes('bad') && r.c === 400);
    if (ok) pass++;
    console.log((ok ? 'PASS ' : 'FAIL ') + r.c + ' ' + String(r.n).padStart(7) + ' ' + r.t.padEnd(30) + ' ' + p);
    if (p.includes('check?domain=automatonsovereign')) console.log('     ' + r.b.slice(0, 200));
    if (p === '/v1/domain/tlds') { const j = (() => { try { return JSON.parse(r.b) } catch { return null } })(); console.log('     extensions=' + (j && j.result && j.result.extensions ? j.result.extensions.length : '?')); }
  }
  console.log('LOCAL ' + pass + '/' + routes.length);
})();
