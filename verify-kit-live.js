// verify-kit-live.js — prove /x402-v2-kit.js is served locally AND publicly. Concrete acceptance test.
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path');
const dir = __dirname;
const base = fs.readFileSync(path.join(dir, 'tunnel.url'), 'utf8').trim().replace(/\s+/g, '');

function get(u, isHttps, host) {
  return new Promise(res => {
    const mod = isHttps ? https : http;
    const opts = isHttps ? { hostname: host, path: u, method: 'GET', timeout: 15000 } : { host: '127.0.0.1', port: 8080, path: u, timeout: 8000 };
    const r = mod.request(opts, resp => { let n = 0, first = ''; resp.on('data', c => { n += c.length; if (first.length < 80) first += c.slice(0, 80).toString(); });
      resp.on('end', () => res({ status: resp.statusCode, bytes: n, ct: resp.headers['content-type'], kv: resp.headers['x-kit-version'], first: first.slice(0, 60) })); });
    r.on('error', e => res({ status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); res({ status: 0, error: 'timeout' }); });
    r.end();
  });
}

(async () => {
  const out = {};
  out.localKit = await get('/x402-v2-kit.js', false);
  out.localJson = await get('/v1/x402-v2-kit', false);
  out.localRoot = await get('/', false);                 // regression: root must still work
  out.localPricing = await get('/pricing', false);       // regression: a real route
  const host = base.replace(/^https?:\/\//, '');
  out.pubKit = await get('/x402-v2-kit.js', true, host);
  out.pubJson = await get('/v1/x402-v2-kit', true, host);
  out.pubHash = await get('/v1/hash', true, host);

  for (const k of Object.keys(out)) console.log(k + ' = ' + JSON.stringify(out[k]));
  const ok = out.localKit.status === 200 && out.localRoot.status === 200 && out.localPricing.status === 200
    && out.pubKit.status === 200 && out.pubJson.status === 200 && out.pubHash.status === 402;
  console.log('\nKIT_LIVE=' + (ok ? 'YES' : 'NO'));
  fs.writeFileSync(path.join(dir, 'kit-live.json'), JSON.stringify({ at: new Date().toISOString(), base, out, kitLive: ok }, null, 2));
})();
