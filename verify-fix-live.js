// verify-fix-live.js - prove the corrected checker is LIVE on the public URL, end to end.
// Runs the same v2 service through (a) the local module and (b) my public /v1/x402-conformance
// endpoint, and asserts they agree. Agreement = the fix reached production.
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');

const TARGETS = [
  'https://page-extract.x402supply.com/mcp',
  'https://api.tensorfeed.ai/x402/base/weather'
];

const base = (fs.existsSync('tunnel.url') ? fs.readFileSync('tunnel.url', 'utf8').trim() : '').replace(/\s+/g, '');

function get(url, ms) {
  return new Promise(res => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { timeout: ms || 30000, headers: { Accept: 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('error', e => res({ status: 0, err: e.message }));
    req.setTimeout(ms || 30000, () => { req.destroy(); res({ status: 0, err: 'timeout' }); });
  });
}

(async () => {
  const local = require('./x402-conformance.js');
  console.log('local impl: ' + (local.__impl || 'legacy'));
  console.log('public base: ' + base + '\n');
  let pass = 0, n = 0;
  for (const t of TARGETS) {
    n++;
    const a = await local.run(t);
    const pub = await get(base + '/v1/x402-conformance?url=' + encodeURIComponent(t));
    let b = null; try { b = JSON.parse(pub.body); } catch (e) {}
    const bRep = b && (b.report || b.report === undefined ? (b.report || b) : b);
    const bVerdict = (bRep && bRep.verdict) || (b && b.verdict) || 'n/a';
    const ok = bVerdict === a.verdict;
    if (ok) pass++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + t);
    console.log('       local=' + a.verdict + ' dialect=' + a.dialect + '  public=' + bVerdict + ' (http ' + pub.status + ')');
  }
  console.log('\nLIVE-AGREEMENT ' + pass + '/' + n + (pass === n ? ' ALL PASS' : ' MISMATCH'));
})();
