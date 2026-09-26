// wire-kit-and-restart.js — one atomic operation:
//   1. replace server.js line-1 SILENT boot with boot-kit.js (self-diagnosing)
//   2. stop the process listening on 8080 (by port, not by name guessing)
//   3. spawn `node server.js` DETACHED from node itself (no cmd/PowerShell quoting)
//   4. poll /health and the revenue-critical kit route, print a verdict + boot log
// Idempotent: safe to re-run. Keeps a timestamped backup of server.js.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const DIR = __dirname;
const PORT = 8080;

function httpGet(p, ms = 5000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: ms }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- 1. patch server.js boot line ----------
  const srvPath = path.join(DIR, 'server.js');
  let src = fs.readFileSync(srvPath, 'utf8');
  const bootLine = `require('./boot-kit.js');`;
  const original = '// __KIT_SERVE_BOOT__ try { require(\'./kit-serve.js\').install(); } catch (e) { console.error(\'kit-serve install failed: \' + e.message); }';

  if (src.startsWith(bootLine)) {
    console.log('patch: already wired (no-op)');
  } else if (src.startsWith(original)) {
    fs.copyFileSync(srvPath, srvPath + '.bak10');
    src = bootLine + '\n' + src.slice(original.length);
    fs.writeFileSync(srvPath, src);
    console.log('patch: boot line replaced, backup server.js.bak10 written');
  } else {
    // Unknown first line — prepend without destroying anything.
    fs.copyFileSync(srvPath, srvPath + '.bak10');
    fs.writeFileSync(srvPath, bootLine + '\n' + src);
    console.log('patch: boot line PREPENDED (first line was unrecognised), backup server.js.bak10');
  }

  // ---------- 2. stop whatever owns 8080 ----------
  // Prefer a direct kill by owning PID discovered via netstat (portable, no PS needed).
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === PORT) pids.add(m[2]);
    }
    for (const pid of pids) {
      try { execSync('taskkill /f /pid ' + pid, { stdio: 'ignore' }); console.log('stop: killed PID ' + pid + ' on :' + PORT); } catch (_) {}
    }
    if (!pids.size) console.log('stop: nothing listening on :' + PORT);
  } catch (e) {
    console.log('stop: netstat failed (' + e.message + ') — continuing');
  }
  await sleep(2500);

  // ---------- 3. spawn detached ----------
  const outFd = fs.openSync(path.join(DIR, 'server.log'), 'a');
  const errFd = fs.openSync(path.join(DIR, 'server.err.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: DIR, detached: true, stdio: ['ignore', outFd, errFd]
  });
  child.unref();
  console.log('start: spawned PID ' + child.pid + ' (detached)');

  // ---------- 4. verify ----------
  let health = null, kit = null, kitJson = null, pricing = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    health = await httpGet('/health', 3000);
    if (health.status === 200) break;
  }
  kit = await httpGet('/x402-v2-kit.js');
  kitJson = await httpGet('/v1/x402-v2-kit');
  pricing = await httpGet('/pricing');

  console.log('\nVERDICT');
  console.log('  /health              ' + JSON.stringify(health));
  console.log('  /x402-v2-kit.js      ' + JSON.stringify(kit) + '  (want status=200)');
  console.log('  /v1/x402-v2-kit      ' + JSON.stringify(kitJson) + '  (want status=200)');
  console.log('  /pricing             ' + JSON.stringify(pricing));

  let boot = '';
  try { boot = fs.readFileSync(path.join(DIR, 'kit-boot.log'), 'utf8').trim(); } catch (_) {}
  console.log('\nKIT BOOT LOG:\n' + (boot || '(none)'));

  const ok = health.status === 200 && kit.status === 200;
  console.log('\nWIRE_RESULT=' + (ok ? 'PASS' : 'FAIL'));
  process.exit(ok ? 0 : 1);
})();
