# Restart value-api to v0.2.1 and verify discovery + payment gate.
$dir = 'C:\root\value-api'
$ev  = Join-Path $dir 'v021_evidence.txt'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }
function T($name, $url, $headers) {
  try {
    $a = @{ UseBasicParsing = $true; Uri = $url; TimeoutSec = 20 }; if ($headers) { $a.Headers = $headers }
    $r = Invoke-WebRequest @a; $c = ($r.Content -replace "`r?`n",' '); if ($c.Length -gt 260) { $c = $c.Substring(0,260) + '...' }
    L ("$name -> $($r.StatusCode) | $c")
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $b = $sr.ReadToEnd() -replace "`r?`n",' '; if ($b.Length -gt 260) { $b = $b.Substring(0,260) + '...' }; L ("$name -> $([int]$resp.StatusCode) | $b") } catch { L ("$name -> $([int]$resp.StatusCode)") } }
    else { L ("$name -> ERR " + $_.Exception.Message) }
  }
}

# kill port-8080 owner, start v0.2.1
foreach ($c in (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)) {
  $pr = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($pr -and $pr.ProcessName -eq 'node') { Stop-Process -Id $pr.Id -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
Start-Sleep -Seconds 3
L ('server.log: ' + ((Get-Content (Join-Path $dir 'server.log') -Tail 2 -ErrorAction SilentlyContinue) -join ' | '))

$b = 'http://127.0.0.1:8080'
T 'FREE /health'                         ($b + '/health')
T 'FREE /.well-known/agent-card.json'    ($b + '/.well-known/agent-card.json')
T 'PAID /v1/echo no-pay (expect 402)'    ($b + '/v1/echo?msg=hi')
T 'PAID /v1/echo bad-tx (expect 402)'    ($b + '/v1/echo?msg=hi') @{ 'X-PAYMENT' = ('0x' + ('c' * 64)) }
T 'FREE /stats'                          ($b + '/stats')

$out | Set-Content $ev -Encoding UTF8
L ('WROTE ' + $ev)
