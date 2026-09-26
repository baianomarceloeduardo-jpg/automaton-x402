@echo off
REM verify-durable.cmd — restart rail, then probe every route, writing all output to a file.
cd /d C:\root\value-api
set LOG=verify-durable.log
echo === VERIFY %DATE% %TIME% === > %LOG%
REM stop only the rail (node on :8080 + boot.js), never every node.exe on the machine
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-rail.ps1" -Port 8080 >> %LOG% 2>&1
ping -n 6 127.0.0.1 > nul
start "valueapi" /MIN cmd /c "node boot.js >> boot.log 2>&1"
ping -n 18 127.0.0.1 > nul
node -e "const http=require('http');const p=(path)=>new Promise(r=>{const q=http.request({host:'127.0.0.1',port:8080,path,method:'GET'},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>r({s:x.statusCode,b:Buffer.byteLength(d),d}))});q.on('error',e=>r({s:0,b:0,d:e.message}));q.setTimeout(12000,()=>{q.destroy();r({s:0,b:0,d:'timeout'})});q.end()});(async()=>{for(const path of ['/health','/durable','/durable.json','/durable.llms.txt','/v1/durable','/v1/index','/catalog']){const r=await p(path);console.log(path.padEnd(22)+' '+r.s+' '+r.b+'B '+String(r.d).slice(0,90).replace(/\s+/g,' '));}})()" >> %LOG% 2>&1
type %LOG%
exit /b 0
