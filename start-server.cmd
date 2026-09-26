@echo off
REM start-server.cmd — reliably (re)start the Value API detached, with logging.
REM WHY: PowerShell Start-Process -RedirectStandardOutput failed with
REM "nao ha suporte para o redirecionamento de entrada" in this shell context.
REM cmd.exe `start /b` with explicit redirection is the dependable primitive here.
cd /d C:\root\value-api || exit /b 1

REM Kill any node process already serving server.js (avoid duplicate listeners).
for /f "tokens=2 delims=," %%p in ('tasklist /fi "imagename eq node.exe" /fo csv /nh') do (
  wmic process where "ProcessId=%%~p" get CommandLine 2>nul | findstr /i "server.js" >nul && taskkill /f /pid %%~p >nul 2>&1
)
timeout /t 2 >nul

REM Start detached. stdout/stderr to files so failures are visible.
start "valueapi" /b /min cmd /c "node server.js >> server.log 2>> server.err.log"
exit /b 0
