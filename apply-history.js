// apply-history.js - idempotent install + syntax check + restart + live proof.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const DIR = __dirname;
const SERVER = path.join(DIR, 'server.js');
const BACKUP = path.join(DIR, 'server.js.bak10');
const MARK = '// __HISTORY_OVERLAY__';
const LINE = MARK + "\nrequire('./history-overlay.js')(server);\n";

const src = fs.readFileSync(SERVER, 'utf8');
if (!fs.existsSync(BACKUP)) { fs.writeFileSync(BACKUP, src); console.log('backup -> server.js.bak10'); }

let clean = src.split(MARK)[0].replace(/\s*$/, '\n');
fs.writeFileSync(SERVER, clean + '\n' + LINE);
console.log('overlay line installed (idempotent)');

for (const f of ['server.js', 'history-overlay.js', 'x402-history.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(DIR, f)], { stdio: 'pipe' }); console.log('syntax OK: ' + f); }
  catch (e) { console.log('SYNTAX FAIL ' + f + '\n' + e.stderr); process.exit(1); }
}

function get(url, cb) {
  const req = http.get(url, r => {
    let b = ''; r.on('data', d => b += d);
    r.on('end', () => cb(null, r.statusCode, r.headers['content-type'] || '', b));
  });
  req.on('error', e => cb(e));
  req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
}

const PORT = process.env.HISTORY_PROOF_PORT || '8085';
// Isolated proof instance so we never disturb the live tunnel.
const child = spawn(process.execPath, [SERVER], {
  cwd: DIR, env: Object.assign({}, process.env, { PORT: PORT }), stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', d => log += d);
child.stderr.on('data', d => log += d);

let pass = 0, n = 0;
function ok(name, cond, extra) { n++; if (cond) { pass++; console.log('PASS  ' + name); } else console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); }

function step(i) {
  const B = 'http://127.0.0.1:' + PORT;
  const steps = [
    ['server up (health)', '/health', c => c === 200],
    ['/x402-history HTML 200 + text/html', '/x402-history', (c, ct, b) => c === 200 && /text\/html/.test(ct) && /x402 Ecosystem History/.test(b)],
    ['/x402-history.md markdown', '/x402-history.md', (c, ct, b) => c === 200 && /markdown/.test(ct) && /x402 Ecosystem History/.test(b)],
    ['/v1/x402/history JSON shape', '/v1/x402/history', (c, ct, b) => { if (c !== 200) return false; const j = JSON.parse(b); return j.ok === true && Array.isArray(j.series) && 'change' in j; }],
    ['record (cached snapshot) appends', '/v1/x402/history/record', (c, ct, b) => { if (c !== 200) return false; const j = JSON.parse(b); return j.recorded === true && typeof j.total === 'number'; }],
    ['history now reports >=1 snapshot', '/v1/x402/history', (c, ct, b) => { if (c !== 200) return false; return JSON.parse(b).snapshots >= 1; }],
    ['legacy /pricing still served', '/pricing', c => c === 200],
    ['legacy /.well-known/x402 still served', '/.well-known/x402', c => c === 200]
  ];
  if (i >= steps.length) {
    console.log('\nHISTORY LIVE PROOF ' + pass + '/' + n + (pass === n ? ' ALL PASS' : ' FAILURES'));
    try { child.kill(); } catch (e) {}
    process.exit(pass === n ? 0 : 1);
    return;
  }
  const [name, p, check] = steps[i];
  get(B + p, (err, code, ct, body) => {
    if (err) { ok(name, false, String(err.message)); }
    else { try { ok(name, !!check(code, ct, body), 'http=' + code + ' ct=' + ct); } catch (e) { ok(name, false, String(e.message)); } }
    step(i + 1);
  });
}

// wait for listen, then run the battery
let tries = 0;
(function ready() {
  get('http://127.0.0.1:' + PORT + '/health', (err, code) => {
    if (!err) return step(0);
    if (++tries > 40) { console.log('server did not come up\n' + log); try { child.kill(); } catch (e) {} process.exit(1); }
    setTimeout(ready, 300);
  });
})();
