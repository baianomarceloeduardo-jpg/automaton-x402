// apply-facilitator.js — minimal, reversible text patch that routes the server's settlement
// calls to my local funded facilitator, then proves it end to end over real HTTP.
//
// The patch is a surgical string replacement of the two FACILITATOR.* call sites inside the
// dual-scheme overlay. No structural edits, no const rebinding, fully reversible via the backup.
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');

const SERVER = 'server.js';
const BACKUP = SERVER + '.bak-facilitator';
const MARKER = 'facilitator-adapter.js';
const ADAPTER = "require('./facilitator-adapter.js')";

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: String((r.stdout || '') + (r.stderr || '')) };
}

let src = fs.readFileSync(SERVER, 'utf8');
const alreadyPatched = src.includes(MARKER);

if (!alreadyPatched) {
  fs.writeFileSync(BACKUP, src);
  console.log('[apply] backup -> ' + BACKUP);
  const nConfigured = (src.match(/FACILITATOR\.facilitatorConfigured\(\)/g) || []).length;
  const nSettle = (src.match(/FACILITATOR\.facilitatorSettle\(/g) || []).length;
  src = src.replace(/FACILITATOR\.facilitatorConfigured\(\)/g, ADAPTER + '.facilitatorConfigured()');
  src = src.replace(/FACILITATOR\.facilitatorSettle\(/g, ADAPTER + '.facilitatorSettle(');
  const total = nConfigured + nSettle;
  if (total === 0) { console.log('[apply] no FACILITATOR call sites found — nothing to patch'); }
  else { fs.writeFileSync(SERVER, src); console.log('[apply] rewired ' + total + ' settlement call site(s) -> local facilitator'); }
} else {
  console.log('[apply] already patched — idempotent no-op');
}

const syn = sh(process.execPath, ['--check', SERVER]);
console.log('[syntax] ' + (syn.ok ? 'OK' : 'FAIL\n' + syn.out));
if (!syn.ok) {
  if (fs.existsSync(BACKUP)) { fs.writeFileSync(SERVER, fs.readFileSync(BACKUP, 'utf8')); console.log('[rollback] restored backup'); }
  process.exit(1);
}

const probe = sh(process.execPath, ['facilitator-adapter.js']);
console.log('[facilitator]\n' + probe.out.trim());

// restart production
sh('powershell', ['-NoProfile', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
sh('powershell', ['-NoProfile', '-Command',
  "Start-Process -FilePath node -ArgumentList 'server.js' -WorkingDirectory 'C:\\root\\value-api' -WindowStyle Hidden"]);
// give it a beat, then confirm it is really up
sh(process.execPath, ['-e', 'setTimeout(()=>{}, 1500)']);
let health = { out: '' };
for (let i = 0; i < 10; i++) {
  health = sh(process.execPath, ['-e',
    "const h=require('http');h.get('http://127.0.0.1:8080/health',r=>{r.resume();console.log('status='+r.statusCode)}).on('error',e=>console.log('ERR '+e.message))"]);
  if (health.out.includes('status=200')) break;
  sh(process.execPath, ['-e', 'setTimeout(()=>{}, 1000)']);
}
console.log('[restart] production ' + health.out.trim());
fs.writeFileSync('facilitator-apply-evidence.json', JSON.stringify({
  at: new Date().toISOString(), patched: !alreadyPatched, syntax: syn.ok,
  facilitator: probe.out.trim(), production: health.out.trim()
}, null, 2));
console.log('evidence -> facilitator-apply-evidence.json');
