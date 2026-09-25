// verify-discovery.js - quote-safe public verification of the dynamic discovery surface.
'use strict';
const https = require('https'), fs = require('fs');
const base = fs.readFileSync('tunnel.url', 'utf8').trim().replace(/\/$/, '');
function get(p) {
  return new Promise(r => {
    https.get(base + p, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => r({ s: res.statusCode, t: res.headers['content-type'] || '', d })); }).on('error', e => r({ s: 0, t: '', d: e.message }));
  });
}
(async () => {
  console.log('BASE ' + base);
  const l = await get('/llms.txt');
  const hasV = /- Version:\s*0\.9\.0/.test(l.d);
  const hasIndex = l.d.indexOf('/index') >= 0;
  const hasRemed = l.d.indexOf('/remediate') >= 0;
  const noStale = l.d.indexOf('graduate-athletic') < 0;
  console.log('llms.txt -> ' + l.s + ' bytes=' + l.d.length + ' version_ok=' + hasV + ' index=' + hasIndex + ' remediate=' + hasRemed + ' no_stale_url=' + noStale);
  const sm = await get('/sitemap.xml');
  const locs = (sm.d.match(/<loc>/g) || []).length;
  console.log('sitemap.xml -> ' + sm.s + ' urls=' + locs);
  const rb = await get('/robots.txt');
  console.log('robots.txt -> ' + rb.s + ' hasSitemap=' + (rb.d.indexOf('Sitemap:') >= 0));
  const ac = await get('/.well-known/agent-card.json');
  let caps = 0; try { const j = JSON.parse(ac.d); caps = (j.capabilities || []).length; } catch (e) {}
  console.log('agent-card.json -> ' + ac.s + ' capabilities=' + caps);
  const ix = await get('/v1/index');
  let count = 0; try { count = JSON.parse(ix.d).count; } catch (e) {}
  console.log('/v1/index -> ' + ix.s + ' count=' + count);
  const rm = await get('/remediate?url=https%3A%2F%2Fexample.com%2F');
  console.log('/remediate -> ' + rm.s + ' fixDivs=' + ((rm.d.match(/class="fix"/g) || []).length));
})();
