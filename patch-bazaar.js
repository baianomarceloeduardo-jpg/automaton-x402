// patch-bazaar.js — serve the x402 Bazaar mirror from my paid API.
//
// Wire bazaar-mirror.js into paid-api.js via the same prepend overlay technique as
// patch-wellknown.js (createServer is called at module load, so the wrapper must be installed
// BEFORE the rest of the file executes). Routes:
//   GET /bazaar            -> HTML (humans)
//   GET /v1/bazaar         -> JSON  (agents)
//   GET /v1/bazaar/refresh -> force a fresh pull from the upstream index (rate-limited to 60s)
//
// Idempotent: if the marker is already present it does nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const TARGET = path.join(DIR, 'paid-api.js');
const MARKER = '/* __BAZAAR_OVERLAY__ */';

const OVERLAY = MARKER + `
(function () {
  const _http = require('http');
  const _orig = _http.createServer.bind(_http);
  let mirror = null;
  try { mirror = require(__dirname + '/bazaar-mirror.js'); } catch (e) { mirror = null; }
  let lastRefresh = 0;

  function handle(req, res) {
    if (!mirror) return false;
    let p; try { p = new URL(req.url, 'http://x').pathname; } catch (e) { p = req.url; }
    const wantJson = p === '/v1/bazaar' || p === '/v1/bazaar/refresh';

    if (p === '/v1/bazaar' || p === '/bazaar' || p === '/v1/bazaar/refresh') {
      const force = p === '/v1/bazaar/refresh' && (Date.now() - lastRefresh > 60000);
      if (force) lastRefresh = Date.now();
      Promise.resolve(mirror.get({ refresh: force })).then(d => {
        if (wantJson) {
          const b = Buffer.from(JSON.stringify(d, null, 2));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
          res.end(b);
        } else {
          const b = Buffer.from(mirror.renderHtml(d));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length, 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
          res.end(b);
        }
      }).catch(e => {
        const b = Buffer.from('{"error":"mirror_failed","detail":' + JSON.stringify(String(e.message)) + '}');
        res.writeHead(500, { 'content-type': 'application/json', 'content-length': b.length });
        res.end(b);
      });
      return true;
    }
    return false;
  }

  _http.createServer = function () {
    const args = Array.prototype.slice.call(arguments);
    const handlers = args.filter(a => typeof a === 'function');
    const rest = args.filter(a => typeof a !== 'function');
    return _orig.apply(_http, rest.concat([function (req, res) {
      try { if (handle(req, res)) return; } catch (e) {}
      for (const h of handlers) { try { return h(req, res); } catch (e) {} }
      res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"no_handler"}');
    }]));
  };
})();
`;

let src = fs.readFileSync(TARGET, 'utf8');
if (src.indexOf(MARKER) !== -1) { console.log('[patch] bazaar overlay already present (no-op)'); process.exit(0); }
fs.writeFileSync(path.join(DIR, 'paid-api.js.bak-bazaar'), src);
fs.writeFileSync(TARGET, OVERLAY + '\n' + src);
console.log('[patch] prepended bazaar overlay to paid-api.js');
console.log('[patch] backup: paid-api.js.bak-bazaar');
