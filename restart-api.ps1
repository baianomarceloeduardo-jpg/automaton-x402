# restart-api.ps1 — force the value API to reload server.js (picks up the x402 v2 overlay).
# Finds the PID actually listening on the API port, stops it, relaunches detached, waits for health.
param([int]$Port = 8080)
$ErrorActionPreference = 'Continue'
$dir = 'C:\root\value-api'

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($p) { Write-Host ("stopping PID " + $p.Id + " (" + $p.ProcessName + ") on port " + $Port); Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2

Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $Port + "/health") -TimeoutSec 3 -UseBasicParsing
    Write-Host ("health status=" + $r.StatusCode + " after " + ($i * 0.5) + "s")
    break
  } catch { }
}

# Confirm the live 402 (if any) now advertises v2.
try {
  $r2 = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $Port + "/v1/hash") -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
  Write-Host ("/v1/hash status=" + $r2.StatusCode)
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    Write-Host ("/v1/hash status=" + [int]$resp.StatusCode + " x402v=" + $resp.Headers['X-402-Version'] + " paymentRequired=" + [bool]$resp.Headers['PAYMENT-REQUIRED'])
  } else { Write-Host "/v1/hash error (not a 402)" }
}
