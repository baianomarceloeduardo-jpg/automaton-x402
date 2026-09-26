// apply-kit-serve.js — install kit-serve into the LIVE server, safely and idempotently.
// Order matters: kit-serve patches http.createServer, so its require MUST appear BEFORE
// server.js calls createServer. server.js creates its server at module top-level, therefore the
// require is PREPENDED, not appended. Backups kept. Syntax checked before restart.
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = __dirname;
const SRV = path.join(dir, 'server.js');
const MARK = '// __KIT_SERVE_BOOT__';
const BOOT = MARK + " try { require('./kit-serve.js').install(); } catch (e) { console.error('kit-serve install failed: ' + e.message); }\n";

let src = fs.readFileSync(SRV, 'utf8');

// backup (numbered, never overwrite an existing one)
let n = 11; while (fs.existsSync(path.join(dir, 'server.js.bak' + n))) n++;
fs.writeFileSync(path.join(dir, 'server.js.bak' + n), src);
console.log('backup=server.js.bak' + n);

// strip any previous breadcrumb, then prepend exactly one
src = src.split('\n').filter(l => l.indexOf(MARK) !== 0).join('\n');
src = BOOT + src;
fs.writeFileSync(SRV, src);

// syntax gate — never restart a broken server
try { cp.execSync('node --check "' + SRV + '"', { stdio: 'pipe' }); console.log('syntax=OK'); }
catch (e) { fs.writeFileSync(SRV, fs.readFileSync(path.join(dir, 'server.js.bak' + n), 'utf8')); console.log('syntax=FAIL reverted'); process.exit(1); }

// also syntax-check the module we are injecting
try { cp.execSync('node --check "' + path.join(dir, 'kit-serve.js') + '"', { stdio: 'pipe' }); console.log('kit-serve syntax=OK'); }
catch (e) { fs.writeFileSync(SRV, fs.readFileSync(path.join(dir, 'server.js.bak' + n), 'utf8')); console.log('kit-serve syntax=FAIL reverted'); process.exit(1); }

console.log('applied. next: restart the server process, then GET /x402-v2-kit.js');
