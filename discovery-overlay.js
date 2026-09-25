
// ===================== __DISCOVERY_OVERLAY__ (Session 7) =====================
// Dynamic discovery surface: /llms.txt, /sitemap.xml, /robots.txt, /.well-known/agent-card.json
// are generated from routes-manifest.js at REQUEST time using the live base URL.
// Never stale again: no hardcoded tunnel URL, no hardcoded version drift.
(function () {
  try {
    const M = require('./routes-manifest.js');
    const fs = require('fs');
    const path = require('path');

    function liveBase(req) {
      const h = req && req.headers ? (req.headers['x-forwarded-host'] || req.headers.host) : '';
      const proto = (req && req.headers && req.headers['x-forwarded-proto']) || 'https';
      if (h) return proto + '://' + h;
      try { const u = fs.readFileSync(path.join(__dirname, 'tunnel.url'), 'utf8').trim(); if (u) return u.replace(/\/$/, ''); } catch (e) {}
      return 'http://127.0.0.1:' + (process.env.PORT || 8080);
    }
    function version() {
      try { const p = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')); return p.version || '0.9.0'; } catch (e) { return '0.9.0'; }
    }

    if (typeof FREE !== 'undefined' && Array.isArray(FREE)) {
      ['/llms.txt', '/sitemap.xml', '/robots.txt', '/.well-known/agent-card.json'].forEach(function (r) { if (FREE.indexOf(r) < 0) FREE.push(r); });
    }

    const prev = server.listeners('request').slice();
    server.removeAllListeners('request');
    server.on('request', function (req, res) {
      let p = '/';
      try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { p = (req.url || '/').split('?')[0]; }
      const b = liveBase(req), v = version();
      try {
        if (p === '/llms.txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
          return res.end(M.llms(b, v));
        }
        if (p === '/sitemap.xml') {
          res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
          return res.end(M.sitemap(b));
        }
        if (p === '/robots.txt') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
          return res.end(M.robots(b));
        }
        if (p === '/.well-known/agent-card.json') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify(M.agentCard(b, v), null, 2));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'discovery_failed', message: String(e.message || e) }));
      }
      for (const fn of prev) { try { fn(req, res); } catch (e) {} }
    });
    console.log('[discovery] overlay active: dynamic /llms.txt /sitemap.xml /robots.txt /.well-known/agent-card.json');
  } catch (e) {
    console.log('[discovery] overlay failed: ' + e.message);
  }
})();
