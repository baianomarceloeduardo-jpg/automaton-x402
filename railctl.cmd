@echo off
REM railctl.cmd — deterministic single-instance bring-up + health proof. No pipes, no guessing.
cd /d C:\root\value-api
set LOG=railctl.log
echo === RAILCTL %DATE% %TIME% === > %LOG%

REM 1. kill every stale node holding 8080 (only those: see kill-rail.ps1; never every node.exe)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-rail.ps1" -Port 8080 >> %LOG% 2>&1
ping -n 5 127.0.0.1 > nul

REM 2. confirm 8080 is free
netstat -ano | findstr ":8080" >> %LOG% 2>&1

REM 3. start exactly one server, detached, stdio to boot.log
start "valueapi" /MIN cmd /c "node boot.js >> boot.log 2>&1"
ping -n 16 127.0.0.1 > nul

REM 4. bounded health proof written to file (never to a pipe)
node -e "const http=require('http');const p=(path)=>new Promise(r=>{const q=http.request({host:'127.0.0.1',port:8080,path,method:'GET'},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>r({s:x.statusCode,d}))});q.on('error',e=>r({s:0,d:e.message}));q.setTimeout(8000,()=>{q.destroy();r({s:0,d:'timeout'})});q.end()});(async()=>{const h=await p('/health');console.log('HEALTH '+h.s+' '+h.d.slice(0,180));const v=await p('/v1/rail');console.log('RAIL '+v.s+' '+v.d.slice(0,300));const x=await p('/v1/hash');console.log('PAIDROUTE '+x.s);})()" >> %LOG% 2>&1

REM 5. record the public URL if a tunnel file exists
if exist tunnel.url (echo TUNNEL: & type tunnel.url >> %LOG%) else (echo TUNNEL: none >> %LOG%)
exit /b 0
