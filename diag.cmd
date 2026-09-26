@echo off
REM diag.cmd — one bounded diagnostic, output to file, fully detached so exec never blocks.
cd /d C:\root\value-api
echo === PATCH CHECK === > diag.out 2>&1
findstr /n "get(url, 6000)" discover-base.js >> diag.out 2>&1
findstr /n "staticNetwork" capability-manifest.js >> diag.out 2>&1
echo === CLI DIRECT (10s cap) === >> diag.out 2>&1
start /B cmd /c "node discover-base.js --self --json > cli.json 2>&1"
ping -n 13 127.0.0.1 >nul
echo --- cli.json --- >> diag.out
type cli.json >> diag.out 2>&1
echo. >> diag.out
echo === DONE === >> diag.out
