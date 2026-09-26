@echo off
REM verify-402.cmd — restart the rail and confirm the v2 challenge now matches ground truth.
cd /d C:\root\value-api
copy /Y x402v2-overlay.js x402v2-overlay.js.bak12 > nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >> v402.log 2>&1
)
start /B cmd /c "node boot.js >> boot.log 2>&1"
ping -n 10 127.0.0.1 > nul
node check402.js >> v402.log 2>&1
type v402.log
