
// ===================== __INDEX_OVERLAY__ (Session 7) =====================
// Serves the x402 Service Index: a free, objective, continuously-updated leaderboard
// of public x402 services rated by spec conformance. Traffic magnet; zero funds needed.
(function () {
  try {
    const IX = require('./x402-index.js');
    if (typeof FREE !== 'undefined' && Array.isArray(FREE)) {
      ['/index', '/v1/index'].forEach(function (r) { if (FREE.indexOf(r) < 0) FREE.push(r); });
    }
    const __prevListeners = server.listeners('request').slice();
    server.removeAllListeners('request');
    server.on('request', function (req, res) {
      let p;
      try { p = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { p = (req.url || '/').split('?')[0]; }
      try {
        if (p === '/v1/index') {
          const st = IX.load();
          return send(res, 200, {
            via: 'x402-index v1.0.0',
            note: 'Objective benchmark of public x402 payment services, scored by spec conformance. Free.',
            runs: st.runs || 0, lastRun: st.lastRun || null, count: st.count || 0,
            scoreboard: IX.leaderboard(st).slice(0, 100).map(function (r) {
              return { url: r.url, score: r.score, verdict: r.verdict, reachable: r.reachable, trend: r.trend, checks: r.passed + '/' + r.total };
            })
          });
        }
        if (p === '/index') {
          const html = IX.render(IX.load(), base());
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' });
          return res.end(html);
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'index_failed', message: e.message }));
      }
      for (const fn of __prevListeners) { try { fn(req, res); } catch (e) {} }
    });
    console.log('[index] overlay active: /index (HTML) + /v1/index (JSON)');
  } catch (e) {
    console.log('[index] overlay failed: ' + e.message);
  }
})();
