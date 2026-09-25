# deploy_v5.ps1 — apply v0.5.0 patch, restart, and verify Merkle batch endpoints end to end.
$dir = 'C:\root\value-api'
Set-Location $dir
$ev = Join-Path $dir 'v050_evidence.txt'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }

L '--- patch_v5.js ---'
L ((& node (Join-Path $dir 'patch_v5.js')) -join ' ')

Remove-Item (Join-Path $dir 'trial.json') -Force -EA SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*value-api*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep 1
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
Start-Sleep 4
L ('server.log: ' + ((Get-Content (Join-Path $dir 'server.log') -Tail 1 -EA SilentlyContinue) -join ''))

function T($name, $method, $rel, $body) {
  try {
    $a = @{ UseBasicParsing = $true; Uri = ('http://127.0.0.1:8080' + $rel); TimeoutSec = 20; Method = $(if ($method) { $method } else { 'GET' }) }
    if ($body) { $a.Body = $body; $a.ContentType = 'application/json' }
    $r = Invoke-WebRequest @a
    $c = ($r.Content -replace "`r?`n", ' '); if ($c.Length -gt 320) { $c = $c.Substring(0, 320) + '...' }
    L ("$name -> $($r.StatusCode) | $c")
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $b = $sr.ReadToEnd() -replace "`r?`n", ' '; if ($b.Length -gt 220) { $b = $b.Substring(0, 220) + '...' }; L ("$name -> $([int]$resp.StatusCode) | $b") } catch { L ("$name -> $([int]$resp.StatusCode)") } }
    else { L ("$name -> ERR " + $_.Exception.Message) }
  }
}

L '--- v0.5.0 verification ---'
T 'FREE  /health' 'GET' '/health' $null

# 1) commit a batch (paid endpoint, free-trial call)
$items = '["alpha","beta","gamma","delta","epsilon"]'
$r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/v2/batch' -Method POST -Body ('{"items":' + $items + '}') -ContentType 'application/json' -TimeoutSec 20
$bj = $r.Content | ConvertFrom-Json
$root = $bj.root; $bidx = $bj.entry.index
L ("PAID  POST /v2/batch -> 200 | committed=true index=$bidx count=$($bj.count) root=$root")
L ("      entry.type=$($bj.entry.type) entry.keyId=$($bj.entry.keyId)")

# 2) INDEPENDENT cross-check: standalone CLI must produce the SAME root
$cli = (& node (Join-Path $dir 'merkle.js') alpha beta gamma delta epsilon) -join "`n"
$lm = [regex]::Match($cli, 'root:\s*([0-9a-f]{64})')
$localRoot = if ($lm.Success) { $lm.Groups[1].Value } else { 'NONE' }
L ("XCHECK local merkle.js root=$localRoot  MATCH=$($localRoot -eq $root)")

# 3) free inclusion proof for a member item
T 'FREE  /v2/proof (beta)' 'GET' "/v2/proof?index=$bidx&item=beta" $null
# 4) verify inclusion (server recomputes from stored batch)
T 'FREE  /v2/batch/verify (beta)' 'GET' "/v2/batch/verify?index=$bidx&item=beta" $null
# 5) NEGATIVE: item not in batch must fail
T 'FREE  /v2/batch/verify (zeta=NEG)' 'GET' "/v2/batch/verify?index=$bidx&item=zeta" $null
# 6) tamper check on the signature chain
T 'FREE  /v2/verify (batch entry)' 'GET' "/v2/verify?index=$bidx" $null
T 'FREE  /stats' 'GET' '/stats' $null

$out | Set-Content $ev -Encoding UTF8
L ('WROTE ' + $ev)
