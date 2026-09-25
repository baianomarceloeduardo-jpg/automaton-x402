# Deploy v0.4.0 and verify discovery + free-trial limiter.
$dir = 'C:\root\value-api'
$ev  = Join-Path $dir 'v040_evidence.txt'
$out = @()
function L($m) { $script:out += $m; Write-Host $m }
function T($name, $url, $headers, $method, $body) {
  try {
    $a = @{ UseBasicParsing = $true; Uri = $url; TimeoutSec = 20; Method = ($(if($method){$method}else{'GET'})) }
    if ($headers) { $a.Headers = $headers }
    if ($body) { $a.Body = $body; $a.ContentType = 'application/json' }
    $r = Invoke-WebRequest @a
    $ft = ''; if ($r.Headers['X-Free-Trial-Remaining']) { $ft = ' [trial_remaining=' + $r.Headers['X-Free-Trial-Remaining'] + ']' }
    $c = ($r.Content -replace "`r?`n",' '); if ($c.Length -gt 200) { $c = $c.Substring(0,200) + '...' }
    L ("$name -> $($r.StatusCode)$ft | $c")
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { try { $sr = New-Object System.IO.StreamReader($resp.GetResponseStream()); $b = $sr.ReadToEnd() -replace "`r?`n",' '; if ($b.Length -gt 200) { $b = $b.Substring(0,200) + '...' }; L ("$name -> $([int]$resp.StatusCode) | $b") } catch { L ("$name -> $([int]$resp.StatusCode)") } }
    else { L ("$name -> ERR " + $_.Exception.Message) }
  }
}

# fresh trial state; restart to v0.4.0
Remove-Item (Join-Path $dir 'trial.json') -Force -EA SilentlyContinue
foreach ($c in (Get-NetTCPConnection -LocalPort 8080 -State Listen -EA SilentlyContinue)) {
  $pr = Get-Process -Id $c.OwningProcess -EA SilentlyContinue
  if ($pr -and $pr.ProcessName -eq 'node') { Stop-Process -Id $pr.Id -Force -EA SilentlyContinue }
}
Start-Sleep 2
Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
Start-Sleep 4
L ('server.log: ' + ((Get-Content (Join-Path $dir 'server.log') -Tail 2 -EA SilentlyContinue) -join ' | '))

$b = 'http://127.0.0.1:8080'
T 'FREE  /openapi.json'                  ($b + '/openapi.json')
T 'FREE  /.well-known/x402-bazaar.json'  ($b + '/.well-known/x402-bazaar.json')
T 'FREE  /.well-known/ai-plugin.json'    ($b + '/.well-known/ai-plugin.json')
L '--- FREE TRIAL limiter (FREE_TRIAL=3): expect 200,200,200,402 ---'
T 'TRIAL 1 /v1/uuid' ($b + '/v1/uuid')
T 'TRIAL 2 /v1/uuid' ($b + '/v1/uuid')
T 'TRIAL 3 /v1/uuid' ($b + '/v1/uuid')
T 'TRIAL 4 /v1/uuid (expect 402)' ($b + '/v1/uuid')
T 'FREE  /stats' ($b + '/stats')

$out | Set-Content $ev -Encoding UTF8
L ('WROTE ' + $ev)
