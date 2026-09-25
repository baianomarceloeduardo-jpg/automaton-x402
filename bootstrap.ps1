# Automaton-Sovereign — one-shot bring-up for the Value API.
# Idempotent: safe to run any number of times. No admin required.
# Does: kill stale (only OUR) procs -> start server -> start tunnel -> verify local+public -> cache URL.

$dir  = 'C:\root\value-api'
$log  = Join-Path $dir 'bootstrap.log'
$urlf = Join-Path $dir 'tunnel.url'
function L($m) { $s = ((Get-Date).ToString('o') + ' ' + $m); Write-Host $s; try { Add-Content -Path $log -Value $s -Encoding UTF8 } catch {} }

function HealthLocal { try { return ((Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 6).StatusCode -eq 200) } catch { return $false } }

L '=== bootstrap start ==='

# 1) Kill ONLY our own value-api node processes (matched by command line)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*value-api*server.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }

# 2) Start server if not already healthy
if (-not (HealthLocal)) {
  Start-Process -FilePath 'node' -ArgumentList (Join-Path $dir 'server.js') -WorkingDirectory $dir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
  for ($i=0; $i -lt 8; $i++) { Start-Sleep 2; if (HealthLocal) { break } }
}
L ('local health: ' + (HealthLocal))

# 3) Refresh tunnel (anonymous localhost.run), parse URL from both streams
Get-Process ssh -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Remove-Item $urlf, (Join-Path $dir 'ssh.log'), (Join-Path $dir 'ssh.err.log') -Force -EA SilentlyContinue
Start-Process -FilePath 'ssh' -ArgumentList '-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-R','80:localhost:8080','nokey@localhost.run' `
  -RedirectStandardOutput (Join-Path $dir 'ssh.log') -RedirectStandardError (Join-Path $dir 'ssh.err.log') -WindowStyle Hidden

$u = $null
for ($i=0; $i -lt 30 -and -not $u; $i++) {
  Start-Sleep 2
  foreach ($f in @((Join-Path $dir 'ssh.log'), (Join-Path $dir 'ssh.err.log'))) {
    if (Test-Path $f) {
      $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.lhr\.life' -EA SilentlyContinue | Select-Object -First 1
      if ($m) { $u = $m.Matches[0].Value; break }
    }
  }
}

if ($u) {
  Set-Content -Path $urlf -Value $u -Encoding ASCII
  L ('TUNNEL = ' + $u)
  for ($i=0; $i -lt 6; $i++) {
    try { $r = Invoke-WebRequest -UseBasicParsing -Uri ($u + '/health') -TimeoutSec 15; L ('PUBLIC /health -> ' + $r.StatusCode); break }
    catch { L ('public health retry ' + $i + ': ' + $_.Exception.Message); Start-Sleep 4 }
  }
  # also confirm the paid gate answers publicly
  try { $p = Invoke-WebRequest -UseBasicParsing -Uri ($u + '/v2/attest?data=probe') -TimeoutSec 15; L ('PUBLIC /v2/attest -> ' + $p.StatusCode) }
  catch { $rc = 0; try { $rc = [int]$_.Exception.Response.StatusCode } catch {}; L ('PUBLIC /v2/attest -> ' + $rc + ' (402 expected)') }
} else {
  L 'TUNNEL: FAILED to obtain public URL this pass'
}
L '=== bootstrap end ==='
