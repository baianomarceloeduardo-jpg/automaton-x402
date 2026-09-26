@echo off
REM rail-public.cmd — single-instance bring-up, then best-available public tunnel. Writes proof to file.
cd /d C:\root\value-api
set LOG=rail-public.log
echo === RAIL-PUBLIC %DATE% %TIME% === > %LOG%

REM stop only the rail (node on :8080 + boot.js), never every node.exe on the machine
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-rail.ps1" -Port 8080 >> %LOG% 2>&1
ping -n 5 127.0.0.1 > nul

start "valueapi" /MIN cmd /c "node boot.js >> boot.log 2>&1"
ping -n 16 127.0.0.1 > nul

REM health probe to file (never a pipe)
node -e "const http=require('http');const p=(path)=>new Promise(r=>{const q=http.request({host:'127.0.0.1',port:8080,path,method:'GET'},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>r({s:x.statusCode,d}))});q.on('error',e=>r({s:0,d:e.message}));q.setTimeout(8000,()=>{q.destroy();r({s:0,d:'timeout'})});q.end()});(async()=>{const h=await p('/health');console.log('HEALTH '+h.s+' '+h.d.slice(0,160));const x=await p('/v1/hash');console.log('PAIDROUTE '+x.s);const c=await p('/catalog');console.log('CATALOG '+c.s);})()" >> %LOG% 2>&1

REM best tunnel: reuse existing, else cloudflared quick tunnel
if exist cloudflared.exe (
  echo STARTING_CLOUDFLARED >> %LOG%
  start "cf" /MIN cmd /c "cloudflared.exe tunnel --url http://127.0.0.1:8080 --no-autoupdate > cf.log 2>&1"
  ping -n 22 127.0.0.1 > nul
  findstr /R /C:"[a-z0-9-]*\.trycloudflare\.com" cf.log > tunnel.url 2>nul
  if exist tunnel.url (
    set /p URL=<tunnel.url
    echo TUNNEL_URL=%URL% >> %LOG%
  ) else (
    echo TUNNEL_FAILED >> %LOG%
  )
) else (
  echo NO_CLOUDFLARED >> %LOG%
)
type %LOG%
exit /b 0
