// osir-overlay.js - appends FREE domain-availability + pricing endpoints to server.js
// Uses the same server.on('request') early-return pattern as the other overlays.
// Idempotent: strips its own marker block before re-appending.
const fs = require('fs');
const P = 'server.js';
let src = fs.readFileSync(P, 'utf8');
const MARK = '\n/* ==== OSIR DOMAIN OVERLAY v1 ==== */';
const i = src.indexOf(MARK);
if (i >= 0) src = src.slice(0, i);

const overlay = MARK + `
(function () {
  try {
    const osir = require('./osir-domain.js');
    if (typeof FREE !== 'undefined' && Array.isArray(FREE)) {
      ['/domain', '/v1/domain/check', '/v1/domain/tlds'].forEach(function (r) { if (FREE.indexOf(r) < 0) FREE.push(r); });
    }
    const __prev = server.listeners('request').slice();
    server.removeAllListeners('request');
    server.on('request', function (req, res) {
      let p = '/', query = '';
      try { const s = (req.url || '/').split('?'); p = decodeURIComponent(s[0]); query = s[1] || ''; } catch (e) { p = (req.url || '/').split('?')[0]; }
      function qs(name) { const m = new RegExp('(?:^|&)' + name + '=([^&]*)').exec(query); if (!m) return ''; try { return decodeURIComponent(m[1]); } catch (e) { return ''; } }
      if (p === '/v1/domain/tlds') {
        return osir.tlds().then(function (t) {
          res.writeHead(t.ok ? 200 : 502, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
          res.end(JSON.stringify(t));
        }).catch(function (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'internal', detail: String(e && e.message || e) })); });
      }
      if (p === '/v1/domain/check') {
        const d = qs('domain') || qs('d');
        return osir.check(d).then(function (c) {
          res.writeHead(c.ok ? 200 : (c.reason === 'malformed_domain' ? 400 : 502), { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
          res.end(JSON.stringify(c));
        }).catch(function (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'internal', detail: String(e && e.message || e) })); });
      }
      if (p === '/domain') {
        const d = (qs('domain') || '').replace(/[^a-z0-9.\\-]/gi, '');
        const html = '<!doctype html><html><head><meta charset=utf-8><title>Free domain availability + pricing</title>' +
          '<meta name="description" content="Live registry availability and pricing for 466 TLDs. No signup, no payment, CORS-open JSON API."></head>' +
          '<body style="font:15px system-ui;max-width:760px;margin:48px auto;padding:0 16px;color:#111">' +
          '<h1 style="margin-bottom:4px">Free domain availability &amp; pricing</h1>' +
          '<p style="color:#555">Live registry data for <b>466 TLDs</b> (registration, renewal, transfer, restore). Free and CORS-open &mdash; build on it.</p>' +
          '<form action="/domain" method="get" style="margin:20px 0">' +
          '<input name="domain" value="' + d + '" placeholder="example.xyz" style="font:16px system-ui;padding:10px;width:62%;border:1px solid #ccc;border-radius:6px">' +
          '<button style="padding:10px 18px;font:16px system-ui;border:0;border-radius:6px;background:#111;color:#fff">Check</button></form>' +
          '<p style="color:#666">JSON API: <code>/v1/domain/check?domain=example.xyz</code> &middot; <code>/v1/domain/tlds</code></p>' +
          (d ? '<pre id="r" style="background:#f6f8fa;padding:14px;border-radius:8px;overflow:auto">checking ' + d + ' …</pre>' +
              '<script>fetch("/v1/domain/check?domain=' + encodeURIComponent(d) + '").then(function(x){return x.json()}).then(function(j){document.getElementById("r").textContent=JSON.stringify(j,null,2)}).catch(function(e){document.getElementById("r").textContent="error: "+e})</script>' : '') +
          '</body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        return res.end(html);
      }
      return __prev.forEach(function (l) { l.call(server, req, res); });
    });
    console.log('[osir-overlay v1] domain endpoints active');
  } catch (e) {
    console.log('[osir-overlay v1] SKIPPED: ' + (e && e.message));
  }
})();
`;

fs.writeFileSync(P, src + overlay);
console.log('osir-overlay appended, total bytes=' + (src + overlay).length);
