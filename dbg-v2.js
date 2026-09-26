// dbg-v2.js — one-shot debug: surface WHY the in-process 402 proof failed.
'use strict';
const http = require('http');
const ov = require(require('path').join(__dirname, 'x402v2-overlay.js'));
ov.install(http);
const V1 = { x402Version: 1, accepts: [{ scheme: 'eip3009', network: 'base',
  asset: ov.USDC, payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528', maxAmountRequired: '1000' }] };
const body = JSON.stringify(V1);
const srv = http.createServer((req, res) => {
  try {
    res.writeHead(402, { 'content-type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  } catch (e) { console.log('HANDLER THROW: ' + e.stack); }
});
srv.on('clientError', e => console.log('clientError: ' + e.message));
srv.listen(8123, '127.0.0.1', () => {
  console.log('listening');
  const r = http.request({ host: '127.0.0.1', port: 8123, path: '/x', method: 'GET' }, res => {
    let b = ''; res.on('data', c => b += c);
    res.on('end', () => {
      console.log('status=' + res.statusCode + ' cl=' + res.headers['content-length']
        + ' actual=' + Buffer.byteLength(b) + ' pr=' + !!res.headers['payment-required']);
      console.log('body=' + b.slice(0, 120));
      srv.close(); process.exit(0);
    });
  });
  r.on('error', e => { console.log('REQ ERROR: ' + e.code + ' ' + e.message); srv.close(); process.exit(1); });
  r.end();
});
process.on('uncaughtException', e => { console.log('UNCAUGHT: ' + e.stack); process.exit(3); });
setTimeout(() => { console.log('TIMEOUT - no response'); process.exit(4); }, 8000);
