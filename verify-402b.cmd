@echo off
REM verify-402b.cmd — restart the rail fully detached, then check the live 402 conformance.
cd /d C:\root\value-api
echo === VERIFY402B %DATE% %TIME% === > v402.log
REM Stop ONLY the rail (node on :8080 + boot.js). `taskkill /IM node.exe` used to kill every node
REM on the machine: orchestrator daemons, paid-api, tunnels and other agents' processes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-rail.ps1" -Port 8080 >> v402.log 2>&1
ping -n 4 127.0.0.1 > nul
start "valueapi" /MIN cmd /c "node boot.js >> boot.log 2>&1"
ping -n 12 127.0.0.1 > nul
node check402.js > v402.out 2>&1
exit /b 0
