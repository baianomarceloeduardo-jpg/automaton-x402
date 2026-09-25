
// ===================== __REMEDIATE_OVERLAY__ (Session 7) =====================
// Free remediation: turn a failed x402 conformance report into concrete fixes.
//   GET /v1/x402-remediate?url=<target>   JSON { failures[], canonicalChallenge }
//   GET /remediate?url=<target>           human HTML page
(function () {
  try {
    const RE = require('./x402-remediate.js');
    if (typeof FREE !== 'undefined' && Array.isArray(FREE)) {
      ['/remediate', '/v1/x402-remediate'].forEach(function (r) { if (FREE.indexOf(r) < 0) FREE.push(r); });
    }
    const prev = server.listeners('request').slice();
    server.removeAllListeners('request');
    server.on('request', function (req, res) {
      let p = '/', q = '';
      try { const s = (req.url || '/').split('?'); p = decodeURIComponent(s[0]); q = s[1] || ''; } catch (e) { p = (req.url || '/').split('?')[0]; }
      if (p === '/v1/x402-remediate' || p === '/remediate') {
        const m = /(?:^|&)url=([^&]+)/.exec(q);
        if (!m) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, reason: 'url_required', usage: '/v1/x402-remediate?url=https://your-x402-service/' }));
        }
        const target = decodeURIComponent(m[1]);
        if (!/^https?:\/\//i.test(target)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, reason: 'unsupported_scheme' }));
        }
        return RE.remediate(target).then(r => {
          if (p === '/remediate') {
            const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            const rows = (r.failures || []).map((f, i) => '<div class="fix"><h3>' + (i + 1) + '. ' + esc(f.check) + '</h3><p><b>Why:</b> ' + esc(f.why) + '</p><p><b>Fix:</b> ' + esc(f.fix) + '</p>' + (f.detail ? '<p class="muted">observed: ' + esc(f.detail) + '</p>' : '') + '</div>').join('');
            const color = r.conformant ? '#137333' : (r.failureCount > 3 ? '#a50e0e' : '#b06000');
            const html = '<!doctype html><html><head><meta charset="utf-8"><title>x402 Remediation</title>' +
              '<meta name="description" content="Free actionable remediation for any x402 service: turn a failed conformance report into concrete, copy-pasteable fixes.">' +
              '<style>body{font:15px/1.55 system-ui,Segoe UI,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;color:#111}' +
              'h1{margin:0 0 6px}h2{margin-top:28px}.muted{color:#666;font-size:13px}.badge{display:inline-block;padding:3px 9px;border-radius:11px;color:#fff;font-weight:600;font-size:13px}' +
              '.fix{border-left:3px solid #ddd;padding:6px 0 6px 14px;margin:14px 0}h3{margin:0 0 6px;font-size:15px}' +
              'pre{background:#0f1115;color:#e6e6e6;padding:13px;border-radius:7px;overflow:auto;font-size:12.5px;line-height:1.45}' +
              'a{color:#0645ad}</style></head><body>' +
              '<h1>x402 Remediation</h1>' +
              '<p><span class="badge" style="background:' + color + '">' + esc(r.verdict) + '</span> &nbsp;' + esc(r.passed) + '/' + esc(r.total) + ' checks passed for <code>' + esc(r.target) + '</code></p>' +
              '<p>' + esc(r.summary) + '</p>' + rows +
              '<h2>Canonical conformant 402 challenge</h2><pre>' + esc(r.canonicalChallenge) + '</pre>' +
              '<p class="muted">Free, no key. Re-check with <a href="/v1/x402-conformance?url=' + encodeURIComponent(r.target) + '">/v1/x402-conformance</a> &middot; embed a badge: <code>/badge.svg?url=...</code> &middot; index: <a href="/index">/index</a></p>' +
              '</body></html>';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' });
            return res.end(html);
          }
          send(res, 200, r);
        }).catch(e => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
        });
      }
      for (const fn of prev) { try { fn(req, res); } catch (e) {} }
    });
    console.log('[remediate] overlay active: /remediate + /v1/x402-remediate');
  } catch (e) {
    console.log('[remediate] overlay failed: ' + e.message);
  }
})();
