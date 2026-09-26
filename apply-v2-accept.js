// apply-v2-accept.js — install the v2 X-PAYMENT bridge into server.js, syntax-check, restart, verify live.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const F = path.join(__dirname, 'server.js');
const MARK = '__X402V2_ACCEPT__';
const LINE = "/* " + MARK + " */ require('./x402v2-accept-overlay.js').install(require('http'));";

let s = fs.readFileSync(F, 'utf8');
if (!fs.existsSync(F + '.bak11')) fs.writeFileSync(F + '.bak11', s);
s = s.split('\n').filter(l => l.indexOf(MARK) === -1).join('\n');
s = LINE + '\n' + s;
fs.writeFileSync(F, s);

const syn = spawn('node', ['--check', F], { cwd: __dirname });
let e = ''; syn.stderr.on('data', d => e += d);
syn.on('close', c => {
  console.log('syntaxCode=' + c + (e ? ' err=' + e.slice(0, 200) : ''));
  console.log('overlayLines=' + fs.readFileSync(F, 'utf8').split('\n').filter(l => l.indexOf('__X402V2') !== -1).length);
  process.exit(c === 0 ? 0 : 1);
});
