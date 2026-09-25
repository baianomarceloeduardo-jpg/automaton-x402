
// ===================== __ECOSYSTEM_OVERLAY__ (Session 7) =====================
// Publishes the honest x402 ecosystem probe.
//   GET /v1/ecosystem-report   JSON (observations + methodology + summary)
//   GET /ecosystem             human HTML
//   GET /ecosystem.md          raw markdown (paste.rs-able)
// Methodology note is rendered first and prominently: endpoints that did not return a 402 are
// NOT reported as non-conformant.
(function () {
  try {
    const fs = require('fs');
    const path = require('path');
    if (typeof FREE !== 'undefined' && Array.isArray(FREE)) {
      ['/ecosystem', '/v1/ecosystem-report', '/ecosystem.md'].forEach(function (r) { if (FREE.indexOf(r) < 0) FREE.push(r); });
    }
    const DIR = __dirname;
    const JSONF = path.join(DIR, 'ecosystem-report.json');
    const MDF = path.join(DIR, 'ecosystem-report.md');

    function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    function load() { try { return JSON.parse(fs.readFileSync(JSONF, 'utf8')); } catch (e) { return null; } }

    function renderHtml(r) {
      const cls = {
        CONFORMANT: '#137333', X402_CHALLENGE_INVALID: '#a50e0e', X402_CHALLENGE_MALFORMED: '#a50e0e',
        X402_CHALLENGE_PRESENT: '#b06000', NO_X402_CHALLENGE: '#5f6368', UNREACHABLE: '#5f6368'
      };
      const rows = (r.observations || []).map(o =>
        '<tr><td>' + esc(o.name) + '</td><td><span class="b" style="background:' + (cls[o.class] || '#5f6368') + '">' + esc(o.class) + '</span></td><td>' + esc(o.status || '-') + '</td><td class="muted">' + esc(o.total ? (o.passed + '/' + o.total) : (o.note ? 'not a verdict' : '')) + '</td></tr>'
      ).join('');
      const by = r.summary && r.summary.by_class ? Object.keys(r.summary.by_class).map(k => esc(k) + ': ' + r.summary.by_class[k]).join('  •  ') : '';
      return '<!doctype html><html><head><meta charset="utf-8"><title>x402 Ecosystem Probe</title>' +
        '<meta name="description" content="An honest, reproducible probe of the registered x402/MCP service ecosystem: which endpoints actually present an x402 402 challenge, and whether it is spec-conformant.">' +
        '<style>body{font:15px/1.55 system-ui,Segoe UI,sans-serif;max-width:960px;margin:40px auto;padding:0 16px;color:#111}' +
        'h1{margin:0 0 6px}h2{margin-top:26px}.muted{color:#666;font-size:13px}' +
        '.b{display:inline-block;padding:2px 8px;border-radius:10px;color:#fff;font-weight:600;font-size:12px}' +
        'table{border-collapse:collapse;width:100%;font-size:13.5px}td,th{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}' +
        '.warn{background:#fff8e1;border-left:4px solid #b06000;padding:12px 14px;border-radius:6px;margin:16px 0}a{color:#0645ad}</style></head><body>' +
        '<h1>x402 Ecosystem Probe</h1>' +
        '<p class="muted">Generated ' + esc(r.at) + ' by Automaton-Sovereign. Reproducible; no account or wallet used.</p>' +
        '<div class="warn"><b>Read the methodology before the numbers.</b><br>' + esc(r.methodology) + '</div>' +
        '<h2>Summary</h2><ul>' +
        '<li>Registry servers scanned: <b>' + esc((r.summary || {}).registry_servers) + '</b></li>' +
        '<li>With an HTTP endpoint: <b>' + esc((r.summary || {}).with_http_endpoints) + '</b></li>' +
        '<li>Sampled: <b>' + esc((r.summary || {}).sampled) + '</b></li>' +
        '<li>Endpoints that <b>actually presented a 402 x402 challenge</b>: <b>' + esc((r.summary || {}).endpoints_presenting_a_402_challenge) + '</b></li>' +
        '<li>Spec-conformant among those: <b>' + esc((r.summary || {}).conformant_of_those) + '</b></li>' +
        '<li>Classification: ' + by + '</li></ul>' +
        '<h2>Observations</h2><table><tr><th>service</th><th>class</th><th>http</th><th>score</th></tr>' + rows + '</table>' +
        '<h2>Check your own service</h2><p>Free, no account: <code>' + esc(r.base) + '/v1/x402-conformance?url=&lt;yours&gt;</code> ' +
        'or see the fixes with <a href="/remediate">/remediate</a>.</p>' +
        '</body></html>';
    }

    const prev = server.listeners('request').slice();
    server.removeAllListeners('request');
    server.on('request', function (req, res) {
      let p = '/', q = '';
      try { const s = (req.url || '/').split('?'); p = decodeURIComponent(s[0]); q = s[1] || ''; } catch (e) { p = (req.url || '/').split('?')[0]; }
      if (p === '/v1/ecosystem-report' || p === '/ecosystem' || p === '/ecosystem.md') {
        const r = load();
        if (!r) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'report_not_generated_yet' })); }
        if (p === '/v1/ecosystem-report') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify(r));
        }
        if (p === '/ecosystem.md') {
          let md = ''; try { md = fs.readFileSync(MDF, 'utf8'); } catch (e) { md = '# x402 Ecosystem Probe\n\n' + r.methodology; }
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          return res.end(md);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        return res.end(renderHtml(r));
      }
      return prev.forEach(function (l) { l.call(server, req, res); });
    });
  } catch (e) {
    console.error('[ecosystem-overlay] init failed: ' + (e && e.message));
  }
})();
