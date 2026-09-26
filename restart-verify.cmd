@echo off
REM restart-verify.cmd — clean restart of the value API and verify the new CDP directory.
cd /d C:\root\value-api
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >> rv.log 2>&1
)
start /B cmd /c "node boot.js >> boot.log 2>&1"
ping -n 10 127.0.0.1 > nul
echo === /health === >> rv.log
curl -s -m 30 "http://127.0.0.1:8080/health" >> rv.log 2>&1
echo. >> rv.log
echo === /v1/cdp-directory summary === >> rv.log
curl -s -m 120 "http://127.0.0.1:8080/v1/cdp-directory?limit=1" -o cdp-out.json >> rv.log 2>&1
node -e "try{const j=require('./cdp-out.json');console.log('ok='+j.ok+' upstreamItems='+j.upstreamItems+' total='+(j.directory&&j.directory.total)+' usdcOnBase='+(j.directory&&j.directory.usdcOnBase));console.log('top='+JSON.stringify((j.directory&&j.directory.topSellers||[]).slice(0,4)));console.log('sample='+JSON.stringify((j.services||[])[0]));}catch(e){console.log('PARSE_FAIL '+e.message);}" >> rv.log 2>&1
echo === done === >> rv.log
type rv.log
