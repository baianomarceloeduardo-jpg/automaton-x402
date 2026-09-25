# build_sdk.ps1 — compile the peer SDK and prove parity + public reachability. Logs to build.log
$dir = 'C:\root\value-api'
$sdk = Join-Path $dir 'sdk'
$log = Join-Path $dir 'build.log'
$lines = @()
function L($m) { $script:lines += "$m"; }

L "=== build_sdk $(Get-Date -Format o) ==="
Set-Location $sdk

# 1) install typescript locally (dev only)
L '--- npm i -D typescript ---'
$np = & cmd /c "npm i -D typescript --no-audit --no-fund --loglevel=error 2>&1"
L ($np -join "`n")
L "npm exit=$LASTEXITCODE"

# 2) compile
L '--- tsc -p tsconfig.json ---'
$tc = & cmd /c "npx --no-install tsc -p tsconfig.json 2>&1"
L ($tc -join "`n")
L "tsc exit=$LASTEXITCODE"
L '--- dist listing ---'
$dist = Get-ChildItem -Path (Join-Path $sdk 'dist') -Recurse -File -EA SilentlyContinue | ForEach-Object { $_.FullName.Replace($sdk + '\','') + ' (' + $_.Length + 'b)' }
L ($(if ($dist) { $dist -join "`n" } else { '(dist empty/missing)' }))

# 3) parity (server merkle.js vs compiled SDK)
Set-Location $dir
L '--- parity2.js ---'
$pr = & cmd /c "node parity2.js 2>&1"
L ($pr -join "`n")
L "parity exit=$LASTEXITCODE"

# 4) public paid probe (x402 challenge must be served publicly)
L '--- public paid probe /v1/hash ---'
$curl = & cmd /c "curl -s -i https://70eefc2e136d18.lhr.life/v1/hash?data=hello 2>&1"
$status = ($curl | Select-String -Pattern '^HTTP/').Line
$acc = ($curl | Select-String -Pattern 'accepts|maxAmountRequired|X-PAYMENT').Line
L ("status: " + $status)
L ("x402: " + (($acc | Select-Object -First 3) -join ' | '))

$lines | Set-Content $log -Encoding UTF8
Get-Content $log
