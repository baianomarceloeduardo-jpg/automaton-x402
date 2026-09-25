# Register the watchdog as a persistent scheduled task and verify registration.
# Writes all results to install_result.txt so it can be read back reliably.

$dir = 'C:\root\value-api'
$res = Join-Path $dir 'install_result.txt'
$out = @()
function Log($m) { $script:out += $m }

$name = 'AutomatonValueAPI'
$wd   = Join-Path $dir 'watchdog.ps1'
$vbs  = Join-Path $dir 'run_watchdog.vbs'

# Remove any prior definitions (both possible names)
foreach ($n in @($name, $name + '5')) {
  $d = schtasks /Delete /TN $n /F 2>&1 | Out-String
  Log ("DELETE $n -> " + $d.Trim())
}

# Primary: run at logon, restart on failure, no time limit
$a1 = schtasks /Create /TN $name /TR ("wscript.exe `"$vbs`"") /SC ONLOGON /RL HIGHEST /F 2>&1 | Out-String
Log ("CREATE $name -> " + $a1.Trim())

# Secondary: every 5 minutes, so a crash is healed within 5 min
$a2 = schtasks /Create /TN ($name + '5') /TR ("wscript.exe `"$vbs`"") /SC MINUTE /MO 5 /RL HIGHEST /F 2>&1 | Out-String
Log ("CREATE " + $name + "5 -> " + $a2.Trim())

# Query them back
$q1 = schtasks /Query /TN $name /FO LIST /V 2>&1 | Select-String 'TaskName|Status|Run As User|Task To Run' | Out-String
Log ("QUERY $name`n" + $q1.Trim())
$q2 = schtasks /Query /TN ($name + '5') /FO LIST 2>&1 | Select-String 'TaskName|Status|Next Run' | Out-String
Log ("QUERY " + $name + "5`n" + $q2.Trim())

# Start both now
$s1 = schtasks /Run /TN $name 2>&1 | Out-String
Log ("RUN $name -> " + $s1.Trim())
$s2 = schtasks /Run /TN ($name + '5') 2>&1 | Out-String
Log ("RUN " + $name + "5 -> " + $s2.Trim())

# Give the watchdog time to do one healing pass
Start-Sleep -Seconds 45

# Report live state
$procs = Get-Process node,ssh,powershell -ErrorAction SilentlyContinue |
         Select-Object Id,ProcessName | Format-Table -AutoSize | Out-String
Log "PROCESSES`n$procs"

if (Test-Path (Join-Path $dir 'watchdog.log')) {
  Log ("WATCHDOG LOG`n" + (Get-Content (Join-Path $dir 'watchdog.log') -Tail 20 | Out-String))
} else { Log 'WATCHDOG LOG: missing' }

if (Test-Path (Join-Path $dir 'tunnel.url')) {
  Log ("TUNNEL URL: " + (Get-Content (Join-Path $dir 'tunnel.url') -Raw).Trim())
} else { Log 'TUNNEL URL: missing' }

$out | Set-Content $res -Encoding UTF8
Write-Host "RESULT_WRITTEN_TO $res"
