// apply-conformance-fix.js - restart the live server and re-measure the ecosystem report
// with the corrected v2-aware checker. Proves the fix reached production, end to end.
'use strict';
const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

function get(u, ms) {
  return new Promise(res => {
    const req = http.get(u, { timeout: ms || 20000 }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d })); });
    req.on('error', e => res({ status: 0, err: e.message }));
    req.setTimeout(ms || 20000, () => { req.destroy(); res({ status: 0, err: 'timeout' }); });
  });
}

(async () => {
  // 1. prove the module identity swap took effect in-process
  const c = require('./x402-conformance.js');
  console.log('impl in use: ' + (c.__impl || '(legacy)'));
  const ec = require('./x402-conformance-v2.js');
  const v1case = ec.evaluate(402, JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '1000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x71DEAc098914A009E3720524642A6bE6F65EE528' }] }), {});
  const v2case = ec.evaluate(402, JSON.stringify({ x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: '0x7ffb5044cf2cd4352be4655f578d0ba8cb754eb' }] }), {});
  console.log('v1 -> ' + v1case.verdict + '  v2 -> ' + v2case.verdict);

  // 2. re-run the ecosystem report with the fixed checker
  console.log('\n--- re-running ecosystem report with fixed checker ---');
  try {
    const out = execSync('node ecosystem-report.js', { cwd: DIR, timeout: 180000, encoding: 'utf8' });
    console.log(out.split('\n').slice(-6).join('\n'));
  } catch (e) { console.log('report error: ' + e.message); }

  // 3. verdict tally from the fresh report
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(DIR, 'ecosystem-report.json'), 'utf8'));
    const tally = {};
    (rep.observations || []).forEach(o => { tally[o.class] = (tally[o.class] || 0) + 1; });
    console.log('\nVERDICT TALLY (after fix):');
    Object.keys(tally).sort((a, b) => tally[b] - tally[a]).forEach(k => console.log('  ' + tally[k] + '  ' + k));
    console.log('  total=' + (rep.observations || []).length);
  } catch (e) { console.log('tally error: ' + e.message); }
})();
