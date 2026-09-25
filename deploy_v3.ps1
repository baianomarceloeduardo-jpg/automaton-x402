# Deploy value-api v0.3.0 and run full attestation-ledger + payment tests.
$dir = 'C:\root\value-api'
$ev  = Join-Path $dir 'v030_evidence.txt'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }
function T($name, $url, $headers, $method, $body) {
  try {
    $a = @{ UseBasicParsing = $true; Uri = $url; TimeoutSec = 20; Method = ($(if($method){$method}else{'GET'})) }
    if ($headers) { $a.Headers = $headers }
    if ($body) { $a.Body = $body; $a.ContentType = 'application/json' }
    $r = Invoke-WebRequest @a; $c = ($r.Content -replace "`r?`n",' '); if ($c.Length -gt 300) { $c = $c.Substring(0,300) + '...' }
    L ("$name -> $($r.StatusCode) | $c")
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $b = $sr.ReadToEnd() -replace "`r?`n",' '; if ($b.Length -gt 300) { $b = $b.Substring(0,300) + '...' }; L ("$name -> $([int]$resp.StatusCode) | $b") } catch { L ("$name -> $([int]$resp.StatusCode)") } }
    else { L ("$name -> ERR " + $_.Exception.Message) }
  }
}

Remove-Item (Join-Path $dir '.noop') -Force -ErrorAction SilentlyContinue

# kill port-8080 owner, start v0.3.0
foreach ($c in (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)) {
  $pr = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($pr -and $pr.ProcessName -eq 'node') { Stop-Process -Id $pr.Id -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
Start-Sleep -Seconds 4
L ('server.log: ' + ((Get-Content (Join-Path $dir 'server.log') -Tail 3 -ErrorAction SilentlyContinue) -join ' | '))

$b = 'http://127.0.0.1:8080'
T 'FREE  /health'                       ($b + '/health')
T 'FREE  /v2/pubkey'                    ($b + '/v2/pubkey')
T 'PAID  /v2/attest no-pay (402)'       ($b + '/v2/attest?data=hello') $null 'GET' $null

# TRUST_MODE on 8092 to exercise the paid path deterministically
L '--- TRUST_MODE paid-path proof on 8092 ---'
$env:PORT='8092'; $env:TRUST_MODE='1'
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server_t.log') -RedirectStandardError (Join-Path $dir 'server_t.err.log') `
  -Environment @{ PORT='8092'; TRUST_MODE='1' }
Start-Sleep -Seconds 4
$h = @{ 'X-PAYMENT' = ('0x' + ('d' * 64)) }
$b2 = 'http://127.0.0.1:8092'
T 'TRUST /v2/attest #1'                 ($b2 + '/v2/attest?data=genesis-entry') $h 'GET' $null
T 'TRUST /v2/attest #2'                 ($b2 + '/v2/attest?data=second-entry')  $h 'GET' $null
T 'TRUST /v2/verify index=0'            ($b2 + '/v2/verify?index=0')
T 'TRUST /v2/verify index=1'            ($b2 + '/v2/verify?index=1')
T 'TRUST /v2/ledger'                    ($b2 + '/v2/ledger?limit=10')
T 'TRUST /v1/hash paid'                 ($b2 + '/v1/hash?input=sovereign') $h 'GET' $null
T 'TRUST /stats'                        ($b2 + '/stats')

# kill the 8092 trust instance only
foreach ($c in (Get-NetTCPConnection -LocalPort 8092 -State Listen -ErrorAction SilentlyContinue)) {
  $pr = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($pr -and $pr.ProcessName -eq 'node') { Stop-Process -Id $pr.Id -Force -ErrorAction SilentlyContinue }
}

$out | Set-Content $ev -Encoding UTF8
L ('WROTE ' + $ev)
