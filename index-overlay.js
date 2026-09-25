
// ===================== __INDEX_OVERLAY__ (Session 7, v2) =====================
// x402 Service Index: free objective leaderboard of x402 services.
//   GET /index                HTML leaderboard
//   GET /v1/index             JSON leaderboard
//   GET /v1/index/submit?url= FREE self-submission into the benchmark queue
//   GET /v1/index/run         trigger a benchmark pass (rate-limited, best-effort)
(function () {
  try {
    const IX = require('./x402-index.js');
    const SUB = require('./x402-index-submit.js');
    if (typeof FREE !== 'undefined' && Array.isArray(FREE)) {
      ['/index', '/v1/index', '/v1/index/submit', '/v1/index/run'].forEach(function (r) { if (FREE.indexOf(r) < 0) FREE.push(r); });
    }
    let lastRun = 0;
    const __prevListeners = server.listeners('request').slice();
    server.removeAllListeners('request');
    server.on('request', function (req, res) {
      let p, query = '';
      try { const s = (req.url || '/').split('?'); p = decodeURIComponent(s[0]); query = s[1] || ''; } catch (e) { p = (req.url || '/').split('?')[0]; }
      try {
        if (p === '/v1/index/submit') {
          const m = /(?:^|&)url=([^&]+)/.exec(query);
          if (!m) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'url_required', usage: '/v1/index/submit?url=https://your-x402-service/' })); }
          return SUB.submit(decodeURIComponent(m[1])).then(r => {
            res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(Object.assign({ via: 'x402-index-submit v1.0.0' }, r, { note: 'Queued services are benchmarked on the next pass. Free and open.' })));
          });
        }
        if (p === '/v1/index') {
          const st = IX.load();
          return send(res, 200, {
            via: 'x402-index v1.1.0',
            note: 'Objective benchmark of public x402 payment services, scored by spec conformance. Free. Submit yours: /v1/index/submit?url=',
            runs: st.runs || 0, lastRun: st.lastRun || null, count: st.count || 0,
            scoreboard: IX.leaderboard(st).slice(0, 100).map(function (r) {
              return { url: r.url, score: r.score, verdict: r.verdict, reachable: r.reachable, trend: r.trend, checks: r.passed + '/' + r.total };
            })
          });
        }
        if (p === '/index') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' });
          return res.end(IX.render(IX.load()));
        }
        if (p === '/v1/index/run') {
          const now = Date.now();
          if (now - lastRun < 60000) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'rate_limited', retryInMs: 60000 - (now - lastRun) })); }
          lastRun = now;
          return IX.run({ concurrency: 6 }).then(st => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, runs: st.runs, count: st.count, lastRun: st.lastRun }));
          }).catch(e => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); });
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'index_failed', message: e.message }));
      }
      for (const fn of __prevListeners) { try { fn(req, res); } catch (e) {} }
    });
    console.log('[index] overlay v2 active: /index /v1/index /v1/index/submit /v1/index/run');
  } catch (e) {
    console.log('[index] overlay failed: ' + e.message);
  }
})();
