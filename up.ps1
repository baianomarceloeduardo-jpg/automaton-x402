# up.ps1 - SINGLE robust bring-up: server UP + best-available public tunnel UP + verified.
# Tries, in order: (1) existing tunnel.url, (2) cloudflared quick tunnel, (3) localhost.run ssh.
# Writes tunnel.url on success. Logs to up.log. Idempotent. ASCII-only.
$dir = 'C:\root\value-api'
$log = Join-Path $dir 'up.log'
$urlFile = Join-Path $dir 'tunnel.url'
function K($m) { "$(Get-Date -Format o)  $m" | Add-Content $log -Encoding ASCII; Write-Host $m }

# ---- 1) local server ----
$up = $false
try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 4; $up = $true; K "local OK v$($h.version) ledger=$($h.ledger)" } catch { $up = $false }
if (-not $up) {
  $busy = Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue
  if (-not $busy) {
    Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
    K 'server: started'
  } else { K 'server: port busy (another instance)' }
  for ($i=0; $i -lt 15 -and -not $up; $i++) { Start-Sleep 1; try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 3; $up = $true } catch {} }
}
if (-not $up) { K 'FATAL: local server not responding'; exit 1 }

function Test-Public($u) { try { $r = Invoke-RestMethod "$u/health" -TimeoutSec 15; return $r.version } catch { return $null } }

# ---- 2) existing tunnel ----
if (Test-Path $urlFile) {
  $cur = (Get-Content $urlFile -Raw).Trim()
  if ($cur) { $v = Test-Public $cur; if ($v) { K "public OK (existing) $cur v$v"; Write-Host "OK $cur"; exit 0 } else { K "existing tunnel dead: $cur" } }
}

# ---- 3) cloudflared quick tunnel ----
$cf = (Get-Command cloudflared -EA SilentlyContinue).Source
if (-not $cf) { foreach ($p in @("$env:LOCALAPPDATA\cloudflared\cloudflared.exe", "C:\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe")) { if (Test-Path $p) { $cf = $p; break } } }
if ($cf) {
  K "trying cloudflared: $cf"
  $cfLog = Join-Path $dir 'cloudflared.log'
  Remove-Item $cfLog -Force -EA SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -EA SilentlyContinue | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
  Start-Process -FilePath $cf -ArgumentList @('tunnel','--url','http://localhost:8080','--no-autoupdate') -WindowStyle Hidden -RedirectStandardOutput $cfLog -RedirectStandardError (Join-Path $dir 'cloudflared.err.log')
  $new = $null
  for ($i=0; $i -lt 30; $i++) {
    Start-Sleep 2
    $t = Get-Content $cfLog -Raw -EA SilentlyContinue
    if (-not $t) { $t = Get-Content (Join-Path $dir 'cloudflared.err.log') -Raw -EA SilentlyContinue }
    if ($t) { $m = [regex]::Match($t, 'https://[a-z0-9-]+\.trycloudflare\.com'); if ($m.Success) { $new = $m.Value; break } }
  }
  if ($new) { $v = Test-Public $new; if ($v) { $new | Set-Content $urlFile -Encoding ASCII; K "public RESTORED (cloudflared) $new v$v"; Write-Host "OK $new"; exit 0 } else { K "cloudflared URL not reachable yet: $new" } }
  else { K 'cloudflared: no URL captured' }
} else { K 'cloudflared not installed; falling back to ssh' }

# ---- 4) localhost.run ssh ----
$tlog = Join-Path $dir 'tunnel.log'
Remove-Item $tlog -Force -EA SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -EA SilentlyContinue | Where-Object { $_.CommandLine -like '*localhost.run*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
$a = @('-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL','-o','ServerAliveInterval=30','-o','ExitOnForwardFailure=yes','-R','80:localhost:8080','nokey@localhost.run')
Start-Process -FilePath 'ssh.exe' -ArgumentList $a -WindowStyle Hidden -RedirectStandardOutput $tlog -RedirectStandardError (Join-Path $dir 'tunnel.err.log')
$new = $null
for ($i=0; $i -lt 30; $i++) { Start-Sleep 2; $t = Get-Content $tlog -Raw -EA SilentlyContinue; if ($t) { $m = [regex]::Match($t, 'https://[a-z0-9]+\.lhr\.life'); if ($m.Success) { $new = $m.Value; break } } }
if ($new) { $v = Test-Public $new; if ($v) { $new | Set-Content $urlFile -Encoding ASCII; K "public RESTORED (localhost.run) $new v$v"; Write-Host "OK $new"; exit 0 } else { K "ssh URL not reachable: $new" } }

K 'DEGRADED: no working public tunnel'
Write-Host 'DEGRADED'
exit 2
