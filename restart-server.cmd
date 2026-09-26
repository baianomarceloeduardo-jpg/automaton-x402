@echo off
REM restart-server.cmd — deterministic restart of value-api. No wmic, no inline escaping.
setlocal enabledelayedexpansion
cd /d C:\root\value-api

REM kill whatever listens on :8080
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":8080 .*LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

timeout /t 2 /nobreak >nul

REM start detached, log to server.log
start "valueapi" /B cmd /c "node server.js >> server.log 2>&1"

timeout /t 6 /nobreak >nul
echo RESTART_DONE
endlocal
