# publish-history.ps1 - ONE shot: restart live server (8080) with history overlay,
# bring up public tunnel, seed a live snapshot, verify the new endpoints PUBLICLY.
$ErrorActionPreference = 'Continue'
$dir = 'C:\root\value-api'
Set-Location $dir

Write-Host '=== 1) stop old server on 8080 ==='
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*server.js*' } |
  ForEach-Object { Write-Host ("kill pid " + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep 2

Write-Host '=== 2) start server (8080) with history overlay ==='
$log = Join-Path $dir 'server.log'
Start-Process -FilePath 'node' -ArgumentList @('server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError (Join-Path $dir 'server.err.log')
$up = $false
for ($i=0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 3; $up = $true; break } catch {}
}
if (-not $up) { Write-Host 'LOCAL_DOWN'; Get-Content $log -Tail 25 -EA SilentlyContinue; Get-Content (Join-Path $dir 'server.err.log') -Tail 25 -EA SilentlyContinue; exit 1 }
Write-Host ("local UP v" + $h.version)

Write-Host '=== 3) local check of NEW endpoints ==='
foreach ($p in @('/v1/x402/history','/x402-history','/x402-history.md')) {
  try {
    $r = Invoke-WebRequest ('http://127.0.0.1:8080' + $p) -TimeoutSec 8 -UseBasicParsing
    Write-Host ("  {0} -> {1} {2} {3}B" -f $p, $r.StatusCode, $r.Headers['Content-Type'], $r.RawContentLength)
  } catch { Write-Host ("  {0} -> ERR {1}" -f $p, $_.Exception.Message) }
}

Write-Host '=== 4) seed a LIVE snapshot (fresh index scan) ==='
try {
  $rec = Invoke-RestMethod 'http://127.0.0.1:8080/v1/x402/history/record?live=1' -TimeoutSec 90
  Write-Host ("  recorded mode={0} day={1} total={2} conformant={3} health={4}%" -f $rec.mode,$rec.day,$rec.total,$rec.conformant,$rec.healthPct)
} catch { Write-Host ("  record failed: " + $_.Exception.Message) }

Write-Host '=== 5) bring up public tunnel ==='
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'public.ps1')
$base = $null
if (Test-Path (Join-Path $dir 'tunnel.url')) { $base = (Get-Content (Join-Path $dir 'tunnel.url') -Raw).Trim() }
if (-not $base) { Write-Host 'NO_TUNNEL_URL'; exit 2 }
Write-Host ("base: " + $base)

Write-Host '=== 6) PUBLIC verification of new endpoints ==='
$okc = 0; $tot = 0
foreach ($p in @('/health','/v1/x402/history','/x402-history','/x402-history.md')) {
  $tot++
  try {
    $r = Invoke-WebRequest ($base + $p) -TimeoutSec 25 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $okc++; Write-Host ("  PASS {0} -> 200 {1}B" -f $p, $r.RawContentLength) }
    else { Write-Host ("  FAIL {0} -> {1}" -f $p, $r.StatusCode) }
  } catch { Write-Host ("  FAIL {0} -> {1}" -f $p, $_.Exception.Message) }
}
Write-Host ("PUBLIC {0}/{1} PASS" -f $okc,$tot)

# persist the live URL as a durable beacon
try { $base | Set-Content (Join-Path $dir 'beacon-live.url') -Encoding ASCII } catch {}
Write-Host ("BEACON_URL=" + $base)
