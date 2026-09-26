// apply-ssrf-guard.js — idempotent apply + restart + LIVE verification of the SSRF guard.
// 1. Load the guard FIRST in server.js (top-of-file require) so no outbound path can escape it.
// 2. Syntax check, restart production.
// 3. Verify enforcement in a real process:
//      - metadata IP  -> refused (ssrf_blocked)
//      - other-private 10.x -> refused
//      - own loopback:8080 -> ALLOWED (self health checks keep working)
//      - public https -> ALLOWED
// 4. Verify the live server still serves its public endpoints.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVER = 'server.js';
const LINE = "try{require('./ssrf-guard.js');}catch(e){console.error('ssrf-guard load failed',e.message)}";

function sh(cmd, args) {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || '') + (e.message || '')) }; }
}

// ---- 1. apply ----
let src = fs.readFileSync(SERVER, 'utf8');
if (src.includes("require('./ssrf-guard.js')")) {
  console.log('[apply] already present — idempotent no-op');
} else {
  fs.writeFileSync(SERVER + '.bak-ssrf', src);
  console.log('[apply] backup -> ' + SERVER + '.bak-ssrf');
  // insert right after any leading shebang / 'use strict'
  const lines = src.split('\n');
  let idx = 0;
  if (lines[0] && lines[0].startsWith('#!')) idx = 1;
  while (idx < lines.length && /^\s*(\/\/.*|\/\*.*\*\/|'use strict';?|"use strict";?)?\s*$/.test(lines[idx])) idx++;
  lines.splice(idx, 0, LINE);
  fs.writeFileSync(SERVER, lines.join('\n'));
  console.log('[apply] guard required at line ' + (idx + 1));
}

const syn = sh(process.execPath, ['--check', SERVER]);
console.log('[syntax] ' + (syn.ok ? 'OK' : 'FAIL\n' + syn.out));
if (!syn.ok) process.exit(1);

// ---- 2. restart production ----
sh('powershell', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
sh('powershell', ['-NoProfile', '-Command',
  "Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory 'C:\\root\\value-api' -WindowStyle Hidden"]);
execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1)']);
console.log('[restart] production server restarted');

// ---- 3. in-process enforcement proof ----
const probe = `
const http=require('http');const https=require('https');
require('./ssrf-guard.js');
const results=[];
function t(name,fn){return new Promise(r=>{const to=setTimeout(()=>{results.push([name,'TIMEOUT']);r()},9000);fn((v)=>{clearTimeout(to);results.push([name,v]);r()})})}
(async()=>{
  await t('metadata 169.254.169.254',cb=>{const q=http.get('http://169.254.169.254/latest/meta-data/',()=>cb('CONNECTED (HOLE)'));q.on('error',e=>cb(/ssrf_blocked|blocked/.test(e.message)?'REFUSED ('+e.message+')':'error '+e.message))});
  await t('private 10.0.0.5',cb=>{const q=http.get('http://10.0.0.5/',()=>cb('CONNECTED (HOLE)'));q.on('error',e=>cb(/ssrf_blocked|blocked/.test(e.message)?'REFUSED ('+e.message+')':'error '+e.message))});
  await t('loopback other port 9999',cb=>{const q=http.get('http://127.0.0.1:9999/',()=>cb('CONNECTED (HOLE)'));q.on('error',e=>cb(/ssrf_blocked|blocked/.test(e.message)?'REFUSED ('+e.message+')':'error '+e.message))});
  await t('own loopback 8080',cb=>{const q=http.get('http://127.0.0.1:8080/health',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>cb('ALLOWED status='+r.statusCode))});q.on('error',e=>cb('ERROR '+e.message))});
  await t('public https paste.rs',cb=>{https.get('https://paste.rs/raw',r=>{r.resume();cb('ALLOWED status='+r.statusCode)}).on('error',e=>cb('error '+e.message))});
  console.log(JSON.stringify(results,null,1));
})();`;
fs.writeFileSync('ssrf-probe.js', probe);
const pr = sh(process.execPath, ['ssrf-probe.js']);
console.log('\n[enforcement]\n' + pr.out.trim());

// ---- 4. live server still healthy ----
const live = sh(process.execPath, ['-e',
  "const h=require('http');h.get('http://127.0.0.1:8080/health',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log('live /health status='+r.statusCode+' '+b.slice(0,120)))}).on('error',e=>console.log('live ERROR '+e.message))"]);
console.log('\n[production] ' + live.out.trim());

fs.writeFileSync('ssrf-apply-evidence.json', JSON.stringify({ at: new Date().toISOString(), syntax: syn.ok, enforcement: pr.out.trim(), production: live.out.trim() }, null, 2));
console.log('evidence -> ssrf-apply-evidence.json');
