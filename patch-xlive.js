// patch-xlive.js — serve the "verified buyable" x402 directory from my paid API.
// Same prepend-overlay technique as patch-bazaar.js (createServer runs at module load).
// Routes: GET /v1/x402-live (JSON), GET /x402-live (HTML), GET /v1/x402-live/refresh (force recheck).
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const TARGET = path.join(DIR, 'paid-api.js');
const MARKER = '/* __XLIVE_OVERLAY__ */';

const OVERLAY = MARKER + `
(function () {
  const _http = require('http');
  const _o = _http.createServer.bind(_http);
  let L = null;
  try { L = require(__dirname + '/x402-live.js'); } catch (e) { L = null; }

  function h(req, res) {
    if (!L) return false;
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    if (p === '/v1/x402-live' || p === '/x402-live' || p === '/v1/x402-live/refresh') {
      const force = p === '/v1/x402-live/refresh';
      const asJson = p !== '/x402-live';
      Promise.resolve(L.liveList({ refresh: force })).then(d => {
        let b;
        if (asJson) { b = Buffer.from(JSON.stringify(d, null, 2));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=120' }); }
        else { b = Buffer.from(L.renderHtml(d));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=120' }); }
        res.end(b);
      }).catch(e => {
        const b = Buffer.from('{"error":"live_failed","detail":' + JSON.stringify(String(e.message)) + '}');
        res.writeHead(500, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b);
      });
      return true;
    }
    return false;
  }

  _http.createServer = function () {
    const a = Array.prototype.slice.call(arguments);
    const hs = a.filter(x => typeof x === 'function');
    const r = a.filter(x => typeof x !== 'function');
    return _o.apply(_http, r.concat([function (q, s) {
      try { if (h(q, s)) return; } catch (e) {}
      for (const x of hs) { try { return x(q, s); } catch (e) {} }
      s.writeHead(500, { 'content-type': 'application/json' }); s.end('{"error":"no_handler"}');
    }]));
  };
})();
`;

let s = fs.readFileSync(TARGET, 'utf8');
if (s.indexOf(MARKER) !== -1) { console.log('[xlive] already wired (no-op)'); process.exit(0); }
fs.writeFileSync(path.join(DIR, 'paid-api.js.bak-xlive'), s);
fs.writeFileSync(TARGET, OVERLAY + '\n' + s);
console.log('[xlive] prepended x402-live routes to paid-api.js');
