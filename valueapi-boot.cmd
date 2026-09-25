@echo off
REM valueapi-boot.cmd - Startup + HKCU\Run entry point. Self-healing by design.
REM Replaces the old keepalive loop: auto-deploy.js only does work when something is broken,
REM and republishes the durable URL beacon when the tunnel URL changes.
setlocal
set VAPI=C:\root\value-api
if not exist "%VAPI%\auto-deploy.log" echo boot %DATE% %TIME% > "%VAPI%\auto-deploy.log"
:loop
cd /d "%VAPI%"
node auto-deploy.js >> "%VAPI%\auto-deploy.log" 2>&1
timeout /t 300 /nobreak >nul
goto loop
