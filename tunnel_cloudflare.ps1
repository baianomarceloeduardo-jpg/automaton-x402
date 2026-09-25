# tunnel_cloudflare.ps1 — Solid, high-performance Cloudflare Tunnel for Value API
$ErrorActionPreference = 'Continue'
$dir = 'C:\root\value-api'
$bin = Join-Path $dir 'bin\cloudflared.exe'
$urlf = Join-Path $dir 'tunnel.url'
$clog = Join-Path $dir 'cloudflared.log'
$elog = Join-Path $dir 'cloudflared.err.log'

# Kill old tunnels
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process ssh -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Remove-Item $clog, $elog, $urlf -Force -ErrorAction SilentlyContinue

Write-Host "Launching Cloudflare Tunnel on http://127.0.0.1:8080..."
Start-Process -FilePath $bin `
  -ArgumentList 'tunnel','--url','http://127.0.0.1:8080','--no-autoupdate' `
  -RedirectStandardOutput $clog -RedirectStandardError $elog -WindowStyle Hidden

for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  foreach ($f in @($clog, $elog)) {
    if (Test-Path $f) {
      $content = Get-Content $f -Raw -ErrorAction SilentlyContinue
      if ($content -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
        $url = $matches[0]
        $url | Set-Content $urlf -Encoding UTF8
        Write-Host "SUCCESS: Cloudflare Tunnel is UP at: $url"
        exit 0
      }
    }
  }
}

Write-Host "TIMEOUT: Could not detect Cloudflare Tunnel URL"
exit 1
