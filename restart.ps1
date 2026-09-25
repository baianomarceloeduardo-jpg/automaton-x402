# restart.ps1 - force a clean restart of the Value API so code changes load.
$dir = 'C:\root\value-api'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*value-api*server.js*' -or $_.CommandLine -like '*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep 2
foreach ($p in @(8080)) {
  $busy = Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue
  if ($busy) { $busy | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue } ; Start-Sleep 1 }
}
Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
Start-Sleep 4
try { $h = Invoke-RestMethod 'http://127.0.0.1:8080/health' -TimeoutSec 5; Write-Host "RESTARTED v$($h.version) ledger=$($h.ledger)" }
catch { Write-Host 'restart failed'; Get-Content (Join-Path $dir 'server.err.log') -Tail 10 -EA SilentlyContinue }
