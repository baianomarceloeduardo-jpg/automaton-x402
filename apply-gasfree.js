// apply-gasfree.js — reversible, idempotent wiring of the gas-free checkout overlay
// into server.js, followed by a live proof on an isolated port.
//
// Two-part injection:
//   (A) module-scope route registry + global hook, placed BEFORE http.createServer
//   (B) consumption loop inside the request handler, after the OPTIONS guard
// This ordering matters: the overlay module registers its routes at require-time,
// so the hook must already exist at module scope when it is required.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SERVER = 'server.js';
const BACKUP = 'server.js.bak10';
const OVERLAY = 'gasfree-overlay.js';
const MB = '// BEGIN __AUTOMATON_ROUTE_REGISTRY__';
const ME = '// END __AUTOMATON_ROUTE_REGISTRY__';
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function log(s) { console.log(s); }

if (!fs.existsSync(BACKUP)) { fs.copyFileSync(SERVER, BACKUP); log('backup created: ' + BACKUP); }
else log('backup exists: ' + BACKUP);

let src = fs.readFileSync(SERVER, 'utf8');

// --- strip any previous injection (idempotent) ---
const reAll = new RegExp(reEsc(MB) + '[\\s\\S]*?' + reEsc(ME) + '\\r?\\n?', 'g');
const n0 = src.length;
src = src.replace(reAll, '');
if (src.length !== n0) log('previous registry stripped (' + (n0 - src.length) + ' bytes)');

// --- (A) module-scope registry, before createServer ---
const anchorServer = 'const server = http.createServer(async (req, res) => {';
if (src.indexOf(anchorServer) < 0) { log('FATAL: createServer anchor missing'); process.exit(1); }
const blockA = [
  MB,
  'const __AUTO_ROUTES = [];',
  'global.__automatonAddRoute = function (pathname, handler) { __AUTO_ROUTES.push({ pathname, handler }); };',
  ME,
  anchorServer,
].join('\n');
src = src.replace(anchorServer, blockA);

// --- (B) consumption loop, after OPTIONS guard ---
const anchorOpt = "  if (M === 'OPTIONS') return send(res, 204, {});";
if (src.indexOf(anchorOpt) < 0) { log('FATAL: OPTIONS anchor missing'); process.exit(1); }
const blockB = [
  anchorOpt,
  '  for (const __r of __AUTO_ROUTES) {',
  '    if (p === __r.pathname) {',
  '      try { const handled = await __r.handler(req, res, u); if (handled !== false) return; }',
  '      catch (e) { return send(res, 500, { error: "route_handler_failed", message: e.message }); }',
  '    }',
  '  }',
].join('\n');
src = src.replace(anchorOpt, blockB);

// --- require the overlay before listen (it self-attaches at require-time) ---
const requireLine = "require('./gasfree-overlay.js'); // attaches gasfree routes";
if (src.indexOf(requireLine) < 0) {
  if (src.indexOf('server.listen(PORT') < 0) { log('FATAL: listen anchor missing'); process.exit(1); }
  src = src.replace('server.listen(PORT', requireLine + '\n\nserver.listen(PORT');
  log('overlay require inserted');
} else log('overlay require already present');

fs.writeFileSync(SERVER, src);

try { cp.execSync('node --check ' + SERVER, { stdio: 'pipe' }); log('SYNTAX OK'); }
catch (e) { log('SYNTAX FAIL:\n' + e.stderr.toString()); process.exit(1); }

const hits = fs.readFileSync(SERVER, 'utf8').split('\n').filter(l => l.includes('__automatonAddRoute') || l.includes('__AUTO_ROUTES'));
log('injection verified (' + hits.length + ' registry lines present). backup: ' + BACKUP);
