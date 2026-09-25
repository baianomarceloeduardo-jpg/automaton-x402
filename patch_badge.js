// patch_badge.js - add FREE /badge.svg (embeddable x402 conformance badge). Idempotent.
'use strict';
const fs = require('fs');
const path = require('path');
const F = path.join(__dirname, 'server.js');
let s = fs.readFileSync(F, 'utf8');
const before = s.length;

if (!s.includes("require('./badge.js')")) {
  s = s.replace(/(const DIRECTORY = require\('\.\/directory\.js'\);)/, "$1\nconst BADGE = require('./badge.js');");
}
if (!s.includes("'/badge.svg'")) {
  s = s.replace("'/robots.txt', '/sitemap.xml', '/directory']", "'/robots.txt', '/sitemap.xml', '/directory', '/badge.svg']");
}

const H = `  if (p === '/badge.svg') {
    const t = u.searchParams.get('url');
    if (!t) return send(res, 400, { error: 'missing_url', usage: '/badge.svg?url=https://host/path' });
    BADGE.badge(t).then(r => {
      if (res.setHeader) {
        res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
      res.statusCode = 200;
      res.end(r.svg);
    }).catch(e => send(res, 500, { error: 'badge_failed', message: e.message }));
    return;
  }
`;
if (!s.includes("p === '/badge.svg'")) {
  s = s.replace("  if (p === '/v2/verify') {", H + "  if (p === '/v2/verify') {");
}

if (s.length === before) { console.log('NOCHANGE'); process.exit(0); }
fs.writeFileSync(F + '.bak5', fs.readFileSync(F));
fs.writeFileSync(F, s);
console.log('PATCHED +' + (s.length - before) + ' require:' + s.includes("require('./badge.js')") + ' route:' + s.includes("'/badge.svg'") + ' handler:' + s.includes("p === '/badge.svg'"));
