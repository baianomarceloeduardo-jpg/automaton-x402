# paidapi-keepalive.ps1 — keeps the PAID API reachable AND its durable listings in sync.
#
# WHY: the paid path is proven (a zero-ETH stranger paid over the public internet, settlement
# verified on-chain). The remaining risk is that the public URL rotates and every durable listing
# goes stale. self-heal-paid.js fixes exactly that: it restores the service, re-establishes the
# tunnel, verifies PUBLICLY, and republishes the durable beacon whenever the base URL changes.
# This supervisor makes that run without me -- every 300s, and at boot.
$ErrorActionPreference = 'Continue'
Set-Location 'C:\root\value-api'

Write-Output ('[' + (Get-Date).ToUniversalTime().ToString('s') + 'Z] paidapi-keepalive supervisor starting')

while ($true) {
  try {
    node self-heal-paid.js 2>&1 | Out-File -FilePath 'self-heal-paid.log' -Append -Encoding utf8
  } catch {
    ('[' + (Get-Date).ToUniversalTime().ToString('s') + 'Z] heal error: ' + $_) | Out-File -FilePath 'self-heal-paid.log' -Append -Encoding utf8
  }
  Start-Sleep -Seconds 300
}
