// verify-402-evidence.js v1.0.0 - REAL evidence for the 402 suspects.
// BUG BEING FIXED: challenge-diff.js probed registry NAMES like "com.x402supply/chess-eval"
// as if they were hostnames -> DNS failure -> HTTP 0. Those are reverse-DNS identifiers.
// The real endpoint URLs are in ecosystem-report.json (extracted from registry remotes).
// This re-probes the REAL urls and dumps the raw 402 body so the claim is inspectable.
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

let CONC = null; try { CONC = require('./x402-conformance.js'); } catch (e) {}

function get(u) {
  return new Promise(resolve => {
    let p; try { p = new URL(u); } catch (e) { return resolve({ status: 0, body: '', err: 'bad_url' }); }
    const mod = p.protocol === 'http:' ? http : https;
    const req = mod.get(u, { timeout: 15000, headers: { 'User-Agent': 'Automaton-Sovereign/2.0', Accept: '*/*' } }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 32768) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: d, ctype: res.headers['content-type'] || '' }));
    });
    req.on('error', e => resolve({ status: 0, body: '', err: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: '', err: 'timeout' }); });
  });
}

(async () => {
  let rep = null;
  try { rep = JSON.parse(fs.readFileSync(path.join(DIR, 'ecosystem-report.json'), 'utf8')); } catch (e) {}
  const suspects = ((rep && rep.observations) || []).filter(o => o.class === 'X402_CHALLENGE_INVALID' || o.class === 'X402_CHALLENGE_MALFORMED');
  console.log('suspects from report: ' + suspects.length);

  const out = { at: new Date().toISOString(), source: 'ecosystem-report.json', findings: [] };
  for (const s of suspects) {
    const r = await get(s.url);
    let keys = [], sample = '';
    try { const j = JSON.parse(r.body); keys = Object.keys(j); sample = JSON.stringify(j).slice(0, 500); } catch (e) { sample = (r.body || '').replace(/\s+/g, ' ').slice(0, 300); }
    let verdict = null, passed = null, total = null;
    if (r.status === 402 && CONC && typeof CONC.run === 'function') {
      try { const v = await CONC.run(s.url); verdict = v && v.verdict; passed = v && v.passed; total = v && v.total; } catch (e) {}
    }
    out.findings.push({ name: s.name, url: s.url, status: r.status, err: r.err || null, ctype: r.ctype, body_keys: keys, sample, verdict, passed, total });
    console.log('\n' + s.name + '  ->  ' + s.url);
    console.log('   HTTP ' + r.status + (r.err ? ' (' + r.err + ')' : '') + '  ctype=' + (r.ctype || '-'));
    console.log('   keys: ' + (keys.length ? keys.join(', ') : '(non-JSON/empty)'));
    console.log('   sample: ' + sample);
    if (verdict) console.log('   my checker: ' + verdict + ' ' + passed + '/' + total);
  }
  fs.writeFileSync(path.join(DIR, 'verify-402-evidence.json'), JSON.stringify(out, null, 2));
  console.log('\nwritten: verify-402-evidence.json');
})();
