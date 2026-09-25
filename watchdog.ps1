# Automaton-Sovereign — self-healing watchdog v4 (Cloudflare Quick Tunnel)
# Health-checks the value-api server on 8080 and public Cloudflare tunnel.
# SAFETY: only ever manages value-api\server.js and value-api\bin\cloudflared.exe.

param([switch]$Once)

$ErrorActionPreference = 'Continue'
$dir  = 'C:\root\value-api'
$wlog = Join-Path $dir 'watchdog.log'
$urlf = Join-Path $dir 'tunnel.url'
$cbin = Join-Path $dir 'bin\cloudflared.exe'
$clog = Join-Path $dir 'cloudflared.log'
$cerr = Join-Path $dir 'cloudflared.err.log'

function W($m) {
  $line = ((Get-Date).ToString('o') + ' ' + $m)
  try { Add-Content -Path $wlog -Value $line -Encoding UTF8 } catch {}
  if ($Once) { Write-Host $line }
}

function Sync-Worker($targetUrl) {
  try {
    $res = Invoke-RestMethod 'https://api.automaton-sovereign.workers.dev/__internal/set_origin' `
      -Method Post `
      -Headers @{ 'x-admin-secret' = 'automaton_sovereign_tunnel_secret_7e32754c' } `
      -Body $targetUrl `
      -TimeoutSec 8
    W ('worker synced to ' + $targetUrl)
  } catch {
    W ('worker sync error: ' + $_.Exception.Message)
  }
}

function Health-Ok {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 5
    return ($r.StatusCode -eq 200 -and $r.Content -like '*Automaton-Sovereign*')
  } catch { return $false }
}

function Get-ValueApiProcs {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*value-api*server.js*' }
}

function Ensure-Server {
  if (Health-Ok) { return }
  # Kill ONLY our own server processes (matched by command line)
  Get-ValueApiProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
  for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Seconds 2
    if (Health-Ok) { W 'server: started OK'; return }
  }
  W 'server: start FAILED'
}

function Ensure-Tunnel {
  $u = $null
  if (Test-Path $urlf) {
    $u = (Get-Content $urlf -Raw -ErrorAction SilentlyContinue)
    if ($u) { $u = $u.Trim() }
  }
  
  $cfProc = Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1
  
  if ($u -and $u -like 'https://*.trycloudflare.com' -and $cfProc) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri ($u + '/health') -TimeoutSec 10
      if ($r.StatusCode -eq 200 -and $r.Content -like '*Automaton-Sovereign*') {
        Sync-Worker $u
        return # Healthy!
      }
    } catch {}
  }

  # If proc is not running or health check failed, re-launch
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Remove-Item $clog, $cerr -Force -ErrorAction SilentlyContinue

  if (-not (Test-Path $cbin)) {
    W 'cloudflared binary not found'
    return
  }

  Start-Process -FilePath $cbin `
    -ArgumentList 'tunnel','--url','http://127.0.0.1:8080' `
    -RedirectStandardOutput $clog -RedirectStandardError $cerr -WindowStyle Hidden

  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 2
    foreach ($f in @($cerr, $clog)) {
      if (Test-Path $f) {
        $content = Get-Content $f -Raw -ErrorAction SilentlyContinue
        if ($content) {
          $m = [regex]::Match($content, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
          if ($m.Success) {
            $newUrl = $m.Value
            $newUrl | Set-Content $urlf -Encoding UTF8
            W ('tunnel: UP ' + $newUrl)
            Sync-Worker $newUrl
            return
          }
        }
      }
    }
  }
  W 'tunnel: FAILED to obtain Cloudflare URL'
}

W ('=== watchdog v4 (Cloudflare) start (pid ' + $PID + ') ===')
do {
  try { Ensure-Server } catch { W ('server err: ' + $_.Exception.Message) }
  try { Ensure-Tunnel } catch { W ('tunnel err: ' + $_.Exception.Message) }
  if (-not $Once) { Start-Sleep -Seconds 20 }
} while (-not $Once)
