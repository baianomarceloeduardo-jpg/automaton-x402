// prove-remediate.js - isolated proof that the remediation overlay works over real HTTP.
// Spawns its own server on an isolated port plus a deliberately non-conformant dummy target.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8094;
const DUMMY = 8095;
let pass = 0, total = 0;
function c(name, ok, extra) { total++; if (ok) pass++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' -- ' + extra : '')); }
function get(port, p) {
  return new Promise(r => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 25000 }, res => {
      let d = ''; res.on('data', x => d += x); res.on('end', () => r({ status: res.statusCode, type: res.headers['content-type'] || '', body: d }));
    });
    req.on('error', e => r({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); r({ status: 0, body: 'timeout' }); });
  });
}
function waitUp(port, tries) {
  return new Promise(resolve => {
    let n = 0;
    (function poll() {
      get(port, '/health').then(r => { if (r.status === 200) return resolve(true); if (++n >= (tries || 40)) return resolve(false); setTimeout(poll, 500); });
    })();
  });
}

(async () => {
  // non-conformant target: returns 200, never a 402 challenge.
  const dummy = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/plain' }); s.end('ok'); });
  await new Promise(r => dummy.listen(DUMMY, '127.0.0.1', r));

  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore'
  });

  try {
    const up = await waitUp(PORT);
    c('server up with remediation overlay', up);
    if (!up) return;

    const dummyUrl = 'http://127.0.0.1:' + DUMMY + '/';
    const r1 = await get(PORT, '/v1/x402-remediate?url=' + encodeURIComponent(dummyUrl));
    let j1 = {}; try { j1 = JSON.parse(r1.body); } catch (e) {}
    c('/v1/x402-remediate -> 200 JSON', r1.status === 200 && r1.type.indexOf('json') >= 0, 'status=' + r1.status);
    c('non-conformant target yields >=1 concrete fix', (j1.failureCount || 0) >= 1 && Array.isArray(j1.failures), 'failures=' + (j1.failureCount || 0));
    c('every failure carries why+fix', (j1.failures || []).every(f => f.why && f.fix));
    c('canonical challenge snippet included', typeof j1.canonicalChallenge === 'string' && j1.canonicalChallenge.indexOf('402') >= 0);

    const own = 'http://127.0.0.1:' + PORT + '/v1/uuid';
    const r2 = await get(PORT, '/v1/x402-remediate?url=' + encodeURIComponent(own));
    let j2 = {}; try { j2 = JSON.parse(r2.body); } catch (e) {}
    c('own paid route is rated (verdict present)', r2.status === 200 && !!j2.verdict, 'verdict=' + j2.verdict + ' ' + j2.passed + '/' + j2.total);

    const r3 = await get(PORT, '/remediate?url=' + encodeURIComponent(dummyUrl));
    c('/remediate -> 200 HTML with fixes', r3.status === 200 && r3.type.indexOf('html') >= 0 && /class="fix"/.test(r3.body), 'bytes=' + r3.body.length);

    const r4 = await get(PORT, '/v1/x402-remediate');
    c('missing url -> 400 url_required', r4.status === 400 && /url_required/.test(r4.body));

    const r5 = await get(PORT, '/v1/x402-remediate?url=ftp://x/');
    c('bad scheme -> 400', r5.status === 400);
  } finally {
    try { srv.kill(); } catch (e) {}
    try { dummy.close(); } catch (e) {}
    console.log('\n' + pass + '/' + total + ' PASS');
    process.exit(pass === total ? 0 : 1);
  }
})();
