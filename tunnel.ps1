# tunnel.ps1 — establish a REAL public URL for the value-api via localhost.run over ssh.
# Idempotent-ish: kills any prior tunnel, starts a fresh one, extracts the public https URL.
$dir = 'C:\root\value-api'
$out = Join-Path $dir 'tunnel.log'
$urlFile = Join-Path $dir 'tunnel.url'

# stop any previous tunnel ssh
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*localhost.run*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Remove-Item $out -Force -EA SilentlyContinue

# local health gate
$h = $null; for ($i=0; $i -lt 10; $i++) { try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 4; break } catch { Start-Sleep 1 } }
if (-not $h) { Write-Host 'LOCAL SERVER DOWN'; exit 1 }
Write-Host "local health: version=$($h.version)"

# start the tunnel (no account needed: nokey@localhost.run)
$args = @('-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=NUL','-o','ServerAliveInterval=30','-R','80:localhost:8080','nokey@localhost.run')
Start-Process -FilePath 'ssh.exe' -ArgumentList $args -WindowStyle Hidden `
  -RedirectStandardOutput $out -RedirectStandardError (Join-Path $dir 'tunnel.err.log')
Write-Host 'tunnel starting...'

$url = $null
for ($i=0; $i -lt 30; $i++) {
  Start-Sleep 2
  $t = Get-Content $out -Raw -EA SilentlyContinue
  if (-not $t) { continue }
  $m = [regex]::Match($t, 'https://[a-z0-9]+\.lhr\.life')
  if ($m.Success) { $url = $m.Value; break }
}
if (-not $url) { Write-Host 'NO URL YET — tail of tunnel.log:'; Get-Content $out -Tail 20 -EA SilentlyContinue; exit 2 }

Write-Host "PUBLIC URL = $url"
$url | Set-Content $urlFile -Encoding ASCII

# verify public reachability end-to-end
try { $ph = Invoke-RestMethod "$url/health" -TimeoutSec 25; Write-Host "PUBLIC health: version=$($ph.version) ledger=$($ph.ledger)  (200 OK)" }
catch { Write-Host "PUBLIC health FAILED: $($_.Exception.Message)" }

try { $pk = Invoke-RestMethod "$url/v2/pubkey" -TimeoutSec 25; Write-Host "PUBLIC /v2/pubkey: 200 keyId=$($pk.keyId)" }
catch { Write-Host "PUBLIC /v2/pubkey FAILED: $($_.Exception.Message)" }

# prove the paid branch challenges publicly with x402 terms
try {
  $r = Invoke-WebRequest "$url/v1/hash?data=hello" -TimeoutSec 25 -SkipHttpErrorCheck
  Write-Host "PUBLIC /v1/hash status=$($r.StatusCode)"
  if ($r.StatusCode -eq 402) { Write-Host ("402 accept: " + ($r.Content.Substring(0,[Math]::Min(300,$r.Content.Length)))) }
} catch { Write-Host "paid probe note: $($_.Exception.Message)" }
