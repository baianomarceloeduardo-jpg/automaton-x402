# install_task.ps1 - make the value-api self-healing at the OS level, independent of the agent process.
# ASCII-only. Registers a scheduled task every 5 minutes + at startup.
$dir = 'C:\root\value-api'
$ps  = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$ka  = Join-Path $dir 'keepalive.ps1'
$name = 'AutomatonValueApiKeepalive'

$action  = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ka`"" -WorkingDirectory $dir
$trigger = @(
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)),
  (New-ScheduledTaskTrigger -AtStartup)
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

try {
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force -EA Stop | Out-Null
  Write-Host "TASK REGISTERED: $name (every 5 min + at startup)"
} catch { Write-Host "TASK REGISTER FAILED: $($_.Exception.Message)" }

# prove the task exists and run it once now
$t = Get-ScheduledTask -TaskName $name -EA SilentlyContinue
if ($t) {
  Write-Host "state=$($t.State)"
  Start-ScheduledTask -TaskName $name
  Start-Sleep 25
  $i = Get-ScheduledTaskInfo -TaskName $name -EA SilentlyContinue
  Write-Host "lastRun=$($i.LastRunTime) lastResult=$($i.LastTaskResult)"
}
# show the tail of the keepalive journal
Write-Host '--- keepalive.log (tail) ---'
Get-Content (Join-Path $dir 'keepalive.log') -Tail 6 -EA SilentlyContinue
