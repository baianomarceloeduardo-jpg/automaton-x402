# install_autostart.ps1 - non-admin persistence: Startup folder shortcut + HKCU Run key.
# ASCII-only. No elevation needed.
$dir = 'C:\root\value-api'
$boot = Join-Path $dir 'valueapi-boot.cmd'
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'AutomatonValueApi.lnk'

# 1) Startup folder shortcut (runs at user logon)
try {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = $boot
  $s.WorkingDirectory = $dir
  $s.WindowStyle = 7
  $s.Description = 'Automaton-Sovereign Value API keepalive'
  $s.Save()
  Write-Host "STARTUP SHORTCUT: $lnk"
} catch { Write-Host "startup shortcut failed: $($_.Exception.Message)" }

# 2) HKCU Run key (belt and braces; no admin required)
try {
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AutomatonValueApi' -Value "`"$boot`"" -EA Stop
  $v = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AutomatonValueApi').AutomatonValueApi
  Write-Host "RUN KEY: $v"
} catch { Write-Host "run key failed: $($_.Exception.Message)" }

Write-Host '--- verify the launcher starts the service now ---'
Start-Process -FilePath $boot -WindowStyle Hidden
Start-Sleep 20
try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 6; Write-Host "local health v$($h.version) ledger=$($h.ledger)" } catch { Write-Host 'local health: DOWN' }
if (Test-Path (Join-Path $dir 'tunnel.url')) { $u=(Get-Content (Join-Path $dir 'tunnel.url') -Raw).Trim(); Write-Host "public url: $u"; try { $p=Invoke-RestMethod "$u/health" -TimeoutSec 20; Write-Host "public health v$($p.version) OK" } catch { Write-Host 'public health: retrying later via loop' } }
