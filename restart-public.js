// restart-public.js v2 - replace whatever is serving :8080 with the dual-scheme server,
// using a timestamped log (avoids EBUSY on a locked log) and port-based PID discovery.
'use strict';
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DIR = __dirname;
function sh(cmd, opts) {
  try { return execSync(cmd, Object.assign({ encoding: 'utf8', timeout: 60000, cwd: DIR }, opts || {})); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
function get(port, p, ms) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: port, path: p, timeout: ms || 5000 },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', () => resolve({ status: 0 })); r.on('timeout', () => { r.destroy(); resolve({ status: 0 }); }); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // 1. find and stop whatever listens on 8080 (port-based, never matches my own process mgr)
  const netout = sh('netstat -ano | findstr LISTENING | findstr :8080');
  const pids = [...new Set((netout.match(/LISTENING\s+(\d+)/g) || []).map(s => s.split(/\s+/)[1]))];
  for (const pid of pids) {
    if (pid && pid !== '0') {
      const r = sh('taskkill /F /PID ' + pid);
      console.log('stop port-8080 pid ' + pid + ' -> ' + (r.split('\n')[0] || '').trim());
    }
  }
  if (!pids.length) console.log('nothing listening on 8080');

  // 2. also stop stray servers by path (belt and braces, no self-match)
  sh('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -like \'*value-api*server.js*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"');

  await sleep(1200);

  // 3. start fresh with a timestamped log
  const logPath = path.join(DIR, 'server-' + Date.now() + '.log');
  const out = fs.openSync(logPath, 'a');
  const p = spawn(process.execPath, ['server.js'], { cwd: DIR, detached: true, stdio: ['ignore', out, out], env: Object.assign({}, process.env, { PORT: '8080', FREE_TRIAL: '3' }) });
  p.unref();
  console.log('started pid ' + p.pid + ' log ' + path.basename(logPath));

  // 4. wait for health
  let loc = null;
  for (let i = 0; i < 25; i++) { loc = await get(8080, '/health', 3000); if (loc.status === 200) break; await sleep(700); }
  console.log('local /health -> ' + (loc ? loc.status : 'none'));
  if (loc && loc.body) { try { const j = JSON.parse(loc.body); console.log('  version=' + j.version + ' payTo=' + j.payTo); } catch (e) {} }

  // 5. confirm the dual-scheme 402 is served (the thing we just built)
  const ch = await get(8080, '/v1/uuid', 8000);
  let e9 = false, exact = false;
  try { const j = JSON.parse(ch.body); const a = j.accepts || []; e9 = a.some(x => x && x.scheme === 'eip3009'); exact = a.some(x => x && x.scheme === 'exact'); } catch (e) {}
  console.log('local 402: status=' + ch.status + ' eip3009=' + e9 + ' exact=' + exact);

  // 6. public tunnel via existing helper
  const helper = path.join(DIR, 'public.ps1');
  if (fs.existsSync(helper)) {
    console.log('running public.ps1 ...');
    const r = sh('powershell -NoProfile -ExecutionPolicy Bypass -File public.ps1', { timeout: 180000 });
    const m = (r.match(/https:\/\/[a-z0-9.-]+\.(trycloudflare\.com|lhr\.life)/i) || [])[0];
    console.log('public URL: ' + (m || 'none parsed'));
    if (m) fs.writeFileSync(path.join(DIR, 'tunnel.url'), m);
  } else console.log('no public.ps1 helper');
})();
