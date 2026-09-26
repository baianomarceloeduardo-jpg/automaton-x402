// persist-paid-api.js — make the PROVEN paid API survive reboot and crashes.
//
// THE GAP: paid-api.js settles real USDC (proven on-chain) but dies with the shell that started
// it. A revenue service that disappears on reboot is not a business. This installs the same
// non-admin persistence pattern proven in Session 2 (Startup shortcut + HKCU Run key), plus a
// keepalive loop that restarts the service if it ever stops.
//
// No admin rights required. Reversible: --uninstall removes both entries.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const LAUNCHER = path.join(DIR, 'paidapi-boot.cmd');
const KEEPALIVE = path.join(DIR, 'paidapi-keepalive.ps1');
const LNK_NAME = 'AutomatonPaidApi.lnk';
const RUN_KEY = 'AutomatonPaidApi';
const STARTUP = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const uninstall = process.argv.includes('--uninstall');

function ps(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return { ok: r.status === 0, out: String((r.stdout || '') + (r.stderr || '')).trim() };
}

if (uninstall) {
  fs.existsSync(path.join(STARTUP, LNK_NAME)) && fs.unlinkSync(path.join(STARTUP, LNK_NAME));
  ps(`Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${RUN_KEY}' -ErrorAction SilentlyContinue`);
  console.log('[uninstall] startup shortcut + HKCU Run key removed');
  process.exit(0);
}

// --- keepalive: if the paid API is not answering, start it; log every action ---
fs.writeFileSync(KEEPALIVE, `# paidapi-keepalive.ps1 - restart the paid API if it stops answering.
$ErrorActionPreference = 'SilentlyContinue'
$dir = '${DIR.replace(/\\/g, '\\\\')}'
$log = Join-Path $dir 'paidapi-keepalive.log'
function Log($m) { "$(Get-Date -Format o) $m" | Out-File -Append -Encoding utf8 $log }

$alive = $false
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8081/health' -UseBasicParsing -TimeoutSec 6
  if ($r.StatusCode -eq 200) { $alive = $true }
} catch { $alive = $false }

if (-not $alive) {
  Log 'health failed -> restarting paid-api.js'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*paid-api.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 1
  Start-Process -FilePath 'node' -ArgumentList 'paid-api.js' -WorkingDirectory $dir -RedirectStandardOutput (Join-Path $dir 'paid-api.log') -RedirectStandardError (Join-Path $dir 'paid-api.err.log') -WindowStyle Hidden
  Start-Sleep -Seconds 5
  try {
    $r2 = Invoke-WebRequest -Uri 'http://127.0.0.1:8081/health' -UseBasicParsing -TimeoutSec 8
    Log ("restart result status=" + $r2.StatusCode)
  } catch { Log ('restart FAILED: ' + $_.Exception.Message) }
} else {
  Log 'health ok'
}
`, 'utf8');

// --- launcher: one keepalive pass, then loop forever (300s) ---
fs.writeFileSync(LAUNCHER, `@echo off
REM paidapi-boot.cmd - persists the PROVEN paid API across reboot/crash. Non-admin.
setlocal
cd /d "${DIR}"
powershell -NoProfile -ExecutionPolicy Bypass -File "${KEEPALIVE}"
:loop
timeout /t 300 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "${KEEPALIVE}"
goto loop
`, 'utf8');

// --- Startup shortcut (primary, works without admin) ---
const lnk = path.join(STARTUP, LNK_NAME);
const mk = ps(`$w = New-Object -ComObject WScript.Shell; $s = $w.CreateShortcut('${lnk.replace(/'/g, "''")}'); $s.TargetPath = '${LAUNCHER.replace(/'/g, "''")}'; $s.WorkingDirectory = '${DIR.replace(/'/g, "''")}'; $s.WindowStyle = 7; $s.Description = 'Automaton paid API persistence'; $s.Save(); if (Test-Path '${lnk.replace(/'/g, "''")}') { 'LNK_OK' } else { 'LNK_FAIL' }`);

// --- HKCU Run key (secondary, belt-and-braces) ---
const reg = ps(`Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${RUN_KEY}' -Value '"${LAUNCHER}"'; (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${RUN_KEY}').${RUN_KEY}`);

// --- start it now ---
ps(`Start-Process -FilePath '${LAUNCHER}' -WindowStyle Hidden`);
spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)']);

let health = { out: '' };
for (let i = 0; i < 12; i++) {
  health = ps(`try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8081/health' -UseBasicParsing -TimeoutSec 6; "status=" + $r.StatusCode } catch { "ERR " + $_.Exception.Message }`);
  if (health.out.includes('status=200')) break;
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']);
}

const evidence = {
  at: new Date().toISOString(),
  launcher: LAUNCHER, keepalive: KEEPALIVE,
  startupShortcut: { path: lnk, result: mk.out.slice(0, 120) },
  hkcuRun: reg.out.slice(0, 200),
  liveHealth: health.out.trim(),
};
fs.writeFileSync(path.join(DIR, 'PAID-API-PERSISTENCE.json'), JSON.stringify(evidence, null, 2));

console.log('[persist] startup shortcut : ' + (mk.out.includes('LNK_OK') ? 'INSTALLED' : 'FAILED (' + mk.out.slice(0, 80) + ')'));
console.log('[persist] HKCU Run key     : ' + (reg.out ? 'INSTALLED' : 'FAILED'));
console.log('[persist] launcher+keepalive written');
console.log('[persist] live health      : ' + health.out.trim());
console.log('evidence -> PAID-API-PERSISTENCE.json');
