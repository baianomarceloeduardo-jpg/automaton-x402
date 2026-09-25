// apply-remediate.js - idempotently append remediation-overlay.js to server.js, verify syntax,
// and prove the free /v1/x402-remediate route end to end on an isolated port.
'use strict';
const fs = require('fs');
const cp = require('child_process');

const MARK = '__REMEDIATE_OVERLAY__';
const SERVER = 'server.js';
const OVERLAY = 'remediation-overlay.js';
const PROBE_PORT = 8084;

function strip(src) {
  const i = src.indexOf('// ===================== ' + MARK);
  return i >= 0 ? src.slice(0, i).replace(/\s+$/, '') + '\n' : src;
}

let src = fs.readFileSync(SERVER, 'utf8');
if (src.indexOf(MARK) >= 0) { src = strip(src); console.log('removed previous overlay'); }
src = src.replace(/\s+$/, '') + '\n\n' + fs.readFileSync(OVERLAY, 'utf8');
fs.writeFileSync(SERVER, src);
console.log('overlay appended');

try { cp.execSync('node --check ' + SERVER, { stdio: 'pipe' }); console.log('SYNTAX OK'); }
catch (e) { console.log('SYNTAX FAIL: ' + (e.stderr ? e.stderr.toString() : e.message)); process.exit(1); }

const child = cp.spawn('node', [SERVER], { env: Object.assign({}, process.env, { PORT: String(PROBE_PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

const http = require('http');
function get(path) {
  return new Promise(resolve => {
    const r = http.get('http://127.0.0.1:' + PROBE_PORT + path, x => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => resolve({ s: x.statusCode, b, ct: x.headers['content-type'] }));
    });
    r.on('error', e => resolve({ s: 0, b: e.message }));
    r.setTimeout(30000, () => { r.destroy(); resolve({ s: 0, b: 'timeout' }); });
  });
}

setTimeout(async () => {
  let pass = 0, total = 0;
  const chk = (n, ok) => { total++; if (ok) pass++; console.log((ok ? 'PASS ' : 'FAIL ') + n); };
  try {
    chk('server up with remediation overlay', out.indexOf('[remediate] overlay active') >= 0);
    const noUrl = await get('/v1/x402-remediate');
    chk('missing url -> 400 url_required', noUrl.s === 400 && /url_required/.test(noUrl.b));
    const bad = await get('/v1/x402-remediate?url=ftp://x.com/');
    chk('bad scheme -> 400', bad.s === 400 && /unsupported_scheme/.test(bad.b));
    const idx = await get('/v1/x402-remediate?url=http://127.0.0.1:8080/');
    let j = {}; try { j = JSON.parse(idx.b); } catch (e) {}
    chk('remediate -> 200 JSON with canonicalChallenge', idx.s === 200 && typeof j.canonicalChallenge === 'string' && j.canonicalChallenge.length > 100);
    chk('remediate reports verdict+passed+total', typeof j.verdict === 'string' && typeof j.passed === 'number' && typeof j.total === 'number');
    chk('canonical snippet carries USDC asset', /0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/.test(j.canonicalChallenge || ''));
    const html = await get('/remediate?url=http://127.0.0.1:8080/');
    chk('HTML /remediate -> 200 text/html', html.s === 200 && /text\/html/.test(html.ct || '') && /Canonical conformant/.test(html.b));
    console.log('\n' + pass + '/' + total + ' PASS');
  } catch (e) { console.log('ERR ' + e.message); }
  try { child.kill(); } catch (e) {}
  process.exit(pass === total ? 0 : 1);
}, 3500);
