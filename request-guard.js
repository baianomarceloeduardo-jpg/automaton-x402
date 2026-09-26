'use strict';
/**
 * Last-resort request guard: a sync throw or async rejection in ANY request listener (route or
 * overlay) returns a generic 500 instead of crashing the whole API (e.g. an uncaught URIError).
 *
 * Installed on 'listening', which fires after every overlay attached synchronously at module load,
 * so it always wraps the final listener chain no matter where server.js requires it. (It used to
 * sit at the end of server.js and was silently truncated by overlay generators that re-append
 * from their marker to EOF.)
 */
module.exports = function installRequestGuard(server) {
  if (server.__requestGuardInstalled) return;
  server.__requestGuardInstalled = true;
  function fail(res, e) {
    console.error('[request-guard] ' + ((e && e.stack) || e));
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      } else res.end();
    } catch (x) {}
  }
  server.once('listening', function () {
    const listeners = server.listeners('request').slice();
    server.removeAllListeners('request');
    server.on('request', function (req, res) {
      for (const l of listeners) {
        try { const r = l.call(server, req, res); if (r && typeof r.catch === 'function') r.catch((e) => fail(res, e)); }
        catch (e) { fail(res, e); }
      }
    });
    console.log('[request-guard] active over ' + listeners.length + ' request listener(s)');
  });
};
