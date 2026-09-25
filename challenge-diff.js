// challenge-diff.js v1.0.0 - EVIDENCE, not verdicts.
//
// Why: my ecosystem probe reported 6 endpoints returning HTTP 402 with 0 conformant. Before
// publishing that, I must rule out the possibility that MY CHECKER is wrong. Two tests:
//   T1 SELF-TEST: run the same checker against MY OWN service. If my own spec-conformant
//      service does not score CONFORMANT, the checker is broken and the 0/6 is meaningless.
//   T2 RAW BODY: dump the exact 402 JSON body from each suspect endpoint and print its keys,
//      so a human can judge directly instead of trusting my score.
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const base = (() => { try { return fs.readFileSync(path.join(DIR, 'tunnel.url'), 'utf8').trim().replace(/\/$/, ''); } catch (e) { return ''; } })();

let CONC = null; try { CONC = require('./x402-conformance.js'); } catch (e) {}

function get(u) {
  return new Promise(resolve => {
    let p; try { p = new URL(u); } catch (e) { return resolve({ status: 0, body: '' }); }
    const mod = p.protocol === 'http:' ? http : https;
    const req = mod.get(u, { timeout: 15000, headers: { 'User-Agent': 'Automaton-Sovereign/2.0', 'Accept': '*/*' } }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 32768) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', e => resolve({ status: 0, body: '', err: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

const SUSPECTS = [
  'https://com.x402supply/chess-eval',
  'https://com.x402supply/endpoint-diligence',
  'https://com.x402supply/entity-resolve',
  'https://com.x402supply/page-extract',
  'https://com.x402supply/pii-redact',
  'https://com.x402supply/hts-classify'
];

(async () => {
  const out = { at: new Date().toISOString(), base, self_test: null, endpoints: [] };

  // ---- T1: self-test. If MY service is not CONFORMANT by my own checker, nothing else counts.
  if (CONC && typeof CONC.run === 'function' && base) {
    try {
      const v = await CONC.run(base + '/v1/uuid');
      out.self_test = { target: base + '/v1/uuid', verdict: v && v.verdict, passed: v && v.passed, total: v && v.total, failed: v && v.failed, checks: v && v.checks };
      console.log('SELF-TEST ' + out.self_test.verdict + ' ' + out.self_test.passed + '/' + out.self_test.total);
      if (v && Array.isArray(v.checks)) v.checks.forEach(c => console.log('   ' + (c.ok ? 'PASS' : 'FAIL') + '  ' + (c.name || c.check) + (c.ok ? '' : '  :: ' + (c.detail || c.why || ''))));
    } catch (e) { out.self_test = { error: String(e.message) }; console.log('SELF-TEST ERROR ' + e.message); }
  } else {
    console.log('SELF-TEST SKIPPED (no checker or no base)');
  }

  // ---- T2: raw bodies from the suspects. Truth by inspection.
  for (const u of SUSPECTS) {
    const r = await get(u);
    let keys = [], sample = '';
    try { const j = JSON.parse(r.body); keys = Object.keys(j); sample = JSON.stringify(j).slice(0, 400); } catch (e) { sample = (r.body || '').replace(/\s+/g, ' ').slice(0, 300); }
    const rec = { url: u, status: r.status, keys, sample, ctype: r.headers && r.headers['content-type'] };
    if (r.status === 402 && CONC && typeof CONC.run === 'function') {
      try { const v = await CONC.run(u); rec.checker_verdict = v && v.verdict; rec.checker_passed = v && v.passed; rec.checker_total = v && v.total; rec.checker_failed = v && v.failed; } catch (e) {}
    }
    out.endpoints.push(rec);
    console.log('\n' + u + '  ->  HTTP ' + r.status + '  ctype=' + (rec.ctype || '-'));
    console.log('   body_keys: ' + (keys.length ? keys.join(', ') : '(non-JSON or empty)'));
    console.log('   sample: ' + sample);
    if (rec.checker_verdict) console.log('   checker: ' + rec.checker_verdict + ' ' + (rec.checker_passed || 0) + '/' + (rec.checker_total || 0));
  }

  fs.writeFileSync(path.join(DIR, 'challenge-diff.json'), JSON.stringify(out, null, 2));
  console.log('\nwritten: challenge-diff.json');
})();
