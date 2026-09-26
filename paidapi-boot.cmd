@echo off
REM paidapi-boot.cmd - persists the PROVEN paid API across reboot/crash. Non-admin.
setlocal
cd /d "C:\root\value-api"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\root\value-api\paidapi-keepalive.ps1"
:loop
timeout /t 300 /nobreak >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\root\value-api\paidapi-keepalive.ps1"
goto loop
