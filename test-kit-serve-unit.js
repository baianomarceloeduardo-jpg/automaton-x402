// test-kit-serve-unit.js — does kit-serve.js actually intercept on a FRESH http server?
// Isolates "module is broken" from "live process didn't reload".
'use strict';
require('./kit-serve.js').install();   // real patch
const http = require('http');
const srv = http.createServer((req, res) => {
  // the "real router" — mimic server.js: unknown URL -> JSON 404
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found', path: req.url }));
});
srv.listen(8099, '127.0.0.1', async () => {
  const get = p => new Promise(r => http.get({ host: '127.0.0.1', port: 8099, path: p, timeout: 5000 }, res => {
    let n = 0; res.on('data', c => n += c.length); res.on('end', () => r({ s: res.statusCode, n, kv: res.headers['x-kit-version'] }));
  }).on('error', e => r({ s: 0, e: e.message })));
  const a = await get('/x402-v2-kit.js');
  const b = await get('/v1/x402-v2-kit');
  const c = await get('/definitely-not-a-route');
  console.log('unit /x402-v2-kit.js    -> ' + JSON.stringify(a) + '  (want s=200, kv=1.0.0)');
  console.log('unit /v1/x402-v2-kit    -> ' + JSON.stringify(b) + '  (want s=200)');
  console.log('unit unknown route      -> ' + JSON.stringify(c) + '  (want s=404 = router intact)');
  console.log('hits=' + global.__KIT_SERVE_HITS);
  const ok = a.s === 200 && a.kv === '1.0.0' && b.s === 200 && c.s === 404;
  console.log('UNIT=' + (ok ? 'PASS' : 'FAIL'));
  srv.close(); process.exit(ok ? 0 : 1);
});
