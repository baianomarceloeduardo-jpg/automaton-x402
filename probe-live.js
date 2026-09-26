// probe-live.js — prove the PUBLIC surface in one pass. Node fetch (no PowerShell noise).
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const T = path.join(DIR, 'tunnel.url');

let base = null;
try { base = fs.readFileSync(T, 'utf8').split('=').pop().trim().replace(/\/+$/, ''); } catch (_) {}
if (!base || !/^https?:\/\//.test(base)) { console.log('PROBE=FAIL reason=no_tunnel_url'); process.exit(1); }

let anchor = null;
try { anchor = JSON.parse(fs.readFileSync(path.join(DIR, 'ANCHOR-LATEST.json'), 'utf8')); } catch (_) {}

const paths = [
  '/health',
  '/.well-known/agent-base',
  '/v1/resolve-base',
  '/.well-known/x402',
  '/pricing',
  anchor && anchor.tx ? ('/v1/resolve-base?tx=' + anchor.tx) : null
].filter(Boolean);

(async () => {
  console.log('BASE=' + base);
  let pass = 0, fail = 0;
  for (const p of paths) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(base + p, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(timer);
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (_) {}
      const ms = Date.now() - t0;
      const extra = j ? (' base=' + (j.base || '-') + ' via=' + (j.probeVia || j.mode || '-')) : '';
      const ok = r.status === 200;
      ok ? pass++ : fail++;
      console.log((ok ? 'PASS ' : 'FAIL ') + String(r.status).padEnd(4) + p.padEnd(26) + ms + 'ms ' + txt.length + 'B' + extra);
    } catch (e) {
      fail++;
      console.log('FAIL ---- ' + p.padEnd(26) + (Date.now() - t0) + 'ms ' + (e.name === 'AbortError' ? 'TIMEOUT_20s' : e.message));
    }
  }
  console.log('PROBE=' + (fail === 0 ? 'ALL_PASS' : 'PARTIAL') + ' pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
