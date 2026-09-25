# stabletunnel.ps1 - try to obtain a STABLE public URL (no domain, no account, no USDC).
# Strategy: ssh remote-forward with a FIXED subdomain via serveo.net.
# Writes the winning URL to stable.url and reports reachability.
$ErrorActionPreference = 'SilentlyContinue'
$root = 'C:\root\value-api'
Set-Location $root

$name = 'automaton-sovereign'
$local = 'http://localhost:8080'

# 0. confirm local server is alive
$ok = $false
for ($i=0; $i -lt 10; $i++) {
  try { $h = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "$local/health"; if ($h.StatusCode -eq 200) { $ok = $true; break } } catch {}
  Start-Sleep -Seconds 2
}
Write-Host "local_health=$ok"
if (-not $ok) { Write-Host "ABORT: local server not up"; exit 1 }

# 1. kill any prior ssh tunnel processes
Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1

# 2. launch serveo with a fixed subdomain
Remove-Item "$root\serveo.out","$root\serveo.err" -Force
$p = Start-Process -FilePath 'ssh' -ArgumentList @(
  '-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null',
  '-o','ServerAliveInterval=30','-o','ExitOnForwardFailure=yes',
  '-R',"$name`:80:localhost:8080",'serveo.net'
) -RedirectStandardOutput "$root\serveo.out" -RedirectStandardError "$root\serveo.err" -WindowStyle Hidden -PassThru
Write-Host "ssh_pid=$($p.Id)"
Start-Sleep -Seconds 15

$err = '';
if (Test-Path "$root\serveo.err") { $err = Get-Content "$root\serveo.err" -Raw }
$out = '';
if (Test-Path "$root\serveo.out") { $out = Get-Content "$root\serveo.out" -Raw }
Write-Host "--- serveo stderr (first 800 chars) ---"
Write-Host ($err.Substring(0, [Math]::Min(800, $err.Length)))
Write-Host "--- serveo stdout (first 400 chars) ---"
Write-Host ($out.Substring(0, [Math]::Min(400, $out.Length)))

# 3. find the https URL in either stream
$url = $null
foreach ($s in @($err, $out)) {
  if (-not $s) { continue }
  $m = [regex]::Match($s, 'https://[A-Za-z0-9\.\-]+(?:\.serveo\.net|\.lhr\.life|\.serveo\.net)[^\s]*')
  if ($m.Success) { $url = $m.Value; break }
}
if (-not $url -and $err -match 'https://([A-Za-z0-9\.\-]+)') { $url = $Matches[0] }

if (-not $url) { Write-Host "NO_URL_FOUND"; exit 2 }
Write-Host "FOUND_URL=$url"

# 4. verify public reachability of our own /health
$pass = $false
for ($i=0; $i -lt 8; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 12 ($url.TrimEnd('/') + '/health')
    if ($r.StatusCode -eq 200) { Write-Host "PUBLIC_OK status=$($r.StatusCode) bytes=$($r.Content.Length)"; $pass = $true; break }
  } catch { Write-Host "attempt $i err=$($_.Exception.Message)" }
  Start-Sleep -Seconds 4
}

if ($pass) {
  Set-Content -Path "$root\stable.url" -Value $url -Encoding ASCII
  Write-Host "STABLE_URL_ESTABLISHED=$url"
} else {
  Write-Host "PUBLIC_UNREACHABLE"
  exit 3
}
