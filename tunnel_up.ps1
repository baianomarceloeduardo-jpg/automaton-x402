# Automaton-Sovereign — bring public tunnel UP (multi-strategy)
# Strategy A: cloudflared quick tunnel (copy binary to avoid file locks)
# Strategy B: ssh -R reverse tunnel via localhost.run (no account, ssh is present)

$ErrorActionPreference = 'Continue'
$dir = 'C:\root\value-api'
$out = Join-Path $dir 'tunnel.url'
if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }

function Log($m) { Write-Host $m }

# --- 0. Ensure the local service is alive ---
try {
  $h = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 5
  Log ('LOCAL_SERVICE=UP ' + $h.StatusCode)
} catch {
  Log 'LOCAL_SERVICE=DOWN -> restarting'
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $dir 'server.log') -RedirectStandardError (Join-Path $dir 'server.err.log')
  Start-Sleep -Seconds 3
}

# --- A. cloudflared ---
$run = Join-Path $dir 'bin\cf_run.exe'
$src = Join-Path $dir 'bin\cloudflared.exe'
if (Test-Path $src) {
  Get-Process cloudflared,cf_run -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Copy-Item $src $run -Force -ErrorAction SilentlyContinue
  if (Test-Path $run) {
    $ver = & $run --version 2>&1 | Out-String
    Log ('CF_VERSION=' + $ver.Trim())
    $log = Join-Path $dir 'cf.log'
    if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
    Start-Process -FilePath $run `
      -ArgumentList 'tunnel','--url','http://localhost:8080','--no-autoupdate' `
      -RedirectStandardOutput $log -RedirectStandardError (Join-Path $dir 'cf.err.log') -WindowStyle Hidden
    for ($i=0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 2
      if (Test-Path $log) {
        $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { $m.Matches[0].Value | Set-Content $out -Encoding UTF8; Log ('CLOUDFLARED_URL=' + $m.Matches[0].Value); break }
      }
    }
    if (-not (Test-Path $out)) { Log 'CLOUDFLARED_NO_URL'; if (Test-Path $log) { Log '--- cf.log ---'; Get-Content $log -Tail 20 } }
  } else { Log 'CF_COPY_FAILED' }
} else { Log 'CF_BINARY_MISSING' }

# --- B. ssh reverse tunnel fallback ---
if (-not (Test-Path $out)) {
  Log 'TRYING_SSH_TUNNEL'
  $slog = Join-Path $dir 'ssh.log'
  if (Test-Path $slog) { Remove-Item $slog -Force -ErrorAction SilentlyContinue }
  Start-Process -FilePath 'ssh' `
    -ArgumentList '-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','ServerAliveInterval=15','-R','80:localhost:8080','nokey@localhost.run' `
    -RedirectStandardOutput $slog -RedirectStandardError (Join-Path $dir 'ssh.err.log') -WindowStyle Hidden
  for ($i=0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    foreach ($f in @($slog, (Join-Path $dir 'ssh.err.log'))) {
      if (Test-Path $f) {
        $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.(lhr\.life|localhost\.run)' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { $m.Matches[0].Value | Set-Content $out -Encoding UTF8; Log ('SSH_URL=' + $m.Matches[0].Value); break }
      }
    }
    if (Test-Path $out) { break }
  }
  if (-not (Test-Path $out)) { Log 'SSH_NO_URL' }
}

# --- C. report ---
if (Test-Path $out) {
  $u = (Get-Content $out -Raw).Trim()
  Log ('FINAL_PUBLIC_URL=' + $u)
  Log '--- PUBLIC PROBE ---'
  foreach ($p in @('/health','/pricing','/v1/hash?input=sovereign')) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri ($u + $p) -TimeoutSec 20
      Log ('PUBLIC GET ' + $p + ' -> ' + $r.StatusCode + ' | ' + (($r.Content -replace "`r?`n",' ').Substring(0, [Math]::Min(160, $r.Content.Length))))
    } catch { Log ('PUBLIC GET ' + $p + ' -> ERR ' + $_.Exception.Message) }
  }
} else {
  Log 'NO_TUNNEL_ESTABLISHED'
}
