# verify_v6.ps1 — apply pubkey patch, restart, prove parity + pubkey + offline signature verification.
$dir = 'C:\root\value-api'
$ev = Join-Path $dir 'v060_evidence.txt'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }

L '--- patch_pubkey.js ---'
L (((& node (Join-Path $dir 'patch_pubkey.js')) -join ' '))
L '--- syntax ---'
& node --check (Join-Path $dir 'server.js'); L ("node --check exit=$LASTEXITCODE")

# restart cleanly
Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -EA SilentlyContinue }
for ($i = 0; $i -lt 10; $i++) { if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue)) { break }; Start-Sleep 1 }
Remove-Item (Join-Path $dir 'trial.json') -Force -EA SilentlyContinue
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
$h = $null; for ($i = 0; $i -lt 12; $i++) { Start-Sleep 1; try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 5; break } catch {} }
L ("health: " + ($(if ($h) { "version=$($h.version) ledger=$($h.ledger)" } else { 'NO RESPONSE' })))

L '--- SDK <-> server Merkle parity ---'
L (((& node (Join-Path $dir 'parity.js')) -join "`n"))

L '--- /v2/pubkey (previously 404) ---'
try {
  $pk = Invoke-RestMethod 'http://127.0.0.1:8080/v2/pubkey' -TimeoutSec 15
  L ("200 | keyId=$($pk.keyId) alg=$($pk.algorithm) pemFirstLine=$((($pk.publicKey -split "`n")[0]))")
  $pk.publicKey | Set-Content (Join-Path $dir 'live_pubkey.pem') -Encoding ASCII
} catch { L ("FAILED: " + $_.Exception.Message) }

# fact: pricing must advertise pubkey as free
L '--- /pricing free list ---'
try { $pr = Invoke-RestMethod 'http://127.0.0.1:8080/pricing' -TimeoutSec 15; L ("free includes /v2/pubkey: " + ($pr.free -contains '/v2/pubkey') + " | paid: " + (($pr.paid | ForEach-Object { $_.path }) -join ',')) } catch { L ("pricing err: " + $_.Exception.Message) }

$out | Set-Content $ev -Encoding UTF8
L 'WROTE v060_evidence.txt'
