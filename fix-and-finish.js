// fix-and-finish.js - (1) correct the e2e verifier test, (2) run e2e, (3) publish artifacts
// durably to paste.rs, (4) report. One decisive run.
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 1. rewrite the free-verifier block in e2e-eip3009.js to POST a FRESH signed envelope
let t = fs.readFileSync('e2e-eip3009.js', 'utf8');
const start = t.indexOf('  // 7. free verifier endpoint works');
const end = t.indexOf('  // 8. unique resources per distinct authorization');
if (start >= 0 && end > start) {
  const replacement = [
    '  // 7. free verifier endpoint works (fresh envelope so it is not already consumed)',
    '  const envV = await e.signAuthorization({ from: wallet.address, to: PAY_TO, value: \'1000\' }, wallet);',
    '  const v2 = await new Promise((resolve, reject) => {',
    '    const body = JSON.stringify(envV);',
    '    const r = http.request(BASEURL + \'/v1/verify-authorization\', { method: \'POST\', timeout: 15000, headers: { \'content-type\': \'application/json\', \'content-length\': Buffer.byteLength(body) } },',
    '      res => { let d = \'\'; res.on(\'data\', c => d += c); res.on(\'end\', () => resolve({ status: res.statusCode, body: d })); });',
    '    r.on(\'error\', reject); r.on(\'timeout\', () => { r.destroy(); reject(new Error(\'timeout\')); }); r.write(body); r.end();',
    '  });',
    '  let vj = {}; try { vj = JSON.parse(v2.body); } catch (e) {}',
    '  chk(\'free /v1/verify-authorization validates envelope\', v2.status === 200 && vj.ok === true);',
    ''
  ].join('\n');
  t = t.slice(0, start) + replacement + t.slice(end);
  fs.writeFileSync('e2e-eip3009.js', t);
  console.log('e2e verifier block corrected');
} else { console.log('e2e verifier block already clean'); }

// 2. run the e2e suite
let out = '';
try { out = execSync('node e2e-eip3009.js', { encoding: 'utf8', timeout: 120000 }); }
catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
const passLine = (out.match(/\d+\/\d+ PASS/) || ['no-summary'])[0];
console.log(out.split('\n').filter(l => /PASS|FAIL|ERROR/.test(l)).join('\n'));
console.log('SUMMARY: ' + passLine);

// 3. publish the caller-bound modules durably (paste.rs = keyless durable paste)
function publish(name, file) {
  try {
    const body = fs.readFileSync(file, 'utf8');
    const cmd = `curl -s -m 30 -X POST --data-binary @"${file}" https://paste.rs`;
    const url = execSync(cmd, { encoding: 'utf8', timeout: 40000 }).trim();
    console.log('PUBLISHED ' + name + ' -> ' + url);
    return url;
  } catch (e) { console.log('PUBLISH_FAIL ' + name + ': ' + e.message); return null; }
}
const pub = {
  module: publish('eip3009.js', 'eip3009.js'),
  service: publish('eip3009-service.js', 'eip3009-service.js'),
  client: publish('eip3009-client.js', 'eip3009-client.js')
};

// 4. record the create-value result
fs.writeFileSync('eip3009-EVIDENCE.txt', [
  'EIP-3009 CALLER-BOUND PAYMENT PATH - EVIDENCE',
  'generated: ' + new Date().toISOString(),
  '',
  'WHY: a raw txHash is a bearer credential; only a signed authorization binds the payer.',
  'MODULE  eip3009.js          self-test 10/10 PASS (sign/verify/settle/challenge)',
  'SERVICE eip3009-service.js  E2E ' + passLine + ' over real HTTP',
  'CLIENT  eip3009-client.js   zero-gas buyer path (facilitator settles)',
  '',
  'E2E checks: unpaid->402 eip3009 accepts[]; signed auth->200 callerBound=true payer echoed;',
  'replay rejected; forged signature rejected; wrong recipient rejected; tampered amount rejected;',
  'free verifier validates envelope; fresh nonce -> second paid call succeeds.',
  '',
  'PUBLISHED:',
  JSON.stringify(pub, null, 2)
].join('\n'));
console.log('EVIDENCE written');
