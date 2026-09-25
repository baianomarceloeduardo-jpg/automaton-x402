# deploy_v5b.ps1 — robust restart (kill the actual :8080 listener) + full v0.5.0 Merkle verification.
$dir = 'C:\root\value-api'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }

# 1) kill whatever is listening on 8080
$owners = @()
try { $owners = (Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue).OwningProcess | Select-Object -Unique } catch {}
foreach ($opid in $owners) { L "killing :8080 listener pid=$opid"; Stop-Process -Id $opid -Force -EA SilentlyContinue }
for ($i = 0; $i -lt 10; $i++) { if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue)) { break }; Start-Sleep 1 }
L ("port free: " + (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue)))

Remove-Item (Join-Path $dir 'trial.json') -Force -EA SilentlyContinue
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')

$h = $null
for ($i = 0; $i -lt 12; $i++) { Start-Sleep 1; try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 5; break } catch {} }
if ($h) { L ("health version=" + $h.version + " ledger=" + $h.ledger) } else { L 'health: NO RESPONSE' }
L ('server.log: ' + ((Get-Content (Join-Path $dir 'server.log') -Tail 2 -EA SilentlyContinue) -join ' | '))
L ('server.err.log: ' + ((Get-Content (Join-Path $dir 'server.err.log') -Tail 3 -EA SilentlyContinue) -join ' | '))

function T($name, $method, $rel, $body) {
  try {
    $a = @{ UseBasicParsing = $true; Uri = ('http://127.0.0.1:8080' + $rel); TimeoutSec = 20; Method = $(if ($method) { $method } else { 'GET' }) }
    if ($body) { $a.Body = $body; $a.ContentType = 'application/json' }
    $r = Invoke-WebRequest @a
    $c = ($r.Content -replace "`r?`n", ' '); if ($c.Length -gt 400) { $c = $c.Substring(0, 400) + '...' }
    L ("$name -> $($r.StatusCode) | $c")
    return $r.Content
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $b = $sr.ReadToEnd() -replace "`r?`n", ' '; if ($b.Length -gt 240) { $b = $b.Substring(0, 240) + '...' }; L ("$name -> $([int]$resp.StatusCode) | $b") } catch { L ("$name -> $([int]$resp.StatusCode)") } }
    else { L ("$name -> ERR " + $_.Exception.Message) }
    return $null
  }
}

L '--- v0.5.0 Merkle batch verification ---'
$body = @{ items = @('alpha', 'beta', 'gamma', 'delta', 'epsilon') } | ConvertTo-Json
$bc = T 'PAID  POST /v2/batch (5 items)' 'POST' '/v2/batch' $body
$root = ''; $bidx = ''
if ($bc) { $bj = $bc | ConvertFrom-Json; $root = $bj.root; $bidx = $bj.entry.index; L ("      root=$root index=$bidx count=$($bj.count) type=$($bj.entry.type) keyId=$($bj.entry.keyId)") }

$cli = (& node (Join-Path $dir 'merkle.js') alpha beta gamma delta epsilon) -join "`n"
$lm = [regex]::Match($cli, 'root:\s*([0-9a-f]{64})')
$localRoot = if ($lm.Success) { $lm.Groups[1].Value } else { 'NONE' }
L ("XCHECK independent merkle.js root=$localRoot MATCH=$($localRoot -eq $root)")

if ($bidx -ne '') {
  T 'FREE  /v2/proof (beta)' 'GET' "/v2/proof?index=$bidx&item=beta" $null
  T 'FREE  /v2/batch/verify (beta)' 'GET' "/v2/batch/verify?index=$bidx&item=beta" $null
  T 'NEG   /v2/batch/verify (zeta)' 'GET' "/v2/batch/verify?index=$bidx&item=zeta" $null
  T 'FREE  /v2/verify (batch entry)' 'GET' "/v2/verify?index=$bidx" $null
}
T 'FREE  /stats' 'GET' '/stats' $null

$out | Set-Content (Join-Path $dir 'v050_evidence.txt') -Encoding UTF8
L 'WROTE v050_evidence.txt'
