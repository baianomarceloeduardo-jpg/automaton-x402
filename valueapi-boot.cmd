@echo off
rem valueapi-boot.cmd - non-admin autostart launcher (no elevation required).
rem Called at user logon from the Startup folder / HKCU Run key.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\root\value-api\keepalive.ps1" >> "C:\root\value-api\boot.log" 2>&1
rem Keep a supervisor loop alive: re-check every 5 minutes so the public URL self-heals.
:loop
timeout /t 300 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\root\value-api\keepalive.ps1" >> "C:\root\value-api\boot.log" 2>&1
goto loop
