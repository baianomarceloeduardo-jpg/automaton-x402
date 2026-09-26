// apply-discover.js — attach the chain-anchored discovery overlay to the live server, reversibly.
//
// server.js declares `const server = http.createServer(...)` at module scope and calls
// server.listen() at the end. There are no exports, so an appended line in the SAME module scope
// can reference `server` directly. That is the least invasive, fully reversible attach point.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const DIR = __dirname;
const F = path.join(DIR, 'server.js');
const MARK = '// __DISCOVER_OVERLAY_APPLIED__';

let s = fs.readFileSync(F, 'utf8');

// idempotent: strip any previous attach (marked or unmarked variants)
s = s.replace(new RegExp('\\n// __DISCOVER_OVERLAY__[\\s\\S]*?\\n', 'g'), '\n');
s = s.replace(new RegExp('\\n' + MARK + '[\\s\\S]*$', 'g'), '\n');

const attach = [
  '',
  MARK,
  '// Chain-anchored service discovery (free, credential-free): GET /v1/discover-base?address=0x..|self=1',
  'try { require("./discover-overlay.js").wrap(server); }',
  'catch (e) { console.error("discover_overlay_attach_failed", e && e.message); }',
  ''
].join('\n');

const out = s + attach;
fs.writeFileSync(F + '.bak-discover', s);
fs.writeFileSync(F, out);

// real syntax check via node itself
try {
  execFileSync(process.execPath, ['--check', F], { stdio: 'pipe' });
  console.log('SYNTAX=OK  bytes=' + out.length + '  attached=yes');
} catch (e) {
  fs.writeFileSync(F, s);
  console.log('SYNTAX=FAIL REVERTED  ' + String(e.stderr || e.message).slice(0, 400));
  process.exit(1);
}
