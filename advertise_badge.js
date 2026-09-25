// advertise_badge.js - wire the badge into every discovery surface + write the embed guide.
'use strict';
const fs = require('fs');
const path = require('path');
const P = (f) => path.join(__dirname, f);

const BASE = (() => { try { return fs.readFileSync(P('tunnel.url'), 'utf8').trim(); } catch (e) { return 'http://localhost:8080'; } })();

// 1. bazaar.json listing
try {
  const bz = JSON.parse(fs.readFileSync(P('bazaar.json'), 'utf8'));
  bz.free = bz.free || [];
  if (!bz.free.some(e => e.path === '/badge.svg')) {
    bz.free.push({ path: '/badge.svg', method: 'GET', params: { url: 'target service base URL' }, returns: 'embeddable SVG conformance badge (shields.io style), CORS-open, cached 5m' });
  }
  fs.writeFileSync(P('bazaar.json'), JSON.stringify(bz, null, 2));
  console.log('bazaar.json free endpoints:', bz.free.length);
} catch (e) { console.log('bazaar ERR', e.message); }

// 2. llms.txt
try {
  let t = fs.readFileSync(P('llms.txt'), 'utf8');
  if (!t.includes('/badge.svg')) {
    t += '\n## Free embeddable x402 conformance badge\nGET /badge.svg?url=<target service url> -> live SVG badge. Embed in your README:\n' +
         '  [![x402](' + BASE + '/badge.svg?url=https://YOUR-SERVICE)](https://YOUR-SERVICE)\n' +
         'Every embed backlinks to this directory. Verify any service free at /v1/x402-conformance?url=<target>.\n';
    fs.writeFileSync(P('llms.txt'), t);
    console.log('llms.txt updated');
  } else console.log('llms.txt already lists badge');
} catch (e) { console.log('llms ERR', e.message); }

// 3. index.html storefront
try {
  let h = fs.readFileSync(P('index.html'), 'utf8');
  if (!h.includes('/badge.svg')) {
    const blk = '<h2>Free: x402 conformance badge</h2>' +
      '<p>Live SVG badge for any x402 service. <img src="/badge.svg?url=https://example.com/" alt="x402 badge" style="vertical-align:middle"></p>' +
      '<pre>[![x402](' + BASE + '/badge.svg?url=https://YOUR-SERVICE)](https://YOUR-SERVICE)</pre>';
    if (h.includes('</body>')) h = h.replace('</body>', blk + '\n</body>');
    else h += blk;
    fs.writeFileSync(P('index.html'), h);
    console.log('index.html updated');
  } else console.log('index.html already lists badge');
} catch (e) { console.log('html ERR', e.message); }

// 4. sitemap route list lives inside server.js; ensure /badge.svg is advertised in openapi
try {
  const oa = JSON.parse(fs.readFileSync(P('openapi.json'), 'utf8'));
  oa.paths = oa.paths || {};
  if (!oa.paths['/badge.svg']) {
    oa.paths['/badge.svg'] = {
      get: {
        summary: 'Free embeddable x402 conformance badge (SVG)',
        parameters: [{ name: 'url', in: 'query', required: true, schema: { type: 'string' }, description: 'Target service base URL to score' }],
        responses: { 200: { description: 'SVG badge', content: { 'image/svg+xml': { schema: { type: 'string' } } } }, 400: { description: 'missing url' } }
      }
    };
    fs.writeFileSync(P('openapi.json'), JSON.stringify(oa, null, 2));
    console.log('openapi.json paths:', Object.keys(oa.paths).length);
  } else console.log('openapi.json already lists badge');
} catch (e) { console.log('openapi ERR', e.message); }

// 5. embed guide artifact (published separately)
const guide = `# Embed the x402 conformance badge

Show your users (and other agents) that your service speaks x402.

    [![x402](${BASE}/badge.svg?url=https://YOUR-SERVICE)](https://YOUR-SERVICE)

HTML:

    <a href="https://YOUR-SERVICE"><img src="${BASE}/badge.svg?url=https://YOUR-SERVICE" alt="x402 badge"></a>

What the badge means: the label is always "x402". The value is the live conformance
verdict produced by ${BASE}/v1/x402-conformance - PASS n/6, or n/6 FAIL.
Colors: green = CONFORMANT, red = NON_CONFORMANT, yellow = PARTIAL.

Free. No key. No signup. CORS-open. Cached 5 minutes per target.
Machine-readable directory: ${BASE}/v1/x402-directory
Human directory: ${BASE}/directory
`;
fs.writeFileSync(P('BADGE-EMBED.md'), guide);
console.log('BADGE-EMBED.md bytes:', guide.length);
console.log('BASE:', BASE);
