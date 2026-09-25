# Kill whatever owns port 8080 (authoritative), then start v0.2.0 and verify.
$dir = 'C:\root\value-api'
$ev  = Join-Path $dir 'deploy2_evidence.txt'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }

L ('=== SWAP TO v0.2.0 ' + (Get-Date -Format o) + ' ===')

# 1. Find + kill the PID owning TCP 8080
$conns = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  L ("port 8080 held by PID " + $c.OwningProcess)
  try {
    $pr = Get-Process -Id $c.OwningProcess -ErrorAction Stop
    L ("  -> " + $pr.ProcessName + " (" + $pr.Id + ") path=" + $pr.Path)
    if ($pr.ProcessName -eq 'node') { Stop-Process -Id $pr.Id -Force -ErrorAction SilentlyContinue; L '  -> killed' }
    else { L '  -> NOT node, leaving it alone' }
  } catch { L ("  -> could not inspect: " + $_.Exception.Message) }
}
Start-Sleep -Seconds 2
$still = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
L ("port 8080 listeners after kill: " + (@($still).Count))

# 2. Start v0.2.0 with an explicit absolute script path so future matching is trivial
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
Start-Sleep -Seconds 3
L ('server.log: ' + ((Get-Content (Join-Path $dir 'server.log') -Tail 3 -ErrorAction SilentlyContinue) -join ' | '))

# 3. Verify FREE + PAID-required behaviour
function T($name, $url, $headers) {
  try {
    $a = @{ UseBasicParsing = $true; Uri = $url; TimeoutSec = 20 }
    if ($headers) { $a.Headers = $headers }
    $r = Invoke-WebRequest @a
    $c = ($r.Content -replace "`r?`n",' '); if ($c.Length -gt 220) { $c = $c.Substring(0,220) + '...' }
    L ("$name -> $($r.StatusCode) | $c")
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $b = $sr.ReadToEnd() -replace "`r?`n",' '
            if ($b.Length -gt 320) { $b = $b.Substring(0,320) + '...' }
            L ("$name -> $([int]$resp.StatusCode) | $b") }
      catch { L ("$name -> $([int]$resp.StatusCode) | (no body)") }
    } else { L ("$name -> ERR " + $_.Exception.Message) }
  }
}

$b = 'http://127.0.0.1:8080'
T 'FREE  /health'            ($b + '/health')
T 'PAID  /v1/hash no-pay'    ($b + '/v1/hash?input=sovereign')
T 'PAID  /v1/uuid no-pay'    ($b + '/v1/uuid')
T 'PAID  /v1/hash bad-tx'    ($b + '/v1/hash?input=sovereign') @{ 'X-PAYMENT' = ('0x' + ('a' * 64)) }
T 'PAID  /v1/hash malformed' ($b + '/v1/hash?input=sovereign') @{ 'X-PAYMENT' = 'garbage' }
T 'FREE  /stats'             ($b + '/stats')

L '=== END ==='
$out | Set-Content $ev -Encoding UTF8
L ("WROTE $ev")
