// apply-index.js - append the index overlay to server.js, syntax-check, then serve + prove.
'use strict';
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');

const SERVER = 'server.js';
const MARKER = '__INDEX_OVERLAY__';
let src = fs.readFileSync(SERVER, 'utf8');
const idx = src.indexOf(MARKER);
if (idx >= 0) { const ls = src.lastIndexOf('\n', idx); src = src.slice(0, ls >= 0 ? ls : idx); console.log('removed previous overlay'); }
else { fs.writeFileSync(SERVER + '.bak10', fs.readFileSync(SERVER)); console.log('backup written: server.js.bak10'); }
const overlay = fs.readFileSync('index-overlay.js', 'utf8');
fs.writeFileSync(SERVER, src.replace(/\s*$/, '') + '\n' + overlay);
console.log('overlay appended');
try { execSync('node --check ' + SERVER, { stdio: 'pipe' }); console.log('SYNTAX OK'); }
catch (e) { console.log('SYNTAX FAIL ' + (e.stderr || e.message).toString().slice(0, 500)); process.exit(1); }

// prove on isolated port
const PORT = 8083;
function get(p, ms) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, timeout: ms || 25000 }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, h: res.headers, body: d })); });
    r.on('error', e => resolve({ status: 0, err: e.message })); r.on('timeout', () => { r.destroy(); resolve({ status: 0 }); }); r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PORT: String(PORT), FREE_TRIAL: '0' }) });
  proc.stdout.on('data', d => process.stdout.write('[svc] ' + d));
  proc.stderr.on('data', d => process.stderr.write('[err] ' + d));
  let up = false;
  for (let i = 0; i < 30; i++) { const h = await get('/health', 3000); if (h.status === 200) { up = true; break; } await sleep(500); }
  let T = 0, P = 0; const chk = (n, c) => { T++; if (c) P++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
  chk('server up with index overlay', up);
  if (!up) { proc.kill(); process.exit(1); }
  const j = await get('/v1/index');
  let jj = {}; try { jj = JSON.parse(j.body); } catch (e) {}
  chk('/v1/index -> 200 JSON with scoreboard', j.status === 200 && Array.isArray(jj.scoreboard));
  const h = await get('/index');
  chk('/index -> 200 HTML with table', h.status === 200 && /<table/.test(h.body) && /x402 Service Index/.test(h.body));
  console.log('  index count=' + (jj.count || 0) + ' runs=' + (jj.runs || 0) + ' rows=' + ((jj.scoreboard || []).length));
  console.log('\n' + P + '/' + T + ' PASS');
  proc.kill();
  process.exit(P === T ? 0 : 1);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });
