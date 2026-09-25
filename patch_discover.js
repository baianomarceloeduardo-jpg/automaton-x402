// patch_discover.js - add crawler/human discoverability routes. Idempotent.
// Adds: /robots.txt (static file), /sitemap.xml (generated from live routes), /directory (HTML).
'use strict';
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'server.js');
let s = fs.readFileSync(F, 'utf8');
const before = s.length;

if (!s.includes("'/robots.txt'")) {
  s = s.replace("'/v1/x402-directory']", "'/v1/x402-directory', '/robots.txt', '/sitemap.xml', '/directory']");
}

const HANDLER = `  if (p === '/robots.txt') {
    return send(res, 200, 'User-agent: *\\nAllow: /\\nSitemap: ' + base() + '/sitemap.xml\\n', { 'content-type': 'text/plain; charset=utf-8' });
  }
  if (p === '/sitemap.xml') {
    const b = base();
    const urls = ['/', '/pricing', '/.well-known/x402', '/.well-known/agent-card.json', '/.well-known/x402-bazaar.json', '/openapi.json', '/llms.txt', '/directory', '/v1/x402-directory', '/v1/x402-conformance', '/v1/verify-payment', '/v2/ledger', '/v2/pubkey'];
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\\n' +
      urls.map(x => '  <url><loc>' + b + x + '</loc><changefreq>daily</changefreq></url>').join('\\n') + '\\n</urlset>\\n';
    return send(res, 200, xml, { 'content-type': 'application/xml; charset=utf-8' });
  }
  if (p === '/directory') {
    const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    if (!res._settled && res.setHeader) res.setHeader('Access-Control-Allow-Origin', '*');
    return DIRECTORY.build({}).then(d => {
      const rows = d.services.map(e => '<tr><td><code>' + esc(e.name) + '</code></td><td>' + esc((e.description || '').slice(0, 140)) + '</td><td>' + (e.endpoint ? '<a href="' + esc(e.endpoint) + '">' + esc(e.endpoint) + '</a>' : '&mdash;') + '</td></tr>').join('\\n');
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>x402 Service Directory</title>' +
        '<style>body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}th{background:#f5f5f5}</style>' +
        '</head><body><h1>x402 Service Directory</h1>' +
        '<p>Live from the public MCP registry. <b>' + d.count + '</b> services matched terms: ' + esc(d.terms.join(', ')) + '. Generated ' + esc(d.generatedAt) + '.</p>' +
        '<p>Machine-readable JSON: <a href="/v1/x402-directory">/v1/x402-directory</a></p>' +
        '<table><tr><th>name</th><th>description</th><th>endpoint</th></tr>' + rows + '</table>' +
        '<p><a href="/">Back to the Value API</a></p></body></html>';
      return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
    }).catch(e => send(res, 500, { error: 'directory_failed', message: e.message }));
  }
`;
if (!s.includes("p === '/directory'")) {
  s = s.replace("  if (p === '/v2/verify') {", HANDLER + "  if (p === '/v2/verify') {");
}

if (s.length === before) { console.log('NOCHANGE (already patched)'); process.exit(0); }
fs.writeFileSync(F + '.bak4', fs.readFileSync(F));
fs.writeFileSync(F, s);
console.log('PATCHED server.js: +' + (s.length - before) + ' bytes | robots:' + s.includes("'/robots.txt'") + ' | handler:' + s.includes("p === '/directory'"));
