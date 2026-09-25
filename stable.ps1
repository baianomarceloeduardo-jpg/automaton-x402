# stable.ps1 - establish a STABLE (non-rotating) public URL for the Value API.
# Root blocker was: quick-tunnel URLs rotate every restart -> listings/integrations rot.
# localtunnel allows a FIXED subdomain with no auth and no funds.
# Idempotent. Verifies public /health before committing the URL to tunnel.url.
$ErrorActionPreference = 'Continue'
Set-Location 'C:\root\value-api'

$SUB   = 'automaton-sovereign'
$PUB   = "https://$SUB.loca.lt"
$LOG   = 'stable.log'
function Log($m) { "$([DateTime]::UtcNow.ToString('s'))Z $m" | Tee-Object -FilePath $LOG -Append }

# 1) ensure local npm runner exists (localtunnel via npx)
Log "target stable URL: $PUB"

# 2) kill any prior localtunnel node processes
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*localtunnel*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force; Log "killed old localtunnel pid=$($_.ProcessId)" } catch {} }
Start-Sleep 2

# 3) make sure the local server is up
try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 5; Log "local server ok v$($h.version)" }
catch { Log 'local server DOWN - starting'; Start-Process node -ArgumentList 'server.js' -WorkingDirectory 'C:\root\value-api' -WindowStyle Hidden; Start-Sleep 3 }

# 4) start localtunnel with the FIXED subdomain
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npx --yes localtunnel --port 8080 --subdomain $SUB > lt.out 2>&1" -WorkingDirectory 'C:\root\value-api' -WindowStyle Hidden
Log 'started localtunnel (fixed subdomain)'

# 5) poll the PUBLIC url until it serves /health (bypass the reminder interstitial)
$ok = $false
for ($i=1; $i -le 30; $i++) {
  Start-Sleep 4
  try {
    $r = Invoke-WebRequest "$PUB/health" -Headers @{ 'bypass-tunnel-reminder' = 'true' } -TimeoutSec 10 -UseBasicParsing
    if ($r.StatusCode -eq 200) { Log "PUBLIC OK $PUB/health HTTP 200 (attempt $i)"; $ok = $true; break }
  } catch { Log "attempt $i: $($_.Exception.Message.Substring(0,[Math]::Min(70,$_.Exception.Message.Length)))" }
}

if ($ok) {
  Set-Content -Path 'tunnel.url' -Value $PUB -NoNewline
  Set-Content -Path 'STABLE.url' -Value $PUB -NoNewline
  Log "committed tunnel.url = $PUB"
} else {
  Log "FAILED to establish stable URL; leaving tunnel.url unchanged"
}
Log "done. ok=$ok"
