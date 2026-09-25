# keepalive.ps1 - one-pass ensure: local server UP, Cloudflare tunnel UP, public health OK.
# ASCII-only. Idempotent. Writes tunnel.url and appends to keepalive.log. Safe to run every few minutes.
$dir = 'C:\root\value-api'
$log = Join-Path $dir 'keepalive.log'
$urlFile = Join-Path $dir 'tunnel.url'
$cbin = Join-Path $dir 'bin\cloudflared.exe'
$clog = Join-Path $dir 'cloudflared.log'
$cerr = Join-Path $dir 'cloudflared.err.log'

function K($m) { "$(Get-Date -Format o)  $m" | Add-Content $log -Encoding ASCII }

# --- 1) local server ---
$localUp = $false
try {
  $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 4
  $localUp = $true
  K "local OK v$($h.version) ledger=$($h.ledger)"
} catch {
  K 'local DOWN'
}

if (-not $localUp) {
  $listen = Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue
  if (-not $listen) {
    Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
    K 'server: started'
    Start-Sleep 3
  } else {
    K 'server: port busy, waiting'
    Start-Sleep 3
  }
}

# --- 2) Cloudflare tunnel process ---
$tun = Get-Process cloudflared -EA SilentlyContinue | Select-Object -First 1
$url = $null
if (Test-Path $urlFile) { $url = (Get-Content $urlFile -Raw -EA SilentlyContinue).Trim() }

# --- 3) prove the tunnel actually works; restart if not ---
$publicOk = $false
if ($tun -and $url -and $url -like 'https://*.trycloudflare.com') {
  try {
    $ph = Invoke-RestMethod "$url/health" -TimeoutSec 10
    if ($ph.agent -eq 'Automaton-Sovereign') {
      $publicOk = $true
      K "public OK $url v$($ph.version)"
    }
  } catch {
    K "public DOWN $url"
  }
}

if (-not $publicOk) {
  $url = $null
  Get-Process cloudflared -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
  Start-Sleep 1
  Remove-Item $clog, $cerr -Force -EA SilentlyContinue

  if (Test-Path $cbin) {
    Start-Process -FilePath $cbin -ArgumentList 'tunnel','--url','http://127.0.0.1:8080' `
      -WindowStyle Hidden -RedirectStandardOutput $clog -RedirectStandardError $cerr
    
    for ($i = 0; $i -lt 25; $i++) {
      Start-Sleep 2
      foreach ($f in @($cerr, $clog)) {
        if (Test-Path $f) {
          $t = Get-Content $f -Raw -EA SilentlyContinue
          if ($t) {
            $m = [regex]::Match($t, 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
            if ($m.Success) {
              $url = $m.Value
              $url | Set-Content $urlFile -Encoding ASCII
              break
            }
          }
        }
      }
      if ($url) { break }
    }
    if ($url) {
      try {
        $ph = Invoke-RestMethod "$url/health" -TimeoutSec 15
        if ($ph.agent -eq 'Automaton-Sovereign') {
          $publicOk = $true
          K "public RESTORED $url v$($ph.version)"
        }
      } catch {
        K "public FAIL after restart $url"
      }
    } else {
      K 'tunnel: no URL obtained'
    }
  } else {
    K 'cloudflared binary not found'
  }
}

if ($publicOk) { "OK $url" } else { 'DEGRADED' }
