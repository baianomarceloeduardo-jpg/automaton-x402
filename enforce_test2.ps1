# enforce_test2.ps1 - ASCII-only. Prove the paid branch enforces x402.
$dir = 'C:\root\value-api'
$ev  = Join-Path $dir 'enforcement_evidence.txt'
$L = @()
function W($m) { $script:L += "$m" }
$base = 'http://127.0.0.1:8080'

function Probe($path, $headers) {
  try {
    if ($headers) { $r = Invoke-WebRequest "$base$path" -Headers $headers -TimeoutSec 20 }
    else { $r = Invoke-WebRequest "$base$path" -TimeoutSec 20 }
    return @{ code = [int]$r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $code = [int]$resp.StatusCode
      $sr = New-Object IO.StreamReader($resp.GetResponseStream())
      return @{ code = $code; body = $sr.ReadToEnd() }
    }
    return @{ code = -1; body = $_.Exception.Message }
  }
}

# restart with clean trial
Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -EA SilentlyContinue }
Start-Sleep 2
Remove-Item (Join-Path $dir 'trial.json') -Force -EA SilentlyContinue
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
$h=$null; for($i=0;$i -lt 15;$i++){ Start-Sleep 1; try{$h=Invoke-RestMethod "$base/health" -TimeoutSec 4;break}catch{} }
if ($h) { W "server health: v$($h.version)" } else { W 'server health: DOWN' }

W ''
W '--- /pricing (pre-payment, must be free) ---'
$pr = Probe '/pricing' $null
W "status=$($pr.code)"

W ''
W '--- trial exhaustion on /v1/hash ---'
$codes = @(); $terms = $null
for ($i=1; $i -le 6; $i++) {
  $r = Probe "/v1/hash?data=trial$i" $null
  $codes += $r.code
  W "  call#$i -> $($r.code)"
  if ($r.code -eq 402 -and -not $terms) { $terms = $r.body }
}
W "sequence: $($codes -join ',')"

W ''
W '--- 402 challenge contents ---'
if ($terms) {
  try {
    $j = $terms | ConvertFrom-Json
    $a = $j.accepts[0]
    W "  x402Version=$($j.x402Version) scheme=$($a.scheme) network=$($a.network) chainId=$($a.chainId)"
    W "  asset=$($a.asset) payTo=$($a.payTo) maxAmountRequired=$($a.maxAmountRequired)"
  } catch { W ("  raw: " + $terms.Substring(0,[Math]::Min(400,$terms.Length))) }
} else { W '  NO 402 OBSERVED - paid branch may be OPEN' }

W ''
W '--- forgery: bogus X-PAYMENT must be rejected ---'
$f = Probe '/v1/hash?data=forge' @{ 'X-PAYMENT' = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }
W "  status=$($f.code)"
if ($f.md) { W "  body=$($f.body)" } else { W ("  body=" + $f.body.Substring(0,[Math]::Min(200,$f.body.Length))) }

$L | Set-Content $ev -Encoding ASCII
Get-Content $ev
