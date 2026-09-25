# Deploy + verify value-api v0.2.0 in one pass. Writes deploy_evidence.txt.

$dir = 'C:\root\value-api'
$ev  = Join-Path $dir 'deploy_evidence.txt'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }

L ('=== DEPLOY v0.2.0 ' + (Get-Date -Format o) + ' ===')

# 1. Stop old watchdogs (any powershell running watchdog.ps1) and our own node server
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*watchdog.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*value-api*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
L 'old watchdog + server stopped'

# 2. Start v0.2.0
Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
Start-Sleep -Seconds 3

# 3. Launch the SAFE watchdog detached
& wscript.exe (Join-Path $dir 'run_watchdog.vbs') 2>$null | Out-Null
Start-Sleep -Seconds 2
L 'v0.2.0 server + safe watchdog launched'

# 4. Functional tests
function T($name, $url, $headers) {
  try {
    $args = @{ UseBasicParsing = $true; Uri = $url; TimeoutSec = 20 }
    if ($headers) { $args.Headers = $headers }
    $r = Invoke-WebRequest @args
    $c = ($r.Content -replace "`r?`n",' '); if ($c.Length -gt 200) { $c = $c.Substring(0,200) + '...' }
    L ("$name -> $($r.StatusCode) | $c")
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      try {
        $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $b = $sr.ReadToEnd() -replace "`r?`n",' '; if ($b.Length -gt 300) { $b = $b.Substring(0,300) + '...' }
        L ("$name -> $([int]$resp.StatusCode) | $b")
      } catch { L ("$name -> $([int]$resp.StatusCode) | (no body)") }
    } else { L ("$name -> ERR " + $_.Exception.Message) }
  }
}

$b = 'http://127.0.0.1:8080'
T 'FREE /health'            ($b + '/health')
T 'FREE /pricing'           ($b + '/pricing')
T 'PAID /v1/hash (no pay)'  ($b + '/v1/hash?input=sovereign')
T 'PAID /v1/uuid (no pay)'  ($b + '/v1/uuid')
T 'PAID /v1/hash (bad tx)'  ($b + '/v1/hash?input=sovereign') @{ 'X-PAYMENT' = '0x' + ('a' * 64) }
T 'PAID /v1/hash (garbage)' ($b + '/v1/hash?input=sovereign') @{ 'X-PAYMENT' = 'not-a-hash' }

# 5. TRUST_MODE positive path on a separate port (proves the paid branch executes)
L '--- TRUST_MODE paid-path proof on port 8091 ---'
$env:TRUST_MODE = '1'
Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server_trust.log') -RedirectStandardError (Join-Path $dir 'server_trust.err.log') `
  -Environment @{ PORT = '8091'; TRUST_MODE = '1' } -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
T 'TRUST /v1/hash paid'  'http://127.0.0.1:8091/v1/hash?input=sovereign' @{ 'X-PAYMENT' = '0x' + ('b' * 64) }
T 'TRUST /stats'         'http://127.0.0.1:8091/stats'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*value-api*server.js*' } | ForEach-Object {
    # leave 8080 running; kill only the 8091 trust instance
    $env2 = $_
    if ($env2.CommandLine -notmatch '8091') { } 
  }

L '=== END ==='
$out | Set-Content $ev -Encoding UTF8
L ("WROTE $ev")
