@echo off
REM one-shot.cmd — restart+verify the rail AND run the registrar probe. One process, one log.
cd /d C:\root\value-api
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%P >> oneshot.log 2>&1
)
start /B cmd /c "node boot.js >> boot.log 2>&1"
ping -n 10 127.0.0.1 > nul
echo === /health === >> oneshot.log
curl -s -m 30 "http://127.0.0.1:8080/health" >> oneshot.log 2>&1
echo. >> oneshot.log
echo === /v1/cdp-directory === >> oneshot.log
curl -s -m 120 "http://127.0.0.1:8080/v1/cdp-directory?limit=1" -o cdp-out.json >> oneshot.log 2>&1
node -e "try{const j=require('./cdp-out.json');console.log('ok='+j.ok+' upstreamItems='+j.upstreamItems+' total='+(j.directory&&j.directory.total)+' usdcOnBase='+(j.directory&&j.directory.usdcOnBase));console.log('top='+JSON.stringify((j.directory&&j.directory.topSellers||[]).slice(0,4)));console.log('sample='+JSON.stringify((j.services||[])[0]));}catch(e){console.log('PARSE_FAIL '+e.message);}" >> oneshot.log 2>&1
echo === /v3/providers === >> oneshot.log
curl -s -m 60 "http://127.0.0.1:8080/v3/providers" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);console.log('reachable='+j.reachable+'/'+j.total+' consensusCapacity='+j.consensusCapacity);}catch(e){console.log('FAIL');}});" >> oneshot.log 2>&1
echo === REGISTRAR PROBE === >> oneshot.log
node find-registrar.js >> oneshot.log 2>&1
echo === END === >> oneshot.log
type oneshot.log
