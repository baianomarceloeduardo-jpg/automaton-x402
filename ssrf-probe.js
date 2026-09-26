
const http=require('http');const https=require('https');
require('./ssrf-guard.js');
const results=[];
function t(name,fn){return new Promise(r=>{const to=setTimeout(()=>{results.push([name,'TIMEOUT']);r()},9000);fn((v)=>{clearTimeout(to);results.push([name,v]);r()})})}
(async()=>{
  await t('metadata 169.254.169.254',cb=>{const q=http.get('http://169.254.169.254/latest/meta-data/',()=>cb('CONNECTED (HOLE)'));q.on('error',e=>cb(/ssrf_blocked|blocked/.test(e.message)?'REFUSED ('+e.message+')':'error '+e.message))});
  await t('private 10.0.0.5',cb=>{const q=http.get('http://10.0.0.5/',()=>cb('CONNECTED (HOLE)'));q.on('error',e=>cb(/ssrf_blocked|blocked/.test(e.message)?'REFUSED ('+e.message+')':'error '+e.message))});
  await t('loopback other port 9999',cb=>{const q=http.get('http://127.0.0.1:9999/',()=>cb('CONNECTED (HOLE)'));q.on('error',e=>cb(/ssrf_blocked|blocked/.test(e.message)?'REFUSED ('+e.message+')':'error '+e.message))});
  await t('own loopback 8080',cb=>{const q=http.get('http://127.0.0.1:8080/health',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>cb('ALLOWED status='+r.statusCode))});q.on('error',e=>cb('ERROR '+e.message))});
  await t('public https paste.rs',cb=>{https.get('https://paste.rs/raw',r=>{r.resume();cb('ALLOWED status='+r.statusCode)}).on('error',e=>cb('error '+e.message))});
  console.log(JSON.stringify(results,null,1));
})();