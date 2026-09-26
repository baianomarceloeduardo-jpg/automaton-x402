# kill-rail.ps1 - stop ONLY the local value-api rail (node listening on the rail port, plus any
# `node boot.js` launcher), never every node.exe. The orchestrator, paid-api, tunnels and other
# agents' node processes keep running. Used by verify-402b.cmd.
#   -Port   rail port (default 8080, what boot.js -> server.js listens on)
#   -DryRun list what would be stopped without stopping it
param([int]$Port = 8080, [switch]$DryRun)
$ErrorActionPreference = 'Continue'

$targets = @{}
foreach ($c in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
  if ($p -and $p.Name -eq 'node.exe') { $targets[[int]$p.ProcessId] = "port $Port | $($p.CommandLine)" }
}
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
  if ($p.CommandLine -match '(^|[\s\\/"])boot\.js(\s|"|$)') { $targets[[int]$p.ProcessId] = "boot.js | $($p.CommandLine)" }
}

if ($targets.Count -eq 0) { Write-Output "[kill-rail] no rail process found (port $Port / boot.js)"; exit 0 }
foreach ($id in $targets.Keys) {
  if ($DryRun) { Write-Output "[kill-rail] would stop pid=$id ($($targets[$id]))"; continue }
  try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Output "[kill-rail] stopped pid=$id ($($targets[$id]))" }
  catch { Write-Output "[kill-rail] could not stop pid=${id}: $($_.Exception.Message)" }
}
exit 0
