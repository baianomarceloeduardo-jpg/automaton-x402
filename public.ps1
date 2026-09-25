# public.ps1 - guarantee a WORKING public URL for the Value API, verify it end-to-end.
$dir = 'C:\root\value-api'
$log = Join-Path $dir 'cloudflared.log'
$urlFile = Join-Path $dir 'tunnel.url'

# 0) local server must answer
$localOk = $false
try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 5; $localOk = $true; Write-Host "local OK v$($h.version)" } catch { Write-Host 'local DOWN' }
if (-not $localOk) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'restart.ps1'); Start-Sleep 3 }

# 1) find cloudflared
$cf = @(
  'C:\root\value-api\cloudflared.exe',
  'C:\Users\marce\cloudflared.exe',
  (Get-Command cloudflared.exe -EA SilentlyContinue | Select-Object -Expand Source)
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $cf) { Write-Host 'NO_CLOUDFLARED'; exit 2 }
Write-Host "cloudflared: $cf"

# 2) kill stale tunnels
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -EA SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Remove-Item $log -EA SilentlyContinue
Start-Sleep 1

# 3) start fresh, capture URL from log
Start-Process -FilePath $cf -ArgumentList @('tunnel','--url','http://127.0.0.1:8080','--no-autoupdate','--logfile',$log,'--loglevel','info') -WindowStyle Hidden
$newUrl = $null
for ($i=0; $i -lt 40; $i++) {
  Start-Sleep 1
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -EA SilentlyContinue |
         ForEach-Object { $_.Matches } | Select-Object -First 1 -Expand Value
    if ($m) { $newUrl = $m; break }
  }
}
if (-not $newUrl) { Write-Host 'NO_URL_FROM_LOG'; Get-Content $log -Tail 15 -EA SilentlyContinue; exit 3 }
Write-Host "tunnel URL: $newUrl"
$newUrl | Set-Content $urlFile -Encoding ASCII

# 4) VERIFY the URL actually serves (retry while CF edge warms up)
$ok = $false
for ($i=0; $i -lt 12; $i++) {
  Start-Sleep 3
  try {
    $r = Invoke-RestMethod "$newUrl/health" -TimeoutSec 10
    if ($r.status -eq 'ok') { $ok = $true; Write-Host "PUBLIC OK $newUrl v$($r.version) ledger=$($r.ledger)"; break }
  } catch { Write-Host "  retry $($i+1): $($_.Exception.Message)" }
}
if ($ok) { Write-Host "VERIFIED:$newUrl" } else { Write-Host 'PUBLIC_NOT_SERVING'; exit 4 }
