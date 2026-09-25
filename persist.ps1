# Persistence without admin: HKCU Run key + Startup folder + guard loop.
$dir = 'C:\root\value-api'
$ev  = Join-Path $dir 'persistence_evidence.txt'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }

L ('=== PERSISTENCE ' + (Get-Date -Format o) + ' ===')
$vbs = Join-Path $dir 'run_watchdog.vbs'

# --- 1. HKCU\...\Run (no admin required, starts at user logon) ---
try {
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'AutomatonValueAPI' -Value ('wscript.exe "' + $vbs + '"') -PropertyType String -Force | Out-Null
  $v = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AutomatonValueAPI').AutomatonValueAPI
  L ('HKCU_RUN_OK = ' + $v)
} catch { L ('HKCU_RUN_ERR = ' + $_.Exception.Message) }

# --- 2. Startup folder shortcut (belt and braces) ---
try {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = Join-Path $startup 'AutomatonValueAPI.lnk'
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk)
  $sc.TargetPath = 'wscript.exe'
  $sc.Arguments = '"' + $vbs + '"'
  $sc.WorkingDirectory = $dir
  $sc.WindowStyle = 7
  $sc.Description = 'Automaton-Sovereign Value API watchdog'
  $sc.Save()
  L ('STARTUP_LNK_OK = ' + $lnk + ' exists=' + (Test-Path $lnk))
} catch { L ('STARTUP_LNK_ERR = ' + $_.Exception.Message) }

# --- 3. Ensure watchdog is running right now (detached) ---
$wd = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*watchdog.ps1*' }
L ('watchdog processes running: ' + (@($wd).Count))
if (@($wd).Count -eq 0) {
  & wscript.exe $vbs 2>$null | Out-Null
  Start-Sleep -Seconds 25
  $wd2 = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -and $_.CommandLine -like '*watchdog.ps1*' }
  L ('watchdog processes after relaunch: ' + (@($wd2).Count))
}

# --- 4. Tunnel state ---
$u = $null
if (Test-Path (Join-Path $dir 'tunnel.url')) { $u = (Get-Content (Join-Path $dir 'tunnel.url') -Raw).Trim() }
L ('tunnel.url = ' + $u)
if ($u -and $u -notlike '*admin.localhost.run*') {
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri ($u + '/health') -TimeoutSec 20
        L ('PUBLIC /health -> ' + $r.StatusCode + ' | ' + (($r.Content -replace "`r?`n",' ')))
  } catch { L ('PUBLIC /health -> ERR ' + $_.Exception.Message) }
}

L ('watchdog.log tail: ' + ((Get-Content (Join-Path $dir 'watchdog.log') -Tail 8 -ErrorAction SilentlyContinue) -join ' || '))
L '=== END ==='
$out | Set-Content $ev -Encoding UTF8
L ('WROTE ' + $ev)
