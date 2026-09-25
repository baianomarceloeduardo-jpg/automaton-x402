// prove-discovery.js - prove the dynamic discovery overlay serves live, correct content.
'use strict';
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const PORT = 8096;
let pass = 0, total = 0;
const c = (n, ok, x) => { total++; if (ok) pass++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? ' -- ' + x : '')); };
function get(p, host) {
  return new Promise(r => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, headers: host ? { host } : {}, timeout: 20000 }, res => {
      let d = ''; res.on('data', x => d += x); res.on('end', () => r({ s: res.statusCode, t: res.headers['content-type'] || '', d }));
    });
    req.on('error', e => r({ s: 0, d: e.message }));
    req.on('timeout', () => { req.destroy(); r({ s: 0, d: 'timeout' }); });
  });
}
(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], { cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await new Promise(r => setTimeout(r, 500)); up = (await get('/health')).s === 200; }
  c('server up with discovery overlay', up);
  try {
    const host = 'example-base-xyz.trycloudflare.com';
    const l = await get('/llms.txt', host);
    c('/llms.txt -> 200 text/plain', l.s === 200 && l.t.indexOf('text/plain') >= 0);
    c('llms.txt uses the LIVE host (no stale tunnel)', l.d.indexOf(host) >= 0);
    c('llms.txt advertises index + remediate + badge', /\/(index|remediate|badge\.svg)/.test(l.d) && l.d.indexOf('/v1/index') >= 0);
    c('llms.txt documents BOTH payment schemes', l.d.indexOf('eip3009') >= 0 && l.d.indexOf('exact') >= 0);
    const s = await get('/sitemap.xml', host);
    c('/sitemap.xml -> 200 xml with many urls', s.s === 200 && (s.d.match(/<url>/g) || []).length >= 20, (s.d.match(/<url>/g) || []).length + ' urls');
    const r = await get('/robots.txt', host);
    c('/robots.txt -> 200 with sitemap + index hint', r.s === 200 && r.d.indexOf('Sitemap:') >= 0 && r.d.indexOf('/index') >= 0);
    const a = await get('/.well-known/agent-card.json', host);
    let j = {}; try { j = JSON.parse(a.d); } catch (e) {}
    c('/.well-known/agent-card.json -> 200 json', a.s === 200 && !!j.name);
    c('agent card lists both schemes + free/paid split', (j.payment && j.payment.schemes && j.payment.schemes.length === 2) && (j.freeEndpoints || []).length >= 15 && (j.paidEndpoints || []).length >= 4);
  } finally {
    try { srv.kill(); } catch (e) {}
    console.log('\n' + pass + '/' + total + ' PASS');
    process.exit(pass === total ? 0 : 1);
  }
})();
