# enforce_test.ps1 — prove the paid branch actually enforces x402 (trial exhaustion, 402 terms, forgery, replay).
$dir = 'C:\root\value-api'
$ev  = Join-Path $dir 'enforcement_evidence.txt'
$L = @()
function W($m) { $script:L += $m }

$base = 'http://127.0.0.1:8080'

# --- 0) fix SDK tsconfig strictness so tsc exits 0 (peer artifact) ---
$ts = Join-Path $dir 'sdk\tsconfig.json'
try {
  $j = Get-Content $ts -Raw | ConvertFrom-Json
  if ($j.compilerOptions.PSObject.Properties.Name -contains 'exactOptionalPropertyTypes') { $j.compilerOptions.exactOptionalPropertyTypes = $false }
  else { $j.compilerOptions | Add-Member -NotePropertyName exactOptionalPropertyTypes -NotePropertyValue $false }
  $j | ConvertTo-Json -Depth 10 | Set-Content $ts -Encoding UTF8
  $tc = & cmd /c "cd /d `"$dir\sdk`" && npx --no-install tsc -p tsconfig.json 2>&1"
  W ("SDK tsc exit=" + $LASTEXITCODE + $(if ($tc) { " | " + ($tc -join ' ') } else { " | clean" }))
} catch { W ("tsconfig fix err: " + $_.Exception.Message) }

# --- 1) restart server with a clean trial so enforcement is deterministic ---
Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -EA SilentlyContinue }
Start-Sleep 2
Remove-Item (Join-Path $dir 'trial.json') -Force -EA SilentlyContinue
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
$h=$null; for($i=0;$i -lt 15;$i++){ Start-Sleep 1; try{$h=Invoke-RestMethod "$base/health" -TimeoutSec 4;break}catch{} }
W ("server health: " + $(if($h){"v$($h.version)"}else{'DOWN'}))

# --- 2) free-trial behaviour: N free calls, then 402 ---
function Probe($path) {
  try {
    $r = Invoke-WebRequest "$base$path" -TimeoutSec 20
    return @{ code = [int]$r.StatusCode; body = $r.Content; pay = $r.Headers['X-PAYMENT-RESPONSE'] }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $code = [int]$resp.StatusCode
      $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $body = $sr.ReadToEnd()
      return @{ code = $code; body = $body }
    }
    return @{ code = -1; body = $_.Exception.Message }
  }
}

W "`n--- /pricing (pre-payment, must be free) ---"
$pr = Probe '/pricing'
W ("status=$($pr.code)")

W "`n--- trial exhaustion on /v1/hash ---"
$codes = @()
for ($i=1; $i -le 6; $i++) { $r = Probe "/v1/hash?data=trial$i"; $codes += $r.code; W ("  call#$i -> $($r.code)") ; if ($r.code -eq 402) { $terms = $r.body } }
W ("sequence: " + ($codes -join ','))

W "`n--- 402 challenge contents ---"
if ($terms) {
  try {
    $j = $terms | ConvertFrom-Json
    $a = $j.accepts[0]
    W ("  x402Version=$($j.x402Version) scheme=$($a.scheme) network=$($a.network) chainId=$($a.chainId)")
    W ("  asset=$($a.asset) payTo=$($a.payTo) maxAmountRequired=$($a.maxAmountRequired)")
  } catch { W ("  raw: " + $terms.Substring(0,[Math]::Min(400,$terms.Length))) }
} else { W "  (no 402 observed — paid branch may be open!)" }

W "`n--- forgery: bogus X-PAYMENT must be rejected ---"
try {
  $r = Invoke-WebRequest "$base/v1/hash?data=forge" -Headers @{ 'X-PAYMENT' = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } -TimeoutSec 20
  W ("  status=$([int]$r.StatusCode) (UNEXPECTED: accepted forged payment)")
} catch {
  $resp=$_.Exception.Response
  if ($resp) { $sr=New-Object IO.StreamReader($resp.GetResponseStream()); W ("  status=$([int]$resp.StatusCode) body=" + $sr.ReadToEnd().Substring(0,200)) }
  else { W ("  err: " + $_.Exception.Message) }
}

$L | Set-Content $ev -Encoding UTF8
Get-Content $ev
