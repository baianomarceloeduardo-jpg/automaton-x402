# install-paidapi-persistence.ps1 — make the self-healing paid API survive reboots, non-admin.
#
# Installs THREE independent triggers so a single failure mode cannot kill revenue:
#   1. Startup-folder shortcut  -> paidapi-boot.cmd
#   2. HKCU Run key             -> paidapi-boot.cmd
#   3. Immediate start          -> proves it works right now
# Idempotent: safe to re-run.
$ErrorActionPreference = 'Continue'
$DIR = 'C:\root\value-api'

# ---- boot cmd ----
$boot = @'
@echo off
cd /d C:\root\value-api
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -File C:\root\value-api\paidapi-keepalive.ps1
'@
[IO.File]::WriteAllText("$DIR\paidapi-boot.cmd", $boot)
Write-Output "wrote $DIR\paidapi-boot.cmd"

# ---- 1. Startup folder shortcut ----
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'AutomatonPaidApi.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = "$DIR\paidapi-boot.cmd"
$sc.WorkingDirectory = $DIR
$sc.WindowStyle = 7
$sc.Description = 'Automaton-Sovereign paid API (self-healing)'
$sc.Save()
if (Test-Path $lnkPath) { Write-Output "OK startup shortcut: $lnkPath" } else { Write-Output "FAILED startup shortcut" }

# ---- 2. HKCU Run key ----
try {
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AutomatonPaidApi' -Value "$DIR\paidapi-boot.cmd" -Force
  $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AutomatonPaidApi').AutomatonPaidApi
  Write-Output "OK Run key: $v"
} catch { Write-Output "FAILED Run key: $_" }

# ---- 3. start it now (kill any stale supervisor first) ----
Get-Process powershell -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*paidapi-keepalive*' } |
  ForEach-Object { try { $_.Kill() } catch {} }
Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$DIR\paidapi-keepalive.ps1" -WorkingDirectory $DIR -WindowStyle Hidden
Start-Sleep -Seconds 3
$n = (Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*paidapi-keepalive*' }).Count
Write-Output "supervisor processes running: $n"
