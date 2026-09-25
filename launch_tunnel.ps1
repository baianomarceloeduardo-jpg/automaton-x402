# Automaton-Sovereign — public tunnel launcher
# Uses PowerShell Start-Process so cloudflared gets a real (redirectable) stdin handle.
# Writes the public URL to tunnel.url and the raw log to tunnel.log

$ErrorActionPreference = 'Continue'
$dir = 'C:\root\value-api'
$exe = Join-Path $dir 'bin\cloudflared.exe'
$log = Join-Path $dir 'tunnel.log'
$url = Join-Path $dir 'tunnel.url'

if (-not (Test-Path $exe)) { Write-Host 'NO_BINARY'; exit 1 }

Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
if (Test-Path $url) { Remove-Item $url -Force -ErrorAction SilentlyContinue }

Start-Process -FilePath $exe `
  -ArgumentList 'tunnel','--url','http://localhost:8080','--no-autoupdate' `
  -RedirectStandardOutput $log `
  -RedirectStandardError (Join-Path $dir 'tunnel.err.log') `
  -WindowStyle Hidden

# Wait for the trycloudflare URL to appear
$found = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { $found = $m.Matches[0].Value; break }
  }
}

if ($found) {
  $found | Set-Content -Path $url -Encoding UTF8
  Write-Host ('PUBLIC_URL=' + $found)
} else {
  Write-Host 'NO_URL_YET'
  if (Test-Path $log) { Get-Content $log -Tail 25 }
  $e = Join-Path $dir 'tunnel.err.log'
  if (Test-Path $e) { Write-Host '--- STDERR ---'; Get-Content $e -Tail 25 }
}
